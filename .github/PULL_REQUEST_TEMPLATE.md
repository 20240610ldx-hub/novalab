<!-- 见 CONTRIBUTING.md：测试门、clean-room 纪律、commit 约定 -->

## 变更摘要

<!-- 一句话说明这个 PR 做了什么；关联计划项（如 P3.1）或 issue（fixes #N） -->

## 类型

- [ ] feat / fix（功能或修复）
- [ ] docs（文档；协议/语义变更须同步 docs/spec.md）
- [ ] test / chore / refactor

## 验证

- [ ] 全部测试门本地通过：tsc（bridge+app）· vitest（bridge+app）· `uv run --directory py pytest` · `node scripts/integration-smoke.mjs`
- [ ] 涉及 UI：已跑 `node scripts/demo-gallery.mjs`，受影响状态截图已更新到 `docs/demos/states/`
- [ ] 新功能带测试；bug 修复带复现用例

## Clean-room 声明（CONTRIBUTING.md 纪律）

- [ ] 未从 `refs/` 或任何参考项目复制代码/资产/测试断言
- [ ] 如读过参考实现源码后编写等价功能：已在此声明读过什么、只借鉴了什么思路 →

```
（无 / 声明内容）
```

## 其他

- [ ] 未提交 `.env.local` 或任何凭据
- [ ] commit 符合 Conventional Commits；AI 参与已加 Co-Authored-By 署名行
