# Architecture

OMP Desktop 是 OMP 的桌面宿主，不是新的 agent 运行时。

```mermaid
flowchart LR
  UI["React desktop UI"] -->|"validated IPC"| Main["Electron main process"]
  Main -->|"native NDJSON RPC"| Native["Windows OMP"]
  Main -->|"wsl.exe + NDJSON RPC"| WSL["OMP in WSL"]
  Native --> Profiles["Default and named Profiles"]
  WSL --> Profiles
  Profiles --> Models["Models, tools, extensions and rules"]
  Main -->|"read-only prefix scan"| Sessions["OMP JSONL sessions"]
  Main --> Metadata["App-only SQLite metadata"]
  Profiles --> Sessions
  Main -->|"semantic tokens"| Themes["OMP config and themes"]
  Themes --> UI
```

## Process boundary

在 Windows 发布版中，主进程同时探测 Windows 原生 OMP 与 WSL 发行版中的 `omp`，并枚举 Default 和命名 Profile。每个 Profile 都通过 OMP 自身解析其 agent 目录，并生成独立 installation ID。启动会话时通过独立参数执行 OMP，用户路径不会插入 shell 脚本文本。WSL supervisor 使用独立进程组并记录精确 PGID，便于 App 退出或切换会话时只清理对应的 OMP：

```text
wsl.exe -d <distro> --cd <cwd> --exec /bin/sh -c <fixed-supervisor> ... <omp> --profile <default|name> --mode rpc-ui --cwd <cwd> [--resume <session>]
```

OMP 仍负责模型目录、模型切换、系统提示、扩展、工具、权限和会话持久化。桌面壳只消费 RPC 帧并发送用户明确触发的协议命令。RuntimeManager 将启动和停止串行化，任一窗口只保留一个受管 RPC 运行时。

## RPC handling

- 等待 `ready` 帧后协商协议 v2。
- v1 使用单行 JSON；v2 同时支持长度前缀分块帧。
- 会话历史通过 `get_messages_page` 按稳定游标读取。
- 模型选择通过 `get_available_models` 和 `set_model` 完成，不直接读写 OMP 模型配置。
- 仅把 `isTerminal !== false` 的 `agent_end` 视为一次运行的最终结束；本地命令通过响应中的 `agentInvoked: false` 或 `prompt_result` 结束。
- 普通命令失败作为 RPC 错误显示给用户，不会被误判为整个 OMP 进程崩溃。
- 遇到 `session_busy` 或 `stale_cursor` 时丢弃分页快照并退回旧版完整读取。
- 未识别的帧会被安全忽略，避免 OMP 添加事件后让 App 崩溃。

## Session model

Renderer 只维护一个会话目标：未启动的新会话，或已保存的 OMP 会话。新会话先绑定 installation ID（包含 backend、基础 OMP 与 Profile 身份），再选择该环境的工作区。修改全局默认只影响未来新会话；已保存会话的 installation ID、Profile、工作区和 session path 不会被覆盖。OMP 第一次发布 session path 后，该路径会绑定到当前新会话，并在索引刷新时提升为已保存会话。

会话索引只读取每个 JSONL 文件开头的固定标题槽和 session header。App 不重写 OMP 会话内容；重命名后的显示标题、置顶、归档和标签属于按 OMP 安装环境隔离的 SQLite 元数据，可在不影响 OMP 的情况下删除或重建。App 持续跟踪 OMP 实际发布的 session path；终端交接、回收和永久删除必须先严格验证拥有该文件的受管进程已经退出。

- “移到回收站”只会把已索引 JSONL 及同名附件目录移动到 OMP data 目录内的 `trash/omp-desktop`；非 XDG 布局下 data 目录通常等于 agent 目录。
- “彻底删除”经过独立警告弹窗的按钮确认，并先把精确目标原子移动到 agent 目录内的私有 staging 目录，再删除 staging；路径、索引、文件类型和附件目录都会重新验证。
- 两种操作都拒绝越出 sessions 根目录的路径，不会使用通配符或递归删除会话根目录。

把会话交给原始终端后，App 会持久保存 handoff lease。该 JSONL 在用户明确确认终端中的 OMP 已关闭前不能被桌面 RPC 再次恢复，避免两个 writer 同时写入。

## Runtime backends

v0.1.0 使用两个彼此隔离的运行 adapter：Windows adapter 直接调用 `omp.exe` 并使用 Win32 路径，WSL adapter 通过指定发行版调用 POSIX 路径。每个 Default/命名 Profile 在 adapter 内仍是独立 installation，分别隔离 agent 目录、会话索引、主题、元数据、最近工作区和终端交接。保存的会话不会跨 adapter 或 Profile 隐式迁移。

## Theme model

内置主题由 OMP `v17.2.12` 源码生成，并解析变量引用、ANSI 256 色和导出背景色。运行时会读取：

- `theme.dark`
- `theme.light`
- `symbolPreset`
- `colorBlindMode`
- OMP agent 目录下的自定义主题

主题轮询和系统明暗模式变化会更新 CSS 语义变量。主题同步失败时使用与模式匹配的内置回退主题。

## Security boundary

Renderer 运行在 Electron sandbox 中，没有 Node.js 权限。所有文件、进程和 WSL 操作都经过固定 preload API；Renderer 只提交不透明 installation ID，主进程从可信发现结果恢复 backend 与 Profile，再按 Win32/POSIX 规则验证路径。Profile 名不会作为自由文本从 Renderer 进入进程参数。外部 URL 只允许交给系统浏览器打开 HTTP(S) 地址。
