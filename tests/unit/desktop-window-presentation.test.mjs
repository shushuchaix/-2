import test from "node:test";
import assert from "node:assert/strict";
import * as startup from "../../electron/startup.mjs";

function fixture({
  visible = false,
  minimized = false,
  destroyed = false,
} = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    restore() {
      calls.push("restore");
      minimized = false;
    },
    show() {
      calls.push("show");
      visible = true;
    },
    focus() {
      calls.push("focus");
    },
  };
}

test("reopening a hidden loaded desktop window shows it before focusing", () => {
  const window = fixture();
  assert.equal(startup.presentDesktopWindow(window), true);
  assert.deepEqual(window.calls, ["show", "focus"]);
});

test("reopening a minimized window restores it before showing and focusing", () => {
  const window = fixture({ minimized: true });
  assert.equal(startup.presentDesktopWindow(window), true);
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);
});

test("a visible desktop window keeps its geometry and only receives focus", () => {
  const window = fixture({ visible: true });
  assert.equal(startup.presentDesktopWindow(window), true);
  assert.deepEqual(window.calls, ["focus"]);
});

test("a minimized window that remains visible only restores and focuses", () => {
  const window = fixture({ visible: true, minimized: true });
  assert.equal(startup.presentDesktopWindow(window), true);
  assert.deepEqual(window.calls, ["restore", "focus"]);
});

test("offscreen acceptance remains hidden without restore, show or focus", () => {
  const window = fixture({ minimized: true });
  assert.equal(startup.presentDesktopWindow(window, { selfTest: true }), false);
  assert.deepEqual(window.calls, []);
});

test("a missing window cannot be revived by a second instance", () => {
  assert.equal(startup.presentDesktopWindow(null), false);
});

test("a destroyed window is not accessed or presented", () => {
  const window = fixture({ destroyed: true });
  window.isMinimized = window.isVisible = () => {
    throw Error("destroyed_access");
  };
  assert.equal(startup.presentDesktopWindow(window), false);
  assert.deepEqual(window.calls, []);
});
