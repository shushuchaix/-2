import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDesktopBackend } from "../../electron/backend/host.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cache = path.join(root, ".cache");

for (const scenario of ["source", "packaged-resources", "packaged-fallback"])
  test(`utility process starts from a physical directory: ${scenario}`, async () => {
    fs.mkdirSync(cache, { recursive: true });
    const fixtureRoot = fs.mkdtempSync(path.join(cache, "desktop-backend-cwd-"));
    const source = path.join(fixtureRoot, "source");
    const resources = path.join(fixtureRoot, "resources");
    fs.mkdirSync(source);
    fs.mkdirSync(resources);
    const archive = path.join(resources, "app.asar");
    fs.writeFileSync(archive, "synthetic ASAR path; deliberately a file");
    const packaged = scenario !== "source";
    const appRoot = packaged ? archive : source;
    const expectedCwd = packaged ? resources : source;
    const fixture = collectionBrowserFixture();
    const child = new EventEmitter();
    child.kill = () => true;
    child.postMessage = () => assert.fail("unexpected RPC during construction");
    let captured;
    let backend;
    try {
      backend = createDesktopBackend({
        utilityProcess: {
          fork(entry, args, options) {
            captured = { entry, args, options };
            // An actual OS child rejects a file used as cwd, matching the
            // pre-entry packaged failure that an EventEmitter-only fake misses.
            captured.process = spawnSync(
              process.execPath,
              ["-e", "process.stdout.write(JSON.stringify({cwd:process.cwd(),appRoot:process.env.RJR_BACKEND_APP_ROOT,resourcesRoot:process.env.RJR_BACKEND_RESOURCES_ROOT,packaged:process.env.RJR_BACKEND_PACKAGED,selfTest:process.env.RJR_BACKEND_SELF_TEST,credentials:process.env.RJR_DISABLE_LOCAL_CREDENTIALS,dataDir:process.env.RJR_DATA_DIR}))"],
              { cwd: options.cwd, env: options.env, encoding: "utf8", windowsHide: true },
            );
            return child;
          },
        },
        ...fixture,
        sessionStore: {},
        credentialService: {},
        appRoot,
        ...(scenario === "packaged-fallback" ? {} : { resourcesRoot: resources }),
        dataDir: path.join(fixtureRoot, "synthetic-data"),
        packaged,
        selfTest: false,
      });
      assert.equal(captured.process.error?.code, undefined);
      assert.equal(captured.process.status, 0, captured.process.stderr);
      const actual = JSON.parse(captured.process.stdout);
      assert.equal(path.resolve(actual.cwd), path.resolve(expectedCwd));
      assert.equal(actual.appRoot, appRoot);
      assert.equal(actual.resourcesRoot, scenario === "packaged-fallback" ? "" : resources);
      assert.equal(actual.packaged, packaged ? "1" : "0");
      assert.equal(actual.selfTest, "0");
      assert.equal(actual.credentials, process.env.RJR_DISABLE_LOCAL_CREDENTIALS || "0");
      assert.equal(actual.dataDir, path.join(fixtureRoot, "synthetic-data"));
      assert.equal(captured.entry, fileURLToPath(new URL("../../electron/backend/entry.cjs", import.meta.url)));
      assert.deepEqual(captured.args, []);
      assert.equal(captured.options.stdio, "pipe");
      assert.equal(captured.options.serviceName, "Resume Job Radar Backend");
      assert.equal(fixture.windows.length, 0);
    } finally {
      child.emit("exit", 0);
      await backend?.close();
      assert.equal(path.dirname(fixtureRoot), cache);
      assert.match(path.basename(fixtureRoot), /^desktop-backend-cwd-/);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
