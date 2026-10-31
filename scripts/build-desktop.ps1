$ErrorActionPreference = 'Stop'
$sweatshopRoot = Split-Path -Parent $PSScriptRoot
$sweatshopMetadata = Get-Content -LiteralPath (Join-Path $sweatshopRoot 'package.json') -Raw | ConvertFrom-Json
$sweatshopBuildScript = Join-Path $PSScriptRoot 'build-desktop.mjs'
& node.exe $sweatshopBuildScript
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
$sweatshopFolder = Join-Path $sweatshopRoot 'dist\Codex-Sweatshop'
$sweatshopArchive = Join-Path $sweatshopRoot ('dist\Codex-Sweatshop-' + $sweatshopMetadata.version + '-Windows.zip')
Compress-Archive -LiteralPath $sweatshopFolder -DestinationPath $sweatshopArchive -Force
$sweatshopHasher = [Security.Cryptography.SHA256]::Create()
$sweatshopArchiveStream = [IO.File]::OpenRead($sweatshopArchive)
try { $sweatshopHash = [BitConverter]::ToString($sweatshopHasher.ComputeHash($sweatshopArchiveStream)).Replace('-','').ToLowerInvariant() }
finally { $sweatshopArchiveStream.Dispose(); $sweatshopHasher.Dispose() }
Set-Content -LiteralPath ($sweatshopArchive + '.sha256') -Value ($sweatshopHash + '  ' + [IO.Path]::GetFileName($sweatshopArchive)) -Encoding ascii
Write-Host "Windows package: $sweatshopArchive"
