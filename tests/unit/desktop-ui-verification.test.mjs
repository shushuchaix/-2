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
