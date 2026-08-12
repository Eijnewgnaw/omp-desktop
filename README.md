<p align="center">
  <img src="build/icon.svg" width="96" alt="OMP Desktop icon" />
</p>

<h1 align="center">OMP Desktop</h1>

<p align="center">
  <strong>A focused desktop workspace for Oh My Pi.</strong><br />
  Start projects, resume sessions, switch models, and organize your work while OMP remains the agent runtime.
</p>

<p align="center">
  <a href="https://github.com/Eijnewgnaw/omp-desktop/releases/latest"><strong>Download the latest release</strong></a>
  · <a href="README.zh-CN.md">简体中文</a>
  · <a href="docs/DEVELOPMENT.md">Development</a>
</p>

<p align="center">
  <a href="https://github.com/Eijnewgnaw/omp-desktop/actions/workflows/ci.yml"><img src="https://github.com/Eijnewgnaw/omp-desktop/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/Eijnewgnaw/omp-desktop/releases"><img src="https://img.shields.io/github/v/release/Eijnewgnaw/omp-desktop?label=release" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-658f90" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Windows-available-4b8bbe" alt="Available for Windows" />
  <img src="https://img.shields.io/badge/macOS-supported-658f90" alt="macOS supported" />
</p>

![OMP Desktop interface](docs/images/omp-desktop-home.png)

<p align="center"><sub>OMP Desktop running with its English interface.</sub></p>

## OMP, without the session friction

OMP Desktop is a local-first companion for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). It adds a visual workspace around OMP without replacing it: models, tools, rules, permissions, extensions, and conversation files remain under OMP's control.

## Features

| Feature | What it does |
| --- | --- |
| **Native desktop runtimes** | Use native macOS OMP, native Windows OMP, OMP inside WSL2, or Windows and WSL together. |
| **Profile-aware sessions** | Keep every OMP Profile, project folder, theme, and session history isolated. |
| **True session resume** | Continue existing OMP JSONL sessions through OMP's native RPC runtime. |
| **Model selection** | Browse and switch between the models reported by OMP. |
| **Session library** | Search, rename, pin, archive, restore, move to Trash, or permanently delete sessions. |
| **Live agent activity** | Follow streaming replies, reasoning, Markdown, code, tool calls, and confirmation requests. |
| **OMP theme sync** | Match OMP's light, dark, custom, symbol, and color-blind theme settings. |
| **Terminal handoff** | Move a session safely to macOS Terminal or Windows Terminal and reclaim it when you return. |

## Start in three steps

1. Click **New session**.
2. Choose the detected native or WSL runtime, an OMP Profile, and a project folder.
3. Start a new conversation—or open any saved session in its original environment.

Each saved session keeps its own runtime, Profile, and workspace. macOS `/...`, native `C:\...`, and WSL `/...` identities remain separate, and ownership locks prevent the desktop app and terminal OMP from writing to the same session simultaneously.

## Platform support

| Platform | Status |
| --- | --- |
| Windows 11 x64 + native Windows OMP | **Available** |
| Windows 11 x64 + OMP in WSL2 | **Available** |
| Default and named OMP Profiles | **Available** |
| macOS on Apple Silicon | **Available** |
| macOS on Intel | **Available** |
| Native Linux desktop | Not currently supported |

## Install

1. Install and configure OMP on macOS, native Windows, in WSL2, or both Windows environments.
2. Download the matching DMG/ZIP or Windows installer from [GitHub Releases](https://github.com/Eijnewgnaw/omp-desktop/releases/latest) when that platform asset is present.
3. Launch OMP Desktop and create your first session.

> [!NOTE]
> The macOS and Windows packages are not code-signed or notarized yet, so the operating system may show an unknown-developer warning. Download builds only from this repository.

## Local by design

- OMP Desktop does not install OMP, store provider API keys, upload conversations, or collect telemetry.
- Session content stays in OMP's own files; desktop-only labels and preferences use a separate local database.
- Trash, permanent deletion, resume, and terminal handoff are validated again in the main process against the selected runtime and session directory.

## Project documentation

- [Development guide](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

OMP Desktop is an independent community project and is not affiliated with or endorsed by the Oh My Pi authors. OMP Desktop is released under the [MIT License](LICENSE).
