import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { createApiClient } from "../../public/js/api.js";
import { createTempDir } from "../helpers/fixtures.mjs";
import * as desktop from "../../electron/self-test.mjs";

const verifier = fileURLToPath(new URL("../../tools/verify-desktop-self-test.ps1", import.meta.url));
const powershell = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
const quote = value => "'" + value.replace(/'/g, "''") + "'";
const report = dpr => ({
  passed: 85, failed: 0, synthetic: true, results: [], screenshots: [],
  network: { externalRequests: 0 }, deviceScaleFactor: dpr,
  bundled: { automaticDownloads: 0, developerToolsRequired: false },
});

const pages = ['workbench','jobs','applications','profiles','targets','sources','logs','trash','settings'];
test("native fixture keeps renderer time aligned across historical dates, clock advances and reloads", async () => {
  let now = Date.parse("2026-10-09T00:00:00Z");
  const realNow = Date.parse("2026-10-16T00:00:00Z");
  const clock = { now: () => now };
  const deadline = now + 72 * 3600 * 1000;
  let renderer;
  const reload = () => {
    renderer = vm.createContext({ Date: { now: () => realNow } });
  };
  const webContents = {
    async executeJavaScript(source, userGesture) {
      assert.equal(userGesture, true);
      return structuredClone(await vm.runInContext(source, renderer));
    },
  };
  reload();
  assert.ok(vm.runInContext("Date.now()", renderer) > deadline);
  assert.equal(await desktop.executeDesktopFixtureScript(webContents, clock, "Date.now()"), now);
  assert.equal(await desktop.executeDesktopFixtureScript(webContents, clock, `Date.now() < ${deadline}`), true);
  now = deadline - 1;
  assert.equal(await desktop.executeDesktopFixtureScript(webContents, clock, `Date.now() < ${deadline}`), true);
  now = deadline;
  assert.equal(await desktop.executeDesktopFixtureScript(webContents, clock, `Date.now() < ${deadline}`), false);
  assert.equal(await desktop.executeDesktopFixtureScript(webContents, clock, "Date.now()"), now);
  // A reload recreates a renderer with the host clock. The first fixture
  // operation must restore the current service time before evaluating the UI.
  reload();
  assert.equal(await desktop.executeDesktopFixtureScript(webContents, clock, "Date.now()"), now);
  assert.equal(await desktop.executeDesktopFixtureScript(webContents, clock, `Date.now() < ${deadline}`), false);
  assert.equal(await desktop.executeDesktopFixtureScript(webContents, clock, "Promise.resolve(Date.now())"), now);
  await assert.rejects(
    desktop.executeDesktopFixtureScript(webContents, clock, "throw Error('original_expression_failure')"),
    /original_expression_failure/,
  );
  let executed = false;
  for (const invalid of [NaN, Infinity, "123;throw Error('injected')", null]) {
    assert.throws(() => desktop.executeDesktopFixtureScript({
      executeJavaScript() { executed = true; },
    }, { now: () => invalid }, "Date.now()"), /invalid_self_test_clock/);
  }
  assert.equal(executed, false);
});

test("native fixture focus script returns a cloneable value", () => {
  const source = fs.readFileSync(new URL("../../electron/self-test.mjs", import.meta.url), "utf8");
  const renderer = vm.createContext({ window: {} });
  const rememberFocus = source.match(/await js\(`([^`]*__rjrReturnFocus[^`]*)`\)/)[1]
    .replace('${locate("查看岗位")}', 'window.syntheticElement');
  renderer.window.syntheticElement = { focus() {} };
  assert.doesNotThrow(() => structuredClone(vm.runInContext(rememberFocus, renderer)));
  assert.equal(renderer.window.__rjrReturnFocus, renderer.window.syntheticElement);
});

test("navigation keeps 768px in the drawer range and switches at 769px", () => {
  for (const width of [374, 375, 376, 768]) {
    assert.equal(desktop.desktopNavigationMatches(width, { links: 0, toggle: true }), true);
    assert.equal(desktop.desktopNavigationMatches(width, { links: 9, toggle: false }), false);
  }
  for (const width of [769, 1024, 1440]) {
    assert.equal(desktop.desktopNavigationMatches(width, { links: 9, toggle: false }), true);
    assert.equal(desktop.desktopNavigationMatches(width, { links: 0, toggle: true }), false);
  }
});

test("offscreen keyboard focus restores emulation and debugger ownership even when verification fails", async () => {
  for (const attached of [false, true]) {
    const calls = [];
    const debuggerApi = {
      isAttached: () => attached,
      attach: version => calls.push(["attach", version]),
      detach: () => calls.push(["detach"]),
      sendCommand: async (command, options) => calls.push([command, options.enabled]),
    };
    const failure = Error("focus audit failed");
    await assert.rejects(desktop.withDesktopKeyboardFocus(debuggerApi, async () => {
      assert.deepEqual(calls.at(-1), ["Emulation.setFocusEmulationEnabled", true]);
      throw failure;
    }), error => error === failure);
    assert.deepEqual(calls, [
      ...(!attached ? [["attach", "1.3"]] : []),
      ["Emulation.setFocusEmulationEnabled", true],
      ["Emulation.setFocusEmulationEnabled", false],
      ...(!attached ? [["detach"]] : []),
    ]);
  }
});

test("a late fetch wrapper cannot observe a request from an already-created API client", async () => {
  const original = globalThis.fetch;
  let transportCalls = 0, wrapperCalls = 0;
  try {
    globalThis.fetch = async () => {
      transportCalls++;
      return new Response(JSON.stringify({ code: "trash_preview_stale", message: "synthetic conflict" }), { status: 409, headers: { "content-type": "application/json" } });
    };
    const client = createApiClient();
    const captured = globalThis.fetch;
    globalThis.fetch = (...args) => { wrapperCalls++; return captured(...args); };
    await assert.rejects(client.request("/trash/purge", { method: "POST", body: {} }));
    assert.equal(transportCalls, 1);
    assert.equal(wrapperCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("native response observer filters origin and route, preserves other listeners, and cleans up on failure", async () => {
  const debuggerApi = new EventEmitter(), calls = [];
  debuggerApi.isAttached = () => false;
  debuggerApi.attach = version => calls.push(["attach", version]);
  debuggerApi.detach = () => calls.push(["detach"]);
  debuggerApi.sendCommand = async command => calls.push([command]);
  const unrelated = () => {};
  debuggerApi.on("message", unrelated);
  const failure = Error("synthetic check failure");
  await assert.rejects(desktop.withDesktopResponses(debuggerApi, "http://127.0.0.1:1234", "/api/v2/trash/purge", async responses => {
    for (const url of ["http://other.invalid/api/v2/trash/purge", "http://127.0.0.1:1234/api/v2/trash/preview", "http://127.0.0.1:1234/api/v2/trash/purge"]) {
      debuggerApi.emit("message", {}, "Network.responseReceived", { requestId: "synthetic-id", response: { url, status: 409, headers: { private: "not retained" } } });
    }
    assert.deepEqual(responses, [{ requestId: "synthetic-id", status: 409 }]);
    throw failure;
  }), error => error === failure);
  assert.deepEqual(calls, [["attach","1.3"],["Network.enable"],["Network.disable"],["detach"]]);
  assert.deepEqual(debuggerApi.listeners("message"), [unrelated]);
  debuggerApi.isAttached = () => true;
  await assert.rejects(desktop.withDesktopResponses(debuggerApi, "http://127.0.0.1:1234", "/api/v2/trash/purge", () => assert.fail("must not borrow another debugger session")), /self_test_debugger_busy/);
  assert.equal(calls.length, 4);
});

test("desktop capture subscribes after settling and before invalidating, and returns only a fresh whole frame", async () => {
  const contents = new EventEmitter(), calls = [];
  const unrelated = () => {};
  contents.on("paint", unrelated);
  contents.isOffscreen = () => true;
  contents.executeJavaScript = async (source) => {
    calls.push("settle");
    assert.match(source, /settleDesktopPopups/);
    assert.equal(contents.listenerCount("paint"), 1);
  };
  contents.capturePage = () => assert.fail("cached capture must not be used");
  const fresh = { isEmpty: () => false, getSize: () => ({ width: 750, height: 1800 }) };
  contents.invalidate = () => {
    calls.push("invalidate");
    assert.equal(contents.listenerCount("paint"), 2, "subscribe before requesting paint");
    contents.emit("paint", {}, {}, { isEmpty: () => true });
    contents.emit("paint", {}, {}, { isEmpty: () => false, getSize: () => ({ width: 0, height: 0 }) });
    contents.emit("paint", {}, { width: 10, height: 10 }, fresh);
  };
  assert.equal(await desktop.captureDesktopFrame(contents), fresh);
  assert.deepEqual(calls, ["settle", "invalidate"]);
  assert.deepEqual(contents.listeners("paint"), [unrelated]);
});

test("desktop capture timeout, invalidation or settling error, and non-offscreen rejection leave no owned listener", async () => {
  for (const mode of ["timeout", "throw", "settle-error", "non-offscreen"]) {
    const contents = new EventEmitter();
    const unrelated = () => {};
    contents.on("paint", unrelated);
    contents.isOffscreen = () => mode !== "non-offscreen";
    contents.executeJavaScript = async () => {
      assert.notEqual(mode, "non-offscreen");
      if (mode === "settle-error") throw Error("synthetic settle failure");
    };
    contents.invalidate = () => { if (mode === "throw") throw Error("synthetic paint failure"); };
    await assert.rejects(desktop.captureDesktopFrame(contents, { timeoutMs: 20 }),
      mode === "timeout" ? /self_test_paint_timeout/ : mode === "throw" ? /synthetic paint failure/ : mode === "settle-error" ? /synthetic settle failure/ : /self_test_offscreen_required/);
    assert.deepEqual(contents.listeners("paint"), [unrelated]);
  }
});

test("desktop capture writes the fresh frame and records actual renderer width and height", async () => {
  const source = fs.readFileSync(new URL("../../electron/self-test.mjs", import.meta.url), "utf8");
  const expression = source.slice(source.indexOf("  const capture = async"), source.indexOf("  const audit = async"));
  const screenshots = [], writes = [], calls = [], contents = {};
  const png = Buffer.from("fresh frame");
  const capture = vm.runInNewContext(`${expression};capture`, {
    js: async expression => vm.runInNewContext(expression, {
      innerWidth: 376, innerHeight: 901, devicePixelRatio: 1.5,
      document: { querySelector: () => ({ textContent: "回收站" }) },
    }),
    desktopPages: desktop.desktopPages, lastPage: "workbench", requestedWidth: 375,
    dataDir: "synthetic", path, screenshots, window: { webContents: contents },
    captureDesktopFrame: async value => {
      assert.equal(value, contents); calls.push("fresh");
      return { toPNG: () => { calls.push("png"); return png; } };
    },
    fs: { writeFileSync: (...args) => writes.push(args) },
  });
  await capture("trash-expired.png", { matrix: false });
  assert.deepEqual(calls, ["fresh", "png"]);
  assert.deepEqual(writes, [[path.join("synthetic", "trash-expired.png"), png]]);
  assert.deepEqual(JSON.parse(JSON.stringify(screenshots)), [{
    page: "trash", width: 375, actualWidth: 376, actualHeight: 901, dpr: 1.5,
    file: "trash-expired.png", matrix: false,
  }]);
});

test("popup inspection waits for entering animations and stable frames, and rejects motion that never settles", async () => {
  const run = (neverSettles = false) => {
    let frame = 0;
    const popup = {
      getClientRects: () => [{}], closest: () => null,
      getAnimations: () => [{ playState: neverSettles || frame < 4 ? "running" : "finished", effect: { getComputedTiming: () => ({ endTime: 150 }) } }],
      getBoundingClientRect: () => ({ left: 16, top: 840, right: 344, bottom: frame < 4 ? 902.113 : 900 }),
    };
    return vm.runInNewContext(`(${desktop.settleDesktopPopups.toString()})()`, {
      performance: { now: () => frame * (neverSettles ? 500 : 16) },
      requestAnimationFrame: callback => { frame++; queueMicrotask(callback); },
      document: { querySelectorAll: () => [popup] },
    });
  };
  const result = await run();
  assert.equal(result.frames, 6);
  assert.equal(result.popupCount, 1);
  await assert.rejects(run(true), /self_test_popup_animation_timeout/);
});

for (const slot of ['sheet-content','sheet-overlay','dialog-overlay','alert-dialog-overlay']) {
  test(`popup settling waits for the still-painted closed ${slot} finite exit`, async () => {
    let frame = 0;
    const closing = {
      getClientRects: () => frame < 8 ? [{}] : [],
      closest: () => ({}), // Base UI marks closed/inert while it is still mounted.
      getAnimations: () => [{ playState: frame < 8 ? 'running' : 'finished', effect: { getComputedTiming: () => ({ endTime: 200 }) } }],
      getBoundingClientRect: () => ({ left: 90, top: 0, right: 375, bottom: 900 }),
    };
    const settled = await vm.runInNewContext(`(${desktop.settleDesktopPopups.toString()})()`, {
      performance: { now: () => frame * 16 },
      requestAnimationFrame: callback => { frame++; queueMicrotask(callback); },
      document: { querySelectorAll: selector => slot === 'sheet-content' || selector.includes(`[data-slot=${slot}]`) ? [closing] : [] },
    });
    assert.ok(frame >= 8, `closed ${slot} still paints its finite exit at frame ${frame}`);
    assert.equal(settled.popupCount, 0);
  });
}

test('popup settling ignores an unrelated infinite animation', async () => {
  let frame = 0;
  const popup = {
    getClientRects: () => [{}], closest: () => null,
    getAnimations: () => [{ playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) } }],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 44, bottom: 44 }),
  };
  const result = await vm.runInNewContext(`(${desktop.settleDesktopPopups.toString()})()`, {
    performance: { now: () => frame * 16 },
    requestAnimationFrame: callback => { frame++; queueMicrotask(callback); },
    document: { querySelectorAll: () => [popup] },
  });
  assert.equal(result.frames, 3);
});

test('dropdown trigger matches the workspace 44px minimum width and height', async () => {
  const { JSDOM } = await import('jsdom');
  const { default: postcss } = await import('postcss');
  const dom = new JSDOM('<button data-slot="dropdown-menu-trigger">版本</button>');
  try {
    const trigger = dom.window.document.querySelector('button');
    const stylesheet = postcss.parse(fs.readFileSync(new URL('../../ui/src/styles.css', import.meta.url), 'utf8'));
    for (const property of ['min-height','min-width']) {
      const values = [];
      stylesheet.walkRules(rule => {
        try { if (!trigger.matches(rule.selector)) return; } catch { return; }
        rule.walkDecls(property, declaration => values.push(declaration.value));
      });
      assert.ok(values.includes('44px'), `actual dropdown trigger must match ${property}:44px`);
    }
  } finally { dom.window.close(); }
});

test('desktop inspector rejects a 32px dropdown trigger and accepts its 44px fixed geometry', async () => {
  const { JSDOM } = await import('jsdom');
  const { createCanvas } = await import('@napi-rs/canvas');
  const dom = new JSDOM('<body><button data-slot="dropdown-menu-trigger" aria-label="目标版本">版本</button></body>');
  try {
    const { document, NodeFilter } = dom.window;
    const trigger = document.querySelector('button');
    let size = 32;
    trigger.getClientRects = () => [{}];
    trigger.getBoundingClientRect = () => ({ left:0, top:0, right:size, bottom:size, width:size, height:size });
    dom.window.HTMLCanvasElement.prototype.getContext = () => createCanvas(1,1).getContext('2d');
    trigger.style.color = 'black';
    trigger.style.backgroundColor = 'white';
    trigger.style.opacity = '1';
    const inspect = () => vm.runInNewContext(`(${desktop.inspectDesktopUi.toString()})(${desktop.desktopContrastRatio.toString()})`, {
      document, NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      innerWidth:1440, innerHeight:900, devicePixelRatio:1, matchMedia:()=>({ matches:false }),
    });
    const small = inspect().hitTargets.find(item => item.label === '目标版本');
    assert.ok(small, 'actual dropdown trigger participates in desktop hit auditing');
    assert.equal(small.ok, false);
    size = 44;
    assert.equal(inspect().hitTargets.find(item => item.label === '目标版本').ok, true);
    trigger.setAttribute('aria-hidden','true');
    assert.equal(inspect().hitTargets.length, 0, 'closed/hidden controls remain outside the interaction audit');
  } finally { dom.window.close(); }
});

test('expiry screenshot waits for closed Sheet content and backdrop to stop painting', () => {
  const source = fs.readFileSync(new URL('../../electron/self-test.mjs',import.meta.url),'utf8');
  const expiry = source.slice(source.indexOf('await phase("回收站到期'),source.indexOf('await phase("减少动效'));
  const expression = expiry.match(/await wait\("([^"\n]*data-slot=sheet-content[^"\n]*)"\)/)?.[1];
  assert.ok(expression, 'expiry capture must wait for both actual Sheet surfaces, not just the transient expired message');
  assert.ok(expiry.indexOf(expression) < expiry.indexOf('await capture("trash-expired.png"'));
  let painted = true;
  const surface = { getClientRects: () => painted ? [{}] : [] };
  const document = { querySelectorAll: selector => {
    assert.ok(selector.includes('[data-slot=sheet-content]') && selector.includes('[data-slot=sheet-overlay]'));
    return [surface];
  } };
  assert.equal(vm.runInNewContext(expression,{document}),false,'closed mounted surfaces still need to finish');
  painted = false;
  assert.equal(vm.runInNewContext(expression,{document}),true);
});

function matrix(dpr) {
  return pages.flatMap(page => [1440,1024,768,375].map(width => ({ page, width, actualWidth: width, dpr, file: `${page}-${width}.png`, matrix: true })));
}
function validateReport(filename, dpr) {
  return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", verifier, "-ReportPath", filename, "-Scales", String(dpr)], { encoding: "utf8", timeout: 20000 });
}

test("matrix validation preserves honest fractional DPI widths and rejects missing, duplicate and invented cells", () => {
  for (const dpr of [1,1.25,1.5,2]) {
    const shots = matrix(dpr);
    shots.find(shot => shot.width === 375).actualWidth = 374;
    shots.find(shot => shot.page === "jobs" && shot.width === 375).actualWidth = 376;
    assert.equal(desktop.validateDesktopMatrix(shots, dpr).length, 0);
    assert.ok(desktop.validateDesktopMatrix(shots.slice(1), dpr).some(issue => issue.code === "missing_matrix_cell"));
    assert.ok(desktop.validateDesktopMatrix([...shots.slice(1), shots[1]], dpr).some(issue => issue.code === "duplicate_matrix_cell"));
    assert.ok(desktop.validateDesktopMatrix(shots.map(shot => ({ ...shot, actualWidth: 377 })), dpr).some(issue => issue.code === "actual_width_mismatch"));
    assert.ok(desktop.validateDesktopMatrix(shots.map(shot => ({ ...shot, dpr: NaN })), dpr).some(issue => issue.code === "dpr_mismatch"));
  }
});

test("contrast uses linear sRGB luminance and distinguishes normal text from the 3:1 large-text/control threshold", () => {
  assert.equal(desktop.desktopContrastRatio([0,0,0], [255,255,255]), 21);
  assert.equal(desktop.desktopContrastRatio([255,255,255], [255,255,255]), 1);
  const ratio = desktop.desktopContrastRatio([128,128,128], [255,255,255]);
  assert.ok(ratio > 3 && ratio < 4.5, String(ratio));
  assert.ok(desktop.desktopContrastRatio([100,116,139], [255,255,255]) >= 3);
  assert.ok(desktop.desktopContrastRatio([216,226,237], [255,255,255]) < 3);
});

test("report-only PowerShell verifies 36 real files at DPR 2 and keeps 1.25 legal; metadata tampering fails", { skip: process.platform !== "win32" }, async t => {
  const directory = await createTempDir(t);
  const filename = path.join(directory, "report.json");
  const shots = matrix(2);
  for (const shot of shots) fs.writeFileSync(path.join(directory, shot.file), Buffer.from("89504e470d0a1a0a", "hex"));
  const cases = [
    [2, value => value, true],
    [1.25, value => ({ ...value, deviceScaleFactor: 1.25, screenshots: matrix(1.25) }), true],
    [2, value => ({ ...value, screenshots: value.screenshots.slice(1) }), false],
    [2, value => ({ ...value, screenshots: [...value.screenshots.slice(1), value.screenshots[1]] }), false],
    [2, value => ({ ...value, screenshots: value.screenshots.map(shot => ({ ...shot, actualWidth: shot.width === 375 ? 376 : shot.width })) }), true],
    [2, value => ({ ...value, screenshots: value.screenshots.map(shot => ({ ...shot, actualWidth: shot.width === 375 ? 377 : shot.width })) }), false],
    [2, value => ({ ...value, screenshots: value.screenshots.map(shot => ({ ...shot, dpr: 1.5 })) }), false],
    [2, value => ({ ...value, screenshots: [...value.screenshots, { page:'settings',width:1440,actualWidth:1152,dpr:2.5,fontZoom:1.25,file:'font.png' }] }), true],
    [2, value => ({ ...value, screenshots: value.screenshots.map((shot,index) => index ? shot : { ...shot, fontZoom:1.25,dpr:2.5 }) }), false],
    [2, value => ({ ...value, screenshots: value.screenshots.map((shot,index) => index ? shot : { ...shot, page:'invented' }) }), false],
    [2, value => ({ ...value, screenshots: value.screenshots.map((shot,index) => index ? shot : { ...shot, dpr:'NaN' }) }), false],
    [2, value => ({ ...value, screenshots: value.screenshots.map((shot,index) => index ? shot : { ...shot, file: "../outside.png" }) }), false],
    [2, value => ({ ...value, screenshots: value.screenshots.map((shot,index) => index ? shot : { ...shot, file: "absent.png" }) }), false],
  ];
  fs.writeFileSync(path.join(directory,'font.png'),Buffer.from('89504e470d0a1a0a','hex'));
  for (const [dpr, transform, expected] of cases) {
    fs.writeFileSync(filename, JSON.stringify(transform({ ...report(2), screenshots: shots })));
    const result = validateReport(filename, dpr);
    assert.equal(result.status === 0, expected, result.stdout + result.stderr);
  }
});

test("PowerShell rejects an otherwise passing old report without the nine-page matrix, without starting an EXE", { skip: process.platform !== "win32" }, async t => {
  const directory = await createTempDir(t);
  const fixture = path.join(directory, "old-report.json");
  fs.writeFileSync(fixture, JSON.stringify(report(1)));
  const script = `
    $ErrorActionPreference='Stop'
    $taskMockDirectory=$null
    function Start-Process {
      param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError)
      $script:taskMockDirectory=$env:RJR_DATA_DIR
      New-Item -ItemType Directory -Path $taskMockDirectory -Force | Out-Null
      Copy-Item -LiteralPath ${quote(fixture)} -Destination (Join-Path $taskMockDirectory 'desktop-self-test.json')
      $taskMockProcess=[pscustomobject]@{Handle=1;Id=0;HasExited=$true;ExitCode=0}
      $taskMockProcess | Add-Member ScriptMethod WaitForExit {param($milliseconds) return $true}
      return $taskMockProcess
    }
    try { & ${quote(verifier)} -ExePath ${quote(process.execPath)} -Scales @(1); exit 0 }
    catch { Write-Output $_.Exception.Message; exit 1 }
    finally {
      if ($taskMockDirectory) {
        $taskExpectedCache=[IO.Path]::GetFullPath(${quote(path.resolve(path.dirname(verifier), "../.cache"))})
        $taskResolvedMock=[IO.Path]::GetFullPath($taskMockDirectory)
        if ([IO.Path]::GetDirectoryName($taskResolvedMock) -ne $taskExpectedCache -or [IO.Path]::GetFileName($taskResolvedMock) -notmatch '^rjr-self-test-exe-[a-f0-9]+$') { throw 'unsafe_mock_cleanup' }
        Remove-Item -LiteralPath $taskResolvedMock -Recurse -Force
      }
    }
  `;
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout: 20000 });
  assert.notEqual(result.status, 0, "An empty screenshot report was accepted: " + result.stdout);
  assert.match(result.stdout + result.stderr, /matrix|矩阵/i);
});
