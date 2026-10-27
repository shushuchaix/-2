import test from "node:test";
import assert from "node:assert/strict";
import * as zhaopin from "../../src/sources/zhaopin.mjs";
import * as shixiseng from "../../src/sources/shixiseng.mjs";
import * as jiuyeqiao from "../../src/sources/jiuyeqiao.mjs";
import { withSourceContext } from "../../src/sources/request-context.mjs";
import { createLegacyProvider } from "../../src/sources/adapters/legacy.mjs";
import { diagnosticError } from "../../src/infrastructure/diagnostics/log.mjs";

const privateMessage =
  "resume-private-content https://user:private-token@example.invalid/?phone=private-contact";
const sources = { zhaopin, shixiseng, jiuyeqiao };
const failures = [
  { name: "TimeoutError", issue: "request_timeout" },
  { code: "ECONNRESET", issue: "network_error" },
  { code: "CERT_HAS_EXPIRED", issue: "tls_certificate_expired" },
];

function requestFailure(fields) {
  return Object.assign(Error(privateMessage), fields, {
    url: "https://user:private-token@example.invalid",
    headers: { authorization: "Bearer private-token" },
    profile: "resume-private-content",
  });
}
function collectModule(id, options = {}) {
  const module = sources[id];
  const input = {
    keyword: "消防",
    keywords: ["消防"],
    maxPages: 1,
    maxDetail: 0,
    delayMs: 0,
    ...options,
  };
  return id === "jiuyeqiao" ? module.collect(input) : module.search(input);
}

for (const id of Object.keys(sources)) {
  for (const fields of failures) {
    test(`${id} preserves safe ${fields.code || fields.name} beside string errors and into diagnostics`, async () => {
      const request = async () => {
        throw requestFailure(fields);
      };
      const direct = await withSourceContext({ request }, () =>
        collectModule(id),
      );
      assert.equal(direct.errors.length, 1);
      assert.equal(typeof direct.errors[0], "string");
      assert.deepEqual(direct.errorDetails, [
        {
          name: fields.name || "Error",
          ...(fields.code ? { code: fields.code } : {}),
        },
      ]);
      assert.equal(
        JSON.stringify(direct.errorDetails).includes("private"),
        false,
      );

      const logged = [];
      const result = await createLegacyProvider(id).collect({
        request,
        queries: [{ keyword: "消防", pageLimit: 1 }],
        sites: [{ siteId: `${id}-synthetic` }],
        reportError: async (error) => {
          logged.push(diagnosticError(error));
        },
      });
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].code, fields.issue);
      assert.equal(result.coverage[0].status, "failed");
      assert.equal(logged[0].name, fields.name || "Error");
      if (fields.code) assert.equal(logged[0].code, fields.code);
      assert.equal(
        JSON.stringify({ result, logged }).includes("private"),
        false,
      );
    });
  }
}

test("legacy detail diagnostics reject unknown fields and code without guessing private message", async () => {
  const logged = [];
  const result = await createLegacyProvider("zhaopin", {
    collector: async () => ({
      jobs: [],
      errors: [privateMessage + " HTTP 403"],
      errorDetails: [
        {
          name: "PrivateAccountName",
          code: "CERT_private-token",
          message: privateMessage,
          status: "403",
          cause: requestFailure({ code: "ECONNRESET" }),
          headers: { authorization: "Bearer private-token" },
        },
      ],
    }),
  }).collect({
    queries: [{ keyword: "消防" }],
    sites: [{ siteId: "zhaopin-synthetic" }],
    reportError: async (error) => logged.push(diagnosticError(error)),
  });
  assert.equal(result.issues[0].code, "unavailable");
  assert.equal(logged[0].name, "Error");
  assert.equal(logged[0].code, undefined);
  assert.equal(logged[0].status, undefined);
  assert.equal(JSON.stringify({ result, logged }).includes("private"), false);
});

for (const id of ["zhaopin", "shixiseng"]) {
  test(`${id} retains explicit native parse errors through structured diagnostics`, async () => {
    const request = async () => ({
      status: 200,
      headers: {},
      text: "<main>Public navigation</main>",
    });
    const direct = await withSourceContext({ request }, () =>
      collectModule(id),
    );
    assert.ok(Array.isArray(direct.errorDetails));
    assert.equal(direct.errorDetails[0].code, "parse_error");
    const result = await createLegacyProvider(id).collect({
      request,
      queries: [{ keyword: "消防", pageLimit: 1 }],
      sites: [{ siteId: `${id}-synthetic` }],
    });
    assert.equal(result.issues[0].code, "parse_error");
  });
}

for (const id of Object.keys(sources)) {
  test(`${id} retains exact HTTP status without original failure content`, async () => {
    const request = async () => ({
      status: 403,
      headers: {},
      text: privateMessage,
    });
    const direct = await withSourceContext({ request }, () =>
      collectModule(id),
    );
    assert.ok(Array.isArray(direct.errorDetails));
    assert.equal(direct.errorDetails[0].status, 403);
    const logged = [];
    const result = await createLegacyProvider(id).collect({
      request,
      queries: [{ keyword: "消防", pageLimit: 1 }],
      sites: [{ siteId: `${id}-synthetic` }],
      reportError: async (error) => logged.push(diagnosticError(error)),
    });
    assert.equal(result.issues[0].code, "http_forbidden");
    assert.equal(logged[0].status, 403);
    assert.equal(JSON.stringify({ result, logged }).includes("private"), false);
  });
}

test("Shixiseng detail transport failure remains a network error rather than insufficient body", async () => {
  const record = {
    sourceId: "shixiseng",
    siteId: "shixiseng-synthetic",
    sourceRecordId: "inn_synthetic",
    url: "https://www.shixiseng.com/intern/inn_synthetic",
    description: "previous body",
    detailStatus: "complete",
    bodyStatus: "complete",
  };
  const request = async () => {
    throw requestFailure({ code: "ECONNRESET" });
  };
  const direct = await withSourceContext({ request }, () =>
    shixiseng.fetchDetail(record),
  );
  assert.equal(typeof direct.error, "string");
  assert.deepEqual(direct.errorDetails, { name: "Error", code: "ECONNRESET" });
  await assert.rejects(
    createLegacyProvider("shixiseng").fetchDetail(record, { request }),
    (error) => {
      assert.equal(error.code, "ECONNRESET");
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );
});
