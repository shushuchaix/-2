import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createTestDocument } from "../helpers/dom.mjs";
import { mountShell } from "../../public/js/components/shell.js";
import { createRouter } from "../../public/js/router.js";
import { createStore } from "../../public/js/state.js";
test("shell restores five routes and shows accessible empty navigation", () => {
  const document = createTestDocument(),
    store = createStore(),
    seen = [];
  const listeners = new Map(),
    window = {
      location: { hash: "#/profiles" },
      addEventListener: (k, v) => listeners.set(k, v),
      removeEventListener: (k) => listeners.delete(k),
    };
  const router = createRouter({ window, onRoute: (r) => seen.push(r) });
  router.start();
  assert.equal(seen[0], "/profiles");
  const shell = mountShell({
    root: document.getElementById("root"),
    store,
    router,
  });
  assert.equal(document.querySelectorAll("nav a").length, 5);
  for (const path of [
    "/workbench",
    "/jobs",
    "/applications",
    "/profiles",
    "/settings",
  ]) {
    router.navigate(path);
    listeners.get("hashchange")?.();
    assert.equal(seen.at(-1), path);
  }
  assert.ok(document.querySelector("[aria-live]"));
  shell.destroy();
  router.stop();
  assert.equal(listeners.size, 0);
});
test("HTML loads the modular entry under CSP", async () => {
  const html = await fs.readFile("public/index.html", "utf8");
  assert.ok(html.includes("/js/main.js"));
  assert.ok(!/<script(?![^>]*src=)/i.test(html));
  assert.ok(!/<style|style=/i.test(html));
});
