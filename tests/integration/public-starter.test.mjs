import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";
test("public starter listens and exposes guarded workspace API", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rjr-starter-")),
    reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const child = spawn(process.execPath, ["src/start-public.mjs"], {
    env: {
      ...process.env,
      RJR_DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      AUTH_PASSWORD: "synthetic-starter-password",
      TRUST_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (x) => (output += x));
  child.stderr.on("data", (x) => (output += x));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const origin = "http://127.0.0.1:" + port;
  allowLocalOrigin(origin);
  let response, health;
  for (let i = 0; i < 50; i++) {
    try {
      response = await fetch(origin + "/api/health", {
        signal: AbortSignal.timeout(2000),
      });
      health = await response.json();
      if (health.status === "ready" || health.status === "maintenance") break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(response?.status, 200, output);
  assert.equal(health?.status, "ready", output);
  assert.equal(health.ok, true);
  assert.equal(health.authRequired, true);
  assert.equal((await fetch(origin + "/api/v2/jobs")).status, 401);
});
