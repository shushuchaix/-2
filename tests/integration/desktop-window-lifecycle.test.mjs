import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { presentDesktopWindow } from "../../electron/startup.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = fs.readFileSync(path.join(root, "electron/main.mjs"), "utf8");
const declaration = parse(source, {
  ecmaVersion: "latest",
  sourceType: "module",
}).body.find(
  (node) =>
    node.type === "FunctionDeclaration" && node.id.name === "createWindow",
);
assert.ok(declaration, "production window creation function exists");

function lifecycle({ selfTest = false } = {}) {
  let resolveLoad;
  class Window extends EventEmitter {
    visible = false;
    minimized = false;
    calls = [];
    webContents = Object.assign(new EventEmitter(), {
      session: {},
      setWindowOpenHandler() {},
      async executeJavaScript() {},
    });
    loadURL() {
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return this.minimized;
    }
    restore() {
      this.calls.push("restore");
      this.minimized = false;
    }
    show() {
      this.calls.push("show");
      this.visible = true;
    }
    focus() {
      this.calls.push("focus");
    }
  }
  const context = vm.createContext({
    path,
    fs: { existsSync: () => false },
    APP_ROOT: root,
    APP_TITLE: "Synthetic",
    SELF_TEST: selfTest,
    BrowserWindow: Window,
    presentDesktopWindow,
    URL,
    app: { commandLine: { getSwitchValue: () => "1" } },
    attachWindowDiagnostics() {},
    diagnostics: {},
    dialog: { showErrorBox() {} },
    selfTestNetwork: { attachSession() {} },
    selfTestRendererErrors: [],
    appUrl: "http://127.0.0.1:1",
  });
  vm.runInContext(
    "let mainWindow=null;\n" +
      source.slice(declaration.start, declaration.end) +
      "\nglobalThis.start=createWindow;globalThis.getWindow=()=>mainWindow;",
    context,
  );
  const creation = context.start();
  return { creation, window: context.getWindow(), finish: () => resolveLoad() };
}

test("successful page load reveals the real creation path without ready-to-show", async () => {
  const run = lifecycle();
  assert.equal(run.window.visible, false);
  run.finish();
  await run.creation;
  assert.equal(run.window.visible, true);
  assert.deepEqual(run.window.calls, ["show", "focus"]);
});

test("loading completion preserves a user minimize after the first successful presentation", async () => {
  const run = lifecycle();
  run.window.emit("ready-to-show");
  run.window.minimized = true;
  run.window.calls.length = 0;
  run.finish();
  await run.creation;
  assert.equal(run.window.minimized, true);
  assert.deepEqual(run.window.calls, []);
});

test("both creation presentation paths keep the synthetic offscreen acceptance window hidden", async () => {
  const run = lifecycle({ selfTest: true });
  run.window.emit("ready-to-show");
  run.finish();
  await run.creation;
  assert.equal(run.window.visible, false);
  assert.deepEqual(run.window.calls, []);
});
