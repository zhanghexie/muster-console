param(
  [ValidateSet('Install', 'Uninstall')][string]$Action = 'Install',
  [string]$InstallDir,
  [string]$Executable = 'MusterConsole.exe',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$MusterLauncherMarker = '@rem Muster Console CLI launcher v1'

function Get-MetaAgentPathKey([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"')).TrimEnd('\', '/').ToLowerInvariant()
}
function Update-MetaAgentUserPath([string]$Current, [string]$Bin, [bool]$Remove) {
  $target = Get-MetaAgentPathKey $Bin
  $parts = @($Current -split ';' | Where-Object { (Get-MetaAgentPathKey $_) -ne $target })
  # Preserve all unrelated entries, order and expandable variables; never use setx.
  $value = $parts -join ';'
  if ($Remove) { return $value }
  if ([string]::IsNullOrEmpty($value)) { return $Bin }
  return $value.TrimEnd(';') + ';' + $Bin
}
function Test-MusterOwnedLauncher([string]$File) {
  return (Test-Path -LiteralPath $File -PathType Leaf) -and ((Get-Content -LiteralPath $File -TotalCount 1) -eq $MusterLauncherMarker)
}
function Find-MusterCommandConflict([string]$SearchPath, [string]$OwnedBin) {
  foreach ($part in ($SearchPath -split ';')) {
    if ([string]::IsNullOrWhiteSpace($part)) { continue }
    $directory = [Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"'))
    foreach ($extension in @('.exe', '.com', '.cmd', '.bat', '.ps1')) {
      $candidate = Join-Path $directory ('muster' + $extension)
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
      if (($extension -eq '.cmd') -and (Test-MusterOwnedLauncher $candidate)) { continue }
      return $candidate
    }
  }
  return $null
}
function Send-MetaAgentEnvironmentChanged {
  if (-not ('MetaAgentCli.EnvironmentBroadcast' -as [type])) {
    Add-Type -Namespace MetaAgentCli -Name EnvironmentBroadcast -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'
  }
  $broadcastResult = [UIntPtr]::Zero
  [void][MetaAgentCli.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$broadcastResult)
}
function Get-MusterLauncherContent {
  $contents = @'
@rem Muster Console CLI launcher v1
@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\MusterConsole.exe" "%~dp0..\resources\app.asar.unpacked\out\main\cliRuns\entry.mjs" %*
exit /b %errorlevel%
'@
  return $contents.Replace("`r`n", "`n").Replace("`n", "`r`n")
}
function Invoke-MetaAgentCliInstall {
  if ([string]::IsNullOrWhiteSpace($InstallDir)) { throw 'InstallDir is required' }
  if ($Executable -ne 'MusterConsole.exe') { throw 'Unexpected executable name' }
  $resolvedInstall = [IO.Path]::GetFullPath($InstallDir)
  $bin = Join-Path $resolvedInstall 'bin'
  $launcher = Join-Path $bin 'muster.cmd'
  $registryKey = 'HKCU:\Software\Muster\MusterConsoleCLI'
  $owner = Get-ItemProperty -LiteralPath $registryKey -ErrorAction SilentlyContinue
  $oldBin = if ($owner) { $owner.Bin } else { $null }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($Action -eq 'Uninstall') {
    $owned = (Get-MetaAgentPathKey $oldBin) -eq (Get-MetaAgentPathKey $bin)
    $owned = $owned -and (Test-MusterOwnedLauncher $launcher)
    if ($DryRun) { return [pscustomobject]@{ action = $Action; bin = $bin; owned = $owned } | ConvertTo-Json -Compress }
    if ($owned) {
      [Environment]::SetEnvironmentVariable('Path', (Update-MetaAgentUserPath $userPath $bin $true), 'User')
      Remove-Item -LiteralPath $launcher
      Remove-ItemProperty -LiteralPath $registryKey -Name Bin
      Send-MetaAgentEnvironmentChanged
    }
    return
  }
  $entry = Join-Path $resolvedInstall 'resources\app.asar.unpacked\out\main\cliRuns\entry.mjs'
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedInstall $Executable) -PathType Leaf) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Packaged CLI entry or bundled runtime is missing' }
  if ((Test-Path -LiteralPath $launcher) -and -not (Test-MusterOwnedLauncher $launcher)) { throw "Refusing to overwrite foreign launcher: $launcher" }
  $conflict = Find-MusterCommandConflict ($env:Path + ';' + $userPath + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')) $bin
  if ($DryRun) { return [pscustomobject]@{ action = $Action; bin = $bin; conflict = $conflict; userPath = (Update-MetaAgentUserPath $userPath $bin $false) } | ConvertTo-Json -Compress }
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  [IO.File]::WriteAllText($launcher, (Get-MusterLauncherContent), [Text.Encoding]::ASCII)
  if ($conflict) { throw "Command conflict: $conflict. Existing command preserved; PATH unchanged. Use $launcher directly or resolve the conflict and reinstall." }
  $nextPath = $userPath
  if ($oldBin -and ((Get-MetaAgentPathKey $oldBin) -ne (Get-MetaAgentPathKey $bin)) -and (Test-MusterOwnedLauncher (Join-Path $oldBin 'muster.cmd'))) { $nextPath = Update-MetaAgentUserPath $nextPath $oldBin $true }
  [Environment]::SetEnvironmentVariable('Path', (Update-MetaAgentUserPath $nextPath $bin $false), 'User')
  New-Item -Path $registryKey -Force | Out-Null
  New-ItemProperty -LiteralPath $registryKey -Name Bin -Value $bin -PropertyType String -Force | Out-Null
  Send-MetaAgentEnvironmentChanged
  Write-Output 'Muster Console CLI installed. Reopen existing terminals or Agent apps, then run: muster --help'
}
if ($MyInvocation.InvocationName -ne '.') { Invoke-MetaAgentCliInstall }
