param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [ValidateRange(2, 1800)][int]$DurationSec = 30,
  [ValidateRange(1000, 5000)][int]$IntervalMs = 1000
)
# Read-only OS CPU/RSS/private-byte sampling of one verified Electron process tree.
# CPU corePercent may exceed 100; machinePercent divides by logical processors.
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutputPath) { throw 'Output already exists; preserve the baseline and choose a new path' }
$rootInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$RootPid"
if ($null -eq $rootInfo -or $rootInfo.Name -notin @('MetaAgent.exe', 'electron.exe') -or $rootInfo.CommandLine -match '--type=') { throw 'RootPid must identify the intended MetaAgent/Electron main process' }
$creationTime = $rootInfo.CreationDate
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null
$writer = [System.IO.StreamWriter]::new($resolvedOutput, $false, [System.Text.UTF8Encoding]::new($false))
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$previous = @{}
try {
  while ($timer.Elapsed.TotalSeconds -lt $DurationSec) {
    $processes = @(Get-CimInstance Win32_Process)
    $currentRoot = $processes | Where-Object { $_.ProcessId -eq $RootPid }
    if ($null -eq $currentRoot -or $currentRoot.CreationDate -ne $creationTime) { throw 'Target process exited or PID was reused; capture is incomplete' }
    $members = @($RootPid)
    do {
      $added = @($processes | Where-Object { $_.ParentProcessId -in $members -and $_.ProcessId -notin $members } | ForEach-Object { [int]$_.ProcessId })
      $members += $added
    } while ($added.Count -gt 0)
    $rows = @()
    foreach ($info in $processes | Where-Object { $_.ProcessId -in $members }) {
      $process = Get-Process -Id $info.ProcessId -ErrorAction SilentlyContinue
      if ($null -eq $process) { continue }
      $at = $timer.Elapsed.TotalMilliseconds
      $cpuMs = $process.TotalProcessorTime.TotalMilliseconds
      $key = "$($info.ProcessId):$($info.CreationDate.ToUniversalTime().Ticks)"
      $corePercent = $null
      if ($previous.ContainsKey($key)) {
        $elapsed = $at - $previous[$key].at
        if ($elapsed -gt 0) { $corePercent = ($cpuMs - $previous[$key].cpuMs) / $elapsed * 100 }
      }
      $previous[$key] = @{ at = $at; cpuMs = $cpuMs }
      $role = if ($info.ProcessId -eq $RootPid) { 'main' } elseif ($info.CommandLine -match '--type=([^\s]+)') { $Matches[1] } else { 'child' }
      $rows += @{ pid = [int]$info.ProcessId; parentPid = [int]$info.ParentProcessId; name = $info.Name; role = $role; corePercent = $corePercent; machinePercent = if ($null -ne $corePercent) { $corePercent / [Environment]::ProcessorCount } else { $null }; workingSetBytes = $process.WorkingSet64; privateBytes = $process.PrivateMemorySize64; handles = $process.HandleCount; threads = $process.Threads.Count }
    }
    $writer.WriteLine((@{ elapsedMs = $timer.Elapsed.TotalMilliseconds; wall = [DateTime]::UtcNow.ToString('o'); logicalProcessors = [Environment]::ProcessorCount; rootPid = $RootPid; processes = $rows } | ConvertTo-Json -Depth 5 -Compress))
    $writer.Flush()
    Start-Sleep -Milliseconds $IntervalMs
  }
} finally { $writer.Dispose() }
