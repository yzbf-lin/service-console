$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RootDir

if (-not $IsWindows) {
    throw "The Windows application must be built on Windows."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is required to build the local Next.js application."
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is required to build the Windows application."
}

$VersionMatch = Select-String -Path (Join-Path $RootDir "pyproject.toml") -Pattern '^version = "([^"]+)"$'
if (-not $VersionMatch) {
    throw "Unable to read the project version from pyproject.toml."
}
$Version = $VersionMatch.Matches[0].Groups[1].Value
$IconPath = Join-Path $RootDir "assets/windows/ServiceConsole.ico"
$ExecutablePath = Join-Path $RootDir "dist/Service Console/Service Console.exe"
$McpHelperBuildPath = Join-Path $RootDir "dist/Service Console MCP.exe"
$McpHelperAppPath = Join-Path $RootDir "dist/Service Console/Service Console MCP.exe"
$UpdaterBuildPath = Join-Path $RootDir "dist/Service Console Updater.exe"
$UpdaterAppPath = Join-Path $RootDir "dist/Service Console/Service Console Updater.exe"

pnpm install --frozen-lockfile
pnpm run build:web-assets
uv sync --locked --group icon
uv run --locked --group icon python (Join-Path $RootDir "scripts/build_windows_icon.py") `
    (Join-Path $RootDir "assets/service-console-icon-1024.png") `
    $IconPath
uv sync --locked --group desktop
uv run --locked --group desktop pyinstaller `
    --noconfirm `
    --clean `
    --windowed `
    --name "Service Console" `
    --icon $IconPath `
    --paths (Join-Path $RootDir "src") `
    --copy-metadata service-console `
    --collect-data service_console `
    --collect-all webview `
    --hidden-import webview.platforms.edgechromium `
    (Join-Path $RootDir "src/service_console/desktop.py")

uv run --locked --group desktop pyinstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "Service Console Updater" `
    --paths (Join-Path $RootDir "src") `
    (Join-Path $RootDir "src/service_console/update_helper.py")

if (-not (Test-Path $UpdaterBuildPath -PathType Leaf)) {
    throw "PyInstaller did not create the expected updater: $UpdaterBuildPath"
}
Copy-Item -Force $UpdaterBuildPath $UpdaterAppPath

uv run --locked --group desktop pyinstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "Service Console MCP" `
    --paths (Join-Path $RootDir "src") `
    --copy-metadata service-console `
    --copy-metadata mcp `
    --collect-data service_console `
    (Join-Path $RootDir "src/service_console/mcp_server.py")

if (-not (Test-Path $McpHelperBuildPath -PathType Leaf)) {
    throw "PyInstaller did not create the expected MCP helper: $McpHelperBuildPath"
}
Copy-Item -Force $McpHelperBuildPath $McpHelperAppPath

if (-not (Test-Path $ExecutablePath -PathType Leaf)) {
    throw "PyInstaller did not create the expected executable: $ExecutablePath"
}

& $UpdaterAppPath --help | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Updater smoke test failed with exit code $LASTEXITCODE"
}
& $McpHelperAppPath --help | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "MCP helper smoke test failed with exit code $LASTEXITCODE"
}
uv run --locked python (Join-Path $RootDir "scripts/smoke_test_mcp_helper.py") $McpHelperAppPath
if ($LASTEXITCODE -ne 0) {
    throw "MCP helper handshake failed with exit code $LASTEXITCODE"
}

Write-Host "`nCreated: $ExecutablePath (version $Version)"
