param()

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ServerEntry = Join-Path $Root "dist-server\server\src\index.js"
if (-not (Test-Path -LiteralPath $ServerEntry)) {
  throw "缺少 $ServerEntry，请先执行 npm run build:tauri:server"
}

$Resources = Join-Path $Root "src-tauri\resources"
New-Item -ItemType Directory -Force -Path $Resources | Out-Null

# 1) 自带 Node 运行时：用户机器无需预装 Node，sidecar 也能跑 node:sqlite。
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$NodeTarget = Join-Path $Resources "node.exe"
Copy-Item -LiteralPath $NodeExe -Destination $NodeTarget -Force

# 2) 把 tsc 产物 + 生产依赖打成单个 ESM 文件。
& node (Join-Path $Root "scripts\bundle-tauri-server.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "esbuild 打包 sidecar 失败（exit $LASTEXITCODE）"
}

$Bundle = Join-Path $Resources "maildeck-server.mjs"
if (-not (Test-Path -LiteralPath $Bundle)) {
  throw "sidecar 产物缺失：$Bundle"
}

$NodeMb = [math]::Round((Get-Item -LiteralPath $NodeTarget).Length / 1MB, 1)
$BundleMb = [math]::Round((Get-Item -LiteralPath $Bundle).Length / 1MB, 2)
Write-Output "tauri sidecar ready: node.exe=${NodeMb}MB maildeck-server.mjs=${BundleMb}MB"
