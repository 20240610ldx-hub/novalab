# 科研运行包工作流洞察（结构 + 本地聚合统计，2026-10-17）

来源：Owner 下载目录里 5 个 Claude Science 运行包（`bundle-7452cde2` / `bundle-85bb5841` 及其完整执行记录版 / `bundle-f9fa236d` / `500meter_bundle-7e368ff9`）。

**数据纪律**：只读结构与代码（manifest 键形状、环境依赖名、notebook 代码的 AST、operon_tape 事件类型）。脚本在 zip 内原地读取、不解压，不读 `.pkl`、不打印任何输出值 / CSV / 图 / 异常信息文本；进入本文的只有计数与名称。脚本保存在会话 scratchpad（`insights/structure.py`、`insights/patterns.py`），不入仓。

## 1. 运行包结构（5/5 一致）

```
manifest.json      frame_id · created_at · frames[{agent_name, dir, segments[]}] · inputs[{name, version_id}] · outputs[{name, version_id}]
frames/OPERON-<id>/NN-<kind>/   每个内核会话一个段：notebook.ipynb + operon_tape.json + environment.yml
outputs/  inputs/  run.sh  README.md
```

- **段（segment）键**：`index, kernel_id, kernel_kind, language, conda_env, notebook, cell_count`（10/10）。同一会话里有 `python` / `repl` / `geo` 等多种内核段，各自声明 conda 环境。
- **输入输出带版本**：完整执行记录版 inputs 37 个、outputs 124 个，每个都有 `version_id`。
- **run.sh 复现脚本**：只由 `conda` 建环境 + `jupyter` 执行 notebook 组成（命令计数 conda 12 / jupyter 2）。
- **体量**：最大一包 186 个文件；输出以 CSV（52）、PNG（29）、docx（3）、xlsx（3）为主，另有 77 MB 的 GeoTIFF。

## 2. 执行与 Agent 行为（聚合）

| 指标 | 数值 |
|---|---|
| 代码 cell / 代码行（4 包合计，完整执行记录版另计） | 258 / 8,481；完整版 221 / 6,510 |
| 相邻 cell 相似度 > 0.8（改一点再跑） | 7 次（4 包）+ 完整版 6 次 |
| 导出 ipynb 的输出类型 | 只有 `stream`（465 条）；`error` 仅 1 条，图像 / 富 MIME 为 0 |
| `host.view_image`（Agent 看自己画的图） | 33 次 |
| tape 事件 | `query_db` 26、`artifact_path` 9、`list_artifacts` 5、`list_findings` 4、`exec_peek` 3、`list_frames` 2、`llm_batch` 1、`get_local_compute_stats` 1 |

**关键发现**：参考应用界面里能看到失败 cell（`error (line 11)`）和内联图，但导出的 `.ipynb` 只剩 stdout——失败记录和图在交付物里丢了。运行包"可复现"（run.sh），却不"可复核"（看不到中途失败了什么、怎么改的）。

## 3. 代码层面的通用模式（AST 调用计数，取与领域无关的部分）

- **打印核对**：`print` 592、`round` 547、`to_string` 125。研究者靠把中间表打印出来逐行核对。
- **防御式校验**：代码里构造 `TypeError` 165、`ValueError` 51、`RuntimeError` 27 次，`isinstance` 317 次——大量手写"输入形状 / 口径不对就抛"。
- **配平与残差**：`sum` 652、`abs` 119、`groupby` 41、`percentile` 47。对应 Owner 说的"迁移矩阵配平"（行列和对齐、看残差）与 P10/P50/P90 不确定性带。
- **口径映射**：自定义分组函数被调用 19 次，配合 `replace` / `contains` / `value_counts`。对应"年龄组口径对齐"——把不同来源的类别映射到统一口径，再核对计数守恒。
- **交付物生成**：`python-docx`（`Pt` / `Cm` / `add_runs`）、`openpyxl`、`savefig` 40、`hashlib` 4（给输出算指纹）。
- **依赖**：环境几乎固定为 numpy / pandas / scipy / matplotlib / seaborn / openpyxl / python-docx / networkx / pyarrow。

## 4. 对路线图的含义（通用化，不做领域局部优化）

| 观察 | 对应 NovaLab 能力 | 现状 |
|---|---|---|
| 导出丢失 error 与图 | **Agent 运行复盘 / 带核验附录的交付**：导出必须保留失败 cell、traceback 摘要与图；"改一点再跑"的序列要能回放 | 当前会话导出已保留 `error` 与 PNG（`bridge/src/exporter.ts`）；本批让失败运行计数并进入会话视图（PR #8）。缺口：历史会话快照只存 mime 键名，导出丢图；同一 cell 反复修改重跑只留最后一次（无追加式运行日志） |
| inputs/outputs 带 version_id、hashlib 手算指纹 | **结果溯源**：输出文件自动记 SHA-256 + 产生它的 cell + 输入指纹 | `run.notify` 已有写事件，缺指纹与输入关联 |
| 手写防御式校验、打印核对 | **通用技能包：口径对齐**——声明映射表 → 自动核对守恒（映射前后合计相等、无未映射类别）；**配平**——迭代比例拟合（IPF / raking）+ 残差报告 | 未开始；做成与领域无关的"类别映射 + 守恒检查""边际配平 + 残差"两个技能 |
| Agent 频繁看自己的图 | 图像进入 Agent 上下文需走 M5 白名单（默认不出本机） | 维持隐私默认；可选"图像描述"由用户逐次放行 |
| P10/P50/P90、情景（低/基准/高） | **情景 / 参数扫描**：同一 notebook 以参数网格批跑，结果按情景并列 | 未开始 |
| 多内核段 + conda_env 声明 | 环境 / 运行可复核：每段声明环境，导出附 `environment` 摘要 | 部分（会话快照有内核信息） |

**建议的下一步顺序**：追加式运行日志（每次运行的代码指纹 + 结果摘要，复盘与交付的共同前提）→ 结果溯源（写事件 + SHA-256）→ 两个通用技能（口径映射守恒、边际配平）→ 参数扫描。历史快照是否保存图像数据（磁盘占用 vs 交付完整）需 Owner 定。
