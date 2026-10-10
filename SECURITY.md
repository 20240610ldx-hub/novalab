# Security Policy

## 报告漏洞

**请不要开公开 issue。** 通过私密渠道报告：

- 邮箱：`20240610ldx-hub@users.noreply.github.com`（过渡联系方式；首选 GitHub 仓库的 Private vulnerability reporting 功能）

我们会在 72 小时内确认收到，并尽力在 30 天内给出修复或缓解方案。致谢报告者（如愿意具名）。

支持版本：最新发布版（当前 0.1.x）与 `main`。

## 威胁模型摘要

NovaLab 是本地优先（local-first）工具，核心安全承诺是"**原始数据不出本机进程边界**"。已知边界与现状：

### 1. 本地优先架构

- Bridge 只监听 `127.0.0.1`（loopback），不暴露公网端口。
- **通道鉴权（0.1.1 起，两层）**。WebSocket 握手不受浏览器 CORS 约束——用户浏览器里任意网页都能尝试连接本机 bridge，而该通道可执行任意 Python（`kernel.repl`）、读写工作区文件。因此：
  1. **Origin 白名单**：`GET /bridge-info` 与 WS upgrade 都要求 `Origin` 是本机前端（vite dev 的 `localhost` / `127.0.0.1` 5000–5999 端口，或 Tauri webview），否则 403；**不带 Origin 的请求同样拒绝**，因此 DNS rebinding 后的同源请求也拿不到 token。
  2. **启动 token**：bridge 每次启动生成 32 字节随机 token（或取 `NOVALAB_BRIDGE_TOKEN`），经 `/bridge-info` 只下发给白名单 Origin；WS 连上后 3 秒内首条消息必须是 `bridge.auth {token}`，否则连接以 1008 关闭，未认证连接收不到任何广播。
  - LLM 代理要求请求头 `x-novalab-bridge-token` 携带同一 token，并同样校验 Origin。
  - 剩余限制：与当前用户同权限的本地进程可以伪造 Origin 头（或读取运行清单 `<dataDir>/bridge.json`），等同于能读用户的全部数据——这不在本工具的防护范围内。
- 文件系统操作（文件树、notebook 读写）限定在 workspace root 内，路径越界拒绝（bridge `fs.test.ts` 覆盖）。
- 内核为独立子进程；kernel 崩溃可经 .py 拓扑回放恢复状态。

### 2. 凭据管理

- **现状（0.1.x）**：设置面板录入的 API key 由 bridge 以 AES-256-GCM 加密落盘 `<dataDir>/providers.json`（0600），仅在 LLM 代理转发时解密进内存；浏览器侧不持有 key。
- dev 兜底：`app/.env.local`（gitignore，明文）仍可用于开发自测；项目代码永不主动读取任何系统凭据存储（ADR-008 纪律）。

### 3. LLM 上下文截断边界（隐私硬保证）

- 出进程（发给任何 LLM provider）的数据白名单：代码文本、traceback、DAG 边、变量 schema 元信息、`head(1)` 级预览。
- 截断在 Bridge `PreviewSerializer` 单一出口执行（>4KB 字符串硬截断），**不依赖 prompt 自觉**；fuzz 测试断言 1B–1MB 输入必 ≤4KB（`bridge/src/preview.test.ts`）。
- Agent 读取 cell 输出（`get_cell_output`，含外部 MCP Agent）只得到 traceback 与 MIME 类型键；stdout/stderr 与写入路径留在本地 UI。
- UI 常驻审计 chip 显示"本次发送了什么"：首条消息逐段 + 每次工具返回的内容预览与体积。
- 原始数据（DataFrame 全量、二进制、文件内容）永不出进程。注意：白名单内的代码与 schema 本身仍会发送给用户配置的 provider——隐私保证的边界是"schema-only"，不是"零发送"。

### 4. Agent 写入通道

- Agent（含外部 MCP Agent）对 notebook 的一切修改永远只产生 staged diff，必须经前端人工 `Tab` 采纳；不存在静默写文件或特权旁路。副作用 cell（写文件/网络请求启发式）默认不进 auto-cascade。

### 已知非目标

代码签名/公证（未配置签名 secrets 时安装包不签名）；WS 通道 TLS（仅 loopback，鉴权见上）；Tauri webview CSP 尚未收紧（`csp: null`）；恶意 notebook .py 的沙箱逃逸（内核以用户权限 exec 任意代码——与 Jupyter 同等信任模型，请勿打开不受信任的 notebook）。
