/**
 * 英文字典（P4.3 i18n 骨架，默认语言）。
 * 纪律：cell 代码与文档不翻译；截图参考原文（`live`/`Ended HH:MM`/truncation
 * banner/view-only footer 等 A-2 元素）在 en 中保持原文。
 * 键集必须与 zh.ts 完全一致（i18n.test.ts 有键集相等单测）。
 */

export const en = {
  /* ---- App header ---- */
  'app.workspaceTooltip': 'No workspace yet (set to the notebook\'s directory once one is open)',
  'app.open': 'Open',
  'app.pathPlaceholder': 'path/to/notebook.py',
  'app.bridgeDown': 'bridge not connected — kernel / run / files unavailable. Make sure the bridge process is running, then refresh.',
  'app.toAppView': 'App View — read-only report (hide code)',
  'app.toEditMode': 'Back to edit view',

  /* ---- AppView（P4.2） ---- */
  'appView.back': '← Back to editor',
  'appView.empty': 'Nothing to show yet — open a notebook and run its cells; prose ("# [md]" comment blocks), interactive controls and outputs will appear here.',
  'appView.untitled': 'Untitled notebook',

  /* ---- KernelStatusBar ---- */
  'kernel.shared': 'Python kernel · shared with the agent',
  'kernel.viewOnlyFooter': "Python · ended {time} — view only; this kernel's namespace no longer exists",
  'kernel.cells': '{count} cells',
  'kernel.cascadeTitle': 'Policy for stale downstream cells after upstream re-runs / diff acceptance',
  'kernel.handleTitle': 'drag to expand variable inspector · double-click to toggle',

  /* ---- InlineREPL ---- */
  'repl.placeholder': 'run code in this kernel…',
  'repl.readOnlyPlaceholder': "view only — this kernel's namespace no longer exists",

  /* ---- SessionBar ---- */
  'session.switcherTitle': 'session switcher — current & past sessions',
  'session.sessions': 'Sessions',
  'session.modalEntryTitle': 'Session notebook — browse sessions · export/import .ipynb',
  'session.empty': 'No sessions yet — open a notebook to get started.',
  'session.endedPillTitle': 'kernel session ended — browse past sessions',
  'session.statePillTitle': 'kernel {state} — session list',
  'session.restart': '↻ restart kernel (start a new session)',
  'session.exportButton': 'export .ipynb',
  'session.exportPendingSuffix': ' (wiring pending)',
  'session.exportWiringPending': 'wiring pending — export.ipynb not routed yet (lands after P3.1 merge)',
  'session.exportTitle': 'export .ipynb — full log beyond {limit} cells (nbformat 4.5)',

  /* ---- SessionModal ---- */
  'sessionModal.title': 'Session notebook',
  'sessionModal.noNotebook': 'no notebook open',
  'sessionModal.summary': '{sessions} sessions · {cells} cells',
  'sessionModal.importPlaceholder': 'path/to/notes.ipynb',
  'sessionModal.importAria': 'import .ipynb path',
  'sessionModal.importButton': 'import .ipynb',
  'sessionModal.importWiringPending': 'wiring pending — import.ipynb not routed yet (lands after P3.1 merge)',
  'sessionModal.importTitle': 'import .ipynb → generate a NovaLab .py and open it (outputs dropped, magics demoted to comments)',
  'sessionModal.closeAria': 'close',
  'sessionModal.empty': 'No sessions yet — open a notebook and run a cell to get started.',
  'sessionModal.loadingSnapshot': 'loading snapshot…',
  'sessionModal.noSnapshotCells': 'no snapshot cells (live session not yet persisted, or snapshot missing).',
  'sessionModal.mimeNote': 'mime: {keys} (history snapshots keep key names only)',
  'sessionModal.exportWiringPending': 'wiring pending — export.ipynb not routed yet (lands after P3.1 merge)',
  'sessionModal.exportTitle': 'export the current/viewed session as .ipynb (nbformat 4.5)',
  'sessionModal.exportPendingSuffix': ' (wiring pending)',
  'sessionModal.importWarnings': 'import demotion warnings ({count})',
  'sessionModal.errorBadgeTitle': 'most recent run failed',

  /* ---- SettingsPanel ---- */
  'settings.title': 'Settings · LLM Provider',
  'settings.close': '✕ close',
  'settings.storageWarning':
    '🔒 API keys are encrypted at rest by the local bridge (loopback port discovered via /bridge-info) with AES-256-GCM — keys encrypted at rest in .novalab/providers.json (0600), never sent back to the frontend (the list only exposes a hasKey mask); all LLM requests go through the local bridge proxy, the browser process never holds plaintext keys. Threat model: defends against casual disclosure (accidental sharing/screenshots/backup leaks), not a determined attacker on the same machine (machine-derived keys can be recomputed; see bridge/src/secret.ts).',
  'settings.proxyNote':
    'All requests go through the bridge LLM proxy (loopback port negotiated via discovery, SSE streaming passthrough) — the browser no longer talks to provider endpoints directly, so the former L-1 CORS block is gone.',
  'settings.bridgeNotReady':
    ' Bridge not ready: falling back to pre-P4 direct connections (direct calls to the user provider\'s baseURL may be blocked by CORS; the dev fallback uses the vite same-origin proxy /llm).',
  'settings.noProvidersDev': 'No user providers yet; currently using the dev fallback (.env.local VITE_NOVALAB_LLM_*).',
  'settings.noProvidersNoDev': 'No user providers yet, and no dev fallback — the Agent is unavailable.',
  'settings.keyStoredTitle': 'API key encrypted at rest on the bridge side (.novalab/providers.json, never sent to the frontend)',
  'settings.setActive': 'set active',
  'settings.edit': 'edit',
  'settings.delete': 'delete',
  'settings.devFallback': 'dev fallback (.env.local)',
  'settings.devViaBridge': 'bridge-encrypted dev-env · via proxy',
  'settings.devDirect': 'VITE_NOVALAB_LLM_* · anthropic-compat',
  'settings.addProvider': '+ add provider',
  'settings.name': 'Name',
  'settings.kind': 'Protocol',
  'settings.kindAnthropic': 'anthropic-compat (Anthropic Messages protocol)',
  'settings.kindOpenai': 'openai-compat (OpenAI protocol: deepseek / ollama / vLLM)',
  'settings.baseUrl': 'baseURL',
  'settings.baseUrlPlaceholderAnthropic': 'https://…/v1',
  'settings.baseUrlPlaceholderOpenai': 'https://api.deepseek.com/v1 or http://127.0.0.1:11434/v1',
  'settings.apiKeyLabel': 'apiKey (encrypted at rest via bridge AES-256-GCM in .novalab/providers.json)',
  'settings.apiKeyLabelHasKey': '; key on file 🔑 — leave blank to keep it',
  'settings.apiKeyPlaceholderHas': 'stored (blank keeps it, typing rotates it)',
  'settings.apiKeyPlaceholderNone': 'sk-… (can be empty for local ollama)',
  'settings.model': 'model',
  'settings.modelSuggested': ' (tokenplan presets, editable)',
  'settings.save': 'save',
  'settings.test': 'Test connection',
  'settings.testing': 'Testing…',
  'settings.testTitle': 'Saves the current draft to encrypted storage first, then issues one generateText via the bridge proxy',
  'settings.cancel': 'cancel',
  'settings.unnamed': '(unnamed)',
  'settings.testOkPrefix': '✓ connection ok',
  'settings.testErrPrefix': '✕ connection failed',
  'settings.language': 'Language',
  'settings.rerunOnboarding': 'Re-run first-launch checks',
  'settings.rerunOnboardingTitle': 'Clears the novalab.onboarded flag and opens the environment self-check wizard again',

  /* ---- TabBar（title 属性） ---- */
  'tab.endedTitle': 'kernel ended — view only',
  'tab.stateTitle': '{state}{mem} — {path}',
  'tab.dirtyTitle': 'unsaved changes',
  'tab.newTitle': 'new tab (open a .py)',

  /* ---- Onboarding（P4.4） ---- */
  'onboarding.title': 'Welcome to NovaLab',
  'onboarding.intro': 'First-launch environment self-check — each item runs in order and reports inline.',
  'onboarding.check.bridge': 'bridge connection (loopback discovery)',
  'onboarding.check.kernel': 'kernel ping (bridge rpc)',
  'onboarding.check.deps': 'demo dependencies (pandas · matplotlib)',
  'onboarding.check.writable': 'workspace writable (write-probe cleanup)',
  'onboarding.status.running': 'checking…',
  'onboarding.status.ok': 'ready',
  'onboarding.skipped': 'skipped — a previous check failed',
  'onboarding.fixLabel': 'Fix command (copy and run in the repo root):',
  'onboarding.start': 'Get started',
  'onboarding.later': 'Retry later',
  'onboarding.copyFix': 'copy fix command',
} as const;
