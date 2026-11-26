# Accoding Companion launcher for Windows.
param(
  [switch]$SoftwareOnly,
  [switch]$PresetOnly,
  [switch]$Yes,
  [switch]$NoLaunch,
  [switch]$Next
)
$ErrorActionPreference = 'Stop'
if ($SoftwareOnly -and $PresetOnly) { throw 'Choose only one component filter.' }
$cliPackage = '@routilet/accoding-companion'
$presetPackage = '@routilet/c-exam-kit-preset'
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
    $version = [version]((& node.exe -p 'process.versions.node').Trim())
    $valid = $version -ge [version]'22.12'
  } catch { $valid = $false }
}
if (-not $valid) {
  Write-Host 'Node.js 22.12 or later and npm are required.'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget -and (Confirm-Action 'Install Node.js LTS using winget?')) {
    & winget.exe install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'winget could not install Node.js.' }
    Write-Host 'Double-click the launcher again after Node.js is installed.'
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
  $output = & npm.cmd view "$Package@$channel" version --prefer-online --fetch-retries=0 --fetch-timeout=5000 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $output) {
    return $null
  }
  $version = ([string]($output | Select-Object -Last 1)).Trim()
  if ($version -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') { return $version }
  return $null
}
$globalRoot = & npm.cmd root --global
if ($LASTEXITCODE -ne 0 -or -not $globalRoot) { throw 'Cannot find the global npm directory.' }
$globalRoot = $globalRoot.Trim()
function Installed-Version([string]$Package) {
  $metadata = Join-Path (Join-Path $globalRoot $Package) 'package.json'
  if (Test-Path -LiteralPath $metadata -PathType Leaf) {
    try {
      $version = (Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json).version
      if ($version) { return [string]$version }
    } catch {}
  }
  return 'not installed'
}

$cliEntry = Join-Path $globalRoot '@routilet\accoding-companion\dist\accoding.mjs'
$manifest = Join-Path $globalRoot '@routilet\c-exam-kit-preset\preset\manifest.json'
$legacyCli = Join-Path $globalRoot '@annouimo\accoding-companion\dist\accoding.mjs'
$hasCli = (Test-Path -LiteralPath $cliEntry -PathType Leaf) -or (Test-Path -LiteralPath $legacyCli -PathType Leaf)
function Start-Companion {
  if (-not $NoLaunch -and -not $PresetOnly -and (Test-Path -LiteralPath $cliEntry -PathType Leaf)) {
    & node.exe $cliEntry
    exit $LASTEXITCODE
  } elseif (-not $NoLaunch -and -not $PresetOnly -and (Test-Path -LiteralPath $legacyCli -PathType Leaf)) {
    & node.exe $legacyCli
    exit $LASTEXITCODE
  }
}

$needsCli = $false
$needsPreset = $false
if (-not $PresetOnly) {
  $cliVersion = Remote-Version $cliPackage
  if (-not $cliVersion) {
    if (-not $hasCli) { throw 'Cannot download Accoding Companion. Check your connection and open the launcher again.' }
    Write-Host 'Update check unavailable. Opening the installed version.'
    Start-Companion
    exit 0
  }
  $current = Installed-Version $cliPackage
  $needsCli = $current -ne $cliVersion -or -not $hasCli
  if ($needsCli) { Write-Host "Accoding Companion: $current -> $cliVersion" }
}
if (-not $SoftwareOnly) {
  $presetVersion = Remote-Version $presetPackage
  if ($presetVersion) {
    $currentPreset = Installed-Version $presetPackage
    $needsPreset = $currentPreset -ne $presetVersion -or -not (Test-Path -LiteralPath $manifest -PathType Leaf)
    if ($needsPreset) { Write-Host "C Exam Kit: $currentPreset -> $presetVersion" }
  } elseif ($PresetOnly -or -not $hasCli) {
    throw 'Cannot download C Exam Kit. Check your connection and open the launcher again.'
  }
}
if (-not $needsCli -and -not $needsPreset) {
  Start-Companion
  exit 0
}
if (-not (Confirm-Action 'Proceed with installation/update?')) {
  Start-Companion
  exit 0
}
if ($needsCli) {
  if ((Test-Path -LiteralPath $legacyCli -PathType Leaf) -and -not (Test-Path -LiteralPath $cliEntry -PathType Leaf)) {
    Write-Host "The old global CLI owns the accoding command. Use the new native launcher, or run npm uninstall -g @annouimo/accoding-companion, then rerun this script."
    Start-Companion
    exit 2
  }
  & npm.cmd install --global --ignore-scripts --no-audit --no-fund "$cliPackage@$cliVersion"
  if ($LASTEXITCODE -ne 0) { throw 'CLI installation failed.' }
  Write-Host 'Accoding Companion software installed.'
}
if ($needsPreset) {
  & npm.cmd install --global --ignore-scripts --no-audit --no-fund "$presetPackage@$presetVersion"
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
Start-Companion
