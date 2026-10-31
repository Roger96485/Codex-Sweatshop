$ErrorActionPreference = 'Stop'
$sweatshopRoot = Split-Path -Parent $PSScriptRoot
$sweatshopPackaged = Join-Path $sweatshopRoot 'dist\Codex-Sweatshop\Codex Sweatshop.exe'
if (Test-Path -LiteralPath $sweatshopPackaged) {
    Start-Process -FilePath $sweatshopPackaged -ArgumentList '--quit' -WorkingDirectory (Split-Path -Parent $sweatshopPackaged) -WindowStyle Hidden | Out-Null
    exit 0
}
$sweatshopElectron = Join-Path $sweatshopRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $sweatshopElectron)) { exit 0 }
Start-Process -FilePath $sweatshopElectron -ArgumentList ('"' + $sweatshopRoot + '" --quit') -WorkingDirectory $sweatshopRoot -WindowStyle Hidden | Out-Null
