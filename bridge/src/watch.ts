/**
 * NotebookWatcher —— 外部 .py 变更热重载（spec §4, plan P1.8）。
 *
 * - notebook.open 成功后 watch 该文件；关闭/重开时 unwatch 旧路径。
 * - 事件 debounce（默认 300ms）合并连发；生产事件源为 chokidar
 *   （ignoreInitial + awaitWriteFinish.stabilityThreshold=150，防读到写一半的文件）。
 * - **自写跳过**：router 在 save_file/cell.save 写盘前后调 markSelfWrite，
 *   写后 suppressMs（默认 500ms）内的事件被忽略——否则自己的保存会触发热重载回环。
 * - 事件源抽象为 FsEventSource 接口，单测注入假事件源（不碰真 fs）。
 */

import path from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

/** 文件事件源抽象（生产 = chokidar；单测 = 假事件源）。 */
export interface FsEventSource {
  /** 开始监听一个路径。 */
  add(filePath: string): void;
  /** 停止监听一个路径。 */
  remove(filePath: string): void;
  /** 关闭事件源，释放全部句柄（进程退场用）。 */
  close(): void;
  /** 注册事件回调（event: change|add|unlink|…）。 */
  onEvent(cb: (event: string, filePath: string) => void): void;
}

/** 生产事件源：chokidar（原子保存 rename 会表现为 add，也视为外部变更）。 */
export class ChokidarEventSource implements FsEventSource {
  private readonly watcher: FSWatcher;
  private cb?: (event: string, filePath: string) => void;

  constructor() {
    this.watcher = chokidarWatch([], {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 150 },
    });
    this.watcher.on('all', (event, filePath) => this.cb?.(event, filePath));
    this.watcher.on('error', () => {
      /* 监听噪音忽略：热重载是增强路径，不能拖垮 bridge */
    });
  }

  add(filePath: string): void {
    this.watcher.add(filePath);
  }

  remove(filePath: string): void {
    this.watcher.unwatch(filePath);
  }

  close(): void {
    void this.watcher.close();
  }

  onEvent(cb: (event: string, filePath: string) => void): void {
    this.cb = cb;
  }
}

export function createChokidarEventSource(): FsEventSource {
  return new ChokidarEventSource();
}

export interface NotebookWatcherOptions {
  /** 事件源工厂（生产注入 createChokidarEventSource，单测注入假事件源）。 */
  sourceFactory: () => FsEventSource;
  /** debounce 静默期结束后的外部变更回调——router 在此 load_file + 广播 + session 留痕。 */
  onExternalChange: (filePath: string) => void | Promise<void>;
  /** 事件合并窗口，默认 300ms。 */
  debounceMs?: number;
  /** markSelfWrite 后的忽略窗口，默认 500ms。 */
  suppressMs?: number;
  now?: () => number;
}

/** 触发热重载的事件（unlink = 文件被删，load_file 必失败，忽略）。 */
const RELOAD_EVENTS = new Set(['change', 'add']);

export class NotebookWatcher {
  private readonly source: FsEventSource;
  private readonly debounceMs: number;
  private readonly suppressMs: number;
  private readonly now: () => number;
  private current?: string;
  private readonly suppressUntil = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: NotebookWatcherOptions) {
    this.source = opts.sourceFactory();
    this.debounceMs = opts.debounceMs ?? 300;
    this.suppressMs = opts.suppressMs ?? 500;
    this.now = opts.now ?? (() => Date.now());
    this.source.onEvent((event, filePath) => this.handleEvent(event, filePath));
  }

  get watchedPath(): string | undefined {
    return this.current;
  }

  /** watch 新路径；旧路径先 unwatch（notebook 关闭/重开）。同路径重复调用为 no-op。 */
  watch(filePath: string): void {
    const target = path.resolve(filePath);
    if (this.current === target) return;
    this.unwatch();
    this.current = target;
    this.source.add(target);
  }

  /** 停止监听当前路径并丢弃未决 debounce。 */
  unwatch(): void {
    this.clearTimer();
    if (this.current !== undefined) {
      this.suppressUntil.delete(this.current);
      this.source.remove(this.current);
      this.current = undefined;
    }
  }

  /** 进程退场：unwatch + 关闭事件源。 */
  close(): void {
    this.unwatch();
    this.source.close();
  }

  /**
   * 标记自写：写盘前后各调一次（后调会把窗口顺延到写完之后 suppressMs），
   * 窗口内到达的该路径事件被忽略。
   */
  markSelfWrite(filePath: string): void {
    this.suppressUntil.set(path.resolve(filePath), this.now() + this.suppressMs);
  }

  private isSuppressed(filePath: string): boolean {
    const until = this.suppressUntil.get(filePath);
    return until !== undefined && this.now() <= until;
  }

  private handleEvent(event: string, rawPath: string): void {
    const filePath = path.resolve(rawPath);
    if (!RELOAD_EVENTS.has(event)) return;
    if (filePath !== this.current) return;
    if (this.isSuppressed(filePath)) return;
    // debounce：窗口内连发合并为一次重载；到点后复查 suppress（写盘可能后到）
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (filePath !== this.current || this.isSuppressed(filePath)) return;
      void this.opts.onExternalChange(filePath);
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
