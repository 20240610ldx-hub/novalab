/**
 * controls/logic.ts — P3.3 交互控件纯函数逻辑（无 DOM/网络依赖，logic.test.ts 覆盖）。
 *
 * 载荷契约（冻结，spec §15.2）：run.mime `application/vnd.novalab.control+json`，
 * data = {controlId, kind, spec, value}。内核以 strict JSON **字符串**承载该对象
 * （前端 store 的 mime data 通道经 asText 归一为文本，对象会被打成
 * "[object Object]"；见 py/novakernel/ui.py mime_data docstring）。parseControlPayload
 * 对字符串/已解析对象/数组三种形态都兼容——store 未来若原样透传对象无需改动。
 */

/** run.mime 的控件 mime key（与 py/novakernel/ui.py CONTROL_MIME 一致）。 */
export const CONTROL_MIME = 'application/vnd.novalab.control+json';

export interface ControlPayload {
  controlId: string;
  kind: string;
  spec: Record<string, unknown>;
  value: unknown;
}

function isPayload(o: unknown): o is ControlPayload {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  return typeof r['controlId'] === 'string' && typeof r['kind'] === 'string';
}

function coerceOne(raw: unknown): ControlPayload[] {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      return coerceOne(JSON.parse(s) as unknown);
    } catch {
      return []; // 坏 JSON：静默丢弃（渲染层降级，不崩）
    }
  }
  if (Array.isArray(raw)) return raw.flatMap(coerceOne);
  if (!isPayload(raw)) return [];
  const spec =
    raw.spec && typeof raw.spec === 'object' && !Array.isArray(raw.spec)
      ? (raw.spec as Record<string, unknown>)
      : {};
  return [{ controlId: raw.controlId, kind: raw.kind, spec, value: raw.value }];
}

/**
 * mime data → 控件载荷列表。兼容：JSON 串（当前内核发射）、对象（store 若透传）、
 * 数组（未来一 cell 多控件累积）。同 controlId 去重取最后一个（cell 重跑重建后
 * 的新载荷覆盖旧值）。
 */
export function parseControlPayload(raw: unknown): ControlPayload[] {
  const byId = new Map<string, ControlPayload>();
  for (const p of coerceOne(raw)) byId.set(p.controlId, p);
  return [...byId.values()];
}

/** slider 值域 clamp（与内核 Slider.validate 同语义；start>stop 自动交换，±Inf 钳到边界，NaN 回下界）。 */
export function clampSlider(v: number, start: number, stop: number): number {
  const lo = Math.min(start, stop);
  const hi = Math.max(start, stop);
  if (Number.isNaN(v)) return Number.isFinite(lo) ? lo : 0;
  return Math.min(hi, Math.max(lo, v));
}

// ------------------------------------------------------------------ 节流

export interface Throttler<T> {
  /** 排队发送（intervalMs 窗口内 coalesce，只保留最新值，trailing edge 发）。 */
  schedule(value: T): void;
  /** 立即发送挂起值（slider 松手/失焦时调用），无挂起则无操作。 */
  flush(): void;
  /** 丢弃挂起值（组件卸载）。 */
  cancel(): void;
}

/**
 * trailing-edge 节流器：slider 拖动按 80ms coalesce 发 control.set（spec §15.3）。
 * setTimeout/Date 由宿主注入以便 node 单测（vitest fake timers 直接接管全局亦可）。
 */
export function createThrottler<T>(intervalMs: number, send: (value: T) => void): Throttler<T> {
  let latest: T | undefined;
  let hasPending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = (): void => {
    timer = null;
    if (!hasPending) return;
    hasPending = false;
    const v = latest as T;
    latest = undefined;
    send(v);
  };

  return {
    schedule(value: T): void {
      latest = value;
      hasPending = true;
      if (timer === null) timer = setTimeout(fire, intervalMs);
    },
    flush(): void {
      if (timer !== null) clearTimeout(timer);
      fire();
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      hasPending = false;
      latest = undefined;
    },
  };
}

// ------------------------------------------------------- 乐观更新 reducer

/**
 * 控件乐观更新状态机（useControlCommit 用）：
 * local = 用户交互立即上屏；ack = rpc 成功，乐观值转正（lastGood）；
 * error = rpc 失败（bridge 未接线 -32601 / 内核 -32000 / 传输层）→ 回滚 lastGood；
 * reset = 内核载荷变化（cell 重跑重建，值回默认）→ 双值同步。
 */
export interface ControlState<T> {
  value: T;
  lastGood: T;
  pending: boolean;
}

export type ControlAction<T> =
  | { type: 'local'; value: T }
  | { type: 'ack' }
  | { type: 'error' }
  | { type: 'reset'; value: T };

export function controlReduce<T>(s: ControlState<T>, a: ControlAction<T>): ControlState<T> {
  switch (a.type) {
    case 'local':
      return { value: a.value, lastGood: s.lastGood, pending: true };
    case 'ack':
      return { value: s.value, lastGood: s.value, pending: false };
    case 'error':
      return { value: s.lastGood, lastGood: s.lastGood, pending: false };
    case 'reset':
      return { value: a.value, lastGood: a.value, pending: false };
  }
}

// ------------------------------------------------------------ table 选择

export type SelectionMode = 'single' | 'multi' | null;

/**
 * 选择值归一（与内核 Table.validate 同语义）：行索引列表；越界过滤、去重保序；
 * single 只留最后一个；mode=null（不可选）恒 null。
 */
export function normalizeSelection(v: unknown, rowCount: number, mode: SelectionMode): number[] | null {
  if (mode === null) return null;
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: number[] = [];
  for (const x of arr) {
    const n = typeof x === 'number' ? Math.trunc(x) : Number.parseInt(String(x), 10);
    if (Number.isFinite(n) && n >= 0 && n < rowCount && !out.includes(n)) out.push(n);
  }
  return mode === 'single' ? out.slice(-1) : out;
}

// ------------------------------------------------------------ spec 读取

export function specNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function specStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** controlId `<cellId>::<name>` → 变量名（label 缺省时展示用）。 */
export function controlVarName(controlId: string): string {
  const i = controlId.indexOf('::');
  return i >= 0 ? controlId.slice(i + 2) : controlId;
}
