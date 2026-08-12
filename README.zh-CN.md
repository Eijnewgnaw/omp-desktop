<p align="center">
  <img src="build/icon.svg" width="96" alt="OMP Desktop 图标" />
</p>

<h1 align="center">OMP Desktop</h1>

<p align="center">
  <strong>为 Oh My Pi 打造的专注桌面工作台。</strong><br />
  快速启动项目、继续会话、切换模型并整理工作，同时让 OMP 始终作为 Agent 运行时。
</p>

<p align="center">
  <a href="https://github.com/Eijnewgnaw/omp-desktop/releases/latest"><strong>下载最新版本</strong></a>
  · <a href="README.md">English</a>
  · <a href="docs/DEVELOPMENT.md">开发文档</a>
</p>

<p align="center">
  <a href="https://github.com/Eijnewgnaw/omp-desktop/actions/workflows/ci.yml"><img src="https://github.com/Eijnewgnaw/omp-desktop/actions/workflows/ci.yml/badge.svg" alt="CI 状态" /></a>
  <a href="https://github.com/Eijnewgnaw/omp-desktop/releases"><img src="https://img.shields.io/github/v/release/Eijnewgnaw/omp-desktop?label=release" alt="最新版本" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-658f90" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Windows-available-4b8bbe" alt="Windows 已发布" />
  <img src="https://img.shields.io/badge/macOS-supported-658f90" alt="macOS 已支持" />
</p>

![OMP Desktop 英文界面](docs/images/omp-desktop-home.png)

<p align="center"><sub>OMP Desktop 当前的英文应用界面。</sub></p>

## 保留 OMP 能力，减少会话摩擦

OMP Desktop 是 [Oh My Pi（OMP）](https://github.com/can1357/oh-my-pi) 的本地优先桌面伴侣。它在 OMP 外增加图形化工作台，但不取代 OMP：模型、工具、规则、权限、扩展和会话文件仍由 OMP 管理。

## 功能

| 功能 | 说明 |
| --- | --- |
| **原生桌面运行时** | 使用 macOS 原生 OMP、Windows 原生 OMP、WSL2 OMP，或同时使用 Windows 与 WSL。 |
| **Profile 独立会话** | 隔离保存每个 OMP Profile 的项目目录、主题和会话历史。 |
| **真实会话恢复** | 通过 OMP 原生 RPC 继续已有 JSONL 会话。 |
| **模型选择** | 查看并切换 OMP 返回的可用模型。 |
| **会话资料库** | 搜索、重命名、置顶、归档、恢复、移到回收站或彻底删除。 |
| **实时 Agent 动态** | 查看流式回复、思考、Markdown、代码、工具调用和确认请求。 |
| **OMP 主题同步** | 跟随 OMP 的亮色、暗色、自定义、符号和色盲主题设置。 |
| **终端交接** | 安全地把会话交给 macOS Terminal 或 Windows Terminal，并在返回时重新接管。 |

## 三步开始

1. 点击 **新建会话**。
2. 选择检测到的原生或 WSL 运行时、OMP Profile 和项目目录。
3. 开始新对话，或在原运行环境中继续任何已保存会话。

每个会话都会保留自己的运行时、Profile 和工作区。macOS `/...`、Windows `C:\...` 与 WSL `/...` 的身份互不混用，所有权锁可避免桌面端和终端 OMP 同时写入同一会话。

## 平台支持

| 平台 | 状态 |
| --- | --- |
| Windows 11 x64 + Windows 原生 OMP | **已支持** |
| Windows 11 x64 + WSL2 OMP | **已支持** |
| Default 与命名 OMP Profiles | **已支持** |
| Apple Silicon macOS | **代码已支持；从下一个版本标签开始打包** |
| Intel macOS | **代码已支持；从下一个版本标签开始打包** |
| 原生 Linux 桌面 | 暂不支持 |

## 安装

1. 在 macOS、Windows 原生环境、WSL2 或两个 Windows 环境中安装并配置 OMP。
2. 从 [GitHub Releases](https://github.com/Eijnewgnaw/omp-desktop/releases/latest) 下载当前版本已提供的对应 DMG/ZIP 或 Windows 安装包。
3. 启动 OMP Desktop 并创建第一个会话。

> [!NOTE]
> macOS 与 Windows 安装包暂未代码签名或公证，因此系统可能显示未知开发者警告。请只从本仓库下载。

## 本地优先

- OMP Desktop 不安装 OMP、不保存模型 API 密钥、不上传会话，也不收集遥测。
- 会话内容保留在 OMP 自己的文件中；桌面端标签和偏好使用独立的本地数据库。
- 回收、彻底删除、恢复和终端交接均会在主进程中再次校验运行时与会话目录。

## 项目文档

- [开发指南](docs/DEVELOPMENT.md)
- [架构说明](docs/ARCHITECTURE.md)
- [安全策略](SECURITY.md)
- [参与贡献](CONTRIBUTING.md)
- [版本记录](CHANGELOG.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)

OMP Desktop 是独立社区项目，与 Oh My Pi 作者不存在官方隶属或背书关系。OMP Desktop 使用 [MIT License](LICENSE)。
