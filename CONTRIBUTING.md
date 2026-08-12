# Contributing

感谢你帮助改进 OMP Desktop。这个项目的首要原则是保持 OMP 作为 agent、工具和会话语义的唯一事实来源。

完整的环境准备、测试矩阵、打包和发布说明见 [开发指南](docs/DEVELOPMENT.md)。

## 开始开发

1. 安装 Node.js 22.20 或更新版本。
2. 运行 `npm ci`。
3. 运行 `npm run dev` 启动开发环境。

Windows 功能需要 Windows 原生或 WSL2 中存在可执行的 `omp`；Default 与命名 Profiles 会作为独立环境检测。Linux 仅作为 WSLg 开发兼容模式。

## 提交前检查

```bash
npm run typecheck
npm test
npm run build
```

如果修改了 RPC 或运行时逻辑，并且本机已安装 OMP，再运行 `npm run test:integration`。该测试只做协议握手和状态读取，不调用模型。

## 变更原则

- 不在 App 内复制或改写 OMP 的 agent 决策逻辑。
- 不直接修改 OMP JSONL 会话；桌面专属元数据应存入独立数据库。
- 新增 IPC 时必须校验全部输入，并保持渲染进程无 Node.js 权限。
- 兼容未知 RPC 帧；新增显示能力不应让旧帧导致崩溃。
- UI 颜色优先来自 OMP 语义主题令牌，不建立平行主题体系。

Bug 报告请包含 Windows 版本、所选运行环境（Windows 原生或 WSL 发行版）、Profile、OMP 版本、复现步骤和已脱敏日志。不要提交 API 密钥或原始会话内容。
