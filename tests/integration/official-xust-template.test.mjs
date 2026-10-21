import test from "node:test";
import assert from "node:assert/strict";
import official from "../../src/sources/adapters/official-announcements.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import { prepareRecruitmentRecord } from "../../src/domain/recruitment-evidence.mjs";

const origin = "https://jy.xust.edu.cn";
const portal = "xust-public-onlines-1";
const site = {
  siteId: "official-92038145590ecfba",
  providerId: "official-announcements",
  name: "西安科技大学",
  origin,
  allowedDomains: ["jy.xust.edu.cn"],
  template: {
    nativePortal: portal,
    recordKind: "recruitment_notice",
    listUrl: origin + "/module/getonlines",
    paginationVerified: true,
  },
};
const now = Date.parse("2026-10-13T05:00:00Z");
const row = (extra = {}) => ({
  recruitment_id: "12345",
  company_id: "34567",
  company_name: "合成消防企业",
  title: "合成消防企业2027年度校园招聘简章",
  create_time: "2026-10-01",
  recruit_type: "正式招聘",
  content: "<p>这是合成的列表摘要，不能据此声称完整正文。</p>",
  job_recruitment: "消防安全岗，设备维护岗",
  work_city: "合成市",
  ...extra,
});
const body =
  "<p>本段为合成招聘公告，所有信息仅用于结构测试。报名截至2026年10月31日。</p>" +
  "<table><tr><th>岗位</th><th>学历</th></tr><tr><td>合成消防岗</td><td>本科</td></tr><tr><td>合成维护岗</td><td>大专</td></tr></table>" +
  '<p>应聘报名网址：<a href="https://careers.example.org/apply">应聘报名</a>，请核对本公告要求。</p>';
function html({
  dataChange,
  visibleTitle,
  visibleBody = body,
  suffix = "",
} = {}) {
  const r = row();
  const data = {
    params: { token: "private-control-marker" },
    is_login: false,
    student_key: "private-control-marker",
    online: {
      recruitment_id: Number(r.recruitment_id),
      company_id: Number(r.company_id),
      school_id: 2421,
      title: r.title,
      content: body,
      create_time: "2026年10月1日",
      state: "已发布",
      is_shelved: 1,
      docs: [],
      jobs: [{ title: "副岗位（不得并入本公告正文）", content: "其他条件" }],
    },
  };
  dataChange?.(data);
  return `<html><body><nav>导航招聘信息</nav><div id="data_details" class="pub-details"><div class="details-head"><h1 class="dh-tit">${visibleTitle ?? r.title}</h1></div><div class="details-content">${visibleBody}</div><div class="detail-module"><div class="job-detail">副岗位（不得并入本公告正文）</div></div><div class="company-infor" data-id="34567"></div></div><script>var data = JSON.parse(JSON.stringify(${JSON.stringify(data)}));${suffix}</script></body></html>`;
}
function replay({
  rows = [row()],
  detail = html(),
  status = 200,
  responseUrl,
  cursor = null,
  query = "消防",
  data,
} = {}) {
  const calls = [],
    context = {
      sites: [structuredClone(site)],
      clock: { now: () => now },
      signal: new AbortController().signal,
      request: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          status,
          url: responseUrl ?? url,
          headers: {},
          text:
            new URL(url).pathname === "/module/getonlines"
              ? JSON.stringify(data ?? { code: 1, msg: "", data: rows })
              : detail,
        };
      },
    };
  return {
    calls,
    context,
    collect: () =>
      official.collectPage({
        site: context.sites[0],
        query: { keyword: query },
        cursor,
        context,
      }),
    detail: (record) => official.fetchDetail(record, context),
  };
}

test("XUST catalog registers the observed native contract without claiming a successful probe", () => {
  const configured = loadSiteCatalog().find((s) => s.siteId === site.siteId);
  assert.equal(configured.template?.nativePortal, portal);
  assert.equal(configured.status, "candidate");
  assert.equal(configured.verifiedAt, null);
  assert.equal(configured.adapterVerification, "unverified");
  assert.equal(configured.templateEvidence.requiresLiveProbe, true);
});

test("XUST reads the native anonymous GET list, retains announcements and never verifies its short summary", async () => {
  const f = replay(),
    page = await f.collect(),
    record = page.records[0];
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, site.template.listUrl);
  assert.equal(u.searchParams.get("k"), "消防");
  assert.equal(u.searchParams.get("start"), "1");
  assert.equal(u.searchParams.get("count"), "15");
  assert.equal(f.calls[0].options.body, undefined);
  assert.equal(record.kind, "recruitment_notice");
  assert.equal(record.sourceRecordId, "12345");
  assert.equal(record.sourceRecordIdKind, "authority");
  assert.equal(record.identityScope, site.siteId);
  assert.equal(record.url, origin + "/detail/online?id=12345&menu_id=8448");
  assert.equal(record.company, "合成消防企业");
  assert.equal(record.publishedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(record.bodyStatus, "incomplete");
  assert.equal(
    prepareRecruitmentRecord(record, now).recruitmentEvidence.bodyVerified,
    false,
  );
  assert.equal(page.hasMore, false);
});

test("XUST preserves native pagination and binds the cursor to its keyword", async () => {
  const f = replay({
    rows: Array.from({ length: 15 }, (_, i) =>
      row({ recruitment_id: String(12000 + i) }),
    ),
  });
  const page = await f.collect();
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor.page, 2);
  const second = replay({ cursor: page.nextCursor });
  await second.collect();
  assert.equal(new URL(second.calls[0].url).searchParams.get("start"), "2");
  const changed = replay({ cursor: page.nextCursor, query: "机场" });
  await assert.rejects(changed.collect(), { code: "pagination_scope" });
  assert.equal(changed.calls.length, 0);
});

test("XUST accepts a valid empty list but rejects malformed envelopes and authority IDs", async () => {
  assert.equal((await replay({ rows: [] }).collect()).records.length, 0);
  for (const data of [
    { code: 0, msg: "", data: [] },
    { code: 1, data: {} },
    { code: 1, msg: "", data: [row({ recruitment_id: "../wrong" })] },
  ]) {
    await assert.rejects(replay({ data }).collect(), { code: "parse_error" });
  }
});

test("XUST excludes conflicting duplicate announcements instead of choosing one title", async () => {
  const page = await replay({
    rows: [row(), row({ title: "另一个公告的名称" })],
  }).collect();
  assert.equal(page.records.length, 0);
});

test("XUST binds visible body, embedded identity and school without running the shipped JavaScript", async () => {
  globalThis.__xustExecuted = 0;
  const f = replay({
    detail: html({ suffix: "globalThis.__xustExecuted += 1;" }),
  });
  const record = await f.detail((await f.collect()).records[0]);
  assert.equal(globalThis.__xustExecuted, 0);
  delete globalThis.__xustExecuted;
  assert.equal(record.kind, "recruitment_notice");
  assert.equal(record.bodyStatus, "complete");
  assert.match(record.description, /合成消防岗/);
  assert.match(record.description, /合成维护岗/);
  assert.doesNotMatch(record.description, /副岗位|导航招聘/);
  assert.doesNotMatch(
    JSON.stringify(record),
    /private-control-marker|student_key|is_login|is_shelved/,
  );
  const prepared = prepareRecruitmentRecord(record, now);
  assert.equal(prepared.recruitmentEvidence.bodyVerified, true);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "open");
  assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(record.applyUrl, "https://careers.example.org/apply");
  assert.equal(record.applicationVerification, undefined);
  assert.ok(
    record.evidence.some(
      (e) => e.source === "xust_native_notice_table" && e.rows.length === 3,
    ),
  );
});

for (const [name, dataChange, visibleTitle] of [
  [
    "other native announcement",
    (d) => {
      d.online.recruitment_id = 54321;
    },
  ],
  [
    "other school",
    (d) => {
      d.online.school_id = 9999;
    },
  ],
  [
    "other company",
    (d) => {
      d.online.company_id = 99999;
    },
  ],
  [
    "other embedded title",
    (d) => {
      d.online.title = "其他公告";
    },
  ],
  ["other visible title", null, "其他公告"],
])
  test(`XUST rejects ${name} before attaching its body`, async () => {
    const f = replay({ detail: html({ dataChange, visibleTitle }) });
    await assert.rejects(f.detail((await f.collect()).records[0]), {
      code: "detail_identity_mismatch",
    });
  });

test("XUST rejects forged ownership, private detail parameters and response redirects", async () => {
  const f = replay(),
    record = (await f.collect()).records[0];
  for (const extra of [
    { siteId: "other" },
    { identityScope: "other" },
    { sourceRecordId: "54321" },
    { url: record.url + "&token=private-control-marker" },
  ]) {
    await assert.rejects(f.detail({ ...record, ...extra }), {
      code: "detail_identity_mismatch",
    });
  }
  assert.equal(f.calls.length, 1);
  const redirect = replay({ responseUrl: "https://other.example.org/" });
  await assert.rejects(redirect.collect(), {
    code: "detail_identity_mismatch",
  });
});

test("XUST rejects non-JSON inline expressions and ambiguous data instead of evaluating them", async () => {
  for (const transform of [
    (h) =>
      h.replace(
        '"school_id":2421',
        '"school_id":(function(){throw Error("unsafe")})()',
      ),
    (h) =>
      h.replace(
        "</body>",
        '<script>var data = JSON.parse(JSON.stringify({"online":{}}));</script></body>',
      ),
  ]) {
    const f = replay({ detail: transform(html()) });
    await assert.rejects(f.detail((await f.collect()).records[0]), {
      code: "parse_error",
    });
  }
});

test("XUST does not promote publisher flags or an attachment-only body to complete recruitment evidence", async () => {
  const emptyBody =
    '<p>岗位及要求详见附件。</p><p><a href="/upload/jobs.pdf">招聘附件</a></p>';
  const f = replay({
    detail: html({
      visibleBody: emptyBody,
      dataChange: (d) => {
        d.online.content = emptyBody;
      },
    }),
  });
  const record = await f.detail((await f.collect()).records[0]);
  assert.equal(record.bodyStatus, "incomplete");
  assert.equal(record.attachmentBodyPending, true);
  assert.equal(record.attachments.length, 1);
  const evidence = prepareRecruitmentRecord(record, now).recruitmentEvidence;
  assert.equal(evidence.bodyVerified, false);
  assert.equal(evidence.openingStatus, "unknown");
  assert.equal(evidence.applicationStatus, "unknown");
});

test("XUST excludes hidden conditions and keeps a mismatched payload body unverified", async () => {
  const visible = body + "<p hidden>副岗位要求必须博士。</p>";
  const f = replay({
    detail: html({
      visibleBody: visible,
      dataChange: (d) => {
        d.online.content = visible;
      },
    }),
  });
  const record = await f.detail((await f.collect()).records[0]);
  assert.doesNotMatch(record.description, /必须博士/);
  const mismatch = replay({
    detail: html({ visibleBody: "<p>其他公告的正文，没有本公告信息。</p>" }),
  });
  await assert.rejects(mismatch.detail((await mismatch.collect()).records[0]), {
    code: "detail_identity_mismatch",
  });
});

test("XUST retries replace its own evidence and preserve expired application suppression", async () => {
  const expired = body.replace("2026年10月31日", "2024年6月23日");
  const f = replay({
    detail: html({
      visibleBody: expired,
      dataChange: (d) => {
        d.online.content = expired;
      },
    }),
  });
  const once = await f.detail((await f.collect()).records[0]),
    twice = await f.detail(once);
  assert.deepEqual(twice.evidence, once.evidence);
  assert.deepEqual(twice.sourceEvidence, once.sourceEvidence);
  assert.equal(
    prepareRecruitmentRecord(twice, now).recruitmentEvidence.openingStatus,
    "expired",
  );
  assert.equal(
    prepareRecruitmentRecord(twice, now).recruitmentEvidence.applicationStatus,
    "unknown",
  );
});

for (const status of [401, 403, 412, 429])
  test(`XUST stops HTTP ${status} without a secondary protocol`, async () => {
    const f = replay({ status });
    await assert.rejects(f.collect(), {
      code: status === 429 ? "rate_limited" : "restricted",
    });
    assert.equal(f.calls.length, 1);
  });

// Regression boundary: refreshed native facts must not inherit proof for another
// application/body, truncate conditions, or treat inert JavaScript as identity.
test("XUST ignores unrelated inert HTML templates shipped alongside its real inline data", async () => {
  const detail = html().replace(
      "</body>",
      '<script type="text/template" id="tmpl_html"><div>合成网页模板</div></script></body>',
    ),
    f = replay({ detail });
  const record = await f.detail((await f.collect()).records[0]);
  assert.equal(record.bodyStatus, "complete");
});

test("XUST refuses identity code shipped only as an inert HTML template", async () => {
  const f = replay({
    detail: html().replace("<script>", '<script type="text/html">'),
  });
  await assert.rejects(f.detail((await f.collect()).records[0]), {
    code: "parse_error",
  });
});

for (const [name, change] of [
  ["application URL", (s) => s.replace("/apply", "/new-apply")],
  ["qualification body", (s) => s + "<p>新增条件：须持注册消防证。</p>"],
])
  test(`XUST revokes an old application check after ${name} changes`, async () => {
    const fresh = change(body),
      f = replay({
        detail: html({
          visibleBody: fresh,
          dataChange: (d) => {
            d.online.content = fresh;
          },
        }),
      }),
      listed = (await f.collect()).records[0],
      record = await f.detail({
        ...listed,
        description: body.replace(/<[^>]*>/g, ""),
        applyUrl: "https://careers.example.org/apply",
        applicationVerification: {
          status: 200,
          formVerified: true,
          checkedAt: new Date(now - 60_000).toISOString(),
        },
      });
    assert.equal(record.applicationVerification, undefined);
    assert.equal(
      prepareRecruitmentRecord(record, now).recruitmentEvidence
        .applicationStatus,
      "unknown",
    );
  });

test("XUST rejects visible qualification tails missing from the embedded body", async () => {
  const f = replay({
    detail: html({ visibleBody: body + "<p>仅招博士且必须持注册消防证。</p>" }),
  });
  await assert.rejects(f.detail((await f.collect()).records[0]), {
    code: "detail_identity_mismatch",
  });
});

test("XUST preserves conditions after a premature closing article in its HTML fragment", async () => {
  const full = body + "</article><p>必须具有注册消防证，且只招博士。</p>",
    f = replay({
      detail: html({
        visibleBody: full,
        dataChange: (d) => {
          d.online.content = full;
        },
      }),
    });
  const record = await f.detail((await f.collect()).records[0]);
  assert.match(record.description, /必须具有注册消防证/);
  assert.match(record.description, /只招博士/);
});

test("XUST removes only the observed reporting control from the body comparison", async () => {
  const footer =
      '<div style="text-align:center"><a href="javascript:;" id="btnComplaint" data-auth="0" data-login="0" data-key=""><img src="/public/images/global/safity.png"><span>校园招聘违规举报</span></a></div>',
    f = replay({ detail: html({ visibleBody: body + footer }) });
  const record = await f.detail((await f.collect()).records[0]);
  assert.equal(record.bodyStatus, "complete");
  assert.doesNotMatch(record.description, /校园招聘违规举报/);
  const extra = replay({
    detail: html({
      visibleBody:
        body +
        footer.replace(
          "校园招聘违规举报",
          "校园招聘违规举报；必须持注册消防证",
        ),
    }),
  });
  await assert.rejects(extra.detail((await extra.collect()).records[0]), {
    code: "detail_identity_mismatch",
  });
});

for (const [name, fresh, expected] of [
  [
    "recruitment attachment",
    '<p>具体资格条件详见<a href="/upload/jobs.pdf">招聘附件</a>。</p>',
    "https://jy.xust.edu.cn/upload/jobs.pdf",
  ],
  [
    "application entry",
    '<p>应聘报名网址：<a href="https://careers.example.org/new-apply">应聘报名</a></p>',
    "https://careers.example.org/new-apply",
  ],
])
  test(`XUST reads the ${name} from the visible body even when embedded text has another anchor`, async () => {
    const original =
        body.replace(/<p>应聘报名网址：[\s\S]*?<\/p>/, "") +
        fresh.replace(/href="[^"]*"/, 'href="/info"'),
      visible = body.replace(/<p>应聘报名网址：[\s\S]*?<\/p>/, "") + fresh,
      f = replay({
        detail: html({
          visibleBody: visible,
          dataChange: (d) => {
            d.online.content = original;
          },
        }),
      }),
      record = await f.detail((await f.collect()).records[0]);
    if (name === "recruitment attachment") {
      assert.equal(record.attachments[0]?.url, expected);
      assert.equal(record.attachmentBodyPending, true);
      assert.equal(
        prepareRecruitmentRecord(record, now).recruitmentEvidence.bodyVerified,
        false,
      );
    } else {
      assert.equal(record.applyUrl, expected);
      assert.equal(record.applicationVerification, undefined);
    }
  });

for (const [name, transform] of [
  ["block comment", (s) => "/*\n" + s + "\n*/"],
  ["template string", (s) => "const unused = `\n" + s + "\n`;"],
  ["uninvoked function", (s) => "function unused() {\n" + s + "\n}"],
])
  test(`XUST refuses embedded identity contained only in a ${name}`, async () => {
    const detail = html().replace(
        /<script>([\s\S]*?)<\/script>/,
        (_, source) => "<script>" + transform(source) + "</script>",
      ),
      f = replay({ detail });
    await assert.rejects(f.detail((await f.collect()).records[0]), {
      code: "parse_error",
    });
  });

test("XUST can read a public announcement explaining login at the employer's application website", async () => {
  const full = body + "<p>应聘者在企业招聘网站登录后报名。</p>",
    f = replay({
      detail: html({
        visibleBody: full,
        dataChange: (d) => {
          d.online.content = full;
        },
      }),
    });
  const record = await f.detail((await f.collect()).records[0]);
  assert.equal(record.bodyStatus, "complete");
  assert.equal(
    prepareRecruitmentRecord(record, now).recruitmentEvidence.bodyVerified,
    true,
  );
  assert.equal(record.applicationVerification, undefined);
});

for (const [name, detail, code] of [
  [
    "login wall",
    '<html><body><p>请先登录后访问招聘正文</p><input type="password"></body></html>',
    "restricted",
  ],
  [
    "captcha wall",
    '<html><body><p>请先完成人机验证后访问</p><input name="captcha"></body></html>',
    "captcha",
  ],
])
  test(`XUST still stops an actual ${name}`, async () => {
    const f = replay({ detail });
    await assert.rejects(f.detail((await f.collect()).records[0]), { code });
  });
