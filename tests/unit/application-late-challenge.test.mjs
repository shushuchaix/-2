import test from "node:test";
import assert from "node:assert/strict";
import { assessApplicationResponse } from "../../src/domain/recruitment-evidence.mjs";

const checkedAt = "2026-10-12T00:00:00.000Z";
const ordinaryForm =
  '<form><input name="resume"><button>提交申请</button></form>';
const page = (body, head = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const assess = (body, head = "", status = 200) =>
  assessApplicationResponse({ status, text: page(body, head) }, checkedAt);

test("visible verification control after a large head cannot verify an application form", () => {
  const result = assess(
    '<form><input name="verifyCode"><button>报名</button></form>',
    `<script>${"const filler = 1;".repeat(2400)}</script>`,
  );
  assert.deepEqual(result, {
    status: 200,
    checkedAt,
    challenge: true,
    formVerified: false,
  });
});

test("visible challenge message after long page content is checked in full", () => {
  const result = assess(
    `<article>${"岗位介绍与公开说明。".repeat(3600)}</article><p>请先完成人机验证后继续报名。</p>${ordinaryForm}`,
  );
  assert.equal(result.challenge, true);
  assert.equal(result.formVerified, false);
});

for (const [name, control] of [
  ["native id", '<input id="verifyCode">'],
  ["native name", '<input name="verify_code">'],
  ["captcha name", '<input name="captcha">'],
  [
    "associated label",
    '<label for="public-code">验证码：</label><input id="public-code">',
  ],
  ["wrapping label", '<label>验证码<input name="code"></label>'],
  ["placeholder", '<input placeholder="请输入验证码">'],
  ["accessible label", '<input aria-label="验证码">'],
]) {
  test(`visible ${name} identifies a verification control`, () => {
    const result = assess(`<form>${control}<button>报名</button></form>`);
    assert.equal(result.challenge, true);
    assert.equal(result.formVerified, false);
  });
}

for (const [name, content] of [
  [
    "script variables",
    '<script>const captcha = "请输入验证码"; let verifyCode = "人机验证";</script>',
  ],
  ["style text", '<style>.captcha::after{content:"验证码"}</style>'],
  [
    "template",
    '<template><label>验证码<input name="verifyCode"></label></template>',
  ],
  [
    "hidden attribute",
    '<div hidden><p>请先完成人机验证。</p><input name="verifyCode"></div>',
  ],
  [
    "aria-hidden ancestor",
    '<div aria-hidden="true"><div><input name="verifyCode"></div></div>',
  ],
  [
    "uppercase aria-hidden",
    '<div aria-hidden="TRUE"><p>请输入验证码。</p><input name="verifyCode"></div>',
  ],
  [
    "display none ancestor",
    '<section style="display: none"><form><input name="verifyCode"><button>报名</button></form></section>',
  ],
  [
    "important hidden ancestor",
    '<section style="DISPLAY : NONE !important;"><div><input name="verifyCode"></div></section>',
  ],
  [
    "visibility hidden ancestor",
    '<section style="color:red; visibility: hidden"><input name="verifyCode"></section>',
  ],
  [
    "collapsed ancestor",
    '<section style="visibility: collapse"><input name="verifyCode"></section>',
  ],
  [
    "hidden input",
    '<input type="hidden" name="verifyCode" value="synthetic-token">',
  ],
]) {
  test(`${name} cannot create an application challenge`, () => {
    const result = assess(`${content}${ordinaryForm}`);
    assert.equal(result.challenge, false);
    assert.equal(result.formVerified, true);
  });
}

test("head title and script cannot create a visible challenge", () => {
  const result = assess(
    ordinaryForm,
    "<title>验证码与 CAPTCHA 开发职位</title><script>const verifyCode = 1;</script>",
  );
  assert.equal(result.challenge, false);
  assert.equal(result.formVerified, true);
});

for (const description of [
  "岗位职责：负责验证码开发、人机验证模块与 CAPTCHA 技术研究。",
  "岗位职责：设计“请输入验证码”提示与验证错误处理模块。",
  "任职要求：熟悉 CAPTCHA、验证码和安全验证系统的开发。",
]) {
  test(`ordinary developer job description is not a challenge: ${description}`, () => {
    const result = assess(`<article>${description}</article>${ordinaryForm}`);
    assert.equal(result.challenge, false);
    assert.equal(result.formVerified, true);
  });
}

test("inline markup quoting a verification prompt in a developer job is not a challenge", () => {
  const result = assess(
    `<article><p>岗位职责：设计<span>请输入验证码</span>提示与验证错误处理模块。</p></article>${ordinaryForm}`,
  );
  assert.equal(result.challenge, false);
  assert.equal(result.formVerified, true);
});

for (const prompt of [
  "请输入验证码后继续报名。",
  "请先完成人机验证。",
  "验证码核验后访问。",
  "访问过于频繁，请稍后再试。",
  "验证码输入错误，请重新填写。",
  "Please complete the CAPTCHA to continue.",
  "Please verify you are human.",
]) {
  test(`visible challenge instruction is detected: ${prompt}`, () => {
    const result = assess(`<p>${prompt}</p>${ordinaryForm}`);
    assert.equal(result.challenge, true);
    assert.equal(result.formVerified, false);
  });
}

for (const wrapper of [
  (content) => `<div hidden>${content}</div>`,
  (content) => `<div aria-hidden="true">${content}</div>`,
  (content) => `<div style="display:none">${content}</div>`,
  (content) => `<div style="visibility:hidden">${content}</div>`,
]) {
  test("application form under a hidden ancestor is not verified", () => {
    const result = assess(wrapper(ordinaryForm));
    assert.equal(result.challenge, false);
    assert.equal(result.formVerified, false);
  });
}

test("visible login controls preserve the login gate", () => {
  const result = assess(
    '<form><input type="password"><button>登录后报名</button></form>',
  );
  assert.equal(result.status, "login_required");
  assert.equal(result.challenge, false);
  assert.equal(result.formVerified, false);
});

test("hidden login controls cannot block a visible application form", () => {
  const result = assess(
    `<div style="display:none"><input type="password">请先登录</div>${ordinaryForm}`,
  );
  assert.equal(result.status, 200);
  assert.equal(result.challenge, false);
  assert.equal(result.formVerified, true);
});

test("non-success response never verifies a form even without a challenge", () => {
  assert.equal(assess(ordinaryForm, "", 403).formVerified, false);
  const result = assess("<p>请先完成人机验证。</p>", "", 403);
  assert.equal(result.status, 403);
  assert.equal(result.challenge, true);
  assert.equal(result.formVerified, false);
});

test("visible application prose without a form is not a verified application entry", () => {
  const result = assess(
    "<article>本职位接受报名与简历投递，详见招聘公告。</article>",
  );
  assert.equal(result.challenge, false);
  assert.equal(result.formVerified, false);
});
