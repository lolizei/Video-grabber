# Builds two zips in dist\ (run from anywhere: powershell -ExecutionPolicy Bypass -File scripts\build.ps1)
#   video-grabber-full-vX.zip   - everything, incl. YouTube (for GitHub releases)
#   video-grabber-store-vX.zip  - YouTube turned off (upload this to the Chrome Web Store)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$files = 'manifest.json', 'background.js', 'config.js', 'popup.html', 'popup.js',
         'downloader.html', 'downloader.js', 'ts-converter.js', 'youtube', 'vendor', 'shared', 'background', 'content', 'ui', 'style.css', 'icons'

$distRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'dist'))
if (-not $distRoot.StartsWith($root.TrimEnd('\') + '\')) { throw 'Invalid build output path' }
if (Test-Path -LiteralPath $distRoot) {
  if ((Get-Item -LiteralPath $distRoot).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Build output cannot be a link' }
  Remove-Item -LiteralPath $distRoot -Recurse -Force
}
foreach ($build in 'full', 'store') {
  New-Item -ItemType Directory -Path "dist\$build" | Out-Null
  Copy-Item -Path $files -Destination "dist\$build" -Recurse
}

@'
// Chrome Web Store build: YouTube support is turned off.
globalThis.VG_CONFIG = {
  build: 'store',
  ENABLE_YOUTUBE: false,
  enableYouTube: false,
  DEBUG: false
};
'@ | Set-Content -Path dist\store\config.js -Encoding UTF8

# Exclude conversion code/assets and UI from the store package entirely.
foreach ($relative in 'youtube','vendor\ffmpeg','shared\youtube.js','background\youtube.js','ui\youtube-tab.js') {
  $targetPath = [System.IO.Path]::GetFullPath((Join-Path "$distRoot\store" $relative))
  if (-not $targetPath.StartsWith("$distRoot\store\")) { throw 'Invalid store exclusion path' }
  Remove-Item -LiteralPath $targetPath -Recurse -Force
}
$popupPath = Join-Path $distRoot 'store\popup.html'
$popupText = Get-Content -LiteralPath $popupPath -Raw
$popupText = $popupText -replace '(?m)^.*id="youtube-tab".*\r?\n','' -replace '(?s)\s*<section id="youtube-panel".*?</section>','' -replace '(?m)^.*src="ui/youtube-tab.js".*\r?\n',''
Set-Content -LiteralPath $popupPath -Value $popupText -Encoding UTF8
$manifestPath = Join-Path $distRoot 'store\manifest.json'
$storeManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$storeManifest.content_security_policy.extension_pages = "script-src 'self'; object-src 'self'"
$storeManifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

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
