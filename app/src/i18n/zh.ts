/**
 * 中文字典（P4.3 i18n 骨架）。键集必须与 en.ts 完全一致
 * （i18n.test.ts 键集相等单测把关）。cell 代码与文档不翻译；
 * 修复命令（uv sync / pnpm install）保持原文。
 */

import type { en } from './en';

export const zh: Record<keyof typeof en, string> = {
  /* ---- App header ---- */
  'app.workspaceTooltip': '尚无工作区（打开 notebook 后为其所在目录）',
  'app.open': '打开',
  'app.pathPlaceholder': 'path/to/notebook.py',
  'app.bridgeDown': 'bridge 未连接 —— kernel / 运行 / 文件功能不可用。请确认 bridge 进程已启动后刷新。',
  'app.toAppView': 'App View —— 只读报告视图（隐藏代码）',
  'app.toEditMode': '返回编辑视图',

  /* ---- AppView（P4.2） ---- */
  'appView.back': '← 返回编辑器',
  'appView.empty': '尚无内容 —— 打开 notebook 并运行 cell 后，散文（"# [md]" 注释块）、交互控件与输出会显示在这里。',
  'appView.untitled': '未命名 notebook',

  /* ---- KernelStatusBar ---- */
  'kernel.shared': 'Python 内核 · 与 agent 共享',
  'kernel.viewOnlyFooter': 'Python · 结束于 {time} —— 只读；该内核命名空间已不存在',
  'kernel.cells': '{count} cells',
  'kernel.cascadeTitle': '上游重跑/diff 采纳后，stale 下游的处理策略',
  'kernel.handleTitle': '拖拽展开变量 inspector · 双击折叠/展开',

  /* ---- InlineREPL ---- */
  'repl.placeholder': '在此内核中运行代码…',
  'repl.readOnlyPlaceholder': '只读 —— 该内核命名空间已不存在',

  /* ---- SessionBar ---- */
  'session.switcherTitle': '会话切换器 —— 当前与历史会话',
  'session.sessions': 'Sessions',
  'session.modalEntryTitle': 'Session notebook —— 会话浏览 · .ipynb 导出/导入',
  'session.empty': '暂无会话记录 —— 打开 notebook 后开始。',
  'session.endedPillTitle': '内核会话已结束 —— 浏览历史会话',
  'session.statePillTitle': '内核 {state} —— 会话列表',
  'session.restart': '↻ restart kernel（开启新会话）',
  'session.exportButton': 'export .ipynb',
  'session.exportPendingSuffix': '（接线 pending）',
  'session.exportWiringPending': '接线 pending —— export.ipynb 尚未接入 router（P3.1 合入后生效）',
  'session.exportTitle': 'export .ipynb —— 完整日志见 {limit}+ 导出（nbformat 4.5）',

  /* ---- SessionModal ---- */
  'sessionModal.title': 'Session notebook',
  'sessionModal.noNotebook': '未打开 notebook',
  'sessionModal.summary': '{sessions} 个会话 · {cells} 个 cell',
  'sessionModal.importPlaceholder': 'path/to/notes.ipynb',
  'sessionModal.importAria': 'import .ipynb 路径',
  'sessionModal.importButton': 'import .ipynb',
  'sessionModal.importWiringPending': '接线 pending —— import.ipynb 尚未接入 router（P3.1 合入后生效）',
  'sessionModal.importTitle': 'import .ipynb → 生成 NovaLab .py 并打开（outputs 丢弃、magic 降级注释）',
  'sessionModal.closeAria': '关闭',
  'sessionModal.empty': '暂无会话记录 —— 打开 notebook 并运行 cell 后开始。',
  'sessionModal.loadingSnapshot': '加载快照…',
  'sessionModal.noSnapshotCells': '无快照 cells（live 会话尚未落盘或快照缺失）。',
  'sessionModal.mimeNote': 'mime: {keys}（历史快照仅存键名）',
  'sessionModal.exportWiringPending': '接线 pending —— export.ipynb 尚未接入 router（P3.1 合入后生效）',
  'sessionModal.exportTitle': '导出当前/浏览中会话为 .ipynb（nbformat 4.5）',
  'sessionModal.exportPendingSuffix': '（接线 pending）',
  'sessionModal.importWarnings': 'import 降级警告（{count}）',
  'sessionModal.errorBadgeTitle': '最近一次运行失败',

  /* ---- SettingsPanel ---- */
  'settings.title': '设置 · LLM Provider',
  'settings.close': '✕ 关闭',
  'settings.storageWarning':
    '🔒 API Key 经本机 bridge（端口由 /bridge-info discovery 协商）以 AES-256-GCM 加密落盘 —— keys encrypted at rest in .novalab/providers.json (0600)，永不回传前端（列表仅暴露 hasKey 掩码）；LLM 请求统一经本机 bridge 代理，浏览器进程不持有明文 key。威胁模型：防 casual 披露（误共享/截图/备份泄露），不防同机决意攻击者（机器派生密钥可复算，见 bridge/src/secret.ts 注释）。',
  'settings.proxyNote':
    '请求统一经 bridge LLM 代理（loopback 端口由 discovery 协商，SSE 流式透传）—— 浏览器不再直连 provider 端点，原 L-1 CORS 拦截消除。',
  'settings.bridgeNotReady':
    ' 当前 bridge 未就绪：回退 P4 前直连（用户 provider 直连其 baseURL 可能被 CORS 拦截；dev 兜底走 vite 同源代理 /llm）。',
  'settings.noProvidersDev': '尚无用户 provider；当前使用 dev 兜底（.env.local VITE_NOVALAB_LLM_*）。',
  'settings.noProvidersNoDev': '尚无用户 provider，且无 dev 兜底 —— Agent 不可用。',
  'settings.keyStoredTitle': 'API Key 已加密存储于 bridge 侧（.novalab/providers.json，永不回传前端）',
  'settings.setActive': '设为当前',
  'settings.edit': '编辑',
  'settings.delete': '删除',
  'settings.devFallback': 'dev 兜底（.env.local）',
  'settings.devViaBridge': 'bridge 加密存储 dev-env · 经代理',
  'settings.devDirect': 'VITE_NOVALAB_LLM_* · anthropic-compat',
  'settings.addProvider': '+ 添加 provider',
  'settings.name': '名称',
  'settings.kind': '协议类型',
  'settings.kindAnthropic': 'anthropic-compat（Anthropic Messages 协议）',
  'settings.kindOpenai': 'openai-compat（OpenAI 协议：deepseek / ollama / vLLM）',
  'settings.baseUrl': 'baseURL',
  'settings.baseUrlPlaceholderAnthropic': 'https://…/v1',
  'settings.baseUrlPlaceholderOpenai': 'https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1',
  'settings.apiKeyLabel': 'apiKey（经 bridge AES-256-GCM 加密落盘 .novalab/providers.json）',
  'settings.apiKeyLabelHasKey': '；已存 🔑，留空 = 保留不变',
  'settings.apiKeyPlaceholderHas': '已存储（留空保留不变，填入则轮换）',
  'settings.apiKeyPlaceholderNone': 'sk-…（ollama 本地可留空）',
  'settings.model': 'model',
  'settings.modelSuggested': '（tokenplan 预设，可改）',
  'settings.save': '保存',
  'settings.test': '测试连接',
  'settings.testing': '测试中…',
  'settings.testTitle': '先保存当前草稿到加密存储，再经 bridge 代理发起一句 generateText',
  'settings.cancel': '取消',
  'settings.unnamed': '（未命名）',
  'settings.testOkPrefix': '✓ 连接成功',
  'settings.testErrPrefix': '✕ 连接失败',
  'settings.language': '语言',
  'settings.rerunOnboarding': '重跑首启检查',
  'settings.rerunOnboardingTitle': '清除 novalab.onboarded 标记并重新打开环境自检向导',

  /* ---- TabBar（title 属性） ---- */
  'tab.endedTitle': '内核已结束 —— 只读',
  'tab.stateTitle': '{state}{mem} —— {path}',
  'tab.dirtyTitle': '未保存改动',
  'tab.newTitle': '新建 tab（打开 .py）',

  /* ---- Onboarding（P4.4） ---- */
  'onboarding.title': '欢迎使用 NovaLab',
  'onboarding.intro': '首启环境自检 —— 逐项异步检查，行内显示结果。',
  'onboarding.check.bridge': 'bridge 连接（loopback discovery）',
  'onboarding.check.kernel': '内核 ping（bridge rpc）',
  'onboarding.check.deps': 'demo 依赖（pandas · matplotlib）',
  'onboarding.check.writable': '工作区可写（写探针临时文件后清理）',
  'onboarding.status.running': '检查中…',
  'onboarding.status.ok': '就绪',
  'onboarding.skipped': '已跳过 —— 前置检查未通过',
  'onboarding.fixLabel': '修复命令（复制后在仓库根目录执行）：',
  'onboarding.start': '开始使用',
  'onboarding.later': '稍后重试',
  'onboarding.copyFix': '复制修复命令',
} as const;
