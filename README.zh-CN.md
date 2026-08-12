<p align="center">
  <img src="build/icon.svg" width="96" alt="OMP Desktop icon" />
</p>

<h1 align="center">OMP Desktop</h1>

<p align="center">
  一个面向 Windows + WSL2 的非官方 <a href="https://github.com/can1357/oh-my-pi">Oh My Pi</a> 桌面工作台。更方便地启动 OMP、继续和管理会话，同时让模型、工具、规则与权限继续由 OMP 本身负责。
</p>

<p align="center">
  <a href="https://github.com/Eijnewgnaw/omp-desktop/actions/workflows/ci.yml"><img src="https://github.com/Eijnewgnaw/omp-desktop/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/Eijnewgnaw/omp-desktop/releases"><img src="https://img.shields.io/github/v/release/Eijnewgnaw/omp-desktop?include_prereleases&label=release" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-658f90" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/status-alpha-d6a84b" alt="Alpha status" />
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

![OMP Desktop 主界面](docs/images/omp-desktop-home.png)

> 当前版本是早期 Alpha，已针对 OMP `17.2.12` 完成真实 RPC 联调。它不会替代 OMP，也不会实现另一套 agent。

## 主要功能

- 自动发现 WSL 发行版中的 `omp`，选定工作区后直接开始任务。
- 索引和继续现有 OMP JSONL 会话，支持搜索、置顶、归档和恢复。
- 侧边栏会话菜单提供继续会话、原始终端、置顶、归档/恢复及移到回收站。
- 删除采用确认后的可恢复移动，同时保留相邻附件目录，不做永久删除。
- 通过 OMP RPC v2 展示流式回复、思考内容、工具执行与扩展确认框。
- 读取 OMP 返回的可用模型列表，并通过 OMP 原生 `set_model` RPC 切换模型。
- 自动读取 `theme.dark`、`theme.light`、`colorBlindMode` 和自定义主题，让界面跟随 OMP 语义色。
- 可在 Windows Terminal 中接管同一个 OMP 会话；交接前会验证桌面运行时已停止，成功后桌面输入框切换为新会话，避免并发写同一 JSONL。

## 数据边界

OMP Desktop 把 OMP 视为唯一的 agent 与会话事实来源：

- 模型请求、工具调用、配置、扩展和会话写入都由本机 OMP 完成。
- App 只读扫描会话文件开头，不会重写 JSONL 内容。
- 置顶、归档等界面元数据保存在 App 自己的 SQLite 数据库中。
- 只有在你确认后，App 才会把会话及附件移动到 `<OMP agent 目录>/trash/omp-desktop/`。
- 不收集遥测，不上传会话，也不保存模型 API 密钥。

详见 [架构说明](docs/ARCHITECTURE.md) 与 [安全策略](SECURITY.md)。

## 安装使用

1. 在 WSL2 中安装并配置 OMP，确认 `command -v omp` 与 `omp --version` 可用。
2. 从 [Releases](https://github.com/Eijnewgnaw/omp-desktop/releases) 下载最新 Windows 安装包。
3. 启动 OMP Desktop，选择检测到的发行版和 WSL 工作区。
4. 新建任务，或从侧边栏选择旧会话继续交流。

安装包目前尚未签名，Windows SmartScreen 可能显示“未知发布者”。请只从本仓库 Release 页面下载。

## 从源码运行

需要 Node.js 22.20 或更新版本，以及已经可用的 OMP。

```bash
npm ci
npm run dev
```

在 WSL 内参与开发时，可使用 WSLg 运行 Linux 开发壳；正式发布目标仍是 Windows 11 x64 + WSL2。

## 验证

```bash
npm run typecheck
npm test
npm run test:integration
npm run test:e2e:resume
```

- 真实 OMP 联调只验证 RPC 协商、状态读取和模型列表，不发送模型请求。
- 恢复会话端到端测试使用假的 OMP，验证旧会话发送、模型切换、异步续跑/错误恢复、崩溃重连、终端交接及新会话所有权，不消耗真实模型。
- 图形端到端测试需要 Electron Linux 运行库和可用的 WSLg。

## 技术结构

- Electron 主进程负责 WSL 发现、单运行时生命周期、会话索引、回收站和本地元数据。
- Preload 暴露最小化、类型化的 API；渲染进程没有 Node.js 权限。
- React 渲染会话、模型选择、Markdown、工具卡和 OMP 扩展 UI。
- RPC 解码器兼容 v1 行帧与 v2 分块帧，历史记录按稳定游标分页读取。
- WSL 运行时关闭时只精确终止对应 OMP 进程组，不关闭整个发行版。

## 路线图

- 为更多 OMP 版本建立兼容性矩阵。
- 改进扩展 widget/status 的可视化承载。
- 增加会话标签、批量操作、跨项目筛选和 App 内回收站浏览器。
- 提供完整英文界面、本地化、签名安装包和安全自动更新。

## 参与贡献

欢迎提交 Issue 与 PR。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。主题数据的来源和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 说明

OMP Desktop 是独立社区项目，与 Oh My Pi 作者不存在官方隶属或背书关系。Oh My Pi 的名称、代码和主题版权归其各自权利人所有。

本项目使用 [MIT License](LICENSE)。
