# Build a portable copy: source + built frontend, without node_modules / data / .env
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root ".pack"
$target = Join-Path $stage "paper-agent"
$zip = Join-Path (Split-Path -Parent $root) "paper-agent-portable.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $target -Force | Out-Null

foreach ($f in @("package.json", ".env.example", ".gitignore", "README.md", "LICENSE")) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $target $f) }
}

foreach ($d in @("server", "web", "scripts", "examples", "fixtures", "docs")) {
  $src = Join-Path $root $d
  if (Test-Path $src) { Copy-Item $src $target -Recurse -Force }
}

# prune: design artifacts, big binaries, source maps
Get-ChildItem (Join-Path $target "docs") -Filter "*.pptx" -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem (Join-Path $target "docs") -Filter "ppt-text.txt" -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem (Join-Path $target "fixtures") -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -ne ".txt" } | Remove-Item -Force
Get-ChildItem (Join-Path $target "web\dist\assets") -Filter "*.map" -ErrorAction SilentlyContinue |
  Remove-Item -Force
Get-ChildItem (Join-Path $target "scripts") -Filter "pack.ps1" -ErrorAction SilentlyContinue | Remove-Item -Force
# plugin-only frontend build (base /paper-agent/) is not part of the source package
$pluginDist = Join-Path $target "web\dist-paper"
if (Test-Path $pluginDist) { Remove-Item $pluginDist -Recurse -Force }

$startHere = @"
paper-agent -- portable copy
============================

1) npm install --ignore-scripts
2) copy .env.example to .env, fill LLM_API_KEY (DeepSeek or any OpenAI-compatible endpoint)
3) npm start            -> http://127.0.0.1:8787   (web/dist is prebuilt)
   rebuild frontend: npm run build && npm start

Porting guide: docs/  (Chinese)

Layout: server/ backend + agent core | web/ frontend | docs/ | scripts/ self-tests
"@
Set-Content -Path (Join-Path $target "START-HERE.txt") -Value $startHere -Encoding ASCII

if (Test-Path $zip) { Remove-Item $zip -Force }
# Use system tar: Compress-Archive writes backslash paths on PS 5.1, which breaks unzip elsewhere.
# -C keeps the archive root at the stage folder no matter what the current directory is.
& tar.exe -a -c -f $zip -C $stage "paper-agent" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zip) -or (Get-Item $zip).Length -eq 0) {
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path $target -DestinationPath $zip -CompressionLevel Optimal
}

$count = (Get-ChildItem $target -Recurse -File | Measure-Object).Count
$size = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host ("OK {0}" -f $zip)
Write-Host ("files={0} zip={1}MB" -f $count, $size)
