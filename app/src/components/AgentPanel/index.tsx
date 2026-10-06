import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isToolUIPart, type UIMessage } from 'ai';
import { useAgentChat } from '../../agent/useAgentChat';
import { AGENT_SYSTEM_PROMPT } from '../../agent/systemPrompt';
import { agentTools, BRIDGE_UPGRADE_MESSAGE } from '../../agent/tools';
import { buildChatPayload } from '../../agent/payload';
import { hasDevEnvModel, resolveActiveModel } from '../../agent/providers';
import { useAgentStore, watchNotebookErrors } from '../../store/agent';
import { ContextChip } from './ContextChip';
import { FixCard } from './FixCard';

/**
 * 右侧 Agent 面板（spec §10 <AgentPanel right>）：
 * ContextChip（常驻审计）+ FixCard（One-click Fix）+ 流式对话（useAgentChat，
 * ai v7 AbstractChat + 进程内 ChatTransport 直连 provider）+ 设置入口。
 */
export function AgentPanel() {
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const setLastPayload = useAgentStore((s) => s.setLastPayload);
  const providers = useAgentStore((s) => s.providers);
  const activeProviderId = useAgentStore((s) => s.activeProviderId);

  const { messages, status, error, sendMessage, stop, regenerate, clearError } = useAgentChat({
    getModel: () =>
      resolveActiveModel(useAgentStore.getState()).model,
    instructions: AGENT_SYSTEM_PROMPT,
    tools: agentTools,
  });

  // run.error 只读订阅（notebook store 不改，转存 agent store.lastError）
  useEffect(() => watchNotebookErrors(), []);

  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const active = resolveActiveModel({ providers, activeProviderId });
  const busy = status === 'streaming' || status === 'submitted';

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setLastPayload(buildChatPayload(text)); // ContextChip 审计（4KB 闸在 buildChatPayload 内）
    void sendMessage(text);
    setInput('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const bridgeUpgrade = messages.some((m) =>
    m.parts.some(
      (p) =>
        isToolUIPart(p) &&
        p.state === 'output-available' &&
        isRecord(p.output) &&
        p.output.bridgeUpgradeNeeded === true,
    ),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header：标题 + 当前生效 provider + 设置入口 */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="text-[13px] text-[var(--text)]">Agent</span>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title={
            active.source === 'user'
              ? `当前生效：${active.label}（点击管理 provider）`
              : active.source === 'dev-env'
                ? `当前生效：${active.label}（兜底；点击配置用户 provider）`
                : '未配置 provider —— 点击打开设置'
          }
          className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] ${
            active.model
              ? 'border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent-ok)] hover:text-[var(--accent-ok)]'
              : 'border-[var(--accent-err)] text-[var(--accent-err)] animate-pulse'
          }`}
        >
          {active.model ? active.label : '⚠ 未配置 LLM'}
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title="设置（provider 管理）"
          className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:text-[var(--text)]"
        >
          ⚙
        </button>
      </div>

      {/* 元素：context chip（M5 审计，常驻） */}
      <ContextChip />

      {/* One-click Fix 卡片（最近 run.error） */}
      <FixCard
        onFix={(text) => {
          void sendMessage(text);
        }}
      />

      {bridgeUpgrade && (
        <div className="mx-2 mt-2 rounded border border-[var(--accent-run)] bg-[var(--panel)] px-2 py-1 text-[11px] text-[var(--accent-run)]">
          {BRIDGE_UPGRADE_MESSAGE}
        </div>
      )}

      {/* 对话流 */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {messages.length === 0 && (
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            反应式 notebook Agent：查依赖、读 traceback、提议代码变更（行内 Diff 审阅）。
            {hasDevEnvModel() ? '' : ' 先在 ⚙ 设置中添加 provider。'}
            <br />
            工具：get_notebook_context / get_cell_output / propose_code_change /
            execute_cell / list_cells / get_cell_code
          </p>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {status === 'submitted' && (
          <p className="text-[11px] text-[var(--muted)]">…请求中</p>
        )}
        {status === 'error' && error && (
          <div className="rounded border border-[var(--accent-err)] bg-[var(--diff-del)] p-2 text-[11px] text-[var(--accent-err)]">
            <p className="break-all">{error.message}</p>
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:text-[var(--text)]"
              >
                打开设置
              </button>
              <button
                type="button"
                onClick={() => {
                  clearError();
                  regenerate();
                }}
                className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:text-[var(--text)]"
              >
                重试
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="flex items-end gap-1 border-t border-[var(--border)] p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          placeholder="问 Agent…（Enter 发送 / Shift+Enter 换行）"
          spellCheck={false}
          className="min-w-0 flex-1 resize-none rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent-run)]"
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            className="rounded border border-[var(--accent-err)] px-2 py-1 text-[12px] text-[var(--accent-err)] hover:bg-[var(--accent-err)] hover:text-[var(--bg)]"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!input.trim()}
            className="rounded border border-[var(--accent-run)] px-2 py-1 text-[12px] text-[var(--accent-run)] hover:bg-[var(--accent-run)] hover:text-[var(--bg)] disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- 消息渲染 ---------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function MessageView({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`rounded-md border p-2 ${isUser ? 'border-[var(--border)] bg-[var(--panel)]' : 'border-[var(--border)] bg-[var(--bg)]'}`}>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        {isUser ? 'you' : 'agent'}
      </div>
      <div className="space-y-1">
        {message.parts.map((part, i) => (
          <PartView key={i} part={part} />
        ))}
      </div>
    </div>
  );
}

type MsgPart = UIMessage['parts'][number];

function PartView({ part }: { part: MsgPart }) {
  if (part.type === 'text') {
    return <p className="whitespace-pre-wrap break-words text-[12px] text-[var(--text)]">{part.text}</p>;
  }
  if (part.type === 'reasoning') {
    return (
      <details className="text-[11px] text-[var(--muted)]">
        <summary className="cursor-pointer select-none">reasoning</summary>
        <p className="mt-1 whitespace-pre-wrap break-words">{part.text}</p>
      </details>
    );
  }
  if (isToolUIPart(part)) {
    return <ToolPartView part={part} />;
  }
  return null; // data/file 部件暂不渲染
}

function ToolPartView({ part }: { part: MsgPart }) {
  const name = part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : part.type;
  const p = part as {
    state: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };

  if (p.state === 'input-streaming' || p.state === 'input-available') {
    return (
      <div className="rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] text-[var(--accent-run)]">
        ⚙ {name}
        {p.state === 'input-streaming' ? ' …' : ' 调用中…'}
      </div>
    );
  }
  if (p.state === 'output-error') {
    return (
      <div className="rounded border border-[var(--accent-err)] bg-[var(--diff-del)] px-2 py-1 text-[11px] text-[var(--accent-err)]">
        ✕ {name}: {p.errorText ?? '执行失败'}
      </div>
    );
  }
  // output-available
  const out = p.output;
  if (isRecord(out) && out.bridgeUpgradeNeeded === true) {
    return (
      <div className="rounded border border-[var(--accent-run)] px-2 py-1 text-[11px] text-[var(--accent-run)]">
        ⚠ {name}: {BRIDGE_UPGRADE_MESSAGE}
      </div>
    );
  }
  if (name === 'propose_code_change') {
    return (
      <div className="rounded border border-[var(--accent-ok)] px-2 py-1 text-[11px] text-[var(--accent-ok)]">
        ✓ 已提议代码变更 → 行内 Diff 待审阅（Tab 采纳 / Esc 拒绝）
      </div>
    );
  }
  const snippet = safeSnippet(out);
  return (
    <details className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)]">
      <summary className="cursor-pointer select-none">✓ {name}</summary>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">{snippet}</pre>
    </details>
  );
}

function safeSnippet(out: unknown): string {
  try {
    const s = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return String(out);
  }
}
