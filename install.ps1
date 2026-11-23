# Accoding Companion install/update: user-initiated, not run from the TUI.
param(
  [switch]$SoftwareOnly,
  [switch]$PresetOnly,
  [switch]$Yes,
  [switch]$Next
)
$ErrorActionPreference = 'Stop'
if ($SoftwareOnly -and $PresetOnly) { throw 'Choose only one component filter.' }
$cliPackage = '@annouimo/accoding-companion'
$presetPackage = '@annouimo/c-exam-kit-preset'
$channel = if ($Next) { 'next' } else { 'latest' }

function Confirm-Action([string]$Message) {
  if ($Yes) { return $true }
  $answer = Read-Host "$Message [y/N]"
  return $answer -match '^(y|yes)$'
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
$valid = $false
if ($node -and $npm) {
  try {
    $major = [int]((& node.exe -p "process.versions.node.split('.')[0]").Trim())
    $valid = $major -ge 22
  } catch { $valid = $false }
}
if (-not $valid) {
  Write-Host 'Node.js LTS (22+) and npm are required.'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget -and (Confirm-Action 'Install Node.js LTS using winget?')) {
    & winget.exe install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'winget could not install Node.js.' }
    Write-Host 'Open a new PowerShell window and rerun this installer.'
  } else {
    if (Confirm-Action 'Open the official Node.js download page?') {
      Start-Process 'https://nodejs.org/en/download/'
    }
    Write-Host 'Install Node.js LTS and rerun this installer.'
  }
  exit 2
}
Write-Host "Node $(node.exe --version), npm $(npm.cmd --version): ready"
Write-Host "Release channel: $channel"

function Remote-Version([string]$Package) {
  $output = & npm.cmd view "$Package@$channel" version --fetch-retries=1 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $output) {
    throw "Cannot query $Package from the configured npm registry."
  }
  return ([string]($output | Select-Object -Last 1)).Trim()
}
function Installed-Cli {
  $output = & npm.cmd ls -g --depth=0 --json 2>$null
  try {
    $obj = $output | Out-String | ConvertFrom-Json
    $entry = $obj.dependencies.PSObject.Properties[$cliPackage]
    if ($entry) { return [string]$entry.Value.version }
  } catch {}
  return 'not installed'
}

$localData = $env:LOCALAPPDATA
if (-not $localData) { $localData = Join-Path $env:USERPROFILE 'AppData\Local' }
$dataRoot = Join-Path $localData 'Accoding Companion'

$needsCli = $false
$needsPreset = $false
if (-not $PresetOnly) {
  $cliVersion = Remote-Version $cliPackage
  $current = Installed-Cli
  Write-Host "Software: $current -> $cliVersion"
  $needsCli = $current -ne $cliVersion
}
if (-not $SoftwareOnly) {
  $presetVersion = Remote-Version $presetPackage
  if ($presetVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$') {
    throw 'Invalid preset version returned by npm.'
  }
  $target = Join-Path (Join-Path $dataRoot 'presets') $presetVersion
  $manifest = Join-Path $target 'node_modules\@annouimo\c-exam-kit-preset\preset\manifest.json'
  $needsPreset = -not (Test-Path -LiteralPath $manifest -PathType Leaf)
  if ($needsPreset) { Write-Host "C Exam Kit: download $presetVersion" }
  else { Write-Host "C Exam Kit: $presetVersion (installed)" }
}
if (-not $needsCli -and -not $needsPreset) {
  Write-Host 'Everything selected is already up to date.'
  exit 0
}
if (-not (Confirm-Action 'Proceed with installation/update?')) {
  Write-Host 'Cancelled.'
  exit 0
}
if ($needsCli) {
  & npm.cmd install --global --ignore-scripts --no-audit --no-fund "$cliPackage@$cliVersion"
  if ($LASTEXITCODE -ne 0) { throw 'CLI installation failed.' }
  Write-Host 'Accoding Companion software installed.'
}
if ($needsPreset) {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  & npm.cmd install --prefix $target --no-save --ignore-scripts --no-audit --no-fund "$presetPackage@$presetVersion"
  if ($LASTEXITCODE -ne 0) { throw 'Preset download failed.' }
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw 'Downloaded package is missing preset/manifest.json.'
  }
  $data = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  if ($data.schemaVersion -ne 1 -or $data.language -ne 'c' -or
      $data.standard -ne 'c99' -or -not $data.components) {
    throw 'Invalid C Exam Kit manifest.'
  }
  Write-Host "C Exam Kit $presetVersion installed. Existing coursework is unchanged."
}
Write-Host "Run 'accoding' in a new terminal to launch."
