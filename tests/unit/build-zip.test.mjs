import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeZip } from "../helpers/resume-files.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
import { extractZip } from "../../tools/lib/unzip.mjs";
test("build archive cannot escape into similarly named sibling directory", async (t) => {
  const dir = await createTempDir(t),
    zip = path.join(dir, "malformed.zip");
  await fs.writeFile(zip, makeZip({ "../out-evil/payload.txt": "outside" }));
  assert.throws(() => extractZip(zip, path.join(dir, "out")), /越界/);
});
