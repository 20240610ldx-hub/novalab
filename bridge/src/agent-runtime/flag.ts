/**
 * ADR-012 实验路径开关（Owner 裁决 D1，2026-10-16：pi 适配层作为 flag 后的实验路径保留，
 * Vercel 路径不动）。默认关闭；只认精确的 "1"。
 *
 * 目前没有任何生产入口读取它：接线（main.ts 起 AgentRuntime、WS agent.run 事件协议）
 * 要等 G-2（第六轮 bridge 重连合入）之后再设计。先把开关的名字和语义定下来。
 */

export const PI_RUNTIME_FLAG = 'NOVALAB_EXPERIMENTAL_PI_RUNTIME';

export function piRuntimeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PI_RUNTIME_FLAG] === '1';
}
