"""runtime.py — 单一共享 globals 的反应式执行核心（spec §5 + 2026-10-06 契约增补）。

职责：
- set_cells：重建 DAG；对变更 cell 及其下游传递闭包标 stale（不自动运行）；
  被删除 cell 的 defs 从 globals 移除；结果回传重算后的 cells（含 defs/refs/sideEffect）；
- load_file：返回完整 NotebookState {cells, dagEdges, schemas, staleSet, execCounts}；
- exec_cell / exec_repl：返回 RunReport {cellId, ok, cascaded, durationMs, traceback?}；
- exec_cell：幽灵变量清除（旧 defs 中不再被新代码定义的名字）→ exec →
  成功提交 defs / 失败回滚该 cell 的 defs（其余 globals 就地变更不回滚，spec §12）→
  cascade 时按拓扑序重跑下游（副作用 cell 跳过；失败分支阻断）；
- exec_repl：直接操作同一 globals，通知 cellId 恒为 "repl"，不参与 DAG 归属；
- 通知形状（冻结）：run.started {cellId}；run.stdout/run.stderr {cellId,text}；
  run.mime {cellId,mime,data}；run.error {cellId,traceback,frames}；
  run.done {cellId,execCount,cascaded,durationMs,defs,refs}。
  触发 cell 的 run.done 在级联完成后发出（cascaded 为实际执行成功的下游 id）。
"""

from __future__ import annotations

import builtins as _builtins_mod
import contextlib
import io
import linecache
import sys
import time
import traceback as tbmod
from dataclasses import dataclass, field

from . import dag, introspect as _introspect, serialize

__all__ = [
    "CellNotFoundError",
    "KernelError",
    "NoNotebookError",
    "Runtime",
]

_MISSING = object()
REPL_ID = "repl"
_FLUSH_INTERVAL_S = 0.016  # 16ms（spec §13 stdout 流合并）
_FLUSH_CHUNK = 4096


class KernelError(Exception):
    """协议级错误；code 映射到 JSON-RPC error.code（-32000 内核内部错）。"""

    code = -32000

    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code


class NoNotebookError(KernelError):
    """-32001：尚未 load_file / set_cells（契约增补 #6）。"""

    code = -32001

    def __init__(self, message: str = "no notebook loaded") -> None:
        super().__init__(message)


class CellNotFoundError(KernelError):
    code = -32602


@dataclass
class CellRecord:
    id: str
    code: str
    side_effect: bool = False
    defs: set[str] = field(default_factory=set)
    refs: set[str] = field(default_factory=set)


class _NotifyStream(io.TextIOBase):
    """把写入内容按 16ms / 4KB 粒度合并为 run.stdout|stderr 通知。"""

    encoding = "utf-8"
    errors = "replace"

    def __init__(self, emit, method: str, cell_id: str) -> None:
        self._emit = emit
        self._method = method
        self._cell_id = cell_id
        self._buf: list[str] = []
        self._size = 0
        self._last = time.perf_counter()

    def writable(self) -> bool:
        return True

    def write(self, s) -> int:  # type: ignore[override]
        if not isinstance(s, str):
            raise TypeError(f"expected str, got {type(s).__name__}")
        if s:
            self._buf.append(s)
            self._size += len(s)
            now = time.perf_counter()
            if self._size >= _FLUSH_CHUNK or now - self._last >= _FLUSH_INTERVAL_S:
                self.flush()
        return len(s)

    def flush(self) -> None:  # type: ignore[override]
        if self._buf:
            text = "".join(self._buf)
            self._buf.clear()
            self._size = 0
            self._last = time.perf_counter()
            self._emit(self._method, {"cellId": self._cell_id, "text": text})


def _cell_filename(cell_id: str) -> str:
    return f"<cell {cell_id}>"


class _CellRunResult:
    __slots__ = ("ok", "traceback", "done")

    def __init__(self, ok: bool, traceback: str | None, done: dict | None) -> None:
        self.ok = ok
        self.traceback = traceback
        self.done = done  # run.done payload（emit_done=False 时由调用方补 cascaded 后发出）


class Runtime:
    def __init__(self, notify=None) -> None:
        # notify(method: str, params: dict) — 由 server 注入，写 stdout JSON-lines
        self._notify_raw = notify or (lambda method, params: None)
        self.header_lines: list[str] | None = None
        self.config: dict[str, str] = {}
        self.sources: dict[str, list[str]] = {}
        self._reset_state()

    # ------------------------------------------------------------------ infra
    def _reset_state(self) -> None:
        self.globals: dict = {"__name__": "__novakernel__", "__builtins__": _builtins_mod}
        self.cells: dict[str, CellRecord] = {}
        self.graph: dag.Graph | None = None
        self.stale: set[str] = set()
        self.defined_by: dict[str, str] = {}  # name → 提交该名字的 cell
        self.exec_counts: dict[str, int] = {}
        self.compile_error: str | None = None

    def _emit(self, method: str, params: dict) -> None:
        self._notify_raw(method, params)

    def _stale_ordered(self) -> list[str]:
        if self.graph is None:
            return sorted(self.stale)
        return [cid for cid in self.graph.order_ids if cid in self.stale]

    @staticmethod
    def _edges_payload(graph: dag.Graph | None) -> list[dict]:
        if graph is None:
            return []
        return [{"from": a, "to": b} for a, b in graph.edges]

    def _cells_payload(self) -> list[dict]:
        return [
            {
                "id": r.id,
                "code": r.code,
                "defs": sorted(r.defs),
                "refs": sorted(r.refs),
                "sideEffect": r.side_effect,
            }
            for r in self.cells.values()
        ]

    # ------------------------------------------------------------- set_cells
    def set_cells(self, cells: list[dict], *, initial: bool = False) -> dict:
        incoming: list[tuple[str, str]] = []
        for c in cells:
            if not isinstance(c, dict) or "id" not in c or "code" not in c:
                raise KernelError("set_cells: each cell needs {id, code}", -32602)
            incoming.append((str(c["id"]), str(c["code"])))
        new_ids = [cid for cid, _ in incoming]
        if len(set(new_ids)) != len(new_ids):
            raise KernelError("set_cells: duplicate cell ids", -32602)

        old = self.cells
        changed = {cid for cid, code in incoming if cid not in old or old[cid].code != code}
        removed = [cid for cid in old if cid not in set(new_ids)]

        # 删除的 cell：其 defs 从 globals 移除（spec §5）
        removed_names: set[str] = set()
        for cid in removed:
            for name, owner in list(self.defined_by.items()):
                if owner == cid:
                    del self.defined_by[name]
                    removed_names.add(name)
                    self.globals.pop(name, None)
            self.stale.discard(cid)
            self.exec_counts.pop(cid, None)

        # 重建记录与 DAG
        analyses: dict[str, dag.CellAnalysis] = {}
        recs: dict[str, CellRecord] = {}
        for cid, code in incoming:
            an = dag.analyze_cell(cid, code)
            analyses[cid] = an
            recs[cid] = CellRecord(
                id=cid, code=code,
                side_effect=dag.detect_side_effect(code),
                defs=an.defs, refs=an.refs,
            )
        self.cells = recs
        self.graph = dag.build_graph(new_ids, analyses)
        self.compile_error = self.graph.compile_error

        if initial:
            self.stale = set()
        else:
            consumers = {cid for cid in new_ids if analyses[cid].refs & removed_names}
            affected = set(changed) | consumers
            affected |= self.graph.downstream(affected)
            self.stale = (self.stale | affected) & set(new_ids)

        out: dict = {
            "cells": self._cells_payload(),
            "edges": self._edges_payload(self.graph),
            "staleSet": self._stale_ordered(),
        }
        if self.compile_error:
            out["compileError"] = self.compile_error
        return out

    # -------------------------------------------------------------- load/save
    def load_file(self, path: str) -> dict:
        nb = serialize.parse_file(path)
        self.header_lines = nb.header_lines
        self.config = nb.config
        self._reset_state()
        self.set_cells([{"id": c.id, "code": c.code} for c in nb.cells], initial=True)
        # 契约增补 #2：完整 NotebookState
        out: dict = {
            "cells": self._cells_payload(),
            "dagEdges": self._edges_payload(self.graph),
            "schemas": _introspect.snapshot(self.globals),
            "staleSet": self._stale_ordered(),
            "execCounts": {cid: 0 for cid in self.cells},
        }
        if self.compile_error:
            out["compileError"] = self.compile_error
        return out

    def save_file(self, path: str, cells: list[dict]) -> dict:
        self.set_cells(cells)
        text = serialize.write(cells, header_lines=self.header_lines, config=self.config)
        serialize.write_file(path, text)
        return {"ok": True}

    # -------------------------------------------------------------- execution
    def exec_cell(self, cell_id: str, cascade: bool = False) -> dict:
        if self.graph is None:
            raise NoNotebookError()
        if cell_id not in self.cells:
            raise CellNotFoundError(f"unknown cell: {cell_id}")
        if self.compile_error:
            raise KernelError(f"compile error, refusing to run: {self.compile_error}")

        t0 = time.perf_counter()
        self._ghost_cleanup(cell_id)
        # cascade 时触发 cell 的 run.done 延迟到级联结束（补上实际 cascaded 列表）
        res = self._run_cell(self.cells[cell_id], attribute=True, emit_done=not cascade)

        cascaded: list[str] = []
        if res.ok and cascade and self.graph is not None:
            desc = self.graph.downstream({cell_id})
            blocked: set[str] = set()
            for cid in self.graph.topo or []:
                if cid not in desc:
                    continue
                if self.cells[cid].side_effect:
                    continue  # 副作用 cell 不进 auto-cascade（spec §5），保持 stale 待手动确认
                if self.graph.parents[cid] & blocked:
                    blocked.add(cid)  # 上游失败 → 本分支阻断
                    self.stale.add(cid)  # 保持/进入 stale 待修复后重跑
                    continue
                sub = self._run_cell(self.cells[cid], attribute=True, emit_done=True)
                if sub.ok:
                    cascaded.append(cid)
                else:
                    blocked.add(cid)

        if res.done is not None:
            res.done["cascaded"] = cascaded
            self._emit("run.done", res.done)

        report: dict = {
            "cellId": cell_id,
            "ok": res.ok,
            "cascaded": cascaded,
            "durationMs": int((time.perf_counter() - t0) * 1000),
        }
        if res.traceback is not None:
            report["traceback"] = res.traceback
        return report

    def exec_repl(self, code: str) -> dict:
        an = dag.analyze_cell(REPL_ID, code)
        rec = CellRecord(id=REPL_ID, code=code, defs=an.defs, refs=an.refs)
        t0 = time.perf_counter()
        res = self._run_cell(rec, attribute=False, emit_done=True)
        report: dict = {
            "cellId": REPL_ID,
            "ok": res.ok,
            "cascaded": [],
            "durationMs": int((time.perf_counter() - t0) * 1000),
        }
        if res.traceback is not None:
            report["traceback"] = res.traceback
        return report

    def introspect(self) -> dict:
        return {"schemas": _introspect.snapshot(self.globals)}

    # ---------------------------------------------------------------- internal
    def _ghost_cleanup(self, cell_id: str) -> None:
        """exec 前删除该 cell 旧 defs 中不再被新代码定义的名字（防幽灵变量）。"""
        rec = self.cells[cell_id]
        owned = {n for n, o in self.defined_by.items() if o == cell_id}
        ghosts = owned - rec.defs
        if not ghosts or self.graph is None:
            return
        for n in ghosts:
            self.globals.pop(n, None)
            self.defined_by.pop(n, None)
        consumers = {cid for cid, r in self.cells.items() if r.refs & ghosts}
        self.stale |= consumers | self.graph.downstream(consumers)

    def _frames(self, exc: BaseException, filename: str) -> list[dict]:
        frames: list[dict] = []
        for frame, lineno in tbmod.walk_tb(exc.__traceback__):
            fn = frame.f_code.co_filename
            src = None
            if fn == filename:
                lines = self.sources.get(fn, [])
                if 1 <= lineno <= len(lines):
                    src = lines[lineno - 1].strip()
            if src is None:
                got = linecache.getline(fn, lineno).strip()
                src = got or None
            frames.append({
                "file": fn,
                "line": lineno,
                "fn": frame.f_code.co_name,
                "srcLine": src,
            })
        return frames

    def _run_cell(self, rec: CellRecord, *, attribute: bool, emit_done: bool) -> _CellRunResult:
        cell_id = rec.id
        filename = _cell_filename(cell_id)
        self.sources[filename] = rec.code.splitlines()
        self.exec_counts[cell_id] = self.exec_counts.get(cell_id, 0) + 1
        self._emit("run.started", {"cellId": cell_id})
        t0 = time.perf_counter()

        try:
            compiled = compile(rec.code, filename, "exec")
        except SyntaxError as e:
            tb_text = "".join(tbmod.format_exception(e)).rstrip()
            frames = [{
                "file": e.filename or filename,
                "line": e.lineno or 0,
                "fn": "<module>",
                "srcLine": (e.text or "").strip() or None,
            }]
            self._emit("run.error", {
                "cellId": cell_id, "traceback": tb_text, "frames": frames,
            })
            if attribute:
                self.stale.add(cell_id)
            return _CellRunResult(False, tb_text, None)

        # 失败回滚快照：只针对该 cell 的 AST defs（spec §12：globals 不整体回滚，
        # 但失败 cell 的 defs 不写入/被还原）
        saved = {n: self.globals.get(n, _MISSING) for n in rec.defs}

        out = _NotifyStream(self._emit, "run.stdout", cell_id)
        err = _NotifyStream(self._emit, "run.stderr", cell_id)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                exec(compiled, self.globals)
        except BaseException as e:  # noqa: BLE001 — 内核进程必须存活（spec §12）
            out.flush()
            err.flush()
            for n, v in saved.items():
                if v is _MISSING:
                    self.globals.pop(n, None)
                else:
                    self.globals[n] = v
            tb_text = "".join(tbmod.format_exception(e)).rstrip()
            self._emit("run.error", {
                "cellId": cell_id,
                "traceback": tb_text,
                "frames": self._frames(e, filename),
            })
            if attribute:
                self.stale.add(cell_id)
            return _CellRunResult(False, tb_text, None)
        else:
            out.flush()
            err.flush()

        self._capture_matplotlib(cell_id)

        committed = sorted(n for n in rec.defs if n in self.globals)
        if attribute:
            old_owned = {n for n, o in self.defined_by.items() if o == cell_id}
            for n in old_owned - set(committed):
                self.defined_by.pop(n, None)
            for n in committed:
                self.defined_by[n] = cell_id
            self.stale.discard(cell_id)

        done = {
            "cellId": cell_id,
            "execCount": self.exec_counts.get(cell_id, 0),
            "cascaded": [],
            "durationMs": int((time.perf_counter() - t0) * 1000),
            "defs": committed,
            "refs": sorted(rec.refs),
        }
        if emit_done:
            self._emit("run.done", done)
            done = None
        return _CellRunResult(True, None, done)

    def _capture_matplotlib(self, cell_id: str) -> None:
        """轻量 matplotlib inline：cell 成功后把打开的 figure 发 run.mime 并关闭。

        契约增补 #4：run.mime {cellId, mime, data}，data 为 base64 字符串。
        """
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is None:
            return
        try:
            import base64

            for num in list(plt.get_fignums()):
                fig = plt.figure(num)
                buf = io.BytesIO()
                fig.savefig(buf, format="png", bbox_inches="tight")
                self._emit("run.mime", {
                    "cellId": cell_id,
                    "mime": "image/png",
                    "data": base64.b64encode(buf.getvalue()).decode("ascii"),
                })
                plt.close(fig)
        except Exception:  # noqa: BLE001 — mime 捕获失败不影响执行结果
            pass
