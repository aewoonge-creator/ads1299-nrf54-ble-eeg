param(
    [string]$Sdk = 'C:\ncs\v2.9.3',
    [string]$Toolchain = 'C:\ncs\toolchains\b620d30767',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\docs\firmware')
)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $repository 'firmware\nrf54_ads1299_ble'
$stage = Join-Path $env:TEMP ('ads1299-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $stage 'app') -Recurse
$environment = Get-Content -LiteralPath (Join-Path $Toolchain 'environment.json') -Raw | ConvertFrom-Json
foreach ($entry in $environment.env_vars) {
    $value = if ($entry.type -eq 'relative_paths') {
        ($entry.values | ForEach-Object { Join-Path $Toolchain $_ }) -join [IO.Path]::PathSeparator
    } else { $entry.value }
    if ($entry.existing_value_treatment -eq 'prepend_to') {
        $value += [IO.Path]::PathSeparator + [Environment]::GetEnvironmentVariable($entry.key, 'Process')
    }
    [Environment]::SetEnvironmentVariable($entry.key, $value, 'Process')
}
$env:ZEPHYR_BASE = Join-Path $Sdk 'zephyr'
$env:PYTHONUTF8 = '1'
$env:PYTHONHOME = Join-Path $Toolchain 'opt\bin'
$python = Join-Path $Toolchain 'opt\bin\python.exe'
$build = Join-Path $stage 'build'
Push-Location $Sdk
try {
    & $python -m west build -b nrf54l15dk/nrf54l15/cpuapp --no-sysbuild -s (Join-Path $stage 'app') -d $build
    if ($LASTEXITCODE -ne 0) { throw "Firmware build failed. Build directory: $stage" }
} finally { Pop-Location }
$versionMatch = [regex]::Match((Get-Content -LiteralPath (Join-Path $source 'src\main.c') -Raw), '#define\s+FW_VERSION\s+"([^"]+)"')
if (-not $versionMatch.Success) { throw 'FW_VERSION is missing.' }
$version = $versionMatch.Groups[1].Value
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$hexName = 'ads1299-nrf54l15-' + $version + '.hex'
$hex = Join-Path $OutputDirectory $hexName
Copy-Item -LiteralPath (Join-Path $build 'zephyr\zephyr.hex') -Destination $hex
$sources = @('CMakeLists.txt', 'prj.conf', 'src/main.c', 'src/ads1299.c', 'src/ads1299.h', 'boards/nrf54l15dk_nrf54l15_cpuapp.overlay')
$manifest = [ordered]@{
    firmware_version = $version
    board = 'nrf54l15dk/nrf54l15/cpuapp'
    sdk = (Split-Path $Sdk -Leaf)
    hex_file = $hexName
    sha256 = (Get-FileHash -LiteralPath $hex -Algorithm SHA256).Hash.ToLowerInvariant()
    build_utc = [DateTime]::UtcNow.ToString('o')
    drdy = 'P1.11'
    start_stop = 'SPI commands; no START GPIO'
    auto_probe = $false
    sources = @($sources | ForEach-Object {
        [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $source $_) -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    validation = 'Compiled from repository sources; not flashed or wirelessly measured in this build.'
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json') -Encoding utf8
Write-Output "Firmware: $hex"
Write-Output "SHA256: $($manifest.sha256)"
Write-Output "Build directory retained: $stage"
