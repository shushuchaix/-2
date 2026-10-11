param([string]$ExePath = '', [double[]]$Scales = @(1, 1.5, 2), [string]$ReportPath = '')
$ErrorActionPreference = 'Stop'
foreach ($scale in $Scales) {
  if ($scale -notin @(1, 1.25, 1.5, 2)) { throw 'Unsupported verification scale' }
}
if (!$Scales.Count) { throw 'At least one verification scale is required' }

function Assert-DesktopReport([string]$TaskReportPath, [double]$TaskScale, [int]$TaskExitCode = 0) {
  if (!(Test-Path -LiteralPath $TaskReportPath -PathType Leaf)) { throw ('Missing self-test report: ' + $TaskReportPath) }
  $taskReport = Get-Content -LiteralPath $TaskReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($TaskExitCode -ne 0 -or $taskReport.failed -ne 0 -or !$taskReport.synthetic -or $taskReport.network.externalRequests -ne 0 -or $taskReport.passed -lt 85) {
    $taskReport.results | Where-Object { !$_.ok } | ConvertTo-Json -Depth 8 | Write-Output
    throw ('Desktop self-test failed: ' + $TaskReportPath)
  }
  if ($null -eq $taskReport.deviceScaleFactor -or [double]::IsNaN($taskReport.deviceScaleFactor) -or [Math]::Abs($taskReport.deviceScaleFactor - $TaskScale) -gt 0.02) { throw ('Actual Chromium scale differs: ' + $taskReport.deviceScaleFactor) }
  if (!$taskReport.bundled -or $taskReport.bundled.automaticDownloads -ne 0 -or $taskReport.bundled.developerToolsRequired -ne $false) { throw 'Bundled runtime proof missing' }
  $taskPages = @('workbench','jobs','applications','profiles','targets','sources','logs','trash','settings')
  $taskWidths = @(1440,1024,768,375)
  $taskMatrix = @($taskReport.screenshots | Where-Object { $_.matrix -eq $true })
  if ($taskMatrix.Count -ne 36) { throw ('Screenshot matrix requires 36 entries; actual ' + $taskMatrix.Count) }
  $taskKeys = @{}
  $taskFiles = @{}
  $taskReportDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $TaskReportPath))
  foreach ($shot in $taskReport.screenshots) {
    if ($shot.page -notin $taskPages -or $null -eq $shot.width -or $null -eq $shot.actualWidth -or $null -eq $shot.dpr) { throw 'Screenshot metadata requires page,width,actualWidth,dpr,file' }
    $taskShotZoom = if ($shot.fontZoom) { $shot.fontZoom } else { 1 }
    if ($taskShotZoom -le 0 -or [double]::IsNaN($shot.dpr) -or [Math]::Abs($shot.dpr / $taskShotZoom - $TaskScale) -gt 0.02) { throw ('Screenshot DPR differs: ' + $shot.file) }
    if (!$shot.file -or [IO.Path]::IsPathRooted($shot.file) -or [IO.Path]::GetExtension($shot.file) -ne '.png') { throw 'Invalid screenshot file' }
    $taskShotPath = [IO.Path]::GetFullPath((Join-Path $taskReportDirectory $shot.file))
    if (!$taskShotPath.StartsWith($taskReportDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Screenshot path escapes report directory' }
    if ($taskFiles.ContainsKey($shot.file)) { throw ('Duplicate screenshot file: ' + $shot.file) }
    $taskFiles[$shot.file] = $true
    if (!(Test-Path -LiteralPath $taskShotPath -PathType Leaf)) { throw ('Missing screenshot ' + $shot.file) }
    if ($shot.matrix -eq $true) {
      if ($taskShotZoom -ne 1) { throw 'Matrix screenshots must use native zoom' }
      if ($shot.width -notin $taskWidths) { throw 'Unknown matrix viewport width' }
      $taskAllowedWidth = if ($shot.width -eq 375) { @(374,375,376) } else { @($shot.width) }
      if ($shot.actualWidth -notin $taskAllowedWidth) { throw ('Actual matrix viewport width differs: ' + $shot.file) }
      $taskKey = $shot.page + ':' + $shot.width
      if ($taskKeys.ContainsKey($taskKey)) { throw ('Duplicate screenshot matrix cell: ' + $taskKey) }
      $taskKeys[$taskKey] = $true
    } elseif ($shot.actualWidth -le 0 -or $shot.width -le 0) { throw 'Invalid scenario viewport width' }
  }
  foreach ($taskPage in $taskPages) { foreach ($taskWidth in $taskWidths) {
    if (!$taskKeys.ContainsKey($taskPage + ':' + $taskWidth)) { throw ('Missing screenshot matrix cell: ' + $taskPage + ':' + $taskWidth) }
  } }
  Write-Output ('SELF_TEST_PASS=' + $taskReport.passed + ' SCALE=' + $taskReport.deviceScaleFactor + ' MATRIX=' + $taskMatrix.Count + ' REPORT=' + $TaskReportPath)
}

if ($ReportPath) {
  if ($Scales.Count -ne 1) { throw 'Report-only verification requires one requested scale' }
  Assert-DesktopReport (Resolve-Path -LiteralPath $ReportPath).Path $Scales[0]
  return
}
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
    $testPath = Join-Path $cachePath ('rjr-self-test-exe-' + [guid]::NewGuid().ToString('N'))
    $env:RJR_DATA_DIR = $testPath
    $argumentList = @('--self-test', ('--force-device-scale-factor=' + $scale.ToString([Globalization.CultureInfo]::InvariantCulture)))
    $process = Start-Process -FilePath $resolvedExe -ArgumentList $argumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput ($testPath + '-stdout.log') -RedirectStandardError ($testPath + '-stderr.log')
    $null = $process.Handle
    Write-Output ('SELF_TEST_SCALE=' + $scale + ' PID=' + $process.Id + ' DIRECTORY=' + $testPath)
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    try {
      while (!$process.WaitForExit(1000)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw ('Self-test did not finish; inspect synthetic process ' + $process.Id + ' and ' + $testPath) }
      }
    } catch {
      $taskWaitFailure = $_
      # The original handle pins the synthetic root; /T cleans its test child tree.
      try {
        if (!$process.HasExited) {
          & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $process.Id /T /F *> $null
          $null = $process.WaitForExit(10000)
        }
      } catch { }
      throw $taskWaitFailure
    }
    $null = $process.WaitForExit()
    $testExitCode = $process.ExitCode
    Write-Output ('SELF_TEST_EXIT=' + $testExitCode)
    $reportPath = Join-Path $testPath 'desktop-self-test.json'
    if ($null -eq $testExitCode) { throw 'Missing synthetic process exit code' }
    Assert-DesktopReport $reportPath $scale $testExitCode
  }
} finally { $env:RJR_DATA_DIR = $previousDataDir;foreach($key in $savedEnvironment.Keys){[Environment]::SetEnvironmentVariable($key,$savedEnvironment[$key],'Process')} }
