[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [string]$PreviousInstallerPath,
  [string]$FailureInstallerPath,
  [string]$ReportRoot = "$env:TEMP\penpot-desktop-acceptance",
  [switch]$Engineering
)

$ErrorActionPreference = "Stop"
if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Build -lt 22000) {
  throw "Acceptance requires Windows 11 x64"
}

function Assert-Installer([string]$Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if (-not $Engineering -and $signature.Status -ne "Valid") {
    throw "Release acceptance requires a valid Authenticode signature: $($signature.Status)"
  }
  return $resolved
}

function Install-Penpot([string]$Path) {
  $process = Start-Process -FilePath $Path -ArgumentList "/S" -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)" }
}

function Find-InstallRoot {
  $keys = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue
  $entry = $keys | Get-ItemProperty | Where-Object DisplayName -eq "Penpot Desktop" | Select-Object -First 1
  if (-not $entry.InstallLocation) { throw "Penpot Desktop current-user installation was not found" }
  return $entry.InstallLocation
}

$installer = Assert-Installer $InstallerPath
$previous = if ($PreviousInstallerPath) { Assert-Installer $PreviousInstallerPath } else { $null }
New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
$dataRoot = Join-Path $env:LOCALAPPDATA "xuchen-cloud\Penpot Desktop"
$sentinel = Join-Path $dataRoot "assets\acceptance-retain.txt"

if ($previous) {
  Install-Penpot $previous
  New-Item -ItemType Directory -Force -Path (Split-Path $sentinel) | Out-Null
  Set-Content -LiteralPath $sentinel -Value "retain-on-upgrade-and-uninstall" -NoNewline
}
Install-Penpot $installer
if ($previous -and (Get-Content -Raw -LiteralPath $sentinel) -ne "retain-on-upgrade-and-uninstall") { throw "Upgrade did not retain user data" }
$installRoot = Find-InstallRoot
$compat = Join-Path $installRoot "resources\acceptance\penpot-desktop-compat.exe"
$runtime = Join-Path $installRoot "resources\runtime\x86_64-pc-windows-msvc"
$plan = Join-Path $installRoot "resources\acceptance\windows-plan.json"
foreach ($path in @($compat, $runtime, $plan)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing installed acceptance input: $path" } }

& $compat credentials
if ($LASTEXITCODE -ne 0) { throw "Windows Credential Manager roundtrip failed" }
$aclRoot = Join-Path $ReportRoot "private-layout"
& $compat security $aclRoot
if ($LASTEXITCODE -ne 0) { throw "Private ACL acceptance failed" }

$work = Join-Path $ReportRoot "runtime"
$report = Join-Path $ReportRoot "compatibility-report.json"
$quoted = @($plan, $runtime, $work, $report) | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
$compatProcess = Start-Process -FilePath $compat -ArgumentList $quoted -PassThru -NoNewWindow
$publicConnections = @()
while (-not $compatProcess.HasExited) {
  $all = Get-CimInstance Win32_Process
  $owned = @($compatProcess.Id)
  do {
    $before = $owned.Count
    $owned += $all | Where-Object ParentProcessId -in $owned | Select-Object -ExpandProperty ProcessId
    $owned = @($owned | Sort-Object -Unique)
  } while ($owned.Count -ne $before)
  $connections = Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object OwningProcess -in $owned
  $publicConnections += $connections | Where-Object {
    ($_.State -eq "Listen" -and $_.LocalAddress -notin @("127.0.0.1", "::1")) -or
    ($_.State -ne "Listen" -and $_.RemoteAddress -notin @("127.0.0.1", "::1", "0.0.0.0", "::"))
  }
  Start-Sleep -Milliseconds 250
  $compatProcess.Refresh()
}
if ($compatProcess.ExitCode -ne 0) { throw "Installed runtime compatibility failed; see $report" }
if ($publicConnections.Count -ne 0) {
  $publicConnections | Select-Object State,LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess | ConvertTo-Json | Set-Content (Join-Path $ReportRoot "public-connections.json")
  throw "Installed runtime used a non-loopback network connection"
}

if (-not (Test-Path -LiteralPath $sentinel)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $sentinel) | Out-Null
  Set-Content -LiteralPath $sentinel -Value "retain-on-upgrade-and-uninstall" -NoNewline
}
if ($FailureInstallerPath) {
  $failed = Start-Process -FilePath (Assert-Installer $FailureInstallerPath) -ArgumentList "/S" -Wait -PassThru
  if ($failed.ExitCode -eq 0) { throw "The failure-path installer unexpectedly succeeded" }
  if ((Get-Content -Raw -LiteralPath $sentinel) -ne "retain-on-upgrade-and-uninstall") { throw "A failed installer changed user data" }
}

$uninstall = (Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" | Get-ItemProperty | Where-Object DisplayName -eq "Penpot Desktop" | Select-Object -First 1).UninstallString
if (-not $uninstall) { throw "Uninstall command was not found" }
$uninstallPath = $uninstall.Trim('"')
$process = Start-Process -FilePath $uninstallPath -ArgumentList "/S" -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Uninstaller failed with exit code $($process.ExitCode)" }
if (-not (Test-Path -LiteralPath $sentinel)) { throw "Uninstall removed user data" }

[pscustomobject]@{
  schemaVersion = 1
  passed = $true
  installer = $installer
  compatibilityReport = $report
  dataRetained = $true
  publicNetworkConnections = 0
  completedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $ReportRoot "acceptance-summary.json")
