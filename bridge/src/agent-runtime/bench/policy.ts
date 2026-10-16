/**
 * 与 harness 无关的 stub 模型策略（ADR-012 对比）。
 *
 * 两套循环把各自的请求上下文（pi TranscriptContext / AI SDK LanguageModelV4Prompt）
 * 归一成同一个 View，交给同一个 Policy 决定下一步；所以"模型能力"完全相同，
 * 对比测到的只是 harness 机制：步数、上下文体积、隐私出口、校验与自纠路径、可中断性。
 *
 * 策略刻意"只凭看到的东西行动"：提议修复前必须在工具结果里看到对应证据
 * （traceback 关键字 / schema 列名 / 源码）；若隐私闸误删了这些证据，策略放弃 → 记失败。
 */

export interface ToolObs {
  name: string;
  text: string;
  isError: boolean;
}

export interface View {
  users: string[];
  results: ToolObs[];
  /** 本次请求之前已有的 assistant 消息数（= 已完成的 LLM 调用数）。 */
  assistantTurns: number;
}

export interface Call {
  name: string;
  args: Record<string, unknown>;
}

export type Action = { calls: Call[] } | { text: string };
export type Policy = (v: View) => Action;
export type Step = (v: View) => Action;

export const call = (name: string, args: Record<string, unknown> = {}): Action => ({ calls: [{ name, args }] });
export const calls = (...cs: Call[]): Action => ({ calls: cs });
export const say = (text: string): Action => ({ text });

export const seen = (v: View, ...needles: string[]): boolean =>
  needles.every((n) => v.results.some((r) => r.text.includes(n)));

export const last = (v: View): ToolObs | undefined => v.results[v.results.length - 1];

export const anyRejected = (v: View, sinceTurnResults: number): boolean =>
  v.results.slice(sinceTurnResults).some((r) => r.isError || r.text.includes('"rejected":true'));

/** 第 i 次 LLM 调用执行 steps[i]；用完后收尾说一句。 */
export function steps(...s: Step[]): Policy {
  return (v) => s[v.assistantTurns]?.(v) ?? say('已完成，请在 Diff 托盘中审阅。');
}

/** 包一层"用户插话"：最新 user 消息含 needle 时改为只回文本、不再调工具。 */
export function honoring(inner: Policy, needle: string, reply: string): Policy {
  return (v) => (v.users.length > 1 && v.users[v.users.length - 1]!.includes(needle) ? say(reply) : inner(v));
}
