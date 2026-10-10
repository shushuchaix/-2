import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
test("fact selection and duplicate comparison share an acyclic pure identity boundary", () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/domain",
  );
  const seen = new Set(),
    active = new Set();
  function visit(file) {
    if (active.has(file))
      assert.fail("Cyclic identity dependency: " + path.basename(file));
    if (seen.has(file)) return;
    active.add(file);
    const code = fs.readFileSync(file, "utf8");
    for (const match of code.matchAll(
      /(?:import|export)[\s\S]*?\bfrom\s*["'](\.\/[^"']+)["']/g,
    )) {
      const next = path.resolve(path.dirname(file), match[1]);
      if (next.startsWith(root + path.sep) && fs.existsSync(next)) visit(next);
    }
    active.delete(file);
    seen.add(file);
  }
  for (const file of [
    "job-facts.mjs",
    "job-duplicates.mjs",
    "duplicate-candidates.mjs",
  ])
    visit(path.join(root, file));
});
