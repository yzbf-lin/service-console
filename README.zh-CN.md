<p align="center">
  <img src="docs/assets/service-console-icon.png" width="160" alt="Service Console 图标">
</p>

<h1 align="center">Service Console</h1>

<p align="center">无需容器，直接启动和管理本地开发服务。</p>

<p align="center">桌面端 · Web · CLI · TUI · 独立日志 · 端口检查 · 远程控制</p>

<p align="center"><a href="README.md">English</a></p>

Service Console 是面向开发工作流的原生进程管理器。服务命令注册一次后，即可从桌面应用、浏览器、
命令行或终端界面执行启动、停止、重启、状态监控和独立日志查看。所有命令都直接作为宿主机进程运行，
不依赖 Docker 或其他容器运行时。

<p align="center">
  <img src="docs/assets/screenshots/service-control.png" width="100%" alt="Service Console 服务控制工作区">
</p>

<p align="center">
  <sub>服务列表、xterm.js 实时日志、生命周期控制与运行指标集中在同一个紧凑工作区。</sub>
</p>

## 主要功能

- 配置命令、工作目录、环境变量、自动启动和优雅停止超时。
- 在紧凑的三栏工作区中启动、停止、重启、编辑、复制、删除或检查服务。
- 查看 PID、运行时间、退出码、重启次数、CPU 和内存。
- 分服务持久化 stdout/stderr，并通过 WebSocket 实时推送。
- 使用 xterm.js 显示 ANSI 日志，支持搜索、复制、链接、换行和滚动历史。
- 查看监听端口及占用进程，并通过 PID/端口二次校验安全终止进程。
- 自动发现桌面端新版本，验证 Ed25519 签名清单与安装包 SHA-256，并在用户确认后安装重启。
- 搜索当前用户的运行中进程（包括无端口 Worker），自动提取 `uv`/`pnpm` 启动命令和工作目录并填入服务配置。
- 使用 Next.js、React、TypeScript、Tailwind CSS、shadcn/ui、Radix UI 与 Lucide React
  构建紧凑控制台，并支持可持久化的浅色/深色主题。
- 桌面端使用随机回环端口、临时 Token 和权限为 `0600` 的运行描述文件。

## 功能导览

以下截图全部使用隔离、脱敏的临时演示进程，不包含个人服务配置、凭据或真实项目日志。

### 从运行中进程创建服务

<p align="center">
  <img src="docs/assets/screenshots/add-service.png" width="100%" alt="从运行中进程创建 Service Console 服务配置">
</p>

可按进程名称、命令或 PID 搜索，再将识别出的启动命令与工作目录填入可编辑的服务定义。该操作不会
挂接现有 stdout/stderr；保存后的命令下一次由 Service Console 启动时才开始采集受管日志。

### 查看端口和占用进程

<p align="center">
  <img src="docs/assets/screenshots/ports-processes.png" width="100%" alt="查看监听端口和占用进程">
</p>

可按端口筛选、展开按进程聚合的 TCP/UDP 监听记录、将占用进程添加为服务，或在 PID 与预期端口
二次校验后终止进程。

### 保存外观偏好

<p align="center">
  <img src="docs/assets/screenshots/settings.png" width="100%" alt="Service Console 主题、签名更新和连接设置">
</p>

支持跟随系统、浅色和深色主题，选择结果会持久化。同一页面会显示当前版本、检查签名更新并引导下载
和重启。Supabase 云端连接保持可选，并不影响本地 FastAPI 控制器提供的启动、停止、日志与端口功能。

### 外观与主题

控制台是静态导出的 Next.js 应用。通用组件遵循 shadcn/ui 结构，交互基础使用 Radix UI，无障碍样式
和主题 token 由 Tailwind CSS 管理，图标使用 Lucide React。可通过顶栏太阳/月亮按钮即时切换浅色和
深色主题。首次打开会跟随操作系统配色，手动选择后会保存到控制器数据目录中的
`ui-preferences.json`，因此桌面端重启或随机回环端口变化后仍能保留；日志终端和页面主题色元数据会
同步更新。

Supabase 是可选云端适配器。构建时提供 `NEXT_PUBLIC_SUPABASE_URL` 和
`NEXT_PUBLIC_SUPABASE_ANON_KEY` 后，可供后续远程认证或状态同步使用。本地启动、停止、重启、日志和
端口操作始终由 FastAPI 控制器执行，不配置 Supabase 也可完整离线使用。

## 环境要求

| 用途 | 要求 |
|---|---|
| 控制器、CLI、TUI | Python 3.12+ 和 [uv](https://docs.astral.sh/uv/) |
| Web 资源开发 | Node.js 22+ 和 pnpm 11 |
| 原生桌面窗口 | macOS、Windows，或 pywebview 支持的 Linux 环境 |
| 构建 macOS `.app` | macOS、Xcode Command Line Tools、Node.js、pnpm 和 uv |
| 构建 Windows `.exe` | Windows、PowerShell 7、Node.js、pnpm 和 uv |

## 快速开始

```bash
git clone https://github.com/yzbf-lin/service-console.git
cd service-console
uv sync --all-groups
uv run service-console-desktop
```

桌面应用会在随机本机端口启动 FastAPI 控制器，并在原生 pywebview 窗口中打开界面。服务定义和日志
默认保存在 `~/.service-console`。

注册并控制一个原生服务：

```bash
uv run service-console add api \
  --command "uv run backend/run.py" \
  --cwd /path/to/project

uv run service-console start api
uv run service-console restart api
uv run service-console logs api --tail 200 --follow
```

桌面端运行时，CLI 会自动发现随机端口和临时 Token，无需手工复制连接参数。

### 从运行中进程添加服务

打开“添加服务”，切换到“运行中进程”即可按名称、命令或 PID 搜索；也可以在“端口与进程”页面点击
进程行右侧的加号。选择“填入配置”后，界面会自动填写服务名称、启动命令、工作目录和安全白名单内的
环境变量，保存前仍可修改。

该操作只根据进程生成配置，不会重新挂接现有进程的 stdout/stderr。保存后应先停止原进程，再由
Service Console 启动服务，避免重复实例或端口冲突；日志从首次受管启动开始采集。命令中的 Token、
Password、Secret、API Key 等敏感参数会被遮罩，需手工确认后再保存。

## 常用命令

| 操作 | 命令 |
|---|---|
| 查看状态 | `service-console list` |
| 启动服务 | `service-console start SERVICE` |
| 停止服务 | `service-console stop SERVICE` |
| 重启服务 | `service-console restart SERVICE` |
| 查看或跟随日志 | `service-console logs SERVICE --tail 200 --follow` |
| 打开终端界面 | `service-console tui` |
| 查看端口 | `service-console ports --port PORT` |
| 正常终止占用进程 | `service-console kill-process PID --port PORT --timeout 3` |
| 超时后强制终止 | `service-console kill-process PID --port PORT --force` |

## 浏览器控制器

Linux、无桌面服务器或偏好浏览器界面时，可以单独启动控制器：

```bash
uv run service-console serve --host 127.0.0.1 --port 8787
```

打开 <http://127.0.0.1:8787>。控制器拥有其子进程组；正常关闭最后一个桌面窗口或停止控制器会优雅
停止受管服务。系统强制退出或直接杀死控制器可能留下子进程，重新启动前应先检查端口。

不要让 `service-console serve` 和 `service-console-desktop` 同时使用同一个数据目录。

## 安全模型

桌面控制器只监听回环地址，并将随机 URL、PID、实例 ID 和临时 Token 写入
`~/.service-console/controller.json`。文件权限为 `0600`，正常退出时自动删除，并使用进程锁避免多个
桌面实例互相覆盖。

注册命令属于受信任本地配置，并以控制器相同的系统权限运行。需要远程访问时，必须配置高强度 Token，
并在控制器前终止 TLS。不要把无鉴权控制器暴露到不可信网络。

## 桌面端自动更新

打包后的桌面应用会立即读取当前版本，并在启动约 2.5 秒后检查 GitHub Releases 的最新稳定版本。只有
当 `latest-update.json` 能通过应用内置公钥的 Ed25519 验签时，版本信息和下载地址才会被信任；下载的
平台安装包还必须与签名清单中的文件名、字节数和 SHA-256 完全一致。

打开“设置 → 应用更新”可以手动检查、下载更新，并选择“安装并重启”。安装不会静默执行：确认窗口会
明确提示关闭 Service Console 将优雅停止全部受管服务；新版本重新打开后，启用了 `auto_start` 的服务
会再次启动。

自动替换仅用于正式打包的 macOS arm64 与 Windows x64 Release，且安装目录必须可写。源码运行、纯
浏览器控制器或不支持的架构仍能发现版本，但会引导前往 Release 下载页。首个内置更新公钥的版本需要
手动安装，从它之后发布的版本才能在应用内更新。

## 打包 macOS 应用

需要 macOS、Xcode Command Line Tools、Node.js、pnpm 和 uv：

```bash
./scripts/build-macos-app.sh
open "dist/Service Console.app"
```

脚本会从 `assets/service-console-icon-1024.png` 生成多分辨率 ICNS 图标；用户提供的透明产品标志原图
保留在 `assets/service-console-logo.png`。随后静态导出 Next.js 与 xterm.js 界面，再用 PyInstaller 打包
CPython、pywebview、FastAPI 和完整界面。Bundle 版本自动与 `pyproject.toml` 同步并进行 ad-hoc 签名。

产物匹配构建机器架构，目前已在 Apple Silicon 上验证。它尚未使用 Apple Developer ID 签名和公证，
通过 GitHub 下载后可能触发 Gatekeeper 提示。`dist/` 默认不进入 Git，应通过 GitHub Releases 分发。

更换产品标志时，将透明原图保存为 `assets/service-console-logo.png`，再统一生成桌面图标、README 图标、
顶栏 Logo 和 favicon：

```bash
uv run --group icon python scripts/build_brand_assets.py
./scripts/build-macos-icon.sh
pnpm run build:web-assets
```

## 打包 Windows 应用

在 Windows 上使用 PowerShell 7、Node.js、pnpm 和 uv：

```powershell
pwsh ./scripts/build-windows-app.ps1
& "dist/Service Console/Service Console.exe" --help
```

脚本会生成多分辨率 ICO 图标、构建同一套离线界面，并在 `dist/Service Console` 生成 PyInstaller
目录包。Windows 10/11 需要安装 Microsoft Edge WebView2 Runtime。当前 Windows 可执行文件未进行
商业代码签名，在配置可信代码签名证书前可能出现 SmartScreen 提示。

## 发布 Release 包

仓库的 `Release` GitHub Actions 工作流会构建 Apple Silicon macOS ZIP 和 Windows x64 ZIP。推送与
`pyproject.toml` 版本一致的标签后，会将两个安装包、`SHA256SUMS.txt`、`latest-update.json` 和
`latest-update.json.sig` 发布到 GitHub Releases：

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

清单签名使用受保护的 `SERVICE_CONSOLE_UPDATE_PRIVATE_KEY_B64` Actions Secret；仓库和客户端只保存
对应公钥。发布过程先写入可恢复的 Draft，再显式标记为 Latest；工作流会拒绝覆盖已经发布的同名
Release。若需要由 GitHub 强制保护标签和资产，还应在仓库设置中启用 Immutable Releases。

也可以手动运行该工作流，只生成可下载的 Actions 构建产物而不创建 GitHub Release。

## FastAPI + Vite + Celery 示例

仓库提供了后端、前端、Celery Worker 和 Celery Beat 的完整原生管理示例，见
[examples/pd-qa-backend.md](examples/pd-qa-backend.md)。Beat 需要显式启动，避免多个调度器重复投递任务。

## 开发与测试

```bash
uv sync --group dev
pnpm install --frozen-lockfile
pnpm run typecheck:web
pnpm run lint:web
pnpm run test:web
pnpm run build:web-assets
uv run pytest
```

接口和架构约束见 [CONTRACT.md](CONTRACT.md)，贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
