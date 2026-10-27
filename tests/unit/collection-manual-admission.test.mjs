import test from "node:test";
import assert from "node:assert/strict";
import { createManualAdmission } from "../../electron/collection/manual-admission.mjs";

test("manual assets admit six per host without 300ms serialization, then wait for a physical completion", async () => {
  const controller = new AbortController(),
    admission = createManualAdmission({
      signal: controller.signal,
      allowance: { lastAt: Date.now() },
    });
  const asset = (id, host = "static.zhipin.com") => ({
    id,
    url: "https://" + host + "/asset.js",
    resourceType: "script",
    method: "GET",
  });
  try {
    const began = performance.now();
    await Promise.all(
      Array.from({ length: 6 }, (_, id) => admission.admit(asset(id))),
    );
    assert.ok(performance.now() - began < 150);
    let seventh = false;
    const waiting = admission.admit(asset(6)).then(() => {
      seventh = true;
    });
    await admission.admit(asset(7, "img.bosszhipin.com"));
    await new Promise(setImmediate);
    assert.equal(seventh, false);
    admission.release(asset(0));
    await waiting;
    assert.equal(seventh, true);
    assert.equal(admission.snapshot().active, 7);
  } finally {
    admission.close();
  }
});

test("manual auth requests preserve pacing and queued asset admission aborts on window revocation", async () => {
  const controller = new AbortController(),
    allowance = { lastAt: Date.now() },
    admission = createManualAdmission({
      signal: controller.signal,
      allowance,
      perHost: 1,
    });
  const asset = (id) => ({
    id,
    url: "https://static.zhipin.com/asset.css",
    resourceType: "stylesheet",
  });
  try {
    await admission.admit(asset(1));
    const task = admission.admit(asset(2));
    controller.abort();
    await assert.rejects(task, { code: "collection_cancelled" });
    assert.equal(admission.snapshot().queued, 0);
  } finally {
    admission.close();
  }
  const second = createManualAdmission({ allowance: { lastAt: Date.now() } });
  const began = performance.now();
  await second.admit({
    id: 3,
    url: "https://www.zhipin.com/wapi/zppassport/status",
    resourceType: "xhr",
  });
  assert.ok(performance.now() - began >= 270);
  second.close();
});
