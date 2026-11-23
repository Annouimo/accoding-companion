param([switch]$SoftwareOnly, [switch]$PresetOnly, [switch]$Yes, [switch]$Next)
& (Join-Path $PSScriptRoot 'launch.ps1') -NoLaunch @PSBoundParameters
exit $LASTEXITCODE
