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

pnpm install --frozen-lockfile
pnpm run build:web-assets
uv sync --group icon
uv run --group icon python (Join-Path $RootDir "scripts/build_windows_icon.py") `
    (Join-Path $RootDir "assets/service-console-icon-1024.png") `
    $IconPath
uv sync --group desktop
uv run --group desktop pyinstaller `
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

if (-not (Test-Path $ExecutablePath -PathType Leaf)) {
    throw "PyInstaller did not create the expected executable: $ExecutablePath"
}

Write-Host "`nCreated: $ExecutablePath (version $Version)"
