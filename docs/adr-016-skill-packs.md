# ADR-016 技能包：类别映射守恒、边际配平（通用、领域中立）

状态：Accepted（2026-10-19，按路线图 wave-2 自主推进；Owner 可在 PR 审阅时改判）

## 1. 背景

运行包工作流洞察（`docs/workflow-insights-bundles.md` §3–4）里有两类与学科无关、反复手写的模式：

- **口径映射**：把不同来源的类别对到统一口径，再打印核对计数是否守恒。
- **配平**：已知行列边际，用迭代比例拟合（IPF / raking）调种子矩阵，再看残差。

ADR-013 §4.3 规定：需要领域知识的规则不进核心，以"技能包"的契约模板插入。本 ADR 定义技能包的最小形状，并落地这两个通用技能。

## 2. 决定

技能包 = **一段 Agent 做法说明 + 用来核验它的声明式契约**。

| 部分 | 位置 | 说明 |
|---|---|---|
| 做法 | `app/src/agent/skills.ts` `SKILL_PACKS` → `skillsPromptSection()` 拼进 system prompt | 何时用、怎么写、拿什么核验。生成的代码只用 pandas / numpy，导出的 notebook 离开 NovaLab 也能跑；不在用户内核里注入辅助库 |
| 契约 | `py/novakernel/shadow.py` `_eval_one`；schema 在 `bridge/src/mcp/tools.ts` `contractSchema` | 与现有契约同一路径：影子内核求值，两道闸只放行计数 |

`skills.test.ts` 守护两者不漂移：每个技能声明的 `contractKinds` 必须能通过 `verify` 的 schema。

### 2.1 `mapping_conserved`

```
{kind: 'mapping_conserved',
 mapping: {源类别: 目标类别} | '命名空间里的 dict / Series 变量名',
 before: {target, column: 源类别列, value?: 数值列, phase?},   // 默认 phase = before
 after:  {target, column: 目标类别列, value?, phase?},          // 默认 phase = after
 rtol?, atol?}
```

- 把 `before` 按映射后的类别汇总（省略 `value` = 行数），与 `after` 按目标类别的汇总逐组比较。
- `unmapped` = 源数据中没有出现在映射表里的类别数（空值类别算 1 个）。
- `violations` = `unmapped` + 合计对不上的目标组数；`total` = 目标组数；`maxAbsDiff` = 最大组差。
- 类别统一按 `str()` 比较（JSON 映射的键只能是字符串）。映射表上限 5000 条。

### 2.2 `margins_match`

```
{kind: 'margins_match', target: 二维数值表或数组,
 rows?: number[] | 变量名, cols?: number[] | 变量名,   // 至少一个
 rtol? (默认 0), atol? (默认 1e-6), phase?}
```

- 行和 / 列和与目标比较；`violations` = 超出容差的行数 + 列数，`maxAbsDiff` = 最大残差。
- 目标是带索引的 Series、且索引与矩阵行（列）标签同集合时，按标签对齐；否则按位置，长度不符 → `invalid-params`。

### 2.3 隐私

两种契约只返回 `status / total / violations / unmapped / maxAbsDiff / reason`。不回显类别标签、映射表或数值（映射表是 Agent 自己写的，但源数据里出现的类别不是）。`unmapped` 已加入第一道闸（`shadow/report.ts`）和第二道闸（`mcp/output-whitelist.ts`）的白名单。

## 3. 不做 / 以后

- 不做 IPF 求解器契约或内核内辅助函数：配平代码由 Agent 写在 notebook 里，用户可审阅、可带走；契约只核验结果。
- 领域技能包（如人口口径表）以后按同一形状加入 `SKILL_PACKS`；是否支持从项目目录加载用户自定义技能包另议。
- 技能段落随 system prompt 每轮发送（约 600 字）；技能多到影响上下文时，改为按需取用的工具。

## 4. 验证

- `py/tests/test_shadow.py`：两种契约的通过 / 失败 / 未映射 / 命名空间映射 / 按标签对齐 / 不回显标签（23 通过）。
- `bridge/src/shadow.acceptance.ts`：真实影子内核里运行映射 + IPF cell，核验 4 条契约（通过、缺映射、配平后通过、未配平失败），且结果不含 canary。
- `bridge/src/mcp/shadow-tools.test.ts`：`unmapped` 过两道闸，回显字段被丢弃。
- `app/src/agent/skills.test.ts`：技能 ↔ 契约 schema 不漂移；system prompt 含全部技能段落。
