"""serialize.py — NovaLab .py 文档格式读写（spec §4，marimo 兼容子集）。

格式：
- 文件头：PEP 723 ``# /// script`` 块 + ``# [novalab] k=v | k2=v2`` 配置行
  （未知键忽略，原样保留以向前兼容）；
- cell 分隔：``# %% [cell-id: <8hex>]``；
- 无 marker 的手写 .py 宽容解析为**单 cell**（id 新生成）；若是真 marimo 文件
  （检出 ``@app.cell`` / ``app = marimo.App``）则走 convert.marimo_to_novalab
  **真转换**（P3.6：拓扑序多 cell，转换失败仍降级单 cell）；
- 首个 marker 之前的正文（若有）也宽容地成为一个新 id cell；
- read → write → read 往返无损：cell 代码文本逐字节一致；write 幂等
  （write(parse(write(x))) == write(x)）。

约定：解析时 cell 代码 = marker 之间文本 strip 首尾换行；写出时 cell 之间空一行、
文件以单个 ``\\n`` 结尾、统一 LF（读入时 universal newlines 已归一化）。
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

__all__ = [
    "Cell",
    "Notebook",
    "new_cell_id",
    "parse",
    "parse_file",
    "write",
    "write_file",
]

CELL_MARKER_RE = re.compile(r"^# %% \[cell-id: ([0-9a-fA-F]{8})\][ \t]*$")
NOVALAB_CONFIG_RE = re.compile(r"^# \[novalab\](.*)$")
# 真 marimo 文件特征（S1 侦察：@app.cell 装饰器式 + marimo.App 头）
_MARIMO_HINT_RE = re.compile(
    r"^@app\.(?:cell|function|class_definition)\b|^app\s*=\s*marimo\.App\b", re.M
)

DEFAULT_HEADER_LINES = [
    "# /// script",
    '# requires-python = ">=3.11"',
    "# dependencies = []",
    "# ///",
]


def new_cell_id() -> str:
    return uuid.uuid4().hex[:8]


@dataclass
class Cell:
    id: str
    code: str


@dataclass
class Notebook:
    header_lines: list[str] = field(default_factory=list)
    config: dict[str, str] = field(default_factory=dict)
    cells: list[Cell] = field(default_factory=list)


def _parse_config_line(rest: str) -> dict[str, str]:
    cfg: dict[str, str] = {}
    for part in rest.split("|"):
        part = part.strip()
        if not part or "=" not in part:
            continue  # 未知/畸形片段：忽略（宽容）
        k, v = part.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        cfg[k.strip()] = v
    return cfg


def parse(text: str) -> Notebook:
    lines = text.split("\n")
    n = len(lines)

    # 1) 头部：开头连续的注释/空行（PEP723 块整体都是注释行），遇 marker 或代码即止
    i = 0
    header: list[str] = []
    while i < n:
        line = lines[i]
        if CELL_MARKER_RE.match(line):
            break
        if line.strip() == "" or line.lstrip().startswith("#"):
            header.append(line)
            i += 1
        else:
            break

    config: dict[str, str] = {}
    for line in header:
        m = NOVALAB_CONFIG_RE.match(line)
        if m:
            config.update(_parse_config_line(m.group(1)))

    # 2) 正文按 marker 切分
    markers: list[tuple[int, str]] = []
    for j in range(i, n):
        m = CELL_MARKER_RE.match(lines[j])
        if m:
            markers.append((j, m.group(1).lower()))

    cells: list[Cell] = []
    if not markers:
        # 真 marimo（@app.cell 装饰器式）→ convert 真转换；失败或非 marimo → 单 cell 降级
        if _MARIMO_HINT_RE.search(text):
            try:
                from . import convert  # 延迟导入：convert 顶层 import serialize，避免循环

                return parse(convert.marimo_to_novalab(text))
            except Exception:
                pass  # 宽容：语法错误/非 marimo → 落入单 cell 降级
        body = "\n".join(lines[i:]).strip("\n")
        cells.append(Cell(new_cell_id(), body))
    else:
        preamble = "\n".join(lines[i:markers[0][0]]).strip("\n")
        if preamble:
            cells.append(Cell(new_cell_id(), preamble))
        for k, (j, cid) in enumerate(markers):
            end = markers[k + 1][0] if k + 1 < len(markers) else n
            code = "\n".join(lines[j + 1:end]).strip("\n")
            cells.append(Cell(cid, code))

    return Notebook(header_lines=header, config=config, cells=cells)


def parse_file(path: str) -> Notebook:
    with open(path, "r", encoding="utf-8") as f:  # universal newlines → \n
        return parse(f.read())


def format_config(config: dict[str, str]) -> str:
    return "# [novalab] " + " | ".join(f"{k}={v}" for k, v in config.items())


def write(
    cells: list[Cell] | list[dict],
    header_lines: list[str] | None = None,
    config: dict[str, str] | None = None,
) -> str:
    """cells 接受 Cell 或 {"id","code"} dict。header_lines=None 时生成默认 PEP723 头。"""
    norm = [(c.id if isinstance(c, Cell) else c["id"],
             (c.code if isinstance(c, Cell) else c["code"])) for c in cells]

    if header_lines is None:
        header_lines = list(DEFAULT_HEADER_LINES)
        if config:
            header_lines.append(format_config(config))
    head = "\n".join(header_lines).strip("\n")

    blocks = [f"# %% [cell-id: {cid}]\n{code.strip(chr(10))}" for cid, code in norm]
    body = "\n\n".join(blocks)
    text = (head + "\n\n" + body) if head else body
    return text.rstrip("\n") + "\n"


def write_file(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
