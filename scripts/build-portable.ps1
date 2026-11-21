# Build the fully portable Windows package:
#   bundled Node runtime + prod deps + prebuilt frontend + one-click 启动.bat,
#   wrapped in a single top-level folder with its own README.
# The target machine needs no Node.js / npm.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$stageRoot = Join-Path $root ".portable"
$pkg = Join-Path $stageRoot "paper-agent-portable"
$app = Join-Path $pkg "app"
$zip = Join-Path (Split-Path -Parent $root) "paper-agent-portable-win64.zip"

if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $app -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $pkg "runtime") -Force | Out-Null

Write-Host "[1/6] copy app source"
foreach ($item in @("server", "web", "docs", "examples", "fixtures")) {
  $src = Join-Path $root $item
  if (Test-Path $src) { Copy-Item $src $app -Recurse -Force }
}
foreach ($file in @("package.json", "package-lock.json", ".env.example", "README.md", "LICENSE", "launcher.mjs")) {
  $src = Join-Path $root $file
  if (Test-Path $src) { Copy-Item $src (Join-Path $app $file) }
}
# drop heavy / unnecessary bits
Get-ChildItem (Join-Path $app "docs") -Filter "*.pptx" -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem (Join-Path $app "fixtures") -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -ne ".txt" } | Remove-Item -Force

Write-Host "[2/6] copy node_modules and prune dev deps"
Copy-Item (Join-Path $root "node_modules") (Join-Path $app "node_modules") -Recurse -Force
Push-Location $app
$env:npm_config_cache = Join-Path $root ".npm-cache"
try {
  & npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund 2>&1 | Out-Host
} finally {
  Pop-Location
}

Write-Host "[3/6] trim packages not needed at runtime"
$trim = @(
  "node_modules\@napi-rs",
  "node_modules\@types",
  "node_modules\pdfjs-dist\types",
  "node_modules\pdfjs-dist\web",
  "node_modules\pdfjs-dist\image_decoders",
  # server only uses the legacy build; the browser worker is already bundled in web/dist
  "node_modules\pdfjs-dist\build"
)
foreach ($p in $trim) {
  $full = Join-Path $app $p
  if (Test-Path $full) { Remove-Item $full -Recurse -Force }
}

Write-Host "[4/6] copy Node runtime"
Copy-Item (Join-Path $root "scripts\..\..\..\..\node_npm_pnpm\node\node.exe") (Join-Path $pkg "runtime\node.exe") -ErrorAction SilentlyContinue
if (-not (Test-Path (Join-Path $pkg "runtime\node.exe"))) {
  $nodeExe = (Get-Command node).Source
  Copy-Item $nodeExe (Join-Path $pkg "runtime\node.exe") -Force
}

Write-Host "[5/6] generate launchers and readme"
& node (Join-Path $root "scripts\gen-portable-extra.mjs") $pkg
if ($LASTEXITCODE -ne 0) { throw "gen-portable-extra failed" }
$portableReadme = Join-Path $root "docs\portable-README.md"
if (Test-Path $portableReadme) { Copy-Item $portableReadme (Join-Path $pkg "README.md") -Force }

Write-Host "[6/6] zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# tar keeps forward-slash paths and is far more reliable than Compress-Archive here
& tar.exe -a -c -f $zip -C $stageRoot "paper-agent-portable" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zip) -or (Get-Item $zip).Length -eq 0) {
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path $pkg -DestinationPath $zip -CompressionLevel Optimal
}

$appSize = (Get-ChildItem $app -Recurse -File | Measure-Object Length -Sum).Sum
$zipSize = (Get-Item $zip).Length
Write-Host ("OK {0}" -f $zip)
Write-Host ("app={0}MB runtime+app={1}MB zip={2}MB" -f [math]::Round($appSize / 1MB, 1), [math]::Round((Get-ChildItem $pkg -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1), [math]::Round($zipSize / 1MB, 1))
