import test from "node:test";
import assert from "node:assert/strict";
import { decodeResponseText } from "../../src/infrastructure/http/text-decoding.mjs";

const gbRecruitment = Buffer.from("d5d0c6b8", "hex");
test("HTML without a HTTP charset reads GB2312 declared by the observed meta tag", () => {
  const data = Buffer.concat([
    Buffer.from(
      '<meta http-equiv="Content-Type" content="text/html; charset=gb2312"><a>',
    ),
    gbRecruitment,
    Buffer.from("</a>"),
  ]);
  assert.ok(decodeResponseText(data, "text/html").includes("<a>招聘</a>"));
});
test("quoted HTTP charset takes priority over a conflicting HTML declaration", () => {
  const data = Buffer.from('<meta charset="gb2312"><p>招聘</p>');
  assert.equal(
    decodeResponseText(data, 'text/html; charset="utf-8"'),
    data.toString("utf8"),
  );
});
test("a UTF8 BOM wins over an inconsistent server charset", () => {
  const data = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("招聘"),
  ]);
  assert.equal(decodeResponseText(data, "text/html; charset=gb2312"), "招聘");
});
test("JSON values and commented HTML metadata cannot switch the response encoding", () => {
  const json = Buffer.from('{"text":"<meta charset=gb2312>招聘"}');
  assert.equal(
    decodeResponseText(json, "application/json"),
    json.toString("utf8"),
  );
  const html = Buffer.from('<!-- <meta charset="gb2312"> --><p>招聘</p>');
  assert.equal(decodeResponseText(html, "text/html"), html.toString("utf8"));
});
test("unknown encodings retain UTF8 and metadata past the bounded prescan is ignored", () => {
  assert.equal(
    decodeResponseText(Buffer.from("招聘"), "text/html; charset=unknown-x"),
    "招聘",
  );
  const data = Buffer.from(" ".repeat(1024) + '<meta charset="gb2312">招聘');
  assert.equal(decodeResponseText(data, "text/html"), data.toString("utf8"));
});
