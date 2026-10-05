import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createTempDir } from "../helpers/fixtures.mjs";
import { allowLocalOrigin } from "../helpers/network-guard.mjs";
test("public starter listens and exposes guarded workspace API", async (t) => {
  const dataDir = await createTempDir(t),
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
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
  });
  const origin = "http://127.0.0.1:" + port;
  allowLocalOrigin(origin);
  let response;
  for (let i = 0; i < 50; i++) {
    try {
      response = await fetch(origin + "/api/health");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.equal(response?.status, 200, output);
  assert.equal((await response.json()).ok, true);
  assert.equal((await fetch(origin + "/api/v2/jobs")).status, 401);
});
