import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // L-1（CORS）历史注：tokenplan 端点不回 Access-Control-Allow-Origin，浏览器直连被
  // preflight 拦截（画廊 11 态降级根因），dev 曾以本同源代理为主路径。
  // **P4 起降级定位：仅作「无 bridge 兜底」** —— 主路径已迁移 bridge 侧 LLM 代理
  // http://127.0.0.1:7789/llm/<providerId>/*（bridge/src/llm-proxy.ts）：用户 provider
  // 与 dev-env 兜底统一经代理注入真 key（SSE 透传），浏览器不再直连端点。
  // bridge 未连接时 providers.ts getDevLanguageModel 在 DEV 回退同源代理：
  //   /llm/* → VITE_NOVALAB_LLM_BASE_URL（去掉尾部 /v1），rewrite 去掉 /llm 前缀。
  // 生产/Tauri：无 bridge 即无兜底（直连 envBaseURL 会被 CORS 拦）——bridge 代理为正路径。
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
