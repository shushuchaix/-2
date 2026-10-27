import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_NODE_RANGE,
  isSupportedNodeVersion,
  assertSupportedNodeRuntime,
} from "../../src/infrastructure/runtime/requirements.mjs";

test("runtime accepts the verified 24.16 baseline and later stable 24.x releases", () => {
  for (const version of [
    "24.16.0",
    "v24.16.0",
    "24.16.1",
    "24.21.0",
    "24.100.0",
    "24.16.0+local.1",
  ]) {
    assert.equal(isSupportedNodeVersion(version), true, version);
    assert.doesNotThrow(() => assertSupportedNodeRuntime(version), version);
  }
  assert.doesNotThrow(() => assertSupportedNodeRuntime());
});

test("runtime rejects unsupported majors, older 24.x, prereleases and malformed versions", () => {
  for (const version of [
    "20.20.2",
    "22.22.0",
    "24.15.999",
    "25.0.0",
    "26.0.0",
    "24.16.0-rc.1",
    "24.16",
    "024.16.0",
    "24.016.0",
    "24.16.0\n",
    "24.16.0+",
    "999999999999999999999.16.0",
    "",
    null,
    {},
    24,
  ]) {
    assert.equal(isSupportedNodeVersion(version), false, String(version));
    assert.throws(
      () => assertSupportedNodeRuntime(version),
      (error) =>
        error.code === "runtime_unsupported" &&
        error.requiredNode === SUPPORTED_NODE_RANGE &&
        error.message.includes("至少 24.16.0") &&
        error.message.includes("低于 25"),
      String(version),
    );
  }
});

test("runtime error prints only a valid version instead of arbitrary supplied text", () => {
  assert.throws(() => assertSupportedNodeRuntime("20.20.2"), {
    code: "runtime_unsupported",
    message: /Node\.js 20\.20\.2/,
  });
  assert.throws(
    () => assertSupportedNodeRuntime("invalid private detail"),
    (error) =>
      error.message.includes("未知版本") && !error.message.includes("private"),
  );
});
