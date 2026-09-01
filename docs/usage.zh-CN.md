# Service Console 使用手册

> 适用版本：Rust/Tauri `0.5.0` 及以上。本文以桌面客户端为主，同时覆盖 CLI、Jenkins 和 MCP。

## 1. 安装与启动

### macOS

正式版本安装后可直接从“应用程序”打开 **Service Console**。源码构建的调试版本可以这样启动：

```bash
open "target/debug/bundle/macos/Service Console.app"
```

也可以直接运行桌面二进制。文件名含空格，路径必须整体加引号：

```bash
"/absolute/path/service-console/target/debug/Service Console"
```

### Windows

从开始菜单启动，或在 PowerShell 中使用：

```powershell
& "C:\Program Files\Service Console\Service Console.exe"
```

应用启动后会自动创建一个随机回环地址和临时 Token，不需要手工设置端口。服务配置、分组和日志默认保存在
`~/.service-console`。

## 2. 添加和管理服务

1. 打开左侧 **服务控制**。
2. 点击服务列表右上角的添加按钮。
3. 填写服务名称、启动命令、工作目录、环境变量、自动启动和停止超时。
4. 保存后，在服务卡片上执行启动、停止、重启、编辑、复制或删除。

工作目录直接填写路径，不要额外包裹引号。命令本身需要引号时，仍按对应 Shell 的语法填写。

### 从运行中进程导入

添加服务时切换到 **运行中进程**，可按名称、命令或 PID 搜索。也可以从 **端口与进程** 页面选择进程并
填入配置。

导入只会生成新的服务配置，不会接管原进程。保存后应先停止原进程，再由 Service Console 启动，避免
重复实例或端口冲突。

## 3. 服务分组

1. 点击服务列表顶部的 **新建分组**。
2. 将服务卡片拖到目标分组；拖回 **未分组** 即可取消归组。
3. 使用分组标题右侧的启动或停止按钮，对组内全部服务执行一键操作。
4. 删除分组时，组内服务会移到 **未分组**，正在运行的进程不会因此停止。

分组和服务归属会持久化，客户端重启后仍会保留。

## 4. 状态和日志

选择一个服务后，可以查看：

- 当前状态、PID、退出码和运行时间；
- CPU、内存和重启次数；
- 独立的 stdout/stderr 实时日志；
- 日志搜索、复制和自动滚动。

应用自身只记录启动、停止、更新、控制器和异常等关键信息。诊断日志位于：

```text
~/.service-console/logs/service-console.log
```

应用日志单文件最多 1 MiB，并保留 2 个轮换备份，避免持续增长。服务自身产生的业务输出保存在同一数据
目录的日志区域，可在客户端按服务查看。

## 5. 端口与进程

打开 **端口与进程** 可以：

- 查看本机监听端口及进程；
- 按端口筛选；
- 将可恢复命令和工作目录的进程导入为服务；
- 在 PID、端口和进程身份校验后终止目标进程。

强制终止只应在正常停止超时后使用。

## 6. Jenkins

1. 打开左侧 **Jenkins**。
2. 点击 **添加 Jenkins 实例**。
3. 填写显示名称、Jenkins 地址、用户名和 API Token。
4. 保存前执行连接测试。
5. 选择实例后浏览 Folder、Job、构建历史、队列和日志。

客户端支持普通构建和常见参数化构建，可触发构建、停止运行中的构建或取消队列项。API Token 由操作系统
凭据后端保存，不会出现在浏览器或 MCP 工具结果中。建议使用 HTTPS 和最小权限的专用 Token。

## 7. 客户端更新

打开 **设置 → 应用更新**：

1. 点击 **检查更新**。
2. 有新版本时点击 **下载更新**。
3. 下载并校验完成后点击 **安装并重启**。

更新包必须通过签名清单、文件大小和 SHA-256 校验。下载过程中直接退出客户端会取消下载并清理未完成
文件，不会继续阻塞退出。安装重启会先优雅停止受管服务；新版本打开后，启用自动启动的服务会重新启动。

## 8. Codex / MCP

当前 MCP Bridge 为独立 Rust 二进制，不使用 Python，也不需要 `service_console.cli`。

### 一键安装

1. 打开 **设置 → AI / MCP 集成**。
2. 确认“应用控制器”“MCP Bridge”“Codex CLI”均显示就绪。
3. 点击 **安装到 Codex**；若检测到旧 Python 注册，按钮会显示 **修复 Codex 配置**。
4. 等待真实 MCP 握手、完整工具列表和核心只读工具调用验证成功。
5. 重启 Codex 一次，使新任务加载 `service-console` 工具。

安装完成后，Bridge 会按需发现当前客户端的随机端口和临时 Token。客户端未运行时，打包版本的 Bridge
会自动启动同一安装目录中的 Service Console 并等待控制器就绪。

### 手工注册

macOS 正式版本：

```bash
codex mcp add service-console -- \
  "/Applications/Service Console.app/Contents/MacOS/service-console-mcp"
```

源码调试版本：

```bash
cargo build --locked --bin service-console-desktop --bin service-console-mcp
codex mcp add service-console -- \
  "$(pwd)/target/debug/service-console-mcp"
```

Windows：

```powershell
codex mcp add service-console -- `
  "C:\Program Files\Service Console\service-console-mcp.exe"
```

### Agent 推荐调用顺序

1. 调用 `service_list` 或 `project_apply_config` 读取/应用项目服务。
2. 使用 `service_start`、`service_stop`、`service_restart` 或分组工具执行操作。
3. 调用 `service_status` 检查状态。
4. 调用 `service_logs` 检查最近日志。
5. Jenkins 操作先调用 `jenkins_instance_list`，再把选中的 `instance_id` 传给后续工具。

Bridge 当前提供 28 个工具，覆盖服务、分组、项目配置、端口、进程和 Jenkins。停止、重启、终止进程等
操作带有 MCP destructive annotations，AI 客户端可按自身策略要求确认。

## 9. 项目配置文件

在项目根目录创建 `.service-console.json`：

```json
{
  "version": 1,
  "project": "example-project",
  "groups": ["backend", "workers"],
  "services": [
    {
      "name": "api",
      "group": "backend",
      "command": "uv run backend/run.py",
      "cwd": ".",
      "env": {"APP_ENV": "development"},
      "auto_start": true,
      "stop_timeout": 10
    },
    {
      "name": "worker",
      "group": "workers",
      "command": "uv run celery -A backend.app worker",
      "cwd": ".",
      "env": {},
      "auto_start": false,
      "stop_timeout": 10
    }
  ]
}
```

Agent 调用 `project_apply_config` 时，相对 `cwd` 会以配置文件所在目录为基准解析。应用配置会创建或更新
文件中声明的服务和分组，但不会删除其他现有服务。

## 10. CLI

桌面客户端运行时，CLI 会自动读取当前控制器信息：

```bash
target/debug/service-console list
target/debug/service-console start api
target/debug/service-console stop api
target/debug/service-console restart api
target/debug/service-console logs api --tail 200 --follow
target/debug/service-console ports --port 8000
target/debug/service-console tui
```

## 11. 常见问题

### `zsh: no such file or directory: .../Service`

原因是可执行文件名包含空格。使用完整引号：

```bash
"/absolute/path/service-console/target/debug/Service Console"
```

### 找不到 `service_console.cli`

Rust 版本已经移除 Python 包。桌面程序使用 `Service Console`，CLI 使用 `service-console`，MCP 使用
`service-console-mcp`。若 Codex 中仍保留旧 Python 注册，在设置页点击 **修复 Codex 配置**。

### 安装 MCP 后 Agent 看不到工具

先在设置页点击 **测试连接**，确认核心工具验证成功，然后重启 Codex 并新建任务。已打开的旧任务不会
自动重新加载刚安装的 MCP Server。

### MCP 显示配置冲突

点击 **修复 Codex 配置**。客户端会移除同名旧注册、写入当前 Rust Bridge，并完成端到端验证；新注册
验证失败时会自动移除。

### 在源码目录外启动调试程序失败

相对路径取决于当前终端目录。切换到仓库目录，或使用加引号的绝对路径。

## 12. 数据位置

默认数据目录为 `~/.service-console`，主要内容包括：

| 内容 | 路径 |
|---|---|
| 服务定义 | `services.json` |
| 服务分组 | `service-groups.json` |
| 服务与应用日志 | `logs/` |
| 当前控制器描述 | `controller.json` |
| 更新缓存与诊断 | `updates/` |

`controller.json` 包含临时本机连接信息，Unix 权限为 `0600`。不要把整个数据目录提交到代码仓库。
