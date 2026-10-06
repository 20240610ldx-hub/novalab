# icons/ — 占位

P1.7 暂不打包（`tauri.conf.json` 中 `bundle.active = false`、`bundle.icon = []`），
本目录为空占位，构建不需要任何图标文件。

**P4 待办**：
1. 准备一张 ≥1024×1024 的 NovaLab 源 PNG（clean-room 自绘，遵守 ADR-004 视觉 tokens）。
2. 在 `app/` 下运行 `pnpm exec tauri icon <源png路径>` 生成全平台图标到本目录。
3. 将生成物填入 `tauri.conf.json` → `bundle.icon`（如 `icons/icon.ico`、`icons/icon.icns`、`icons/128x128.png` 等），并把 `bundle.active` 置 `true`。
