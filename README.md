<p align="center">
  <img src="build/icon.svg" width="96" alt="OMP Desktop icon" />
</p>

<h1 align="center">OMP Desktop</h1>

<p align="center">
  一个面向 Windows + WSL2 的非官方 <a href="https://github.com/can1357/oh-my-pi">Oh My Pi</a> 桌面工作台。更方便地启动 OMP、恢复和管理会话，同时让模型、工具、规则与权限继续由 OMP 本身负责。
</p>

<p align="center">
  <a href="https://github.com/Eijnewgnaw/omp-desktop/actions/workflows/ci.yml"><img src="https://github.com/Eijnewgnaw/omp-desktop/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-658f90" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/status-alpha-d6a84b" alt="Alpha status" />
</p>

![OMP Desktop 主界面](docs/images/omp-desktop-home.png)

> 当前版本是早期 Alpha，已针对 OMP `17.2.12` 完成真实 RPC 联调。它不会替代 OMP，也不会实现另一套 agent。

## 它解决什么

- 自动发现 WSL 发行版中的 `omp`，选定工作区后直接开始任务。
- 索引现有 OMP JSONL 会话，支持搜索、置顶、归档和一键恢复。
- 通过 OMP RPC v2 展示流式回复、思考内容、工具执行与扩展确认框。
- 自动读取 `theme.dark`、`theme.light`、`colorBlindMode` 和自定义主题，让桌面界面跟随 OMP 的语义色。
- 随时在 Windows Terminal 中回到原始 OMP 会话，保留终端工作流作为可靠退路。
- 使用隔离的 Electron 渲染进程、严格 IPC 校验和外链白名单，缩小桌面壳的攻击面。

## 数据边界

OMP Desktop 把 OMP 视为唯一的 agent 与会话事实来源：

- 模型请求、工具调用、配置、扩展和会话写入都由你本机的 OMP 完成。
- App 只读扫描 OMP 会话文件的开头，不会重写 JSONL。
- 置顶、归档等界面元数据保存在 App 自己的 SQLite 数据库中。
- 不收集遥测，不上传会话，也不保存模型 API 密钥。

详见 [架构说明](docs/ARCHITECTURE.md) 与 [安全策略](SECURITY.md)。

## 使用

### 安装版

1. 在 WSL2 中安装并配置 OMP，确认 `omp --version` 可用。
2. 从 [Releases](https://github.com/Eijnewgnaw/omp-desktop/releases) 下载 Windows 安装包。
3. 启动 OMP Desktop，选择检测到的发行版和 WSL 工作区。

### 从源码运行

需要 Windows 11 + WSL2、Node.js 22.20 或更新版本，以及已经可用的 OMP。

```bash
npm ci
npm run dev
```

在 WSL 内参与开发时，可直接使用 WSLg 运行 Linux 开发壳；正式发布目标仍是 Windows + WSL2。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

真实 OMP 联调不会发送模型请求，只验证 RPC 握手、v2 协商和状态读取：

```bash
npm run test:integration
```

图形端到端测试还需要 Electron 的 Linux 运行库和可用的 WSLg：

```bash
npm run test:e2e
```

## 技术结构

- Electron 主进程负责 WSL 发现、受控进程启动、会话索引和本地元数据。
- Preload 暴露最小化、类型化的 API；渲染进程没有 Node.js 权限。
- React 渲染会话、Markdown、工具卡和 OMP 扩展 UI。
- RPC 解码器同时兼容 v1 行帧与 v2 分块帧，历史记录按稳定游标分页读取。

## 路线图

- 为更多 OMP 版本建立兼容性矩阵。
- 改进扩展 widget/status 的可视化承载。
- 增加会话标签编辑、批量归档和跨项目筛选。
- 在签名基础设施可用后提供签名安装包和自动更新。

## 参与贡献

欢迎提交 Issue 与 PR。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。主题数据的来源和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 说明

OMP Desktop 是社区项目，与 Oh My Pi 作者不存在官方隶属关系。Oh My Pi 的名称、代码和主题版权归其各自权利人所有。

本项目使用 [MIT License](LICENSE)。
