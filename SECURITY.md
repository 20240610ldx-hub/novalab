# Security Policy

## 报告漏洞

**请不要开公开 issue。** 通过私密渠道报告：

- 邮箱：`20240610ldx-hub@users.noreply.github.com`（过渡联系方式；首选 GitHub 仓库的 Private vulnerability reporting 功能）

我们会在 72 小时内确认收到，并尽力在 30 天内给出修复或缓解方案。致谢报告者（如愿意具名）。

支持版本：当前仅 `main`（0.0.x 开发期，未发布正式版本）。

## 威胁模型摘要

NovaLab 是本地优先（local-first）工具，核心安全承诺是"**原始数据不出本机进程边界**"。已知边界与现状：

### 1. 本地优先架构

- Bridge 只监听 `127.0.0.1`（loopback），不暴露公网端口；前端 ↔ Bridge 的 WS 无鉴权，威胁模型假定单机单用户（同机其他本地进程可连接 loopback 端口——已知限制，多用户主机上请注意）。
- 文件系统操作（文件树、notebook 读写）限定在 workspace root 内，路径越界拒绝（bridge `fs.test.ts` 覆盖）。
- 内核为独立子进程；kernel 崩溃可经 .py 拓扑回放恢复状态。

### 2. 凭据管理

- **现状（0.0.x）**：LLM API key 存于 `app/.env.local`（gitignore，明文）；项目代码永不主动读取任何系统凭据存储（ADR-008 纪律）。
- **P4 进行中**：迁移到加密配置/系统 keychain；落盘文件采用 **0600 权限**（仅属主可读写），key 仅在使用时解密进内存。

### 3. LLM 上下文截断边界（隐私硬保证）

- 出进程（发给任何 LLM provider）的数据白名单：代码文本、traceback、DAG 边、变量 schema 元信息、`head(1)` 级预览。
- 截断在 Bridge `PreviewSerializer` 单一出口执行（>4KB 字符串硬截断、cell 输出各字段 8KB），**不依赖 prompt 自觉**；fuzz 测试断言 1B–1MB 输入必 ≤4KB（`bridge/src/preview.test.ts`）。
- UI 常驻审计 chip 显示"本次发送了什么"；`0 rows sent` 为默认态。
- 原始数据（DataFrame 全量、二进制、文件内容）永不出进程。注意：白名单内的代码与 schema 本身仍会发送给用户配置的 provider——隐私保证的边界是"schema-only"，不是"零发送"。

### 4. Agent 写入通道

- Agent（含外部 MCP Agent）对 notebook 的一切修改永远只产生 staged diff，必须经前端人工 `Tab` 采纳；不存在静默写文件或特权旁路。副作用 cell（写文件/网络请求启发式）默认不进 auto-cascade。

### 已知非目标

代码签名/公证（P4 release 流水线接入前，安装包不签名）；WS 通道 TLS/鉴权（单机模型）；恶意 notebook .py 的沙箱逃逸（内核以用户权限 exec 任意代码——与 Jupyter 同等信任模型，请勿打开不受信任的 notebook）。
