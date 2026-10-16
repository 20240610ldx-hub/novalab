/**
 * N2（修错）× 6、N3（重构）× 4 合成夹具。数据全部为编造的小数字 / 假函数名。
 */

import { analyze, type Fixture, type FixtureCell } from './fixtures';
import { call, calls, say, seen, steps, anyRejected } from './policy';

const tb = (cellId: string, line: string): string =>
  `Traceback (most recent call last):\n  File "<cell ${cellId}>", line 1, in <module>\n${line}`;

/** 通用 NameError 判定：按 cell 顺序，引用了前面没定义、也不在 externals 里的名字就报错。 */
function nameErrors(cells: FixtureCell[], externals: string[]): Record<string, string> {
  const known = new Set(externals);
  const out: Record<string, string> = {};
  for (const c of cells) {
    const { defs, refs } = analyze(c.code);
    const missing = refs.find((r) => !known.has(r) && !defs.includes(r));
    if (missing) out[c.id] = tb(c.id, `NameError: name '${missing}' is not defined`);
    for (const d of defs) known.add(d);
  }
  return out;
}

const merge = (...rs: Record<string, string>[]): Record<string, string> => Object.assign({}, ...rs);
const code = (cells: FixtureCell[], id: string): string => cells.find((c) => c.id === id)?.code ?? '';

/** >4KB 的 preview：尾部 canary 必须被 bridge 4KB 截断挡住。 */
const bigPreview = `${'{"amount": 12.5, "region": "N", "year": 2021}, '.repeat(100)}CANARY-PREVIEW-tail`;

const surveySchema = [
  {
    name: 'df_raw',
    type: 'DataFrame',
    shape: [1200, 3],
    columns: ['amount', 'region', 'year'],
    preview: bigPreview,
  },
];

export const N2_FIXTURES: Fixture[] = [
  {
    id: 'n2-nameerror',
    kind: 'N2',
    title: 'NameError 拼写',
    prompt: 'cell b 报错了，请修复。',
    cells: [
      { id: 'a', code: 'values = [4, 8, 15, 16, 23, 42]' },
      { id: 'b', code: 'total = sum(valuse)' },
      { id: 'c', code: 'share = total / 2' },
    ],
    oracle: (cs) => nameErrors(cs, []),
    runFirst: ['b'],
    policy: steps(
      () => call('list_cells'),
      () => call('get_cell_output', { cellId: 'b' }),
      () => call('get_cell_code', { cellId: 'b' }),
      (v) =>
        seen(v, 'NameError', 'valuse', 'sum(valuse)')
          ? call('propose_code_change', { targetCellId: 'b', action: 'update', newCode: 'total = sum(values)', rationale: '拼写' })
          : say('看不到报错信息，无法修复。'),
    ),
  },
  {
    id: 'n2-keyerror',
    kind: 'N2',
    title: 'KeyError 列名大小写（需 schema）',
    prompt: 'cell b 报 KeyError，请修复。',
    cells: [
      { id: 'a', code: 'df_raw = load_survey()' },
      { id: 'b', code: 'amount_sum = df_raw["Amount"].sum()' },
    ],
    schemas: surveySchema,
    oracle: (cs) =>
      merge(
        nameErrors(cs, ['load_survey']),
        code(cs, 'b').includes('"amount"') ? {} : { b: tb('b', "KeyError: 'Amount'") },
      ),
    runFirst: ['b'],
    policy: steps(
      () => call('list_cells'),
      () => call('get_cell_output', { cellId: 'b' }),
      () => call('get_notebook_context'),
      (v) =>
        seen(v, "KeyError: 'Amount'", '"amount"')
          ? call('propose_code_change', {
              targetCellId: 'b',
              action: 'update',
              newCode: 'amount_sum = df_raw["amount"].sum()',
              rationale: '列名为小写 amount',
            })
          : say('缺少列信息，无法修复。'),
    ),
  },
  {
    id: 'n2-typeerror',
    kind: 'N2',
    title: 'TypeError 漏调用',
    prompt: '修复 cell b。',
    cells: [
      { id: 'a', code: 'values = [3, 5, 7]' },
      { id: 'b', code: 'mean_v = sum(values) / len' },
    ],
    oracle: (cs) =>
      merge(
        nameErrors(cs, []),
        code(cs, 'b').includes('len(values)')
          ? {}
          : { b: tb('b', "TypeError: unsupported operand type(s) for /: 'int' and 'builtin_function_or_method'") },
      ),
    runFirst: ['b'],
    policy: steps(
      () => call('get_cell_output', { cellId: 'b' }),
      () => call('get_cell_code', { cellId: 'b' }),
      (v) =>
        seen(v, 'TypeError', '/ len')
          ? call('propose_code_change', { targetCellId: 'b', action: 'update', newCode: 'mean_v = sum(values) / len(values)' })
          : say('无法定位。'),
    ),
  },
  {
    id: 'n2-rulebook',
    kind: 'N2',
    title: '首个提议违反单赋值 → 预检拒绝 → 自纠',
    prompt: 'cell b 报错，请修复。',
    cells: [
      { id: 'a', code: 'df_raw = load_survey()' },
      { id: 'b', code: 'clean = df_raw.dropna(subset=["amout"])' },
      { id: 'c', code: 'n_clean = len(clean)' },
    ],
    schemas: surveySchema,
    oracle: (cs) =>
      merge(
        nameErrors(cs, ['load_survey']),
        code(cs, 'b').includes('"amount"') ? {} : { b: tb('b', "KeyError: ['amout']") },
      ),
    runFirst: ['b'],
    policy: steps(
      () => call('get_cell_output', { cellId: 'b' }),
      () => call('get_notebook_context'),
      (v) =>
        seen(v, 'amout', '"amount"')
          ? call('propose_code_change', {
              targetCellId: 'b',
              action: 'update',
              newCode: 'df_raw = df_raw.dropna(subset=["amount"])',
            })
          : say('无法定位。'),
      (v) =>
        anyRejected(v, v.results.length - 1)
          ? call('propose_code_change', {
              targetCellId: 'b',
              action: 'update',
              newCode: 'clean = df_raw.dropna(subset=["amount"])',
              rationale: '预检拒绝重定义 df_raw，改回新名字',
            })
          : say('已提议。'),
    ),
  },
  {
    id: 'n2-import',
    kind: 'N2',
    title: 'ModuleNotFoundError 拼写',
    prompt: '第一个 cell 报错，请修复。',
    cells: [
      { id: 'a', code: 'import pandsa as pd' },
      { id: 'b', code: 'frame = pd.DataFrame({"k": [1]})' },
    ],
    oracle: (cs) =>
      code(cs, 'a').includes('import pandas as pd')
        ? nameErrors(cs, [])
        : { a: tb('a', "ModuleNotFoundError: No module named 'pandsa'"), b: tb('b', "NameError: name 'pd' is not defined") },
    runFirst: ['a'],
    policy: steps(
      () => call('list_cells'),
      () => call('get_cell_output', { cellId: 'a' }),
      (v) =>
        seen(v, "No module named 'pandsa'")
          ? call('propose_code_change', { targetCellId: 'a', action: 'update', newCode: 'import pandas as pd' })
          : say('无法定位。'),
    ),
  },
  {
    id: 'n2-badargs',
    kind: 'N2',
    title: '首个工具调用参数非法（action=replace）→ 校验错误 → 自纠',
    prompt: '修复 cell b。',
    cells: [
      { id: 'a', code: 'temps = [21.5, 22.1, 19.8]' },
      { id: 'b', code: 'avg_temp = sum(temps) / count(temps)' },
    ],
    oracle: (cs) => nameErrors(cs, []),
    runFirst: ['b'],
    policy: steps(
      () => call('get_cell_output', { cellId: 'b' }),
      (v) =>
        seen(v, "name 'count'")
          ? call('propose_code_change', { targetCellId: 'b', action: 'replace', newCode: 'avg_temp = sum(temps) / len(temps)' })
          : say('无法定位。'),
      (v) =>
        v.results[v.results.length - 1]?.isError || seen(v, 'toolError')
          ? call('propose_code_change', { targetCellId: 'b', action: 'update', newCode: 'avg_temp = sum(temps) / len(temps)' })
          : say('已提议。'),
    ),
  },
];

const THRESH_CELLS: FixtureCell[] = Array.from({ length: 9 }, (_, i) => ({
  id: `p${i + 1}`,
  code: `flag_${i + 1} = score_${i + 1} > 0.5`,
}));

export const N3_FIXTURES: Fixture[] = [
  {
    id: 'n3-extract',
    kind: 'N3',
    title: '提取重复变换为函数（单条消息 3 个提议）',
    prompt: '把 c、d 里重复的线性变换提取成函数 affine，并让两处调用它。',
    cells: [
      { id: 'a', code: 'values = [3, 1, 2]' },
      { id: 'b', code: 'values_b = [5, 7]' },
      { id: 'c', code: 'scaled_a = [v * 2 + 1 for v in values]' },
      { id: 'd', code: 'scaled_b = [v * 2 + 1 for v in values_b]' },
    ],
    oracle: (cs) => nameErrors(cs, []),
    accept: (cs) =>
      cs.some((c) => /^def affine\(/m.test(c.code)) && code(cs, 'c').includes('affine(') && code(cs, 'd').includes('affine('),
    policy: steps(
      () => call('list_cells'),
      () => calls({ name: 'get_cell_code', args: { cellId: 'c' } }, { name: 'get_cell_code', args: { cellId: 'd' } }),
      (v) =>
        seen(v, 'v * 2 + 1 for v in values', 'v * 2 + 1 for v in values_b')
          ? calls(
              {
                name: 'propose_code_change',
                args: { targetCellId: 'b', action: 'insert_below', newCode: 'def affine(xs):\n    return [v * 2 + 1 for v in xs]' },
              },
              { name: 'propose_code_change', args: { targetCellId: 'c', action: 'update', newCode: 'scaled_a = affine(values)' } },
              { name: 'propose_code_change', args: { targetCellId: 'd', action: 'update', newCode: 'scaled_b = affine(values_b)' } },
            )
          : say('无法读取源码。'),
    ),
  },
  {
    id: 'n3-rename',
    kind: 'N3',
    title: '跨 3 格改名 df→df_raw / df2→df_clean',
    prompt: '把 df 改名为 df_raw、df2 改名为 df_clean，保持下游一致。',
    cells: [
      { id: 'a', code: 'df = load_survey()' },
      { id: 'b', code: 'df2 = df.dropna()' },
      { id: 'c', code: 'summary = df2.describe()' },
    ],
    oracle: (cs) => nameErrors(cs, ['load_survey']),
    accept: (cs) => cs.every((c) => !/(?<![.\w])df2?\b/.test(c.code)),
    policy: steps(
      () => call('list_cells'),
      (v) =>
        seen(v, 'df2 = df.dropna()', 'summary = df2.describe()')
          ? calls(
              { name: 'propose_code_change', args: { targetCellId: 'a', action: 'update', newCode: 'df_raw = load_survey()' } },
              { name: 'propose_code_change', args: { targetCellId: 'b', action: 'update', newCode: 'df_clean = df_raw.dropna()' } },
              { name: 'propose_code_change', args: { targetCellId: 'c', action: 'update', newCode: 'summary = df_clean.describe()' } },
            )
          : say('无法读取。'),
    ),
  },
  {
    id: 'n3-split',
    kind: 'N3',
    title: '拆分 cell（搬移定义被预检拒绝 → 改新名字绕过）',
    prompt: '把 cell b 拆成两个 cell：均值一个、最大值一个。',
    cells: [
      { id: 'a', code: 'values = [2, 9, 4]' },
      { id: 'b', code: 'mean_v = sum(values) / len(values)\nmax_v = max(values)' },
      { id: 'c', code: 'spread = max_v - mean_v' },
    ],
    oracle: (cs) => nameErrors(cs, []),
    accept: (cs) => !/max/.test(code(cs, 'b')) && cs.length === 4,
    note: 'diff.stage 只对"当前 cells + 本条 diff"做预检，不叠加已 staged 的 diff：把 max_v 搬到新 cell 会与仍在 b 里的 max_v 冲突而被拒；策略改用新名字 max_val 并同步改 c 后通过。',
    policy: steps(
      () => call('get_cell_code', { cellId: 'b' }),
      (v) =>
        seen(v, 'max_v = max(values)')
          ? calls(
              { name: 'propose_code_change', args: { targetCellId: 'b', action: 'update', newCode: 'mean_v = sum(values) / len(values)' } },
              { name: 'propose_code_change', args: { targetCellId: 'b', action: 'insert_below', newCode: 'max_v = max(values)' } },
            )
          : say('无法读取。'),
      (v) =>
        anyRejected(v, v.results.length - 2)
          ? calls(
              { name: 'propose_code_change', args: { targetCellId: 'b', action: 'insert_below', newCode: 'max_val = max(values)' } },
              { name: 'propose_code_change', args: { targetCellId: 'c', action: 'update', newCode: 'spread = max_val - mean_v' } },
            )
          : say('已提议。'),
    ),
  },
  {
    id: 'n3-budget',
    kind: 'N3',
    title: '9 格逐个读取 → 撞 10 步上限',
    prompt: '把所有 cell 里的阈值 0.5 统一提取为常量 THRESH。',
    cells: [...Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, code: `score_${i + 1} = ${i / 10}` })), ...THRESH_CELLS],
    oracle: (cs) => nameErrors(cs, []),
    accept: (cs) => cs.some((c) => /^THRESH = 0\.5/m.test(c.code)),
    note: '预期两边都失败：逐格读取需要 11 次 LLM 调用，两套循环都在第 10 次后停止（pi 无内建步数上限，靠 finishTurn 实现）。',
    policy: steps(
      () => call('list_cells'),
      ...THRESH_CELLS.map((c) => () => call('get_cell_code', { cellId: c.id })),
      () =>
        calls(
          { name: 'propose_code_change', args: { targetCellId: 's9', action: 'insert_below', newCode: 'THRESH = 0.5' } },
          ...THRESH_CELLS.map((c, i) => ({
            name: 'propose_code_change',
            args: { targetCellId: c.id, action: 'update', newCode: `flag_${i + 1} = score_${i + 1} > THRESH` },
          })),
        ),
    ),
  },
];

export const ALL_FIXTURES: Fixture[] = [...N2_FIXTURES, ...N3_FIXTURES];
