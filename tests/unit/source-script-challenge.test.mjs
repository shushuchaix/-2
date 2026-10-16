import test from "node:test";
import assert from "node:assert/strict";
import { assessApplicationResponse } from "../../src/domain/recruitment-evidence.mjs";
import {
  withSourceContext,
  sourceFetch,
} from "../../src/sources/request-context.mjs";
import { fetchDetail } from "../../src/sources/zhaopin.mjs";
import { noticeDocument } from "../../src/sources/adapters/official-announcements.mjs";

// Synthetic structure of the HTTP200 script-only EdgeOne gate observed on
// public Zhaopin job details. No challenge arguments, tokens or upstream code.
const gate =
  '<script>function solveChallenge(){}; const cookieName="EO-Bot-Js-Token"; document.cookie=cookieName; location.href=location.href;</script>';
const response = (text) => ({ status: 200, text, headers: {} });

test("a script-only bot gate is identified even without visible captcha text", () => {
  const result = assessApplicationResponse(response(gate), null);
  assert.equal(result.challenge, true);
  assert.equal(result.formVerified, false);
});

test("legacy source reads report a script challenge instead of a parsing failure", async () => {
  let calls = 0;
  await assert.rejects(
    withSourceContext(
      {
        request: async () => {
          calls++;
          return response(gate);
        },
      },
      () => sourceFetch("https://www.zhaopin.com/jobdetail/synthetic.htm"),
    ),
    { code: "captcha" },
  );
  assert.equal(calls, 1);
});

test("a script gate cannot become a Zhaopin fallback job description", async () => {
  await assert.rejects(
    withSourceContext({ request: async () => response(gate) }, () =>
      fetchDetail({ url: "https://www.zhaopin.com/jobdetail/synthetic.htm" }),
    ),
    { code: "captcha" },
  );
});

test("official notice reads report the same script-only challenge explicitly", () => {
  assert.throws(() => noticeDocument(response(gate)), { code: "captcha" });
});

for (const content of [
  "<article><h1>合成技术岗位</h1><p>负责研究 solveChallenge 和 EO-Bot-Js-Token 检测机制。</p></article>",
  '<form><input name="resume"><button>提交申请</button></form>',
])
  test("an actual body or application is not replaced by an inert script gate marker", () => {
    const result = assessApplicationResponse(
      response(`<html><body>${content}${gate}</body></html>`),
      null,
    );
    assert.equal(result.challenge, false);
  });

test("ordinary bootstrap scripts and unrelated quoted bot words are not a gate", async () => {
  for (const html of [
    "<script>const tokenName='EO-Bot-Js-Token';</script>",
    "<script>function solveChallenge(){};</script>",
    "<script>const captcha='documentation';</script>",
  ])
    assert.equal(
      assessApplicationResponse(response(html), null).challenge,
      false,
    );
});
