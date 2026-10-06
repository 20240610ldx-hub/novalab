import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // L-1（CORS）：tokenplan 端点不回 Access-Control-Allow-Origin，浏览器直连被
  // preflight 拦截（画廊 11 态降级根因）。dev 走同源代理：
  //   /llm/* → VITE_NOVALAB_LLM_BASE_URL（去掉尾部 /v1），rewrite 去掉 /llm 前缀；
  // providers.ts getDevLanguageModel 在 DEV 用 baseURL '/llm/v1'。
  // 生产/Tauri：P4 bridge 侧 LLM 代理（feature-matrix L-1 遗留行）。
  // 注意：用户自配 provider（SettingsPanel）在 dev 仍是浏览器直连，端点缺 CORS
  // 头时依旧被拦——设置面板警告区有提示。
  const env = loadEnv(mode, process.cwd(), 'VITE_NOVALAB_LLM');
  const llmTarget = (env.VITE_NOVALAB_LLM_BASE_URL ?? '').replace(/\/v1\/?$/, '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5199,
      strictPort: true,
      ...(llmTarget
        ? {
            proxy: {
              '/llm': {
                target: llmTarget,
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/llm/, ''),
              },
            },
          }
        : {}),
    },
  };
});
