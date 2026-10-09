param([string]$ExePath = '', [double[]]$Scales = @(1, 1.25, 1.5))
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (!$ExePath) { $ExePath = Join-Path $workspacePath 'dist/简历岗位雷达-win32-x64/简历岗位雷达.exe' }
$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
$cachePath = Join-Path $workspacePath '.cache'
New-Item -ItemType Directory -Path $cachePath -Force | Out-Null
$previousDataDir = $env:RJR_DATA_DIR
$savedEnvironment=@{}
foreach($key in @('PATH','PYTHONHOME','PYTHONPATH','PLAYWRIGHT_BROWSERS_PATH','ELECTRON_RUN_AS_NODE')){$savedEnvironment[$key]=[Environment]::GetEnvironmentVariable($key,'Process');Remove-Item -LiteralPath ('Env:'+$key) -ErrorAction SilentlyContinue}
try {
  foreach ($scale in $Scales) {
    if ($scale -notin @(1, 1.25, 1.5)) { throw 'Unsupported verification scale' }
    $testPath = Join-Path $cachePath ('rjr-self-test-exe-' + [guid]::NewGuid().ToString('N'))
    $env:RJR_DATA_DIR = $testPath
    $argumentList = @('--self-test', ('--force-device-scale-factor=' + $scale.ToString([Globalization.CultureInfo]::InvariantCulture)))
    $process = Start-Process -FilePath $resolvedExe -ArgumentList $argumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput ($testPath + '-stdout.log') -RedirectStandardError ($testPath + '-stderr.log')
    $null = $process.Handle
    Write-Output ('SELF_TEST_SCALE=' + $scale + ' PID=' + $process.Id + ' DIRECTORY=' + $testPath)
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    while (!$process.WaitForExit(1000)) {
      if ([DateTime]::UtcNow -gt $deadline) { throw ('Self-test did not finish; inspect synthetic process ' + $process.Id + ' and ' + $testPath) }
    }
    $process.WaitForExit()
    $testExitCode = $process.ExitCode
    Write-Output ('SELF_TEST_EXIT=' + $testExitCode)
    $reportPath = Join-Path $testPath 'desktop-self-test.json'
    if (!(Test-Path -LiteralPath $reportPath)) { throw ('Missing self-test report: ' + $testPath) }
    $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $testExitCode -or $testExitCode -ne 0 -or $report.failed -ne 0 -or !$report.synthetic -or $report.network.externalRequests -ne 0) {
      $report.results | Where-Object { !$_.ok } | ConvertTo-Json -Depth 8 | Write-Output
      throw ('Desktop self-test failed: ' + $reportPath)
    }
    if ([Math]::Abs($report.deviceScaleFactor - $scale) -gt 0.02) { throw ('Actual Chromium scale differs: ' + $report.deviceScaleFactor) }
    if (!$report.bundled -or $report.bundled.automaticDownloads -ne 0 -or $report.bundled.developerToolsRequired) { throw 'Bundled runtime proof missing' }
    foreach ($shot in $report.screenshots) {
      if (!(Test-Path -LiteralPath (Join-Path $testPath $shot.file))) { throw ('Missing screenshot ' + $shot.file) }
    }
    Write-Output ('SELF_TEST_PASS=' + $report.passed + ' SCALE=' + $report.deviceScaleFactor + ' REPORT=' + $reportPath)
  }
} finally { $env:RJR_DATA_DIR = $previousDataDir;foreach($key in $savedEnvironment.Keys){[Environment]::SetEnvironmentVariable($key,$savedEnvironment[$key],'Process')} }
