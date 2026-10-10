import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as asar from "@electron/asar";
import { apiFixture } from "../helpers/api-fixture.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const runtime = [
  "electron/main.mjs",
  "electron/preload.cjs",
  "electron/credentials.mjs",
  "electron/directories.mjs",
  "electron/self-test.mjs",
  "electron/self-test-network.mjs",
  "electron/self-test-boss.mjs",
  "electron/collection/boss-page.mjs",
  "electron/collection/browser.mjs",
  "electron/collection/sessions.mjs",
  "electron/collection/network-policy.mjs",
  "electron/collection/ipc.mjs",
  "src/sources/boss/protocol.mjs",
  "src/sources/boss/records.mjs",
  "src/sources/boss/cities.mjs",
  "src/sources/adapters/boss.mjs",
  "src/sources/adapters/shared.mjs",
  "src/sources/registry.mjs",
  "src/sources/planning.mjs",
  "src/sources/catalog.mjs",
  "src/sources/catalog/platforms.json",
  "src/application/content-read-service.mjs",
  "src/application/collection-service.mjs",
  "src/application/collection-ledger.mjs",
  "src/application/collection-refresh.mjs",
  "src/application/source-service.mjs",
  "src/application/workspace-operations.mjs",
  "src/application/package-runtime-service.mjs",
  "src/domain/collection.mjs",
  "src/llm/prompt-registry.mjs",
  "src/server.mjs",
  "src/config.mjs",
  "src/application/context.mjs",
  "src/application/run-service.mjs",
  "src/application/purge-service.mjs",
  "src/infrastructure/storage/repository.mjs",
  "src/infrastructure/storage/package-control.mjs",
  "src/infrastructure/storage/bootstrap-workspace.mjs",
  "src/infrastructure/diagnostics/log.mjs",
  "src/domain/ontology.json",
  "src/sources/catalog/universities.json",
  "public/login.html",
  "public/login.js",
  "public/style.css",
  "public/js/validation-rules.js",
  "public/js/diagnostic-rules.js",
  "public/js/version-management.js",
  "public/js/components/form-validation.js",
  "public/js/components/dom.js",
];

async function packageFixture(t) {
  const root = await createTempDir(t),
    stage = path.join(root, "stage"),
    archive = path.join(root, "synthetic.asar");
  const write = async (rel, body) => {
    const file = path.join(stage, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  };
  for (const file of runtime) {
    const body = file.endsWith(".json")
      ? "{}"
      : "/* synthetic runtime presence */";
    await write(file, body);
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  }
  const pkg = {
    name: "synthetic-build-fixture",
    main: "electron/main.mjs",
    type: "module",
    dependencies: { "synthetic-dependency": "1.0.0" },
  };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  await write("package.json", JSON.stringify(pkg));
  await write(
    "node_modules/synthetic-dependency/package.json",
    JSON.stringify({
      name: "synthetic-dependency",
      dependencies: { "synthetic-child": "1.0.0" },
    }),
  );
  await write(
    "node_modules/synthetic-child/package.json",
    JSON.stringify({ name: "synthetic-child" }),
  );
  await fs.cp(
    path.join(stage, "node_modules"),
    path.join(root, "node_modules"),
    { recursive: true },
  );
  await write(
    "public/app/index.html",
    '<div id="root"></div><script type="module" src="/app/assets/index.js"></script><link rel="modulepreload" href="/app/assets/chunk.js"><link rel="stylesheet" href="/app/assets/index.css">',
  );
  await write(
    "public/app/assets/index.js",
    'import { shared } from "./chunk.js"; console.log(shared);',
  );
  await write("public/app/assets/chunk.js", "export const shared = 1;");
  await write("public/app/assets/index.css", 'body {font-family: "Synthetic"}');
  const pack = () => asar.createPackage(stage, archive);
  const verify = () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {verifyPackageArchive} from './tools/verify-package.mjs'; verifyPackageArchive({archivePath:process.argv[1],root:process.argv[2]});",
        archive,
        root,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
  return { root, stage, archive, write, pack, verify };
}

test("production authentication serves the built root only after synthetic password login", async (t) => {
  const f = await apiFixture(t, { authRequired: true, legacySchema: false });
  const session = await f.call("/api/session");
  assert.equal(session.data.authRequired, true);
  assert.equal(
    (await f.call("/api/v2/jobs?allTargets=true")).response.status,
    401,
  );
  const root = await f.callAuthenticated("/");
  assert.equal(root.response.status, 200);
  assert.match(root.text, /\/app\/assets\//);
  assert.equal(
    (await f.callAuthenticated("/api/v2/jobs?allTargets=true")).response.status,
    200,
  );
});

test("built asset references are real and unknown paths cannot fall back to business HTML", async (t) => {
  const f = await apiFixture(t, { authRequired: true, legacySchema: false });
  const root = await f.callAuthenticated("/");
  const assets = [...root.text.matchAll(/(?:src|href)="(\/app\/[^\"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(assets.some((file) => file.endsWith(".js")));
  assert.ok(assets.some((file) => file.endsWith(".css")));
  for (const file of assets)
    assert.equal((await f.call(file)).response.status, 200, file);
  assert.equal((await f.call("/app/assets/missing.js")).response.status, 404);
  assert.equal(
    (await f.call("/unrecognized-business-page")).response.status,
    404,
  );
  assert.equal((await f.call("/login")).response.status, 200);
  for (const file of [
    "/login.js",
    "/style.css",
    "/js/validation-rules.js",
    "/js/diagnostic-rules.js",
    "/js/components/form-validation.js",
    "/js/components/dom.js",
    "/js/version-management.js",
  ])
    assert.equal((await f.call(file)).response.status, 200, file);
  for (const route of ["jobs", "profiles", "trash", "settings"]) {
    const response = await fetch(f.origin + "/" + route, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "/#/" + route);
  }
});

test("UI build keeps login and shared backend validation siblings intact", async (t) => {
  const buildRoot = await createTempDir(t);
  await fs.cp(path.join(ROOT, "ui"), path.join(buildRoot, "ui"), {
    recursive: true,
  });
  await fs.cp(path.join(ROOT, "public/js"), path.join(buildRoot, "public/js"), {
    recursive: true,
  });
  await fs.mkdir(path.join(buildRoot, "tools"));
  await fs.copyFile(
    path.join(ROOT, "tools/build-ui.mjs"),
    path.join(buildRoot, "tools/build-ui.mjs"),
  );
  await fs.copyFile(
    path.join(ROOT, "package.json"),
    path.join(buildRoot, "package.json"),
  );
  await fs.symlink(
    path.join(ROOT, "node_modules"),
    path.join(buildRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const siblings = [
    "public/login.html",
    "public/login.js",
    "public/js/validation-rules.js",
    "public/js/diagnostic-rules.js",
  ];
  for (const file of siblings) {
    await fs.mkdir(path.dirname(path.join(buildRoot, file)), {
      recursive: true,
    });
    await fs.copyFile(path.join(ROOT, file), path.join(buildRoot, file));
  }
  const before = await Promise.all(
    siblings.map((file) => fs.readFile(path.join(buildRoot, file), "utf8")),
  );
  const result = spawnSync(process.execPath, ["tools/build-ui.mjs"], {
    cwd: buildRoot,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = await Promise.all(
    siblings.map((file) => fs.readFile(path.join(buildRoot, file), "utf8")),
  );
  assert.deepEqual(after, before);
  assert.match(
    await fs.readFile(path.join(buildRoot, "public/app/index.html"), "utf8"),
    /\/app\/assets\/.*\.js/,
  );
  const { validateUiAssets } = await import("../../tools/verify-package.mjs");
  assert.ok(validateUiAssets({ root: buildRoot }).js.length >= 1);
});

test("package verifier accepts the real asset graph and full production dependency closure", async (t) => {
  const f = await packageFixture(t);
  await f.pack();
  const result = f.verify();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("package verifier rejects a missing referenced chunk and required transitive dependency", async (t) => {
  const f = await packageFixture(t);
  await fs.unlink(path.join(f.stage, "public/app/assets/chunk.js"));
  await f.pack();
  let result = f.verify();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /missing.*chunk|UI asset.*chunk/i,
  );
  await f.write("public/app/assets/chunk.js", "export const shared = 1;");
  await fs.unlink(
    path.join(f.stage, "node_modules/synthetic-child/package.json"),
  );
  await f.pack();
  result = f.verify();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /dependency.*synthetic-child|synthetic-child.*dependency/i,
  );
});

test("package verifier excludes private directories, credentials, tests and old business renderers", async (t) => {
  const f = await packageFixture(t);
  for (const forbidden of [
    "data/private.json",
    "control/state.json",
    "cache/value.json",
    "logs/private.log",
    "credentials.v2.json",
    "credentials/private.json",
    ".credentials.yaml",
    "tests/fixture.json",
    "public/js/main.js",
    "public/js/pages/jobs.js",
  ]) {
    await f.write(forbidden, "synthetic forbidden content");
    await f.pack();
    const result = f.verify();
    assert.notEqual(result.status, 0, forbidden);
    assert.match(result.stdout + result.stderr, /forbidden|excluded/i);
    await fs.unlink(path.join(f.stage, forbidden));
  }
});

test("package verifier rejects absent Boss protocol", async (t) => {
  const f = await packageFixture(t);
  const protocol = "src/sources/boss/protocol.mjs";
  await fs.unlink(path.join(f.stage, protocol));
  await f.pack();
  let result = f.verify();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /Missing runtime file.*boss\/protocol/,
  );
});

test("package verifier rejects stale production services", async (t) => {
  const f = await packageFixture(t);
  for (const file of [
    "electron/collection/sessions.mjs",
    "src/application/collection-service.mjs",
    "src/llm/prompt-registry.mjs",
  ]) {
    await f.write(file, "/* stale assembled module */");
    await f.pack();
    const result = f.verify();
    assert.notEqual(result.status, 0, file);
    assert.ok(
      (result.stdout + result.stderr).includes(
        "Source/package mismatch: " + file,
      ),
    );
    await f.write(file, "/* synthetic runtime presence */");
  }
});

test("package verifier rejects first-party absolute user SDK paths even when source bytes match", async (t) => {
  const f = await packageFixture(t),
    file = "src/sources/adapters/boss.mjs";
  const body = "const sdk = 'C:/Users/synthetic/.agent-reach/sdk.js';";
  await f.write(file, body);
  await fs.writeFile(path.join(f.root, file), body);
  await f.pack();
  const result = f.verify();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /User-specific runtime path.*boss/,
  );
});
