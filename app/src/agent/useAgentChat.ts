import {
  AbstractChat,
  convertToModelMessages,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type ChatInit,
  type ChatState,
  type ChatStatus,
  type ChatTransport,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { useRef, useSyncExternalStore } from 'react';

/**
 * ai v7 的 useChat 形态（以 node_modules/ai@7.0.128 的 d.ts 为准核实）：
 *  - `useChat` 本体在 @ai-sdk/react —— 本项目未安装（P2.1 禁改 package.json）。
 *  - ai 包导出的是无框架内核：`AbstractChat`（状态机）+ `ChatTransport` 接口。
 *    本文件 = 两者的最小 React 绑定：
 *      AgentChatTransport —— 浏览器进程内直连 provider：streamText（工具循环 execute
 *                            全部 client-side，走 bridge rpc）→ toUIMessageStream。
 *      AgentChat          —— AbstractChat 子类，补一个可订阅的 ChatState（v7 的
 *                            ChatState 是纯接口，官方带订阅的 Chat 类在 @ai-sdk/react）。
 *      useAgentChat       —— useSyncExternalStore 绑定，API 面对齐 useChat
 *                            （messages/status/error/sendMessage/stop/regenerate）。
 */

/* ---------------- transport ---------------- */

export interface AgentChatTransportOptions {
  /** 每次请求时解析当前生效模型（provider 可随时在设置面板切换）。 */
  getModel: () => LanguageModel | null;
  /** Reactive Rulebook system prompt。 */
  instructions: string;
  tools: ToolSet;
  /** 工具循环步数上限（默认 10）。 */
  maxSteps?: number;
}

export const NO_PROVIDER_ERROR =
  '未配置 LLM provider —— 请打开设置面板添加 provider，或在 app/.env.local 填写 VITE_NOVALAB_LLM_*';

export class AgentChatTransport implements ChatTransport<UIMessage> {
  constructor(private readonly getOptions: () => AgentChatTransportOptions) {}

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const opts = this.getOptions();
    const model = opts.getModel();
    if (!model) throw new Error(NO_PROVIDER_ERROR);
    const result = streamText({
      model,
      instructions: opts.instructions,
      tools: opts.tools,
      stopWhen: stepCountIs(opts.maxSteps ?? 10),
      messages: await convertToModelMessages(messages),
      abortSignal,
    });
    return toUIMessageStream({
      stream: result.fullStream,
      tools: opts.tools,
      onError: (err) => (err instanceof Error ? err.message : String(err)),
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null; // 进程内直连，无服务端流可重连
  }
}

/* ---------------- observable chat state ---------------- */

class ObservableChatState implements ChatState<UIMessage> {
  status: ChatStatus = 'ready';
  error: Error | undefined = undefined;
  messages: UIMessage[] = [];
  onMutate: () => void = () => {};

  pushMessage(message: UIMessage): void {
    this.messages = [...this.messages, message];
    this.onMutate();
  }

  popMessage(): void {
    this.messages = this.messages.slice(0, -1);
    this.onMutate();
  }

  replaceMessage(index: number, message: UIMessage): void {
    const copy = [...this.messages];
    copy[index] = message;
    this.messages = copy;
    this.onMutate();
  }

  snapshot = <T,>(thing: T): T => thing; // 无 immutable 库，identity 即可
}

export interface AgentChatSnapshot {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
}

export type AgentChatInit = Omit<ChatInit<UIMessage>, 'messages'>;

export class AgentChat extends AbstractChat<UIMessage> {
  private readonly listeners = new Set<() => void>();
  private cached: AgentChatSnapshot | null = null;

  constructor(init: AgentChatInit) {
    const state = new ObservableChatState();
    super({ ...init, state });
    state.onMutate = () => this.notify();
  }

  private notify(): void {
    this.cached = null;
    for (const l of this.listeners) l();
  }

  protected override setStatus(args: { status: ChatStatus; error?: Error }): void {
    super.setStatus(args);
    this.notify();
  }

  override get messages(): UIMessage[] {
    return super.messages;
  }

  override set messages(value: UIMessage[]) {
    super.messages = value;
    this.notify();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): AgentChatSnapshot => {
    const prev = this.cached;
    if (
      prev &&
      prev.messages === this.messages &&
      prev.status === this.status &&
      prev.error === this.error
    ) {
      return prev;
    }
    this.cached = { messages: this.messages, status: this.status, error: this.error };
    return this.cached;
  };
}

/* ---------------- React hook ---------------- */

export interface UseAgentChatResult extends AgentChatSnapshot {
  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  regenerate: () => void;
  clearError: () => void;
  chat: AgentChat;
}

/** useChat 的本地对等物；options 每次渲染可传新对象（内部经 ref 取最新值）。 */
export function useAgentChat(options: AgentChatTransportOptions): UseAgentChatResult {
  const optsRef = useRef(options);
  optsRef.current = options;
  const chatRef = useRef<AgentChat | null>(null);
  if (chatRef.current == null) {
    chatRef.current = new AgentChat({
      transport: new AgentChatTransport(() => optsRef.current),
      onError: (err) => console.error('agent chat error:', err),
    });
  }
  const chat = chatRef.current;
  const snap = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  return {
    ...snap,
    sendMessage: (text: string) => chat.sendMessage({ text }),
    stop: () => {
      void chat.stop();
    },
    regenerate: () => {
      void chat.regenerate();
    },
    clearError: () => chat.clearError(),
    chat,
  };
}
