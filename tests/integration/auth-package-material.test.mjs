import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import * as asar from "@electron/asar";
import { verifyPackageArchive } from "../../tools/verify-package.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";

test("packaged artifacts reject session registry, root secret, locks and pending writes at any depth", async (t) => {
  const dir = await createTempDir(t);
  const files = [".auth-sessions.json", "nested/.auth-sessions.json.lock", "nested/.auth-sessions.json.lock.reclaim", "nested/.auth-sessions.json.synthetic.tmp", ".session-secret", "nested/.session-secret.synthetic.tmp"];
  for (let n = 0; n < files.length; n++) {
    const source = path.join(dir, "input-" + n), archivePath = path.join(dir, "archive-" + n + ".asar");
    await fs.mkdir(path.dirname(path.join(source, files[n])), { recursive: true });
    await fs.writeFile(path.join(source, files[n]), "synthetic-session-material");
    await asar.createPackage(source, archivePath);
    assert.throws(() => verifyPackageArchive({ archivePath }), /Forbidden packaged files/);
  }
});
