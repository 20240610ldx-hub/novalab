# icons/ — 已生成（P4.1）

全平台图标已由 `pnpm exec tauri icon`（源图 `source.png`）生成，
`tauri.conf.json` → `bundle.icon` 引用其中 4 项（`32x32.png`、`128x128.png`、
`128x128@2x.png`、`icon.ico`），NSIS 打包已验证消费 `icon.ico`。
`android/`、`ios/` 子目录为生成器附带产物——desktop-only（P1.7 决策）下
不消费，保留以备移动目标。

**更换流程**：准备 ≥1024×1024 clean-room 源 PNG（遵守 ADR-004 视觉 tokens）→
在 `app/` 下 `pnpm exec tauri icon <源png>` → review 本目录 diff →
确认 `bundle.icon` 路径仍有效。
