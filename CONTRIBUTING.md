# Contributing to NovaLab

欢迎贡献！本文档覆盖：fork-flow、测试门、**clean-room 纪律（硬性）**、commit 约定与 PR checklist。

## Fork-flow

1. Fork 本仓库，从 `main` 切特性分支：`git checkout -b feat/your-thing`。
2. 本地开发，跑通下方全部测试门。
3. Commit 遵循 [Conventional Commits](https://www.conventionalcommits.org/)（见下）。
4. Push 到你的 fork，向 `main` 开 PR，填写 PR 模板并勾完 checklist。
5. CI（`.github/workflows/ci.yml`）必须全绿；maintainer 审阅后合并。

环境搭建见 [README 快速开始](README.md#快速开始)。

## 测试门（PR 必须全绿，与 CI 同款）

| 门 | 命令 |
|---|---|
| 类型检查 | `pnpm --filter @novalab/bridge exec tsc --noEmit` 且 `pnpm --filter @novalab/app exec tsc --noEmit` |
| 脚本客户端回归 | `pnpm test:scripts`（随机 loopback 端口合成 WS，不读凭据/调用 provider） |
| bridge 单测 | `pnpm --filter @novalab/bridge exec vitest run` |
| app 单测 | `pnpm --filter @novalab/app exec vitest run` |
| Python 内核单测 | `uv run --directory py pytest` |
| 真实进程验收 | `pnpm --filter @novalab/bridge exec vitest run --config vitest.acceptance.config.ts`（先 `uv sync --directory py --all-extras`；鉴权/代理负例、纯 Diff 预检、真实保存/关闭与执行队列生命周期） |
| HTML 浏览器验收 | `node scripts/html-output-smoke.mjs <app-url>`（开发前端已运行；Chromium；无真实 provider） |
| 保存/关闭浏览器验收 | `node scripts/save-lifecycle-smoke.mjs <app-url>`（开发前端已运行；Chromium + 私有临时 bridge/文件；uv 环境已准备） |
| 外部冲突浏览器验收 | `node scripts/file-conflict-smoke.mjs <app-url>`（源码稳定后新启开发前端；私有临时文件；后台冲突、watcher 提醒、备份/冷加载、失败后显式重试与副本重开） |
| 集成冒烟 | `node scripts/integration-smoke.mjs`（私有临时 bridge + kernel，核验 PID/token 后直连，起停自管） |
| 进程隔离验收 | `node --test --test-timeout=70000 scripts/integration-smoke.acceptance.mjs`（先准备 uv 环境；独占合成 7788 服务，覆盖成功/故障/超时/信号处理器/并发；不得停止已占用该端口的其他服务） |
| Packaged 进程归属验收（Release 门） | 先构建 sidecars，再 `node --test --test-timeout=70000 scripts/packaged-startup-smoke.acceptance.mjs`；真实 bundled node/bridge/uv + 已准备的 Python，临时 notebook；需 7788 空闲建 decoy，不得停止其他服务，不与集成隔离套件并行。平台与非安装器边界见 [清单](docs/release-v0.1.1-checklist.md) |
| 画廊（涉及 UI 时） | 无 LLM 用 `node scripts/demo-gallery.mjs --skip-agent`（明确跳过 11 态）；受影响截图更新到 `docs/demos/states/`。真实 Agent 单列验收：11 态 optional 失败不影响脚本退出码，需核对实际结果 |

新增功能必须带测试；修 bug 先补一个能复现的失败用例再修。

## Clean-room 纪律（ADR-004，硬性）

本项目对 marimo / JupyterLab / Claude Science 等先行者采取 **clean-room** 姿态，对外声明见 [NOTICE](NOTICE)。贡献代码即表示你遵守：

1. **`refs/` 只读**：参考仓库（marimo、codemirror-merge、vercel-ai 等）只用于阅读理解思路，已 gitignore、不进依赖图。**禁止**从 `refs/` 复制任何文件、代码片段、注释、测试进 `app/` `bridge/` `py/` `scripts/`。
2. **学思路，不抄表达**：可以学习并重新实现算法与语义（如 DAG 失效传播），但实现代码、命名组织、错误文案必须是本项目自己的表达。如果你读过某个参考实现的源码后写等价功能，请在 PR 描述中声明"读过什么、只借鉴了什么思路"。
3. **测试断言自写**：测试用例与断言必须依据本项目 spec（`docs/spec.md`）与实际行为编写，禁止搬运参考项目的测试文件或断言值。
4. **视觉资产零复制**：不从任何闭源产品取样像素、抠图、提取 CSS；design tokens 改动在 `app/src/styles/` 内自建。
5. 拿不准时开 issue 问，宁可多问不要多抄。

## Commit 约定

Conventional Commits，一行式 subject（祈使句，英文），scope 可选：

```
feat(app): inline diff MergeView with Tab/Esc tray
fix(bridge): gate TabBar refresh on bridge connection
docs: gallery states 12-15b for P3 features
test / chore / refactor / perf 同理
```

- 关联计划项时带阶段号，如 `feat: multi-tab multi-kernel with focus routing (P3.1)`。
- **Co-Authored-By 行**：由 AI 助手（如 Claude Code）参与撰写的 commit，须在 message 末尾空一行后加其署名行（例如 `Co-Authored-By: Claude <noreply@anthropic.com>`），保持归属透明；纯人工 commit 不需要。

## PR checklist

- [ ] 全部测试门本地跑过且通过（CI 会复核）
- [ ] 新功能带测试；bug 修复带复现用例
- [ ] 遵守 clean-room 纪律；如读过参考实现源码，已在描述中声明边界
- [ ] 涉及协议/语义变更：已同步更新 `docs/spec.md`（规范文档先行）
- [ ] 涉及 UI：画廊受影响状态已重拍（`node scripts/demo-gallery.mjs`）
- [ ] commit message 符合约定；AI 参与已署名
- [ ] 未触碰 `refs/`、未提交 `.env.local` 或任何凭据

## 报告问题

- Bug：用 [issue 模板](.github/ISSUE_TEMPLATE/bug_report.yml)，附最小复现 .py 与平台信息。
- 安全漏洞：**不要开公开 issue**，见 [SECURITY.md](SECURITY.md)。

## 行为准则

参与本项目即同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
