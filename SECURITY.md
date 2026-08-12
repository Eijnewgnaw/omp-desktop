# Security Policy

## Supported versions

当前只有最新正式版本接收安全修复。

## Reporting a vulnerability

请使用 GitHub 的 [Private vulnerability reporting](https://github.com/Eijnewgnaw/omp-desktop/security/advisories/new) 私下报告漏洞。不要先创建公开 Issue，也不要附带真实 API 密钥、访问令牌或未脱敏的 OMP 会话。

报告中请提供影响范围、复现条件、受影响版本和最小化的验证材料。维护者会确认收到报告，并在验证后协调修复与披露。

## Security model

- 渲染进程启用 `contextIsolation`、sandbox 和 `webSecurity`，并禁用 Node.js 集成。
- Preload 只暴露固定 IPC 接口；主进程使用 schema 和路径规则校验输入。
- OMP 进程通过原生 argv 或固定 supervisor 脚本和独立位置参数启动，不把用户输入拼接进 shell 脚本文本；回收时只向记录的精确进程或 WSL 进程组发送信号。
- Windows Terminal 子命令中的字面分号会按其命令行规范转义；终端交接或会话回收只有在受管 OMP 退出得到验证后才会继续，验证失败时保留所有权并阻止操作。
- macOS Terminal 交接使用固定 AppleScript，工作区、OMP 路径与参数均通过独立 argv 传入，再由 AppleScript 逐项进行 shell quoting。
- 外部导航默认拒绝，仅允许系统浏览器打开 HTTP(S) URL。
- App 不接管 OMP 凭据，不发送遥测，也不重写 OMP 会话内容。只有用户确认后，才会把严格位于 sessions 根目录下的会话移动到可恢复回收站，或在独立警告弹窗再次确认后永久删除精确目标。

桌面壳无法替代对 OMP 本身、扩展、模型提供商和工作区代码的安全评估。运行工具前仍应检查 OMP 显示的意图与确认请求。
