/**
 * 技能包（ADR-016）：一段写进 system prompt 的做法 + 用来核验它的声明式契约。
 * 契约求值在影子内核里（py/novakernel/shadow.py），这里只教 Agent 什么时候用、怎么写、拿什么核验。
 * 写出来的代码只用 pandas / numpy，导出的 notebook 离开 NovaLab 也能跑。
 * 当前两个是领域中立的通用技能；领域技能包以后按同一形状加进来。
 */
export interface SkillPack {
  id: string;
  title: string;
  /** 依赖的 verify 契约 kind（skills.test.ts 校验它们都在 verify 的 schema 里）。 */
  contractKinds: readonly string[];
  prompt: string;
}

export const SKILL_PACKS: readonly SkillPack[] = [
  {
    id: 'category-mapping',
    title: '类别映射守恒',
    contractKinds: ['mapping_conserved'],
    prompt: `适用：把不同来源的类别统一到同一口径（重新分组、合并编码、对齐分类表）。
做法：映射表写成一个 dict 变量（如 group_map），用 .map(group_map) 生成新列再 groupby 汇总，不要写成一串 replace 或 if/else。映射不到的类别要显式处理（报错，或在映射表里明确归入"其他"），不要让它静默变成 NaN 后被 groupby 丢掉。
核验：shadow_run 之后 verify {kind: 'mapping_conserved', mapping: 'group_map', before: {target: 源表, column: 源类别列, value: 数值列}, after: {target: 汇总表, column: 目标类别列, value: 数值列}}。省略 value 表示按行数守恒。unmapped > 0 说明有源类别没进映射表；violations 是未映射类别数加上合计对不上的目标组数。`,
  },
  {
    id: 'margin-balancing',
    title: '边际配平（IPF）',
    contractKinds: ['margins_match', 'sum_conserved'],
    prompt: `适用：已知行合计和列合计，要把一个种子矩阵（迁移矩阵、交叉表、构成表）调到同时满足两组边际。
做法：迭代比例拟合（IPF / raking）——交替按"行目标 / 当前行和""列目标 / 当前列和"缩放，直到最大残差小于容差或达到迭代上限。开始前先比较两组边际的总和：不一致时说明差多少，请用户决定以哪组为准，不要悄悄缩放。种子里的 0 会一直是 0；某行（列）全为 0 而目标不为 0 时无解，要报出来而不是除以 0。把迭代次数和最终最大残差存成结果变量，便于复核。
核验：verify {kind: 'margins_match', target: 配平后的矩阵, rows: 行目标变量, cols: 列目标变量}（带索引的 Series 会按标签对齐），再用 sum_conserved 核对总量。`,
  },
];

export function skillsPromptSection(packs: readonly SkillPack[] = SKILL_PACKS): string {
  const body = packs.map((p) => `### ${p.title}（${p.id}）\n${p.prompt}`).join('\n\n');
  return `## 通用技能（与领域无关，遇到对应任务时照做）\n${body}`;
}
