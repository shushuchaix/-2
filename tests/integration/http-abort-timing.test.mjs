import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("../fixtures/http-abort-timing.mjs", import.meta.url),
);
const guard = new URL("../helpers/network-guard.mjs", import.meta.url).href;
for (const mode of ["dns", "budget", "timeout"]) {
  test(`cancellation during ${mode} consumes created rejections and starts no transport`, () => {
    const child = spawnSync(
      process.execPath,
      ["--import", guard, fixture, mode],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(
      result.unhandled,
      0,
      "created DNS/transport promises must have a rejection handler",
    );
    assert.equal(
      result.transport,
      0,
      "a cancellation after reservation must not start transport",
    );
    assert.equal(result.claims, mode === "dns" ? 0 : 1);
    assert.equal(
      result.settlements,
      0,
      "uncertain reservations remain charged",
    );
    if (mode === "timeout") assert.equal(result.errorName, "TimeoutError");
    else assert.equal(result.reasonPreserved, true);
  });
}
