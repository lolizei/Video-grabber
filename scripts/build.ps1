# Builds two zips in dist\ (run from anywhere: powershell -ExecutionPolicy Bypass -File scripts\build.ps1)
#   video-grabber-full-vX.zip   - everything, incl. YouTube (for GitHub releases)
#   video-grabber-store-vX.zip  - YouTube turned off (upload this to the Chrome Web Store)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$files = 'manifest.json', 'background.js', 'config.js', 'popup.html', 'popup.js',
         'downloader.html', 'downloader.js', 'ts-converter.js', 'vendor', 'style.css', 'icons'

if (Test-Path dist) { Remove-Item dist -Recurse -Force }
foreach ($build in 'full', 'store') {
  New-Item -ItemType Directory -Path "dist\$build" | Out-Null
  Copy-Item -Path $files -Destination "dist\$build" -Recurse
}

@'
// Chrome Web Store build: YouTube support is turned off.
globalThis.VG_CONFIG = {
  build: 'store',
  enableYouTube: false
};
'@ | Set-Content -Path dist\store\config.js -Encoding UTF8

# Zip with forward-slash paths (Compress-Archive on Windows PowerShell 5 writes backslashes,
# which the Chrome Web Store rejects).
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function New-ExtensionZip($source, $destination) {
  $base = (Resolve-Path $source).Path.TrimEnd('\') + '\'
  $zip = [System.IO.Compression.ZipFile]::Open($destination, 'Create')
  try {
    Get-ChildItem $source -Recurse -File | ForEach-Object {
      $entry = $_.FullName.Substring($base.Length).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, 'Optimal') | Out-Null
    }
  } finally { $zip.Dispose() }
}

foreach ($build in 'full', 'store') {
  New-ExtensionZip "dist\$build" (Join-Path $root "dist\video-grabber-$build-v$version.zip")
}
Write-Host "Built dist\video-grabber-full-v$version.zip and dist\video-grabber-store-v$version.zip"
