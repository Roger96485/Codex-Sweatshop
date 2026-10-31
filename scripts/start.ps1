$ErrorActionPreference = 'Stop'
$sweatshopRoot = Split-Path -Parent $PSScriptRoot
$sweatshopPackaged = Join-Path $sweatshopRoot 'dist\Codex-Sweatshop\Codex Sweatshop.exe'
if (Test-Path -LiteralPath $sweatshopPackaged) {
    Start-Process -FilePath $sweatshopPackaged -WorkingDirectory (Split-Path -Parent $sweatshopPackaged) -WindowStyle Normal | Out-Null
    exit 0
}
$sweatshopElectron = Join-Path $sweatshopRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $sweatshopElectron)) { throw 'Run npm ci and npm run setup:desktop first, or extract the Windows ZIP package.' }
Start-Process -FilePath $sweatshopElectron -ArgumentList ('"' + $sweatshopRoot + '"') -WorkingDirectory $sweatshopRoot -WindowStyle Normal | Out-Null
