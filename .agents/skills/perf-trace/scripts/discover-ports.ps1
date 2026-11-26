# Read-only process/loopback discovery. Never prints command lines or reads application stores.
$ErrorActionPreference = 'Stop'
$appProcesses = @(Get-CimInstance Win32_Process -Filter "Name='MetaAgent.exe' OR Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' })
$appPids = @($appProcesses | ForEach-Object { [int]$_.ProcessId })
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $appPids -and $_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') })
@($listeners | ForEach-Object { @{ port = $_.LocalPort; pid = $_.OwningProcess } } | Sort-Object { $_.port } -Unique) | ConvertTo-Json -Compress
