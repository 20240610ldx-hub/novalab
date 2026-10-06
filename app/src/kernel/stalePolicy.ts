import type { Cell } from './types';

/**
 * 上游 cell 重跑（或 diff 被采纳）后，其 stale 下游该如何处理。
 * 这是 NovaLab 的核心语义开关：反应式模型保证"状态不撒谎"，
 * 但"要不要自动把下游全部重跑"是一个产品决策，不是技术决策。
 */
export type StaleDecision = 'auto-cascade' | 'mark-only' | 'ask';

export interface StaleContext {
  /** 即将受影响的 stale 下游 cells（拓扑序）。 */
  downstream: Cell[];
  /** 触发本次重跑的 cell 上次运行耗时（ms）——级联成本的代理指标。 */
  lastRunMs: number;
  triggeredBy: 'user-run' | 'diff-accepted';
}

/**
 * NovaLab 的级联性格。Owner 裁决（2026-10-06）：一律 mark-only——
 * 科研 cell 常有昂贵副作用（调 API、写文件、跑模型），auto-cascade 误触发代价过高；
 * 重跑时机交给用户或 Agent 显式 execute_cell（spec §5）。
 * P2 设置面板将提供 auto-cascade / ask 开关，届时本函数退化为开关默认值来源。
 * 三取向的权衡档案见 docs/plan.md P2.4 与 docs/spec.md §5/§9。
 */
export function decideStalePolicy(_ctx: StaleContext): StaleDecision {
  return 'mark-only';
}
