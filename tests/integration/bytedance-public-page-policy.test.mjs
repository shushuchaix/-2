import test from "node:test";
import assert from "node:assert/strict";
import { createPagePolicy } from "../../electron/collection/network-policy.mjs";
const api = "https://jobs.bytedance.com/api/v1/search/job/posts";
const route = {
  platform: "bytedance",
  nativePublicQuery: "消防",
  hosts: ["jobs.bytedance.com", "lf-package-cn.feishucdn.com"],
  strictPath: true,
  publicPath: (u) =>
    u.hostname === "jobs.bytedance.com" &&
    ["/campus/position", "/api/v1/search/job/posts"].includes(u.pathname),
};
const body = () => ({
  keyword: "消防",
  limit: 10,
  offset: 0,
  job_category_id_list: [],
  tag_id_list: [],
  location_code_list: [],
  subject_id_list: [],
  recruitment_id_list: ["201"],
  portal_type: 3,
  job_function_id_list: [],
  storefront_id_list: [],
  portal_entrance: 1,
});
function details(
  data = body(),
  url = api + "?_signature=native-public-signature",
) {
  return {
    url,
    method: "POST",
    resourceType: "xhr",
    webContentsId: 7,
    uploadData: [{ bytes: Buffer.from(JSON.stringify(data)) }],
  };
}
test("permits the exact native read-only campus search and accounts its real method", async () => {
  const seen = [];
  const policy = createPagePolicy({
    routePolicy: route,
    webContentsId: 7,
    reserve: async (d) => seen.push(d),
  });
  assert.deepEqual(await policy.authorize(details()), { cancel: false });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, details().url);
});
for (const [name, change] of Object.entries({
  resume: (d) => (d.profile = "private-marker"),
  privateQuery: (d) => (d.keyword = "private-marker"),
  anotherPage: (d) => (d.offset = 10),
  oversizedLimit: (d) => (d.limit = 100),
  noncampus: (d) => (d.portal_type = 2),
  changedFilter: (d) => (d.location_code_list = ["private-marker"]),
}))
  test("rejects " + name + " without reserving a request", async () => {
    let count = 0;
    const policy = createPagePolicy({
      routePolicy: route,
      reserve: async () => count++,
    });
    const b = body();
    change(b);
    assert.deepEqual(await policy.authorize(details(b)), { cancel: true });
    assert.equal(count, 0);
  });
for (const endpoint of [
  "/api/v1/job/application/create",
  "/api/v1/user/resume",
  "/api/v1/user/mobile/login",
  "/api/v1/search/job/posts?keyword=private-marker",
])
  test(
    "blocks other writes and mismatched signed query " + endpoint,
    async () => {
      let count = 0;
      const policy = createPagePolicy({
        routePolicy: route,
        reserve: async () => count++,
      });
      assert.deepEqual(
        await policy.authorize(
          details(body(), "https://jobs.bytedance.com" + endpoint),
        ),
        { cancel: true },
      );
      assert.equal(count, 0);
    },
  );
test("does not enable native public POST for a different platform or missing public query", async () => {
  for (const changed of [
    { ...route, platform: "other" },
    { ...route, nativePublicQuery: undefined },
    { ...route, nativePublicQuery: "private-marker" },
  ]) {
    const policy = createPagePolicy({
      routePolicy: changed,
      reserve: async () => {
        throw Error("must not reserve");
      },
    });
    assert.deepEqual(await policy.authorize(details()), { cancel: true });
  }
});
test("rejects uploads, duplicate query fields and authentication query markers", async () => {
  const policy = createPagePolicy({
    routePolicy: route,
    reserve: async () => {
      throw Error("must not reserve");
    },
  });
  for (const x of [
    { ...details(), uploadData: [{ file: "/private-file" }] },
    details(body(), api + "?keyword=消防&keyword=消防"),
    details(body(), api + "?token=private-marker"),
  ])
    assert.deepEqual(await policy.authorize(x), { cancel: true });
});
test("keeps ordinary public GET and request ceiling behavior", async () => {
  let count = 0;
  const policy = createPagePolicy({
    routePolicy: route,
    maxRequests: 1,
    reserve: async () => count++,
  });
  const d = {
    url: "https://jobs.bytedance.com/campus/position?keywords=消防&type=2&current=1&limit=10",
    method: "GET",
    resourceType: "mainFrame",
  };
  assert.deepEqual(await policy.authorize(d), { cancel: false });
  assert.deepEqual(await policy.authorize(d), { cancel: true });
  assert.equal(count, 1);
});
