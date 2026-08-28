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

## 主要功能

- 配置命令、工作目录、环境变量、自动启动和优雅停止超时。
- 从紧凑的服务卡片启动、停止、重启、编辑、复制或删除服务。
- 查看 PID、运行时间、退出码、重启次数、CPU 和内存。
- 分服务持久化 stdout/stderr，并通过 WebSocket 实时推送。
- 使用 xterm.js 显示 ANSI 日志，支持搜索、复制、链接、换行和滚动历史。
- 查看监听端口及占用进程，并通过 PID/端口二次校验安全终止进程。
- 使用 Tabler 紧凑控制台，并支持可持久化的浅色/深色主题。
- 桌面端使用随机回环端口、临时 Token 和权限为 `0600` 的运行描述文件。

### 外观与主题

控制台在本地打包 `@tabler/core` 1.4 组件库，不依赖 CDN。可通过顶栏太阳/月亮按钮即时切换浅色和
深色主题。首次打开会跟随操作系统配色，手动选择后会保存到控制器数据目录中的
`ui-preferences.json`，因此桌面端重启或随机回环端口变化后仍能保留；日志终端和页面主题色元数据会
同步更新。

## 快速开始

需要 Python 3.12+ 和 [uv](https://docs.astral.sh/uv/)：

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

## 打包 macOS 应用

需要 macOS、Xcode Command Line Tools、Node.js、pnpm 和 uv：

```bash
./scripts/build-macos-app.sh
open "dist/Service Console.app"
```

脚本会从 `assets/service-console-icon-1024.png` 生成多分辨率 ICNS 图标，构建本地 Tabler 与
xterm.js 资源，再用 PyInstaller 打包 CPython、pywebview、FastAPI 和完整界面。Bundle 版本自动与
`pyproject.toml` 同步并进行 ad-hoc 签名。

产物匹配构建机器架构，目前已在 Apple Silicon 上验证。它尚未使用 Apple Developer ID 签名和公证，
通过 GitHub 下载后可能触发 Gatekeeper 提示。`dist/` 默认不进入 Git，应通过 GitHub Releases 分发。

## FastAPI + Vite + Celery 示例

仓库提供了后端、前端、Celery Worker 和 Celery Beat 的完整原生管理示例，见
[examples/pd-qa-backend.md](examples/pd-qa-backend.md)。Beat 需要显式启动，避免多个调度器重复投递任务。

## 开发与测试

```bash
uv sync --group dev
pnpm install --frozen-lockfile
pnpm run build:web-assets
uv run pytest
```

接口和架构约束见 [CONTRACT.md](CONTRACT.md)，贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
