import test from "node:test";
import assert from "node:assert/strict";
import ncss from "../../src/sources/adapters/ncss.mjs";
import job91 from "../../src/sources/adapters/university-91job.mjs";
const context = (site, request) => ({
  runId: "r",
  sites: [site],
  queries: [{ keyword: "工程", pageLimit: 1 }],
  targetSnapshot: { cities: [] },
  request,
  clock: { now: Date.now },
  onBatch: async () => {},
});
test("NCSS notices and 91job school scopes preserve factual kind and requirements", async () => {
  const r = await ncss.collect(
    context({ siteId: "ncss" }, async (url) => ({
      status: 200,
      headers: {},
      text: JSON.stringify({
        flag: true,
        data: {
          list: [
            {
              jobId: "notice-1",
              jobName: "2027校园招聘公告",
              recName: "合成公司",
              recruitType: "1",
            },
          ],
          pagenation: { total: 1 },
        },
      }),
      url,
    })),
  );
  assert.equal(r.records[0].kind, "recruitment_notice");
  const request = async (url, opts) => {
    assert.equal(
      opts.headers["Content-Type"],
      "application/json;charset=utf-8",
    );
    const body = JSON.parse(opts.body);
    return {
      status: 200,
      headers: {},
      url,
      text: JSON.stringify({
        success: true,
        code: 200,
        result: {
          total: 100,
          pages: 5,
          records: [
            {
              zpgwid: "1",
              zwmc: "工程岗位",
              dwmc: "合成公司",
              sqxxdm: body.xxdm,
              zwms: JSON.stringify({ rzzg: "合成的工程岗位要求" }),
            },
          ],
        },
      }),
    };
  };
  const seu = await job91.collect(
    context(
      { siteId: "seu", origin: "https://seu.91job.org.cn", tenantId: "10286" },
      request,
    ),
  );
  const hhu = await job91.collect(
    context(
      { siteId: "hhu", origin: "https://hhu.91job.org.cn", tenantId: "10294" },
      request,
    ),
  );
  assert.notEqual(seu.records[0].identityScope, hhu.records[0].identityScope);
  assert.equal(seu.records[0].description, "合成的工程岗位要求");
  assert.equal(seu.coverage[0].truncated, true);
});
test("business errors, missing identity and normal empty results differ", async () => {
  const site = {
    siteId: "seu",
    origin: "https://seu.91job.org.cn",
    tenantId: "10286",
  };
  const run = (body) =>
    job91.collect(
      context(site, async () => ({
        status: 200,
        headers: {},
        text: JSON.stringify(body),
      })),
    );
  assert.equal(
    (await run({ success: false, code: 403 })).issues[0].code,
    "restricted",
  );
  assert.equal(
    (
      await run({
        success: true,
        code: 200,
        result: { records: [], pages: 0, total: 0 },
      })
    ).coverage[0].status,
    "complete",
  );
  assert.equal(
    (
      await run({
        success: true,
        code: 200,
        result: { records: [{ zwmc: "缺ID" }] },
      })
    ).issues[0].code,
    "invalid_record",
  );
});
test("91job notices have a separate identity and factual notice kind", async () => {
  const ctx = context(
    { siteId: "seu", origin: "https://seu.91job.org.cn", tenantId: "10286" },
    async (url) => {
      assert.ok(url.includes("getZpggPageList"));
      return {
        status: 200,
        text: JSON.stringify({
          success: true,
          code: 200,
          result: {
            records: [
              {
                zpggid: "notice-1",
                zpggbt: "校园招聘公告",
                fbsj: "2026-09-01",
              },
            ],
            pages: 1,
          },
        }),
      };
    },
  );
  ctx.queries[0].kind = "recruitment_notice";
  const r = await job91.collect(ctx);
  assert.equal(r.records[0].kind, "recruitment_notice");
  assert.equal(r.records[0].sourceRecordId, "notice:notice-1");
});
