import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import * as hpuAdapter from "../../src/sources/adapters/hpu-public-notices.mjs";
import { loadSiteCatalog } from "../../src/sources/catalog.mjs";
import {
  collectHpuPublicNotices,
  fetchHpuPublicNotice,
} from "../../src/sources/adapters/hpu-public-notices.mjs";
import {
  prepareRecruitmentRecord,
  isVerifiedRecommendation,
} from "../../src/domain/recruitment-evidence.mjs";

const siteId = "official-c738f71905918585";
const listUrl = "https://hpu.bysjy.com.cn/";
const detailUrl = listUrl + "detail/news?id=1839023&type_id=9129";
const apiUrl = listUrl + "detail/getnoticedetail?notice_id=1839023";
const now = Date.parse("2026-10-12T00:00:00Z");
const read = (name) =>
  fs.readFileSync(
    new URL(
      `../fixtures/official-template-repair/hpu-${name}`,
      import.meta.url,
    ),
    "utf8",
  );
function replay({
  list = read("list.html"),
  detail,
  status = 200,
  responseUrl,
} = {}) {
  const site = {
    siteId,
    providerId: "official-announcements",
    origin: "https://hpu.bysjy.com.cn",
    name: "河南理工大学就业网",
    status: "candidate",
    verifiedAt: null,
    adapterVerification: "unverified",
    template: {
      nativePortal: "hpu-public-notices-1",
      recordKind: "recruitment_notice",
      listUrl,
      paginationVerified: false,
    },
    templateEvidence: { requiresLiveProbe: true },
  };
  const requests = [],
    fixtureErrors = [];
  const context = {
    sites: [site],
    clock: { now: () => now },
    request: async (url, options) => {
      requests.push({ url, signal: options?.signal });
      if (url === listUrl) return { status: 200, text: list, headers: {} };
      if (url === apiUrl)
        return {
          status,
          text: detail ?? read("detail.json"),
          headers: { "content-type": "application/json" },
          ...(responseUrl ? { url: responseUrl } : {}),
        };
      fixtureErrors.push(url);
      throw Error("Unexpected synthetic fixture request");
    },
  };
  return { site, requests, fixtureErrors, context };
}
const altered = (change) => {
  const payload = JSON.parse(read("detail.json"));
  change(payload);
  return JSON.stringify(payload);
};
async function listRecord(fixture) {
  const page = await collectHpuPublicNotices(fixture.site, 1, fixture.context);
  assert.equal(page.records.length, 1);
  return { page, record: page.records[0] };
}
async function detail(fixture) {
  const { record } = await listRecord(fixture);
  return fetchHpuPublicNotice(fixture.site, record, fixture.context);
}

test("HPU accepts one native announcement, without jump wrappers, duplicate IDs, events, navigation or external rows", async () => {
  const fixture = replay();
  const { page, record } = await listRecord(fixture);
  assert.equal(record.url, detailUrl);
  assert.equal(record.sourceRecordId, "1839023");
  assert.equal(record.sourceRecordIdKind, "authority");
  assert.equal(record.sourceId, "official-announcements");
  assert.equal(record.siteId, siteId);
  assert.equal(record.identityScope, siteId);
  assert.equal(record.kind, "recruitment_notice");
  assert.equal(record.company, null);
  assert.equal(record.title, "合成矿业2027年度高校毕业生招聘简章");
  assert.equal(record.publishedAt, null);
  assert.equal(record.detailStatus, "incomplete");
  assert.equal(page.coverageScope, "limited");
  assert.equal(page.truncationReason, "listing_only");
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    fixture.requests.map((row) => row.url),
    [listUrl],
  );
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU pure native JSON body keeps a single notice and complete separate education table rows", async () => {
  const fixture = replay();
  const record = await detail(fixture);
  assert.equal(record.kind, "recruitment_notice");
  assert.equal(record.detailStatus, "complete");
  assert.equal(record.bodyStatus, "complete");
  assert.equal(record.bodyIncomplete, false);
  assert.equal(record.publishedAt, "2026-09-30T00:00:00.000Z");
  assert.match(record.description, /通风与安全（合成） 硕士 3/);
  assert.match(record.description, /通风与安全（合成） 本科 12/);
  assert.match(record.description, /合计 63/);
  assert.ok(record.description.endsWith("因此只保留一份公告。"));
  const table = record.evidence.find(
    (row) => row.source === "native_notice_table",
  );
  assert.deepEqual(table.rows, [
    ["专业", "学历", "人数"],
    ["通风与安全（合成）", "硕士", "3"],
    ["通风与安全（合成）", "本科", "12"],
    ["合计", "63"],
  ]);
  assert.deepEqual(record.attachments, []);
  assert.equal(
    prepareRecruitmentRecord(record, now).recruitmentEvidence.bodyVerified,
    true,
  );
  assert.deepEqual(
    fixture.requests.map((row) => row.url),
    [listUrl, apiUrl],
  );
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU native publication has literal field evidence", async () => {
  const fixture = replay();
  const record = await detail(fixture);
  const publication = record.sourceEvidence.find(
    (row) => row.field === "publishedAt",
  );
  assert.equal(publication?.value, "2026-09-30T00:00:00.000Z");
  assert.equal(publication?.sourceExcerpt, "2026年9月30日");
  assert.equal(publication?.status, "verified");
  assert.equal(publication?.sourceUrl, apiUrl);
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU repeated detail does not duplicate its table or body facts", async () => {
  const fixture = replay();
  const once = await detail(fixture);
  const twice = await fetchHpuPublicNotice(fixture.site, once, fixture.context);
  assert.deepEqual(twice.evidence, once.evidence);
  assert.deepEqual(twice.sourceEvidence, once.sourceEvidence);
  assert.deepEqual(
    fixture.requests.map((row) => row.url),
    [listUrl, apiUrl, apiUrl],
  );
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU explicit recruitment closing date and plaintext URL do not claim a verified application", async () => {
  const fixture = replay();
  const record = prepareRecruitmentRecord(await detail(fixture), now);
  assert.equal(record.deadlineAt, "2026-10-31T15:59:59.999Z");
  assert.equal(record.recruitmentEvidence.openingStatus, "open");
  assert.equal(record.applyUrl, "https://webhr.shccig.com/webhrN2-zp");
  assert.equal(record.recruitmentEvidence.applicationStatus, "unknown");
  assert.equal(record.applicationVerification, undefined);
  assert.ok(
    record.sourceEvidence.some(
      (row) => row.field === "applyUrl" && row.status === "unknown",
    ),
  );
  assert.equal(
    isVerifiedRecommendation({
      qualification: { status: "pass" },
      evidence: record.recruitmentEvidence,
    }),
    false,
  );
  assert.deepEqual(
    fixture.requests.map((row) => row.url),
    [listUrl, apiUrl],
  );
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU ticket signup dates and ticket expiry never supply recruitment deadline or open status", async () => {
  const fixture = replay({
    detail: altered(({ data }) => {
      data.content = data.content.replace("2026年10月31日", "10月31日");
      data.sign_up_type = 1;
      data.sign_up_end_time = "2026-10-31 17:00:00";
      data.is_overdue = true;
    }),
  });
  const record = prepareRecruitmentRecord(await detail(fixture), now);
  assert.equal(record.deadlineAt, null);
  assert.equal(record.recruitmentEvidence.openingStatus, "unknown");
  assert.ok(
    !record.sourceEvidence.some(
      (row) => row.field === "deadlineAt" && row.status === "verified",
    ),
  );
});

test("HPU an already expired body deadline remains expired despite active ticket signup", async () => {
  const fixture = replay({
    detail: altered(({ data }) => {
      data.content = data.content.replace("2026年10月31日", "2026年9月1日");
      data.sign_up_type = 1;
      data.sign_up_end_time = "2027-12-31 17:00:00";
      data.is_overdue = false;
    }),
  });
  assert.equal(
    prepareRecruitmentRecord(await detail(fixture), now).recruitmentEvidence
      .openingStatus,
    "expired",
  );
});

test("HPU missing or invalid publication remains unknown and never borrows the graduation year or homepage mark", async () => {
  for (const value of ["", "待提供", "2026年2月30日", null]) {
    const fixture = replay({
      detail: altered(({ data }) => {
        data.create_time = value;
      }),
    });
    assert.equal((await detail(fixture)).publishedAt, null);
  }
});

test("HPU native docs and content attachment links are public metadata only, deduplicated and never extracted", async () => {
  const fixture = replay({
    detail: altered(({ data }) => {
      data.docs = [
        {
          doc_id: 7,
          doc_name: "合成岗位附件",
          doc_url: "/uploads/synthetic-positions.xlsx",
        },
        {
          doc_id: 8,
          doc_name: "合成私网附件",
          doc_url: "http://127.0.0.1/private.pdf",
        },
        {
          doc_id: 9,
          doc_name: "合成授权附件",
          doc_url: "https://example.org/file.pdf?token=synthetic",
        },
        {
          unknown_name: "未经证据支持的字段",
          unknown_url: "https://example.org/unknown.docx",
        },
      ];
      data.file_name_url = "https://example.org/ignored-file.docx";
      data.content_source_url = "https://example.org/ignored-republication";
      data.content +=
        '<p><a href="/uploads/synthetic-positions.xlsx">合成岗位附件</a></p>';
    }),
  });
  const record = await detail(fixture);
  assert.deepEqual(record.attachments, [
    {
      url: listUrl + "uploads/synthetic-positions.xlsx",
      title: "合成岗位附件",
      textStatus: "not_extracted",
    },
  ]);
  assert.ok(
    !record.sourceEvidence.some(
      (row) => row.value === listUrl + "uploads/synthetic-positions.xlsx",
    ),
  );
  assert.deepEqual(
    fixture.requests.map((row) => row.url),
    [listUrl, apiUrl],
  );
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU body links and table evidence exclude explicitly hidden data and page chrome", async () => {
  const fixture = replay({
    detail: altered(({ data }) => {
      data.content +=
        '<nav>页面导航与版权信息 招聘条件 报名截止2027年1月1日 <a href="https://example.org/navigation">投递</a></nav><div aria-hidden=" TRUE "><p>报名网站 https://example.org/hidden</p><table><tr><td>隐藏岗位</td></tr></table></div><footer>页脚投递入口</footer>';
    }),
  });
  const record = await detail(fixture);
  assert.ok(!record.description.includes("页面导航"));
  assert.ok(!record.description.includes("隐藏岗位"));
  assert.ok(!record.description.includes("页脚投递"));
  assert.equal(
    record.evidence.filter((row) => row.source === "native_notice_table")
      .length,
    1,
  );
  assert.equal(record.applyUrl, "https://webhr.shccig.com/webhrN2-zp");
  assert.equal(
    prepareRecruitmentRecord(record, now).deadlineAt,
    "2026-10-31T15:59:59.999Z",
  );
});

test("HPU catalog candidate flags and single-page coverage are unchanged; page two makes no request", async () => {
  const fixture = replay();
  await detail(fixture);
  const before = fixture.requests.length;
  const page = await collectHpuPublicNotices(fixture.site, 2, fixture.context);
  assert.deepEqual(page.records, []);
  assert.equal(page.coverageScope, "limited");
  assert.equal(page.nextCursor, null);
  assert.equal(fixture.requests.length, before);
  assert.equal(fixture.site.status, "candidate");
  assert.equal(fixture.site.verifiedAt, null);
  assert.equal(fixture.site.adapterVerification, "unverified");
  assert.equal(fixture.site.templateEvidence.requiresLiveProbe, true);
});

test("HPU the real public catalog identity can use the native contract without invented site sourceId or origin spelling", async () => {
  const fixture = replay();
  const catalogSite = loadSiteCatalog().find((site) => site.siteId === siteId);
  fixture.site = { ...catalogSite, template: fixture.site.template };
  const { record } = await listRecord(fixture);
  const fetched = await fetchHpuPublicNotice(
    fixture.site,
    record,
    fixture.context,
  );
  assert.equal(fetched.detailStatus, "complete");
  assert.equal(catalogSite.sourceId, undefined);
  assert.equal(catalogSite.origin, "https://hpu.bysjy.com.cn");
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU native template availability is a strict boolean contract for source validation", () => {
  const fixture = replay();
  assert.equal(hpuAdapter.isHpuPublicTemplateConfigured?.(fixture.site), true);
  for (const change of [
    (site) => {
      site.siteId = "another-site";
    },
    (site) => {
      site.providerId = "another-provider";
    },
    (site) => {
      site.origin = "https://example.org";
    },
    (site) => {
      site.template.nativePortal = "another-portal";
    },
    (site) => {
      site.template.listUrl += "?page=2";
    },
    (site) => {
      site.template.recordKind = "job";
    },
  ]) {
    const site = structuredClone(fixture.site);
    change(site);
    assert.equal(hpuAdapter.isHpuPublicTemplateConfigured?.(site), false);
  }
  assert.equal(hpuAdapter.isHpuPublicTemplateConfigured?.(null), false);
  assert.equal(hpuAdapter.isHpuPublicTemplateConfigured?.({}), false);
});

for (const [name, change] of [
  [
    "site ID",
    (site) => {
      site.siteId = "other-site";
    },
  ],
  [
    "provider ID",
    (site) => {
      site.providerId = "other-source";
    },
  ],
  [
    "origin",
    (site) => {
      site.origin = "https://example.org/";
    },
  ],
  [
    "list origin",
    (site) => {
      site.template.listUrl = "https://example.org/";
    },
  ],
  [
    "list query",
    (site) => {
      site.template.listUrl += "?session=synthetic";
    },
  ],
  [
    "portal contract",
    (site) => {
      site.template.nativePortal = "other-native-contract";
    },
  ],
  [
    "record kind",
    (site) => {
      site.template.recordKind = "job";
    },
  ],
]) {
  test(`HPU rejects unbound ${name} before any fixture request`, async () => {
    const fixture = replay();
    change(fixture.site);
    await assert.rejects(
      collectHpuPublicNotices(fixture.site, 1, fixture.context),
      { code: "template_not_configured" },
    );
    assert.deepEqual(fixture.requests, []);
  });
}

for (const [name, change] of [
  [
    "source",
    (record) => {
      record.sourceId = "other-source";
    },
  ],
  [
    "site",
    (record) => {
      record.siteId = "other-site";
    },
  ],
  [
    "scope",
    (record) => {
      record.identityScope = "other-scope";
    },
  ],
  [
    "kind",
    (record) => {
      record.kind = "job";
    },
  ],
  [
    "native ID",
    (record) => {
      record.sourceRecordId = "1839024";
    },
  ],
  [
    "authority",
    (record) => {
      record.sourceRecordIdKind = "hint";
    },
  ],
  [
    "URL origin",
    (record) => {
      record.url = "https://example.org/detail/news?id=1839023";
    },
  ],
  [
    "duplicate ID",
    (record) => {
      record.url += "&id=1839023";
    },
  ],
  [
    "additional query",
    (record) => {
      record.url += "&session=synthetic";
    },
  ],
  [
    "URL path",
    (record) => {
      record.url = listUrl + "detail/getnoticedetail?notice_id=1839023";
    },
  ],
  [
    "empty title",
    (record) => {
      record.title = "";
    },
  ],
]) {
  test(`HPU rejects unbound record ${name} before detail request`, async () => {
    const fixture = replay();
    const { record } = await listRecord(fixture);
    change(record);
    await assert.rejects(
      fetchHpuPublicNotice(fixture.site, record, fixture.context),
      { code: "detail_identity_mismatch" },
    );
    assert.deepEqual(
      fixture.requests.map((row) => row.url),
      [listUrl],
    );
    assert.deepEqual(fixture.fixtureErrors, []);
  });
}

for (const [name, payload, code] of [
  [
    "wrong native ID",
    altered(({ data }) => {
      data.notice_id = 1839024;
    }),
    "detail_identity_mismatch",
  ],
  [
    "unsafe native ID",
    altered(({ data }) => {
      data.notice_id = 9007199254740992;
    }),
    "detail_identity_mismatch",
  ],
  [
    "string native ID",
    altered(({ data }) => {
      data.notice_id = "1839023";
    }),
    "detail_identity_mismatch",
  ],
  [
    "wrong title",
    altered(({ data }) => {
      data.notice_name = "合成另一公司招聘公告";
    }),
    "detail_title_mismatch",
  ],
  ["missing data", JSON.stringify({ code: 1 }), "parse_error"],
  [
    "failed API code",
    altered((body) => {
      body.code = 0;
    }),
    "parse_error",
  ],
  [
    "string API code",
    altered((body) => {
      body.code = "1";
    }),
    "parse_error",
  ],
  [
    "HTML shell",
    "<html><body>招聘公告导航与脚本外壳</body></html>",
    "parse_error",
  ],
  ["invalid JSON", "{invalid JSON", "parse_error"],
  [
    "empty content",
    altered(({ data }) => {
      data.content = "";
    }),
    "detail_insufficient",
  ],
  [
    "short content",
    altered(({ data }) => {
      data.content = "<p>招聘公告</p>";
    }),
    "detail_insufficient",
  ],
  [
    "content shell",
    altered(({ data }) => {
      data.content =
        "<html><body><nav>招聘岗位报名导航内容足够长但不是公告正文。</nav></body></html>";
    }),
    "parse_error",
  ],
  [
    "template content",
    altered(({ data }) => {
      data.content = "<p>{{notice.content}} 招聘岗位正文加载中</p>";
    }),
    "detail_insufficient",
  ],
  [
    "hidden-only content",
    altered(({ data }) => {
      data.content =
        '<div style="display: /* synthetic */ none">' + data.content + "</div>";
    }),
    "detail_insufficient",
  ],
  [
    "navigation-only content",
    altered(({ data }) => {
      data.content = "<nav>" + data.content + "</nav>";
    }),
    "detail_insufficient",
  ],
  [
    "login content",
    altered(({ data }) => {
      data.content =
        '<form><input type="password"><p>请先登录后查看公告</p></form>';
    }),
    "restricted",
  ],
  [
    "late challenge content",
    altered(({ data }) => {
      data.content += '<p>请先完成人机验证</p><input name="captcha">';
    }),
    "captcha",
  ],
]) {
  test(`HPU rejects ${name} instead of verifying a notice body`, async () => {
    const fixture = replay({ detail: payload });
    await assert.rejects(detail(fixture), { code });
    assert.deepEqual(
      fixture.requests.map((row) => row.url),
      [listUrl, apiUrl],
    );
    assert.deepEqual(fixture.fixtureErrors, []);
  });
}

for (const [name, status, content, code] of [
  ["HTTP forbidden", 403, "<p>Access denied</p>", "restricted"],
  ["HTTP failure", 500, "<p>Service unavailable</p>", "unavailable"],
  [
    "HTML challenge",
    200,
    "<html><head><title>安全验证</title></head><body>请完成人机验证</body></html>",
    "captcha",
  ],
  [
    "HTML login",
    200,
    '<html><body><form><input type="password"><p>请先登录</p></form></body></html>',
    "restricted",
  ],
]) {
  test(`HPU rejects ${name} at the response boundary`, async () => {
    const fixture = replay({ status, detail: content });
    await assert.rejects(detail(fixture), { code });
    assert.deepEqual(
      fixture.requests.map((row) => row.url),
      [listUrl, apiUrl],
    );
  });
}

test("HPU requires visible native title and rejects title attribute disagreement", async () => {
  const fixture = replay({
    list: read("list.html").replaceAll(
      'title="合成矿业2027年度高校毕业生招聘简章"',
      'title="合成不同公告招聘简章"',
    ),
  });
  const page = await collectHpuPublicNotices(fixture.site, 1, fixture.context);
  assert.deepEqual(page.records, []);
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU request cancellation is propagated without a parsed success", async () => {
  const fixture = replay();
  const controller = new AbortController();
  fixture.context.signal = controller.signal;
  const { record } = await listRecord(fixture);
  controller.abort();
  fixture.context.request = async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    options.signal.throwIfAborted();
    assert.fail("Aborted fixture must not return a response");
  };
  await assert.rejects(
    fetchHpuPublicNotice(fixture.site, record, fixture.context),
    { name: "AbortError" },
  );
});

for (const responseUrl of [
  "https://example.org/detail/getnoticedetail?notice_id=1839023",
  listUrl + "detail/getnoticedetail?notice_id=1839024",
  apiUrl + "&notice_id=1839023",
]) {
  test(`HPU response URL cannot silently change its native authority (${new URL(responseUrl).origin})`, async () => {
    const fixture = replay({ responseUrl });
    await assert.rejects(detail(fixture), { code: "detail_identity_mismatch" });
    assert.deepEqual(
      fixture.requests.map((row) => row.url),
      [listUrl, apiUrl],
    );
    assert.deepEqual(fixture.fixtureErrors, []);
  });
}

test("HPU retained announcement proof never converts a fresh candidate URL into an available application", async () => {
  const fixture = replay();
  const { record } = await listRecord(fixture);
  record.applicationVerification = {
    checkedAt: new Date(now).toISOString(),
    status: 200,
    formVerified: true,
  };
  record.applyUrl = "https://example.org/old-apply";
  const fresh = prepareRecruitmentRecord(
    await fetchHpuPublicNotice(fixture.site, record, fixture.context),
    now,
  );
  assert.equal(fresh.applyUrl, "https://webhr.shccig.com/webhrN2-zp");
  assert.equal(fresh.applicationVerification, undefined);
  assert.equal(fresh.recruitmentEvidence.applicationStatus, "unknown");
});

test("HPU conflicting titles for one native notice ID do not select an arbitrary first row", async () => {
  const { document } = parseHTML(read("list.html"));
  const anchor = document.querySelector('a[href="/detail/news?id=1839023"]');
  assert.ok(
    anchor,
    "The second native-ID anchor must exist in the reduced fixture",
  );
  anchor.setAttribute("title", "合成另一个招聘简章");
  anchor.querySelector("span.content-txt").textContent = "合成另一个招聘简章";
  const fixture = replay({ list: document.toString() });
  assert.deepEqual(
    (await collectHpuPublicNotices(fixture.site, 1, fixture.context)).records,
    [],
  );
  assert.deepEqual(fixture.fixtureErrors, []);
});

test("HPU foreign cursors and invalid page numbers are rejected before requests", async () => {
  for (const page of [0, -1, 1.5, NaN]) {
    const fixture = replay();
    await assert.rejects(
      collectHpuPublicNotices(fixture.site, page, fixture.context),
      { code: "pagination_scope" },
    );
    assert.deepEqual(fixture.requests, []);
  }
  const fixture = replay();
  fixture.context.cursor = { url: "https://example.org/" };
  await assert.rejects(
    collectHpuPublicNotices(fixture.site, 1, fixture.context),
    { code: "pagination_scope" },
  );
  assert.deepEqual(fixture.requests, []);
});

test("HPU cancellation after an injected transport response does not return a parsed success", async () => {
  const fixture = replay();
  const { record } = await listRecord(fixture);
  const controller = new AbortController();
  fixture.context.signal = controller.signal;
  fixture.context.request = async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort();
    return { status: 200, text: read("detail.json"), headers: {} };
  };
  await assert.rejects(
    fetchHpuPublicNotice(fixture.site, record, fixture.context),
    { name: "AbortError" },
  );
});
