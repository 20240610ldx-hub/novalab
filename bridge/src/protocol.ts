/** 前端 ↔ Bridge WS 协议消息类型（spec §6.1 的子集骨架）。 */

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type KernelState = 'idle' | 'busy' | 'restarting' | 'dead';

export interface RunErrorParams {
  cellId: string;
  traceback: string;
  frames: { file: string; line: number; fn: string; srcLine: string }[];
}

export interface RunDoneParams {
  cellId: string;
  execCount: number;
  cascaded: string[];
  durationMs: number;
}
