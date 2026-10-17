# ADR-012（提案）Agent harness：是否引入 pi-agent-core

> 状态：**D1 已裁决（Owner，2026-10-16）**：接受 §8 建议 —— pi 适配层作为 flag 后的实验路径保留在本分支，Vercel 路径不动；G-1 真实模型对比待 Owner 填好 `app/.env.local` 后运行（见 §10）。D2–D4 仍待裁决。
> 原状态：提案。本轮只交付 spike 原型 + 对比数据，未合入主线、未改动现有 Vercel 路径（`app/src/agent/*` 零改动）、未接 WS（`bridge/src/router.ts` 零改动）。
> 基线：`bce0c2d`（claude/novalab-dead-kernel-restart-b33920）。日期 2026-10-16。
> **数据口径：没有调用任何真实 LLM。** 本工作树没有 `app/.env.local`，按 ADR-008 不读取其他工作树或凭据存储。全部对比都用脚本化 stub 策略跑出来，下文的"成功率"只衡量 harness 机制，不代表模型能力。

## 1. 问题

现有 Agent 跑在浏览器里：`useAgentChat.ts` 用 `streamText` 做工具循环，`stopWhen: stepCountIs(10)`；工具是六个（spec §7）；provider 适配是自建的（`openaiCompat.ts` 474 行 + `providers.ts` 396 行），密钥经 bridge `llm-proxy` 注入，浏览器拿不到明文 key。Owner 想知道：如果改用 pi 的 agent 运行时（`@earendil-works/pi-agent-core` + `pi-ai`），能不能得到更高的自由度，比如运行中插话、钩子、本地模型覆盖面和扩展机制，同时 **M4（写入一律 staged）和 M5（隐私白名单）不放松**。

## 2. 与任务简报不一致、已核实的事实

| 简报说法 | 核实结果（2026-10-16） |
|---|---|
| 版本还在 0.7x，迭代很快 | 已经发布 **1.x**：1.0.0 发布于 10-01，1.3.0 发布于 10-15，从 1.0.0 起 15 天内发了 8 个版本。旧 scope `@mariozechner/pi-*` 停在 0.73.1，已标 deprecated。 |
| 仓库 `github.com/badlogic/pi-mono` | npm `repository` 字段现为 `github.com/earendil-works/pi`。maintainers：mitsuhiko、badlogic、rwachtler。许可证 MIT。 |
| 六个工具只读 + `propose_code_change`，Agent 不能运行代码 | 六个工具里有 **`execute_cell`**（`cell.run`）。Agent 能运行**已有** cell，但不能改代码，改代码只能走 staged diff。 |
| — | `engines.node >= 22.19.0`。`build-bridge.mjs` 目前只要求 sidecar node ≥ 22。 |

本 spike 精确 pin 的是 `pi-agent-core@1.0.4` + `pi-ai@1.0.4`：1.0 线的最后一个补丁版本，发布 11 天。最新的 1.3.0 发布不到 24 小时，所以没有用。

## 3. 选项

- **A. 保持 Vercel AI SDK（浏览器内循环）**：维持现状。
- **B. pi-agent-core 跑在 bridge（Node）**：本 spike 已实现为与 A 并列的适配层。
- **C. 只通过现有 MCP 让外部 pi 接入**：`bridge --mcp` 已经暴露六个工具（spec §6.3），外部的 pi（pi-coding-agent / `pi-mcp`）可以直接连上来，NovaLab 不需要写代码。

还有一个独立的维度：**循环跑在哪里**（浏览器还是 bridge）和**用哪个循环库**（Vercel 还是 pi）可以分开选。"Vercel AI SDK 跑在 bridge"同样可行，AI SDK 支持 Node。所以下面列出的 bridge 侧收益，有一部分并不专属于 pi。§5 会逐条说明。

## 4. 原型（选项 B）

代码在 `bridge/src/agent-runtime/`，全部未提交：

| 文件 | 作用 |
|---|---|
| `tool-schemas.ts` | **单源生成**：先用 `z.toJSONSchema(agentToolSchemas[name])` 得到 JSON Schema，再用 `Type.Unsafe` 包装成 TypeBox。不手写第二份 schema。`execute` 内部仍调用 `executeAgentTool`，用 zod 再 parse 一次，zod 是权威校验。 |
| `policy.ts`（M4） | `guardHost`：工具实现只能通过它访问 router，并且只放行 6 个方法（`agent.context/cellOutput/listCells/cellCode`、`diff.stage`、`cell.run`）。`cell.save`、`diff.accept`、`fs.*`、`kernel.repl` 在这一层直接抛 `M4Violation`。`decideToolGate`（由 `beforeToolCall` 调用）负责三件事：工具名白名单（**不引入** pi-coding-agent 的 read/write/edit/bash，pi 扩展或 skill 注入的任何工具都会被拦截）、`execute_cell` 策略（allow/deny）、每次 run 的提议预算（默认 8）。 |
| `privacy.ts`（M5） | `transformContext` 在**每次 LLM 请求前**对所有 toolResult 按工具做输出白名单：zod 对象默认 strip，白名单外的键直接丢弃；非 JSON、形状不符或未知工具一律 fail closed，替换成占位文本；字段截断规则是一般字符串 4KB、traceback 8KB、源码不截断，已经被 bridge 截断过的字段不会再叠加后缀；`details`/`structuredContent` 不随请求发出。每个工具结果按 `toolCallId` 去重，只记一条审计：字节数、丢弃的键、截断的字段、是否被 redacted。 |
| `runtime.ts` | `AgentRuntime`：`prompt / steer / followUp / abort`。写入和执行类工具设为 `executionMode: 'sequential'`。pi **没有内建步数上限**，这里用 `finishTurn` 在第 10 次 LLM 调用后结束，对齐 `stepCountIs(10)`。 |
| `provider.ts` | 用 `createProvider` 接两种兼容端点，与 app 的 `ProviderId` 对齐：`openai-compat`（`openAICompletionsApi`，覆盖 Ollama / vLLM / LM Studio）和 `anthropic-compat`（`anthropicMessagesApi`，覆盖 ADR-008 的 tokenplan 自测代理）。baseUrl 沿用 app 的约定（含 `/v1`）。key 只能显式传入，本模块不读 env，也不读凭据存储。 |
| `flag.ts` | 实验开关 `NOVALAB_EXPERIMENTAL_PI_RUNTIME`，默认关闭，只认 `"1"`。**目前没有任何生产入口读取它**：接线要等 G-2。 |
| `bench/*` | 合成夹具（`OracleKernel` 基于 `FakeKernel`）、同一份 stub 策略分别驱动两套循环、对比脚本 `compare.ts`，以及 G-1 真实模型脚本 `real.ts`（§10）。 |

依赖改动：`bridge/package.json` 新增 `@earendil-works/pi-agent-core@1.0.4`、`@earendil-works/pi-ai@1.0.4`（精确 pin），以及 devDependency `ai@7.0.128`、`@ai-sdk/anthropic@4.0.72`（只给 bench 用，版本与 app 一致，复刻 app 的循环和 dev 兜底 provider）。lockfile 新增 81 个包。

## 5. 证据

### 5.1 对比方法

两套循环接**同一个宿主**（真实的 `RpcRouter` + `OracleKernel`），由**同一个 stub 策略**驱动。stub 策略只根据自己看到的信息行动：提议修复之前，必须在工具结果里看到对应的证据（traceback 关键字、schema 列名或源码）。所以如果隐私闸误删了证据，结果会直接表现为失败。

Vercel 侧按 app 的做法复刻：`streamText` + `stepCountIs(10)`，工具 = `AGENT_TOOL_DEFS` + `executeAgentTool`，错误按 `safeRpc` 包成 `{toolError}`。唯一的差异是宿主走 in-process 的 `router.invoke`，没有经过 WS。

每次执行时，OracleKernel 往 stdout、stderr、text/html mime 和写入路径里撒 canary；另外有一个 >4KB 的 schema preview，canary 放在尾部。**泄漏数 = canary 出现在模型实际收到的请求里的次数。**

token 是估算值：取两边归一化后的请求内容（system、工具声明、消息文本、工具调用、工具结果），按 `ceil(chars/4)` 计算，两边口径相同。成本：本地或自测端点按 0 计；按 token × 单价可以自行换算。

复现命令：`pnpm --filter @novalab/bridge exec tsx src/agent-runtime/bench/compare.ts ../docs/adr-012-bench-results.json`。原始数据见 [adr-012-bench-results.json](adr-012-bench-results.json)。

### 5.2 N2（修错）× 6、N3（重构）× 4

| 夹具 | 说明 | Vercel 成功 / LLM 调用 / 估算输入 token | pi 成功 / LLM 调用 / 估算输入 token |
|---|---|---|---|
| n2-nameerror | 拼写 | ✓ / 5 / 4205 | ✓ / 5 / 3597 |
| n2-keyerror | 列名大小写（需要 schema） | ✓ / 5 / 7292 | ✓ / 5 / 6684 |
| n2-typeerror | 漏调用 | ✓ / 4 / 3108 | ✓ / 4 / 2622 |
| n2-rulebook | 首个提议重定义 → 预检拒绝 → 自纠 | ✓ / 5 / 8767 | ✓ / 5 / 8160 |
| n2-import | 模块名拼写 | ✓ / 4 / 3196 | ✓ / 4 / 2710 |
| n2-badargs | 首个调用 `action:"replace"` → 校验错误 → 自纠 | ✓ / 4 / 3329 | ✓ / 4 / 2721 |
| n3-extract | 一条消息里 3 个提议（提取函数） | ✓ / 4 / 3505 | ✓ / 4 / 3019 |
| n3-rename | 跨 3 格改名 | ✓ / 3 / 2452 | ✓ / 3 / 2088 |
| n3-split | 拆分 cell（搬移定义被拒 → 改用新名字） | ✓ / 4 / 3208 | ✓ / 4 / 2722 |
| n3-budget | 逐格读 9 格 → 撞 10 步上限（**两边都预期失败**） | ✗ / 10 / 13223 | ✗ / 10 / 12008 |
| **合计** | | **N2 6/6，N3 3/4，48 次调用，45 次工具调用，≈52.3k 输入 token** | **N2 6/6，N3 3/4，48 次调用，45 次工具调用，≈46.3k 输入 token** |
| **泄漏（正常路径）** | | **0** | **0** |

结论：在模型行为完全相同的前提下，两套 harness 的成功率、步数和工具调用数**完全一致**；参数校验错误和预检拒绝都能正确回传给模型自纠；两边泄漏都是 0。pi 侧估算输入 token 少约 11%，主要来自工具声明序列化体积的差异。这只是估算器层面的差异，真实的线上字节数取决于 provider 适配器（app 的 `openaiCompat.ts` 和 pi 的 `openai-completions` 不一样），**不应作为决策依据**。

### 5.3 M5 故障注入（模拟 bridge 出口回归，让 `agent.cellOutput` 误带 `stdout` 和写入路径）

| | Vercel | pi |
|---|---|---|
| canary 进入 LLM 请求 | **2 个**（`CANARY-STDOUT-…`、`CANARY-PATH-…`） | **0** |
| 审计 | 只记字节数，看不出越界 | `droppedKeys = [stdout, writes]` |

现有路径**只有 bridge 出口这一道闸**。pi 原型在 `transformContext` 里加了第二道白名单闸。需要说明：这道闸**不依赖 pi**，在 app 的 `tools.ts` 的 `execute` 里，或者用 AI SDK 的 `toModelOutput`，同样可以做到。

### 5.4 可中断性

| 场景 | Vercel | pi |
|---|---|---|
| I1 运行中插话（第 1 个工具结果后说"只诊断，不要提议"） | 2 次调用，下一次请求就能看到插话，0 次请求被丢弃，0 个 diff；但需要 **abort 加上在应用层重建历史再重发**（bench 里十余行，app 里对应 `chat.stop()` + `sendMessage`） | 2 次调用，下一次请求就能看到插话，0 个 diff；**原生 `steer()`，同一个 run 内完成** |
| I2 中止慢执行（execute_cell 耗时 1.5s，100ms 后 abort） | 循环要 **1403 ms** 才结束（`executeAgentTool` 不接 abortSignal，要等工具跑完） | **1 ms**（工具 execute 收到 signal 立即返回） |
| I3 排队追问（运行中排队"再总结一句"） | 6 次调用；没有原生队列，应用层要等第一个流结束后**发起第二次 run** | 6 次调用；原生 `followUp()`，**同一个 run** |

两边内核侧的 exec 都**不可取消**：abort 之后 cell 仍会跑完，结果只进本地输出缓存。I2 的差距可以在 Vercel 路径上消除，只要给 `executeAgentTool` 传入 `abortSignal` 即可。I1 和 I3 两边的调用次数相同，差别在于需要多少应用层代码，以及事件是否属于同一个 run。

### 5.5 包体与运行环境

- sidecar 的 esbuild 单文件 bundle：**1.60 MB → 3.04 MB**（+1.44 MB）。虽然只用到了 OpenAI 兼容这一个 API，`openai` SDK 和 `@aws-sdk/*` 的代码（各约 199 个模块）仍然会被打进来。
- `node_modules` 增加约 55–60 MB：`openai` 25 MB、`@anthropic-ai/sdk` 13 MB、`@google/genai` 11 MB、`pi-ai` 5.8 MB、AWS 若干 MB。
- `@earendil-works/pi-telemetry` 是传递依赖，声明为 `^1.0.4`，**实际解析到 1.3.0**。也就是说，顶层精确 pin 管不住传递依赖，只能靠 lockfile。已核实它只包含 span 契约、noop 实现和 in-memory 参考实现，**没有 exporter，也没有网络调用**。`createModels()` 不会主动拉取任何目录；Radius 的远端目录只有注册该 provider 才会启用。
- `pi-ai` 的 README 声称支持浏览器，但 `pi-agent-core` 在 Vite/Tauri webview 里**没有验证过**。本 spike 只在 Node 上跑。

### 5.6 测试

- `bridge/src/agent-runtime/runtime.test.ts`：16 项全部通过。覆盖 schema 单源一致性、M4（未知工具、execute=deny、受限宿主）、M5（丢键、fail-closed、截断、审计去重、故障注入下 0 泄漏）、`steer`、10 步上限，以及 `createOpenAICompat` 打本地假 OpenAI SSE 端点：工具声明来自 zod、`Authorization` 来自显式 key、请求体里没有 canary、usage 能正确计入。
  另外两项：实验开关默认关闭；`anthropic-compat` 下 pi 和 app 的 `@ai-sdk/anthropic` 用同一个 baseURL 打到同一路径，key 都走 `x-api-key`。
- bridge 全量 21 个文件、290 项通过（含上述 16 项）。`tsc --noEmit` 在 bridge 和 app 都干净。

## 6. 风险

1. **版本节奏**：从 1.0.0 起 15 天内发了 8 个版本，API 仍在变（README 写明已移除 `shouldStopAfterTurn`，改为 `finishTurn`）。传递依赖用的是 caret 范围（见 5.5）。需要一条 pin 纪律：lockfile 入库，升级单独做 PR，候选版本至少发布 14 天，并且升级时跑本 bench 和 runtime 测试作为门槛。
2. **包 scope 与所有权**：半年内从 `@mariozechner/*` 迁到 `@earendil-works/*`，仓库也搬了位置，维护方是三人小组。后续还可能再迁移或改名；MIT 许可证允许 vendor，作为退路。
3. **TypeBox 与 zod 的转换**：单源生成已经可用。但 pi 的校验器会**做宽松的类型转换**（`cellId: 1` → `"1"`，`cascade: "true"` → `true`），zod 不会。测试已经钉住一个不变量：凡是 pi 放行的参数，经它转换后的值 zod 也一定放行，所以权威校验没有被绕过。代价是两条路径对模型的不规范输出容忍度不同。另外 zod 升级后 `toJSONSchema` 的输出可能漂移，由测试兜底。
4. **浏览器运行时**：未验证（5.5）。B 的前提是循环在 bridge 里跑，不依赖浏览器端。
5. **依赖第六轮 bridge 重连**：原型没有接 WS。真正集成需要 `agent.*` 的流式事件协议（前端订阅 `message_update` / `tool_execution_*`），以及在 bridge 断线或重启时如何处理进行中的 run。这正是第六轮在改的 `router` / `client` 层（它的交接便签里已列出断线不通知 store 等问题）。**必须等第六轮落地之后再设计**，否则两边会冲突。
6. **双路径维护**：如果 A 和 B 长期并存，`systemPrompt.ts`（目前在 app 里，bench 通过相对路径引用）、审计 UI（ContextChip）、provider 设置都要做成单一来源，否则会出现行为漂移。
7. **pi 没有内建步数上限**：靠 `finishTurn` 实现，已经有测试覆盖。日后升级 pi 时，如果这个钩子的语义变了，这道保护会静默失效，属于升级门的必测项。

### 顺带发现（与选型无关，建议另开工作包）

- **F1**：Vercel 路径的 M5 只有一道闸（5.3）。把白名单的第二道闸补到 `app/src/agent/tools.ts` 成本很低，而且无论选 A 还是 B 都成立。
- **F2**：`diff.stage` 的预检只校验"当前 cells + 本条 diff"，不叠加已经 staged 的 diff。因此"把定义搬到新 cell"会和原 cell 里仍然存在的定义冲突而被拒（n3-split）。stub 策略改用新名字绕过了，这也恰好符合 Reactive Rulebook。这和路线图阶段 3"完善多格 Diff 队列"直接相关。**（2026-10-17 已修复：叠加待审 diff 预检 + `dependsOn` / `conflictsWith` / `hint`，见路线图 §12。）**
- **F3**：AI SDK 会**并发**执行同一条消息里的多个工具调用，router 因此会收到并发的 `diff.stage`。入队顺序目前依赖内核按 FIFO 应答，并没有文档化的保证。pi 原型把写入类工具设为串行。另外，bench 的 FakeKernel 曾因为共享的 `nextCompileError` 字段在并发下错配，已在 `OracleKernel` 里修正。真内核按请求独立计算，没有这个问题。**（2026-10-17：`diff.stage` 已排入 notebook 写队列，并发 stage 按到达顺序串行，见路线图 §12。）**
- **F4**：`executeAgentTool` 不接 abortSignal（5.4 的 I2）。
- **F6**：在 `anthropic-compat` 下，pi 走的是 `@anthropic-ai/sdk` 的 beta 接口，请求路径是 `/v1/messages?beta=true`；app 的 `@ai-sdk/anthropic` 用的是 `/v1/messages`。如果代理严格匹配查询串，pi 会不兼容。G-1 第一次运行时就能看出来。bridge `llm-proxy` 是否透传查询串，需要在 G-2 接线时确认。
- **F7**：`@ai-sdk/anthropic` 遇到未知模型 id（tokenplan 的 qwen/glm/deepseek 等）会把输出上限压到 **4096**，运行时有 warning。也就是说 **app 现网对这些模型的输出预算就是 4096**，长代码提议可能被截断。G-1 脚本让 pi 也对齐到 4096，保证对比公平。这一点与选型无关，可以单独评估是否给 app 显式设置 `maxOutputTokens`。
- **F5（未验证的假设，不计为缺陷）**：traceback 在 M5 白名单内，但异常消息本身可能带出数据值，例如 `KeyError` 或 `ValueError` 里的单元格内容。本轮没有构造复现，先登记为开放问题。

## 7. 选项评估

| | A 保持 Vercel | B pi in bridge | C 外部 pi 走 MCP |
|---|---|---|---|
| M4 | 结构性保证（工具只能 staged） | 结构性保证 + `guardHost` + `beforeToolCall` 白名单 | NovaLab 内部仍是结构性保证；但外部 pi 自带 bash/read/write，**可以完全绕开 NovaLab 直接读写工作区文件**。这与今天 Claude Code 通过 MCP 接入的边界相同，不在 NovaLab 的防护范围内 |
| M5 | 一道闸 | 两道闸，加逐条审计 | NovaLab 出口一道闸；外部模型能看到它自己读到的任何东西 |
| 插话 / 追问 / 中止 | 应用层拼接 | 原生 | 由外部工具负责 |
| provider 覆盖 | 自建适配，870 行 | README 列出 34 家内建 provider，外加任意 OpenAI 兼容端点 | 由外部工具负责 |
| 新增成本 | 0 | +81 个包，sidecar +1.44 MB，需要 WS 事件协议和第六轮配合 | 约为 0（现有 MCP） |
| 主要风险 | 自建适配的维护负担 | 版本节奏、所有权变动、双路径漂移 | 边界外的写入，以及用户体验割裂 |

## 8. Go / No-Go 建议

**建议：替换 A 为 No-Go；保留 B 作为 flag 后面的实验路径为有条件 Go；C 不需要做任何事，直接写进文档。**

理由：在同等模型行为下，B 没有带来可测的成功率或步数优势（5.2 完全一致）。它的实际收益在于运行中插话、追问、中止这类控制原语是原生的（5.4），以及 provider 覆盖面更广。最有价值的安全增益是第二道 M5 闸（5.3），但这一项**不依赖 pi**，在 A 上也能做（F1）。B 的成本是确定的：81 个包、+1.44 MB、版本节奏快、需要等第六轮。"成功率"这项关键证据目前只有 stub 数据，还缺真实模型的数据。

B 转为正式 Go 的门槛（全部满足才进入集成）：

1. **G-1 真实模型对比**：Owner 在 `app/.env.local` 填好自测端点后，跑同一组 N2/N3，加上 2–3 个更难的题目。B 的成功率不低于 A，泄漏为 0，可中断性场景复测通过。
2. **G-2 第六轮落地**：bridge 重连合入之后，再设计 `agent.run` 的 WS 事件协议，以及断线时进行中 run 的语义。
3. **G-3 依赖纪律**：采用 §6.1 的 pin 规则；sidecar 的 node 下限提到 22.19。
4. **G-4 单一来源**：system prompt、审计条目格式和 provider 配置收拢到 bridge，A 和 B 共用。

## 9. 请 Owner 裁决

- ~~**D1**~~：**已裁决（2026-10-16）**：接受。B 作为 flag 后的实验路径保留在本分支，A 不动。
- **D2**：B 路径里 `execute_cell` 的默认策略。`allow` 与现状一致；`deny` 表示 Agent 只能读和提议，运行一律在用户采纳 diff 时触发。实现位置：`policy.ts` 的 `decideToolGate`。
- **D3**：F1 的 M5 第二道闸是否先补到 A？与本 ADR 的结论无关，可以单独开一个工作包。
- **D4**：§6.1 的依赖 pin 纪律是否作为全仓规则（ai、@ai-sdk/* 同样适用）？

## 10. G-1 运行方式（Owner 手动）

1. 在**本工作树**的 `app/.env.local` 里填 `VITE_NOVALAB_LLM_BASE_URL`、`VITE_NOVALAB_LLM_API_KEY`、`VITE_NOVALAB_LLM_MODEL`。与 app 的 dev 兜底是同一份文件，kind 默认为 `anthropic-compat`。**G-1 要求必须显式写出 MODEL**。
2. 运行 `pnpm --filter @novalab/bridge exec tsx src/agent-runtime/bench/real.ts --reps 3 --out ../docs/adr-012-g1-results.json`。如果端点是 OpenAI 兼容的，加上 `--kind openai-compat`。
3. 运行量：10 个夹具 × 2 套 harness × 3 次重复，加上 2 次插话场景，大约 200–350 次 LLM 请求，消耗的是 Owner 的自测额度。
4. 脚本只读这一个文件，不打印端点和 key。泄漏扫描基于真实 HTTP 请求体（包装了 `globalThis.fetch`）。两边使用同一端点、同一模型、同一 system prompt，输出上限都是 4096（F7）。
5. 已用本地假 Anthropic 端点做过端到端冒烟：两边各 20 次请求，usage 计数一致，泄漏 0；临时的 `.env.local` 已删除。**没有对真实模型跑过**。

G-1 通过判据（沿用 §8）：pi 的 N2/N3 成功率不低于 Vercel，泄漏 = 0，插话场景两边都不产生 staged diff。真实模型的输出有随机性，3 次重复的差距在 1 题以内都视为持平。

## 附：受测源码指纹（git blob，前 12 位）

```
a1d4aecb6e45 bridge/src/agent-runtime/flag.ts
460e2413a019 bridge/src/agent-runtime/policy.ts
7edc80d7d8e5 bridge/src/agent-runtime/privacy.ts
f5655c4d5dc2 bridge/src/agent-runtime/provider.ts
6950e4cda9c0 bridge/src/agent-runtime/runtime.test.ts
5138ab8b427a bridge/src/agent-runtime/runtime.ts
9706e519fd68 bridge/src/agent-runtime/tool-schemas.ts
08a7571704f9 bridge/src/agent-runtime/bench/compare.ts
035feba8ccea bridge/src/agent-runtime/bench/fixtures-data.ts
58a147de7b87 bridge/src/agent-runtime/bench/fixtures.ts
2f0f3739a399 bridge/src/agent-runtime/bench/loops.ts
663495ec21ab bridge/src/agent-runtime/bench/policy.ts
bad14711f82a bridge/src/agent-runtime/bench/real.ts
```
