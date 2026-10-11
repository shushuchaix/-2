import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
