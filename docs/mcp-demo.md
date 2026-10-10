# NovaLab MCP 接入示例（P2.7）

Bridge 内置 MCP stdio server（spec §6.3 / ADR-003）：外部 Agent（Claude Code、Claude Desktop 或任意 MCP 客户端）可以直接读写*审阅通道*内的 notebook 上下文，与前端 in-process 工具共用同一套 schema/execute 单一来源（`bridge/src/mcp/tools.ts`）与同一个 router。

## 启动方式

```
tsx bridge/src/main.ts --mcp [notebook.py]
```

- `--mcp`：不起 WS 服务，stdout 专属 MCP 协议帧（日志走 stderr）。
- 可选位置参数：启动即打开的 notebook 路径；不给则工具调用返回"尚未打开 notebook"。

## Claude Code 接入

```bash
claude mcp add novalab -- pnpm --dir "D:/Notebook Agent/bridge" exec tsx src/main.ts --mcp "D:/Notebook Agent/demos/demo.py"
```

或项目级 `.mcp.json`（仓库根）：

```json
{
  "mcpServers": {
    "novalab": {
      "command": "pnpm",
      "args": [
        "--dir", "D:/Notebook Agent/bridge",
        "exec", "tsx", "src/main.ts",
        "--mcp", "D:/Notebook Agent/demos/demo.py"
      ]
    }
  }
}
```

其他 MCP 客户端（Claude Desktop 等）同理：`command` 指向任何能跑 `tsx src/main.ts --mcp <path>` 的启动器。

## 工具一览（六工具，spec §7）

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_notebook_context` | — | `{dagEdges, schemas, focusCellId, staleSet}` | 依赖拓扑 + 变量 schema（过 PreviewSerializer 4KB 硬截断）；**无原始数据** |
| `get_cell_output` | `cellId` | `{traceback, mimeKeys}` | 隐私安全摘要；stdout、stderr 与文件路径只留在本地 UI/session，不发送给 Agent |
| `propose_code_change` | `targetCellId, action(update\|insert_below), newCode, rationale?` | `{diffId}` 或 `{rejected:true, reason}` | 只产生 staged diff；入队前编译预检（多重定义/DAG 环 → 拒绝并回 reason，供模型自纠） |
| `execute_cell` | `cellId, cascade?` | run 报告 `{cellId, ok, cascaded, durationMs, traceback?}` | 与前端同一内核、同一执行队列 |
| `list_cells` | — | `[{id, execCount, status, firstLine, defs, refs}]` | status ∈ idle / ok / stale / error |
| `get_cell_code` | `cellId` | `{cellId, code}` | 源码原文 |

## Resources

| URI | 内容 |
|---|---|
| `novalab://notebook/dag` | JSON `{dagEdges, staleSet}`（application/json） |
| `novalab://cell/{id}` | 该 cell 源码原文（text/x-python） |

## 安全边界

- **Staged-only**：`propose_code_change` 永远只把 diff 放入暂存队列，前端弹行内审阅（Tab 采纳 / Esc 拒绝）；外部 Agent **不存在特权写入通道**——MCP 与前端 in-process 工具落到同一批 `router.invoke` 方法，无旁路。
- **隐私契约（spec §8 / ADR-006）**：出进程数据白名单 = 代码文本、traceback、DAG 边、schema 元信息与 MIME 类型键；stdout/stderr、文件写入路径、DataFrame 全量、二进制和文件内容留在本地 UI/session。`agent.context` 的 schema 过 PreviewSerializer 4KB 硬截断，traceback 仍按 8KB 截断。
- **编译预检**：stage 前把"应用该 diff 后的全量 cells"发给内核 `set_cells` 试探（纯静态分析、不执行），随后无条件回滚为原 cells；两次额外往返的成本可接受，换来无效提议不进审阅队列。
