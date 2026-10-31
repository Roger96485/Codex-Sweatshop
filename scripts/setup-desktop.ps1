$ErrorActionPreference = 'Stop'
$sweatshopRoot = Split-Path -Parent $PSScriptRoot
$sweatshopElectron = Join-Path $sweatshopRoot 'node_modules\electron'
if (-not (Test-Path -LiteralPath (Join-Path $sweatshopElectron 'package.json'))) { throw 'Run npm ci first.' }
$sweatshopVersion = (Get-Content -LiteralPath (Join-Path $sweatshopElectron 'package.json') -Raw | ConvertFrom-Json).version
$sweatshopRuntime = Join-Path $sweatshopElectron 'dist'
$sweatshopExe = Join-Path $sweatshopRuntime 'electron.exe'
$sweatshopVersionFile = Join-Path $sweatshopRuntime 'version'
if ((Test-Path -LiteralPath $sweatshopExe) -and (Test-Path -LiteralPath $sweatshopVersionFile)) {
    $sweatshopInstalled = (Get-Content -LiteralPath $sweatshopVersionFile -Raw).Trim().TrimStart('v')
    if ($sweatshopInstalled -eq $sweatshopVersion) {
        Set-Content -LiteralPath (Join-Path $sweatshopElectron 'path.txt') -Value 'electron.exe' -NoNewline -Encoding ascii
        Write-Host "Electron $sweatshopVersion is ready."
        exit 0
    }
}
$sweatshopArchiveName = "electron-v$sweatshopVersion-win32-x64.zip"
$sweatshopCache = Join-Path $sweatshopRoot '.research'
New-Item -ItemType Directory -Path $sweatshopCache -Force | Out-Null
$sweatshopArchive = Join-Path $sweatshopCache $sweatshopArchiveName
$sweatshopChecksums = Get-Content -LiteralPath (Join-Path $sweatshopElectron 'checksums.json') -Raw | ConvertFrom-Json
$sweatshopExpected = $sweatshopChecksums.PSObject.Properties[$sweatshopArchiveName].Value
if (-not $sweatshopExpected) { throw 'Official checksum unavailable.' }
if (-not (Test-Path -LiteralPath $sweatshopArchive)) {
    $sweatshopUrl = "https://github.com/electron/electron/releases/download/v$sweatshopVersion/$sweatshopArchiveName"
    Invoke-WebRequest -Uri $sweatshopUrl -OutFile $sweatshopArchive -UseBasicParsing
}
$sweatshopActual = (Get-FileHash -LiteralPath $sweatshopArchive -Algorithm SHA256).Hash
if ($sweatshopActual -ne $sweatshopExpected) { throw "Electron checksum mismatch: $sweatshopArchive" }
Expand-Archive -LiteralPath $sweatshopArchive -DestinationPath $sweatshopRuntime -Force
Set-Content -LiteralPath (Join-Path $sweatshopElectron 'path.txt') -Value 'electron.exe' -NoNewline -Encoding ascii
Write-Host "Electron $sweatshopVersion is ready (official SHA256 verified)."
