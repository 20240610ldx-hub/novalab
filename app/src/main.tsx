import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
/* A-3 #19：JetBrains Mono 全界面（400/500/700 离线打包；styles.css --font-mono 首选） */
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
