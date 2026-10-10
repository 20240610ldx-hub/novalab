import { useState } from 'react';
import { generateText } from 'ai';
import { useAgentStore } from '../../store/agent';
import {
  createLanguageModel,
  hasDevEnvModel,
  isProviderStorageRemote,
  modelSuggestionsFor,
  type ProviderConfig,
  type ProviderId,
} from '../../agent/providers';
import { useI18n } from '../../i18n';

/**
 * 设置面板（P2.1 / M6 模型解耦；P4 加密存储 + LLM 代理）：provider 增删改 +
 * 当前生效指示 + 测试连接。
 * 存储（P4/ADR-008）：rpc providers.* → bridge AES-256-GCM 加密落盘
 * .novalab/providers.json（0600）—— apiKey 永不出桥（列表仅 hasKey 掩码，
 * 编辑时 key 留空 = 保留既有）；顶部常驻存储说明（settings.storageWarning，
 * 原文 = providers.STORAGE_WARNING，P4.3 迁入字典）。
 * 测试连接走 bridge LLM 代理（端口由 discovery 协商）：先把草稿落库，再以 'proxy'
 * 占位 key 发起 generateText，真 key 由代理注入上游。
 * P4.3：标签/警告全部经 t()；语言切换（novalab.lang）。
 * P4.4：「重跑首启检查」入口（onRerunOnboarding → App → Onboarding rerun）。
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

export interface SettingsPanelProps {
  /** P4.4：重跑首启检查（App 层翻 Onboarding rerun）。 */
  onRerunOnboarding?: () => void;
}

export function SettingsPanel({ onRerunOnboarding }: SettingsPanelProps) {
  const open = useAgentStore((s) => s.settingsOpen);
  const setOpen = useAgentStore((s) => s.setSettingsOpen);
  const providers = useAgentStore((s) => s.providers);
  const activeProviderId = useAgentStore((s) => s.activeProviderId);
  const upsertProvider = useAgentStore((s) => s.upsertProvider);
  const removeProvider = useAgentStore((s) => s.removeProvider);
  const setActiveProvider = useAgentStore((s) => s.setActiveProvider);
  const { t, lang, setLang } = useI18n();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [test, setTest] = useState<TestState>({ state: 'idle', msg: '' });

  if (!open) return null;

  const suggestions = draft ? modelSuggestionsFor(draft) : [];
  const remote = isProviderStorageRemote();

  const startEdit = (config: ProviderConfig | null) => {
    // bridge 掩码纪律：已存 key 的 provider 编辑时 key 置空（留空 = 保留既有密文）
    setDraft(config ? { ...config, apiKey: config.hasKey ? '' : config.apiKey } : newDraft());
    setTest({ state: 'idle', msg: '' });
  };

  const save = () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.baseURL.trim() || !draft.model.trim()) return;
    void (async () => {
      // 顺序 await：两次 persist 都是全量同步，串行避免 setActive 竞态
      await upsertProvider({ ...draft, name: draft.name.trim(), baseURL: draft.baseURL.trim(), model: draft.model.trim() });
      // 首个 provider 自动设为当前生效；dev 兜底让位
      if (activeProviderId == null) await setActiveProvider(draft.id);
      setDraft(null);
    })();
  };

  const testConnection = async () => {
    if (!draft || !draft.baseURL.trim() || !draft.model.trim()) return;
    setTest({ state: 'testing', msg: '' });
    try {
      const cleaned: ProviderConfig = {
        ...draft,
        name: draft.name.trim() || t('settings.unnamed'),
        baseURL: draft.baseURL.trim(),
        model: draft.model.trim(),
      };
      // 测试走 bridge 代理：先把草稿落入加密存储（代理按 id 注入真 key）。
      // bridge 不可达时 persist 静默降级，createLanguageModel 自动回退直连草稿凭据。
      await upsertProvider(cleaned);
      const model = createLanguageModel(cleaned);
      const res = await generateText({ model, prompt: 'ping' });
      const text = (res.text ?? '').trim();
      const via = remote ? 'bridge proxy (discovered loopback)' : 'direct (bridge not ready)';
      setTest({ state: 'ok', msg: `${via} · ${text.length} chars${text ? `: "${text.slice(0, 40)}"` : ''}` });
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
          <h2 className="text-[14px] text-[var(--text)]">{t('settings.title')}</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto rounded border border-[var(--border)] px-2 py-0.5 text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            {t('settings.close')}
          </button>
        </div>

        {/* P4 存储说明（常驻）：加密落盘 + 代理路径；bridge 未就绪时附加降级提示 */}
        <div className="mb-3 rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px] leading-relaxed text-[var(--muted)]">
          {t('settings.storageWarning')}
          <p className="mt-1">
            {t('settings.proxyNote')}
            {!remote && (
              <span className="text-[var(--accent-run)]">{t('settings.bridgeNotReady')}</span>
            )}
          </p>
        </div>

        {/* provider 列表 */}
        <div className="mb-3 space-y-1">
          {providers.length === 0 && !draft && (
            <p className="text-[11px] text-[var(--muted)]">
              {hasDevEnvModel() ? t('settings.noProvidersDev') : t('settings.noProvidersNoDev')}
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
                {p.hasKey && <span title={t('settings.keyStoredTitle')}>🔑</span>}
                <span className="truncate text-[var(--muted)]" title={p.baseURL}>
                  {p.baseURL}
                </span>
                <span className="ml-auto shrink-0 text-[var(--muted)]">{p.model}</span>
                <span className="flex shrink-0 gap-1">
                  {!isActive && (
                    <button type="button" onClick={() => void setActiveProvider(p.id)} className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:border-[var(--accent-ok)] hover:text-[var(--accent-ok)]">
                      {t('settings.setActive')}
                    </button>
                  )}
                  <button type="button" onClick={() => startEdit(p)} className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:text-[var(--text)]">
                    {t('settings.edit')}
                  </button>
                  <button type="button" onClick={() => void removeProvider(p.id)} className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:border-[var(--accent-err)] hover:text-[var(--accent-err)]">
                    {t('settings.delete')}
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
              <span className="text-[var(--text)]">{t('settings.devFallback')}</span>
              <span className="text-[var(--muted)]">
                {remote ? t('settings.devViaBridge') : t('settings.devDirect')}
              </span>
              {activeProviderId != null && (
                <button type="button" onClick={() => void setActiveProvider(null)} className="ml-auto rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:border-[var(--accent-ok)] hover:text-[var(--accent-ok)]">
                  {t('settings.setActive')}
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
            {t('settings.addProvider')}
          </button>
        ) : (
          <div className="space-y-2 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[11px] text-[var(--muted)]">
                {t('settings.name')}
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="tokenplan / deepseek / ollama-local"
                  className={`mt-0.5 ${inputCls}`}
                />
              </label>
              <label className="block text-[11px] text-[var(--muted)]">
                {t('settings.kind')}
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as ProviderId })}
                  className={`mt-0.5 ${inputCls}`}
                >
                  <option value="anthropic-compat">{t('settings.kindAnthropic')}</option>
                  <option value="openai-compat">{t('settings.kindOpenai')}</option>
                </select>
              </label>
            </div>
            <label className="block text-[11px] text-[var(--muted)]">
              {t('settings.baseUrl')}
              <input
                value={draft.baseURL}
                onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
                placeholder={draft.kind === 'anthropic-compat' ? t('settings.baseUrlPlaceholderAnthropic') : t('settings.baseUrlPlaceholderOpenai')}
                spellCheck={false}
                className={`mt-0.5 ${inputCls}`}
              />
            </label>
            <label className="block text-[11px] text-[var(--muted)]">
              {t('settings.apiKeyLabel')}
              {draft.hasKey ? t('settings.apiKeyLabelHasKey') : ''}
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder={draft.hasKey ? t('settings.apiKeyPlaceholderHas') : t('settings.apiKeyPlaceholderNone')}
                spellCheck={false}
                className={`mt-0.5 ${inputCls}`}
              />
            </label>
            <label className="block text-[11px] text-[var(--muted)]">
              {t('settings.model')}
              {suggestions.length > 0 && t('settings.modelSuggested')}
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
                {t('settings.save')}
              </button>
              <button
                type="button"
                onClick={() => void testConnection()}
                disabled={test.state === 'testing' || !draft.baseURL.trim() || !draft.model.trim()}
                title={t('settings.testTitle')}
                className="rounded border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--accent-run)] hover:text-[var(--accent-run)] disabled:opacity-40"
              >
                {test.state === 'testing' ? t('settings.testing') : t('settings.test')}
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="ml-auto rounded border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
              >
                {t('settings.cancel')}
              </button>
            </div>

            {test.state === 'ok' && (
              <p className="text-[11px] text-[var(--accent-ok)]">{t('settings.testOkPrefix')} {test.msg}（generateText "ping"）</p>
            )}
            {test.state === 'err' && (
              <p className="break-all text-[11px] text-[var(--accent-err)]">{t('settings.testErrPrefix')} {test.msg}</p>
            )}
          </div>
        )}

        {/* P4.3/P4.4 底部行：语言切换 + 重跑首启检查 */}
        <div className="mt-4 flex items-center gap-2 border-t border-[var(--border)] pt-3">
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
            {t('settings.language')}
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value === 'zh' ? 'zh' : 'en')}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent-run)]"
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </label>
          {onRerunOnboarding && (
            <button
              type="button"
              onClick={() => {
                onRerunOnboarding();
                setOpen(false);
              }}
              title={t('settings.rerunOnboardingTitle')}
              className="ml-auto rounded border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--accent-run)] hover:text-[var(--text)]"
            >
              {t('settings.rerunOnboarding')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
