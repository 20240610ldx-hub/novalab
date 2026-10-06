# NovaLab

本地优先 · 反应式内核 · Agent 深度协同的桌面科研数据工作台。
交互范式 clean-room 复刻 Claude Science Notebook，执行语义超越 JupyterLab。

## 文档

- [docs/intent.md](docs/intent.md) — 愿景、需求头脑风暴、决策记录、**待裁决开放问题 Q1–Q7**
- [docs/spec.md](docs/spec.md) — 架构、协议、内核语义、工具 schema、UI 规格
- [docs/plan.md](docs/plan.md) — spike/门、四阶段 WBS、参考仓库阅读地图、风险登记

## 仓库布局

| 目录 | 内容 |
|---|---|
| `app/` | React 19 前端（CodeMirror 6、Zustand、Tailwind v4、Vercel AI SDK） |
| `bridge/` | node TS 桥接进程：WS JSON-RPC、内核监督、隐私截断、MCP server |
| `py/` | `novakernel` 反应式 Python 内核（路线 B 原型，uv 管理） |
| `refs/` | 只读参考仓库：marimo / codemirror-merge / vercel-ai（已 gitignore） |
| `docs/` | intent / spec / plan / adr / demos |

## 快速开始

```bash
pnpm install            # 前端 + bridge 依赖（已装可跳过）
uv sync --directory py --all-extras   # Python 内核依赖（已装可跳过）
# 将 cc-switch tokenplan 的 URL/Key 填入 app/.env.local（intent Q7，gitignored）
pnpm dev:bridge         # 终端 1：桥接进程 ws://127.0.0.1:7788
pnpm dev:app            # 终端 2：前端 http://localhost:5199
```

## 当前状态

骨架 + 依赖就绪（2026-10-06）。下一步：plan §1 的 S1/S2 spike 与 G1 内核路线门；
`app/src/kernel/stalePolicy.ts` 中 `decideStalePolicy()` 为预留给 Owner 的代码贡献点（plan P2.4）。
