$ErrorActionPreference = "Stop"
$ClojureArguments = @($args)
$desktopRoot = Split-Path -Parent $PSScriptRoot
$toolchainRoot = Join-Path $desktopRoot ".cache\toolchains"

function Find-SingleFile([string]$filter, [string]$label) {
  $matches = @(Get-ChildItem -LiteralPath $toolchainRoot -Filter $filter -File -Recurse -ErrorAction SilentlyContinue)
  if ($matches.Count -ne 1) {
    throw "Expected one $label under $toolchainRoot, found $($matches.Count)"
  }
  return $matches[0].FullName
}

$module = $env:PENPOT_CLOJURE_TOOLS_MODULE
if (-not $module) {
  $module = Find-SingleFile "ClojureTools.psd1" "ClojureTools module"
}
if (-not $env:JAVA_HOME) {
  $java = Find-SingleFile "java.exe" "JDK java.exe"
  $env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $java)
}
$env:Path = "$(Join-Path $env:JAVA_HOME 'bin');$env:Path"

$normalized = @()
foreach ($argument in $ClojureArguments) {
  $decoded = $argument
  if ($argument.StartsWith("PENPOT_BASE64:")) {
    try {
      $bytes = [Convert]::FromBase64String($argument.Substring("PENPOT_BASE64:".Length))
      $decoded = [Text.Encoding]::UTF8.GetString($bytes)
    } catch {
      throw "Invalid encoded Clojure argument"
    }
  }
  if ($decoded -match '^-(M|T|X):(.+)$') {
    $normalized += "-$($Matches[1]):"
    $normalized += $Matches[2]
  } else {
    $normalized += $decoded
  }
}

Import-Module -Name $module -Force
if ($env:PENPOT_CLOJURE_TRACE_ARGUMENTS) {
  Write-Output "Clojure adapter input: $($ClojureArguments | ConvertTo-Json -Compress)"
  Write-Output "Clojure adapter normalized: $($normalized | ConvertTo-Json -Compress)"
  Write-Output "Clojure adapter command: $((Get-Command clojure).CommandType)"
}
Invoke-Clojure @normalized
exit $LASTEXITCODE
