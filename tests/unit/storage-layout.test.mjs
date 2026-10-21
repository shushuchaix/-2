import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTempDir } from "../helpers/fixtures.mjs";
const load = () => import("../../src/infrastructure/storage/layout.mjs");
test("one resolved data root preserves authoritative files and creates current history and cache directories", async (t) => {
  const { resolveDataLayout, ensureDataLayout } = await load(),
    dataDir = await createTempDir(t),
    layout = resolveDataLayout(dataDir);
  assert.equal(layout.runs, path.join(dataDir, "runs-v2"));
  assert.equal(layout.workspace, path.join(dataDir, "workspace.v2.json"));
  assert.equal(layout.credentials, path.join(dataDir, "credentials.v2.json"));
  fs.writeFileSync(layout.workspace, "unchanged");
  ensureDataLayout(layout);
  assert.equal(fs.readFileSync(layout.workspace, "utf8"), "unchanged");
  assert.ok(fs.statSync(layout.cache).isDirectory());
});
test("only known valid old caches migrate atomically; new wins, corrupt old stays and failed write keeps source", async (t) => {
  const { resolveDataLayout, ensureDataLayout, migrateKnownCaches } =
      await load(),
    layout = resolveDataLayout(await createTempDir(t));
  ensureDataLayout(layout);
  const old = path.join(layout.root, "font-map.json"),
    current = path.join(layout.cache, "font-map.json"),
    data = { savedAt: "2026-10-08", map: { "\ue001": "甲" } };
  fs.writeFileSync(old, JSON.stringify(data));
  fs.mkdirSync(path.join(layout.root, "unknown"));
  fs.writeFileSync(path.join(layout.root, "unknown", "secret.json"), "leave");
  await migrateKnownCaches(layout);
  assert.deepEqual(JSON.parse(fs.readFileSync(current, "utf8")), data);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(layout.root, "unknown", "secret.json")));
  fs.writeFileSync(old, JSON.stringify({ ...data, map: { "\ue001": "乙" } }));
  await migrateKnownCaches(layout);
  assert.deepEqual(JSON.parse(fs.readFileSync(current, "utf8")), data);
  const hosts = path.join(layout.root, "university-hosts.json");
  fs.writeFileSync(hosts, "broken");
  await migrateKnownCaches(layout);
  assert.equal(fs.readFileSync(hosts, "utf8"), "broken");
  fs.writeFileSync(
    hosts,
    JSON.stringify({ 合成学校: { host: "", v: 3, probedAt: "2026-10-08" } }),
  );
  await migrateKnownCaches(layout, {
    fsAdapter: {
      ...fs,
      renameSync() {
        throw Object.assign(Error("synthetic failure"), { code: "EIO" });
      },
      linkSync() {
        throw Object.assign(Error("synthetic failure"), { code: "EIO" });
      },
    },
  });
  assert.ok(fs.existsSync(hosts));
  assert.equal(
    fs.existsSync(path.join(layout.cache, "university-hosts.json")),
    false,
  );
  await migrateKnownCaches(layout);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(layout.cache, "university-hosts.json"), "utf8"),
    )["合成学校"].host,
    "",
  );
});
