import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { drainArchiveWrite } from "../../tools/lib/archive-write.mjs";

test("archive creation waits for the returned stream to finish its delayed disk writes", async () => {
  let release,
    completed = false;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      release = callback;
    },
  });
  output.end("tail");
  const pending = drainArchiveWrite(Promise.resolve(output)).then(() => {
    completed = true;
  });
  await new Promise(setImmediate);
  assert.equal(completed, false);
  release();
  await pending;
  assert.equal(output.writableFinished, true);
});

test("archive creation rejects a late write error instead of verifying a partial file", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() =>
        callback(Object.assign(Error("disk failure"), { code: "EIO" })),
      );
    },
  });
  output.end("tail");
  await assert.rejects(drainArchiveWrite(Promise.resolve(output)), {
    code: "EIO",
  });
});

test("archive creation also accepts newer packers that drain internally", async () => {
  await drainArchiveWrite(Promise.resolve());
});
