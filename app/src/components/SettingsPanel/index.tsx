import { useState } from 'react';
import { generateText } from 'ai';
import { useAgentStore } from '../../store/agent';
import {
  createLanguageModel,
  hasDevEnvModel,
  modelSuggestionsFor,
  STORAGE_WARNING,
  type ProviderConfig,
  type ProviderId,
} from '../../agent/providers';

/**
 * 设置面板（P2.1 / M6 模型解耦）：provider 增删改 + 当前生效指示 + 测试连接。
 * 存储：localStorage 键 `novalab.providers`，明文 —— 顶部常驻显著警告（P4 迁移 keychain）。
 */

type Draft = ProviderConfig;

function newDraft(): Draft {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, kind: 'anthropic-compat', name: '', baseURL: '', apiKey: '', model: '' };
}

interface TestState {
  state: 'idle' | 'testing' | 'ok' | 'err';
  msg: string;
}

export function SettingsPanel() {
  const open = useAgentStore((s) => s.settingsOpen);
  const setOpen = useAgentStore((s) => s.setSettingsOpen);
  const providers = useAgentStore((s) => s.providers);
  const activeProviderId = useAgentStore((s) => s.activeProviderId);
  const upsertProvider = useAgentStore((s) => s.upsertProvider);
  const removeProvider = useAgentStore((s) => s.removeProvider);
  const setActiveProvider = useAgentStore((s) => s.setActiveProvider);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [test, setTest] = useState<TestState>({ state: 'idle', msg: '' });

  if (!open) return null;

  const suggestions = draft ? modelSuggestionsFor(draft) : [];

  const startEdit = (config: ProviderConfig | null) => {
    setDraft(config ? { ...config } : newDraft());
    setTest({ state: 'idle', msg: '' });
  };

  const save = () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.baseURL.trim() || !draft.model.trim()) return;
    upsertProvider({ ...draft, name: draft.name.trim(), baseURL: draft.baseURL.trim(), model: draft.model.trim() });
    // 首个 provider 自动设为当前生效；dev 兜底让位
    if (activeProviderId == null) setActiveProvider(draft.id);
    setDraft(null);
  };

  const testConnection = async () => {
    if (!draft || !draft.baseURL.trim() || !draft.model.trim()) return;
    setTest({ state: 'testing', msg: '' });
    try {
      const model = createLanguageModel({ ...draft, baseURL: draft.baseURL.trim(), model: draft.model.trim() });
      const res = await generateText({ model, prompt: 'ping' });
      const text = (res.text ?? '').trim();
      setTest({ state: 'ok', msg: `连接成功 · 回复 ${text.length} 字符${text ? `："${text.slice(0, 40)}"` : ''}` });
    } catch (err) {
      setTest({ state: 'err', msg: err instanceof Error ? err.message : String(err) });
    }
  };

  const inputCls =
    'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent-run)]';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setOpen(false)}>
      <div
        className="max-h-[85vh] w-[560px] max-w-[92vw] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center">
          <h2 className="text-[14px] text-[var(--text)]">设置 · LLM Provider</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto rounded border border-[var(--border)] px-2 py-0.5 text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            ✕ 关闭
          </button>
        </div>

        {/* 明文存储警告（常驻显著） */}
        <div className="mb-3 rounded border border-[var(--accent-err)] bg-[var(--diff-del)] p-2 text-[11px] leading-relaxed text-[var(--accent-err)]">
          {STORAGE_WARNING}
          <p className="mt-1">
            另注（L-1）：浏览器 dev 下用户自配 provider 仍直连其 baseURL——端点若不回
            CORS 头（Access-Control-Allow-Origin），请求会被浏览器拦截；可暂用 dev
            兜底（.env.local，经 vite 同源代理 /llm），P4 迁移 bridge 侧代理后消除。
          </p>
        </div>

        {/* provider 列表 */}
        <div className="mb-3 space-y-1">
          {providers.length === 0 && !draft && (
            <p className="text-[11px] text-[var(--muted)]">
              尚无用户 provider{hasDevEnvModel() ? '；当前使用 dev 兜底（.env.local VITE_NOVALAB_LLM_*）。' : '，且无 dev 兜底 —— Agent 不可用。'}
            </p>
          )}
          {providers.map((p) => {
            const isActive = p.id === activeProviderId;
            return (
              <div
                key={p.id}
                className={`flex items-center gap-2 rounded border px-2 py-1 text-[11px] ${
                  isActive ? 'border-[var(--accent-ok)]' : 'border-[var(--border)]'
                }`}
              >
                <span className={isActive ? 'text-[var(--accent-ok)]' : 'text-[var(--muted)]'}>
                  {isActive ? '●' : '○'}
                </span>
                <span className="text-[var(--text)]">{p.name}</span>
                <span className="rounded bg-[var(--bg)] px-1 text-[10px] text-[var(--muted)]">{p.kind}</span>
                <span className="truncate text-[var(--muted)]" title={p.baseURL}>
                  {p.baseURL}
                </span>
                <span className="ml-auto shrink-0 text-[var(--muted)]">{p.model}</span>
                <span className="flex shrink-0 gap-1">
                  {!isActive && (
                    <button type="button" onClick={() => setActiveProvider(p.id)} className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:border-[var(--accent-ok)] hover:text-[var(--accent-ok)]">
                      设为当前
                    </button>
                  )}
                  <button type="button" onClick={() => startEdit(p)} className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:text-[var(--text)]">
                    编辑
                  </button>
                  <button type="button" onClick={() => removeProvider(p.id)} className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:border-[var(--accent-err)] hover:text-[var(--accent-err)]">
                    删除
                  </button>
                </span>
              </div>
            );
          })}

          {/* dev 兜底行 */}
          {hasDevEnvModel() && (
            <div className={`flex items-center gap-2 rounded border px-2 py-1 text-[11px] ${activeProviderId == null ? 'border-[var(--accent-ok)]' : 'border-[var(--border)]'}`}>
              <span className={activeProviderId == null ? 'text-[var(--accent-ok)]' : 'text-[var(--muted)]'}>
                {activeProviderId == null ? '●' : '○'}
              </span>
              <span className="text-[var(--text)]">dev 兜底（.env.local）</span>
              <span className="text-[var(--muted)]">VITE_NOVALAB_LLM_* · anthropic-compat</span>
              {activeProviderId != null && (
                <button type="button" onClick={() => setActiveProvider(null)} className="ml-auto rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:border-[var(--accent-ok)] hover:text-[var(--accent-ok)]">
                  设为当前
                </button>
              )}
            </div>
          )}
        </div>

        {!draft ? (
          <button
            type="button"
            onClick={() => startEdit(null)}
            className="rounded border border-[var(--accent-run)] px-2 py-1 text-[12px] text-[var(--accent-run)] hover:bg-[var(--accent-run)] hover:text-[var(--bg)]"
          >
            + 添加 provider
          </button>
        ) : (
          <div className="space-y-2 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[11px] text-[var(--muted)]">
                名称
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="tokenplan / deepseek / ollama-local"
                  className={`mt-0.5 ${inputCls}`}
                />
              </label>
              <label className="block text-[11px] text-[var(--muted)]">
                协议类型
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as ProviderId })}
                  className={`mt-0.5 ${inputCls}`}
                >
                  <option value="anthropic-compat">anthropic-compat（Anthropic Messages 协议）</option>
                  <option value="openai-compat">openai-compat（OpenAI 协议：deepseek / ollama / vLLM）</option>
                </select>
              </label>
            </div>
            <label className="block text-[11px] text-[var(--muted)]">
              baseURL
              <input
                value={draft.baseURL}
                onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
                placeholder={draft.kind === 'anthropic-compat' ? 'https://…/v1' : 'https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1'}
                spellCheck={false}
                className={`mt-0.5 ${inputCls}`}
              />
            </label>
            <label className="block text-[11px] text-[var(--muted)]">
              apiKey（明文存本机 localStorage，见上方警告）
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="sk-…（ollama 本地可留空）"
                spellCheck={false}
                className={`mt-0.5 ${inputCls}`}
              />
            </label>
            <label className="block text-[11px] text-[var(--muted)]">
              model{suggestions.length > 0 && '（tokenplan 预设，可改）'}
              <input
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                list="novalab-model-suggestions"
                placeholder={suggestions[0] ?? 'model id'}
                spellCheck={false}
                className={`mt-0.5 ${inputCls}`}
              />
              <datalist id="novalab-model-suggestions">
                {suggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={save}
                disabled={!draft.name.trim() || !draft.baseURL.trim() || !draft.model.trim()}
                className="rounded border border-[var(--accent-ok)] px-2 py-1 text-[12px] text-[var(--accent-ok)] hover:bg-[var(--accent-ok)] hover:text-[var(--bg)] disabled:opacity-40"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => void testConnection()}
                disabled={test.state === 'testing' || !draft.baseURL.trim() || !draft.model.trim()}
                className="rounded border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--accent-run)] hover:text-[var(--accent-run)] disabled:opacity-40"
              >
                {test.state === 'testing' ? '测试中…' : '测试连接'}
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="ml-auto rounded border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
              >
                取消
              </button>
            </div>

            {test.state === 'ok' && (
              <p className="text-[11px] text-[var(--accent-ok)]">✓ {test.msg}（generateText "ping" 一句）</p>
            )}
            {test.state === 'err' && (
              <p className="break-all text-[11px] text-[var(--accent-err)]">✕ {test.msg}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
