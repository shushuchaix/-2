import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { evalInlinePayload } from "../../src/util/html.mjs";
test("inline remote data cannot execute an assignment", () => {
  delete globalThis.__rjrDesignProbe;
  assert.equal(
    evalInlinePayload(
      "<script>window.__NUXT__=(function(){globalThis.__rjrDesignProbe=true;return {ok:true};}())</script>",
      "__NUXT__",
    ),
    null,
  );
  assert.equal(globalThis.__rjrDesignProbe, undefined);
});
test("static payload parses bound literals and rejects active syntax and limits", async () => {
  const { parseStaticPayload } = await import(
    "../../src/util/static-payload.mjs"
  );
  assert.deepEqual(
    parseStaticPayload(
      fs.readFileSync(
        new URL("../fixtures/payloads/bound-iife.txt", import.meta.url),
        "utf8",
      ),
    ),
    { title: "工程师", data: [null] },
  );
  assert.deepEqual(
    parseStaticPayload(
      '(function(a,b){return {title:a,list:[b]};})("工程师",null)',
    ),
    { title: "工程师", list: [null] },
  );
  for (const input of [
    "process.env",
    "({get x(){return 1}})",
    "({__proto__:{x:1}})",
    "({constructor:1})",
    'import("node:fs")',
    "(function(a){a.x=1;return a})({})",
    '(()=>fetch("https://x.example"))()',
    "(function(){return Object.create(null)})()",
  ])
    assert.throws(() => parseStaticPayload(input));
  assert.throws(
    () => parseStaticPayload("[[[[[[0]]]]]]", { maxDepth: 3 }),
    /limit|depth/i,
  );
  assert.throws(() => parseStaticPayload("[1,2]", { maxNodes: 2 }), /limit/i);
  assert.throws(() => parseStaticPayload('{"x":1}', { maxBytes: 2 }), /limit/i);
  assert.deepEqual(
    evalInlinePayload(
      '<script>window.__NUXT__={"data":[1]};</script>',
      "__NUXT__",
    ),
    { data: [1] },
  );
});
