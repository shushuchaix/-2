import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../src/config.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";

test("explicit proxy opt-out overrides a saved opt-in and hop counts must be bounded integers", async (t) => {
  const dataDir = await createTempDir(t);
  await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ server: { trustProxy: true } }));
  const names = ["TRUST_PROXY", "TRUST_PROXY_HOPS"], previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of names) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  process.env.TRUST_PROXY = "0"; process.env.TRUST_PROXY_HOPS = "1";
  assert.equal(loadConfig({ dataDir, quiet: true, readLocalCredentials: false }).server.trustProxy, false);
  process.env.TRUST_PROXY = "1"; process.env.TRUST_PROXY_HOPS = "2";
  const cfg = loadConfig({ dataDir, quiet: true, readLocalCredentials: false });
  assert.equal(cfg.server.trustProxy, true);
  assert.equal(cfg.server.trustedProxyHops, 2);
  for (const value of ["0", "11", "2.5", "garbage"]) {
    process.env.TRUST_PROXY_HOPS = value;
    assert.throws(() => loadConfig({ dataDir, quiet: true, readLocalCredentials: false }), /TRUST_PROXY_HOPS/);
  }
});

test("the offline switch prevents automatic local credential discovery", async (t) => {
  const dataDir = await createTempDir(t);
  await fs.writeFile(path.join(dataDir, "config.json"), "{}");
  await fs.writeFile(path.join(dataDir, ".credentials.yaml"), "DEEPSEEK_API_KEY: synthetic-dsh-credential-only\n");
  const names = ["DSH_HOME", "DEEPSEEK_API_KEY", "RJR_DISABLE_LOCAL_CREDENTIALS"], previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of names) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  process.env.DSH_HOME = dataDir;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.RJR_DISABLE_LOCAL_CREDENTIALS = "1";
  assert.equal(loadConfig({ dataDir, quiet: true }).deepseek.apiKey, "");
  delete process.env.RJR_DISABLE_LOCAL_CREDENTIALS;
  assert.equal(loadConfig({ dataDir, quiet: true, readLocalCredentials: false }).deepseek.apiKey, "");
  // Positive control stops at the isolated fake DSH home and never reads a real home.
  assert.equal(loadConfig({ dataDir, quiet: true }).deepseek.apiKey, "synthetic-dsh-credential-only");
});
