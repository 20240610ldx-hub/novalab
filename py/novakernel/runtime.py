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
  displayhook 语义（L-4）：末语句为裸表达式时对其 eval，并以
  run.mime {cellId:"repl", mime:"text/plain", data:repr} 回显（repr 失败降级 str；
  结果为 None 不发）；末语句异常照常走 run.error，不回显；
- 交互控件（spec §15，P3.3）：cell 成功执行后扫描本 cell 新 defs 中的 ui.Control
  实例 → registry 注册（controlId = "<cellId>::<变量名>"，cell 重跑 = 旧 controlId
  注销 + 重建回默认值）+ 发 run.mime application/vnd.novalab.control+json
  （data = {controlId,kind,spec,value} 的 strict JSON 串，见 ui.mime_data）；
  REPL 收尾表达式是 Control 走同一发射路径（不再发 text/plain repr，不重复发）；
  control_set(controlId, value)：mutate（不重发 mime，前端已乐观更新）→ 下游传递
  闭包自动级联重跑（Owner 裁决：绕过 mark-only；发常规 run.* 通知）→ side-effect
  下游仅标 stale 并进 staleSideEffect 返回；未知 controlId → KernelError -32602；
- 通知形状（冻结）：run.started {cellId}；run.stdout/run.stderr {cellId,text}；
  run.mime {cellId,mime,data}；run.error {cellId,traceback,frames}；
  run.notify {cellId,kind,path}（kind='file-write'：exec 期间写盘的文件绝对路径，
  同路径去重、单次 exec 至多 WRITE_NOTIFY_LIMIT 条）；
  run.done {cellId,execCount,cascaded,durationMs,defs,refs}。
  触发 cell 的 run.done 在级联完成后发出（cascaded 为实际执行成功的下游 id）。
"""

from __future__ import annotations

import ast
import builtins as _builtins_mod
import contextlib
import io
import linecache
import os
import sys
import time
import traceback as tbmod
from dataclasses import dataclass, field

from . import dag, introspect as _introspect, serialize
from . import ui as _ui

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


# ---------------------------------------------------------------- write 审计
# CPython 的 sys.addaudithook 注册的钩子无法卸载，故采用「进程级单例钩子 +
# exec 窗口槽位」：钩子只在 _ACTIVE_WATCHER 槽位非空（= 某次 exec 进行中）时
# 处理 open 事件；槽位在 _run_cell 的 exec 开始时置入、结束时（含异常路径）
# 清空——语义上等价于「钩子仅在本次 exec 期间生效」。

# builtins.open / io.open 的 mode 为字符串：含 w/a/x/+ 即写意图
_WRITE_MODE_CHARS = frozenset("wax+")
# os.open 路径：mode 是 int 权限位，写意图看 flags
_WRITE_FLAG_MASK = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
# 单次 exec 的 file-write 通知上限（防循环写临时文件造成通知风暴）
WRITE_NOTIFY_LIMIT = 50

_ACTIVE_WATCHER: "_WriteWatcher | None" = None
_AUDIT_INSTALLED = False


def _audit_hook(event: str, args: tuple) -> None:
    # 钩子内异常会传播进触发事件的调用点（破坏所有 open），必须整体吞掉
    if event == "open" and _ACTIVE_WATCHER is not None:
        try:
            _ACTIVE_WATCHER.on_open(args)
        except Exception:  # noqa: BLE001 — 审计钩子绝不向宿主进程抛错
            pass


class _WriteWatcher:
    """收集一次 exec 窗口内以写方式打开的文件路径，结束后发 run.notify。

    - 审计事件 open (path, mode, flags)：mode 为 str 时看 w/a/x/+；为 int
      （os.open）时看 flags 写位——只读打开不发；
    - pandas to_csv/to_excel、matplotlib savefig 底层都走 open，自动覆盖；
    - import 触发的字节码缓存写（__pycache__/*.pyc）是解释器噪音，过滤；
    - 同路径去重（normcase+abspath 比较），发出的 path 规整为绝对路径，
      至多 WRITE_NOTIFY_LIMIT 条。
    """

    __slots__ = ("cell_id", "emit", "paths", "_seen", "_prev")

    def __init__(self, cell_id: str, emit) -> None:
        self.cell_id = cell_id
        self.emit = emit
        self.paths: list[str] = []
        self._seen: set[str] = set()
        self._prev: _WriteWatcher | None = None

    def __enter__(self) -> "_WriteWatcher":
        global _ACTIVE_WATCHER, _AUDIT_INSTALLED
        if not _AUDIT_INSTALLED:
            _AUDIT_INSTALLED = True
            sys.addaudithook(_audit_hook)
        self._prev = _ACTIVE_WATCHER
        _ACTIVE_WATCHER = self
        return self

    def __exit__(self, *exc_info) -> bool:
        global _ACTIVE_WATCHER
        _ACTIVE_WATCHER = self._prev
        self.flush()
        return False  # 不吞 exec 的异常

    def on_open(self, args: tuple) -> None:
        mode = args[1] if len(args) > 1 else None
        if isinstance(mode, str):
            if not _WRITE_MODE_CHARS.intersection(mode):
                return
        else:
            flags = args[2] if len(args) > 2 else 0
            try:
                if not int(flags) & _WRITE_FLAG_MASK:
                    return
            except (TypeError, ValueError):
                return
        p = _path_to_str(args[0] if args else None)
        if p is None or p.endswith(".pyc") or "__pycache__" in p:
            return
        key = os.path.normcase(os.path.abspath(p))
        if key in self._seen:
            return
        self._seen.add(key)
        if len(self.paths) < WRITE_NOTIFY_LIMIT:
            self.paths.append(os.path.abspath(p))

    def flush(self) -> None:
        for p in self.paths:
            self.emit("run.notify", {
                "cellId": self.cell_id, "kind": "file-write", "path": p,
            })
        self.paths = []


def _path_to_str(path) -> str | None:
    """审计事件的 path 可能是 str/bytes/PathLike/int(fd)；fd 无法恢复路径名。"""
    if isinstance(path, str):
        return path
    if isinstance(path, bytes):
        return os.fsdecode(path)
    if isinstance(path, int):
        return None
    try:
        return os.fspath(path)
    except TypeError:
        return None


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
        # 交互控件 registry（spec §15.1）：controlId → 活对象；cellId → 其 controlId 集
        self.controls: dict[str, _ui.Control] = {}
        self._controls_by_cell: dict[str, set[str]] = {}

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

        # 删除的 cell：其 defs 从 globals 移除（spec §5）；控件同步注销（§15.1）
        removed_names: set[str] = set()
        for cid in removed:
            for name, owner in list(self.defined_by.items()):
                if owner == cid:
                    del self.defined_by[name]
                    removed_names.add(name)
                    self.globals.pop(name, None)
            self.stale.discard(cid)
            self.exec_counts.pop(cid, None)
            self._unregister_cell_controls(cid)

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
        # L-4：displayhook —— 末语句裸表达式 eval 后以 run.mime text/plain 回显
        res = self._run_cell(rec, attribute=False, emit_done=True, displayhook=True)
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

    # --------------------------------------------------------------- controls
    def control_set(self, control_id: str, value=None) -> dict:
        """control.set {controlId, value}（spec §15.3，冻结契约）。

        mutate Control.value（不重发 run.mime——前端已乐观更新）→ 下游传递闭包
        自动级联重跑（复用 exec_cell 的级联 machinery，发常规 run.* 通知；
        Owner 裁决：控件级联绕过 mark-only）→ side-effect 下游不自动跑，
        标 stale 并进 staleSideEffect 返回。未知 controlId → KernelError -32602；
        值校验失败（date 非法串等）同样 -32602。REPL 控件（owner 不在 cells）
        只 mutate 不级联；存在编译错时跳过级联（与 exec_cell 拒跑语义一致）。
        """
        ctl = self.controls.get(control_id)
        if ctl is None:
            raise KernelError(f"unknown controlId: {control_id}", -32602)
        try:
            ctl.value = value  # ui.Control.validate：slider clamp / date ISO 校验等
        except (ValueError, TypeError) as e:
            raise KernelError(f"invalid value for control {control_id}: {e}", -32602) from e

        cell_id = control_id.split("::", 1)[0]
        cascaded: list[str] = []
        stale_side: list[str] = []
        if (
            self.graph is not None
            and not self.compile_error
            and cell_id in self.cells
        ):
            desc = self.graph.downstream({cell_id})
            blocked: set[str] = set()
            for cid in self.graph.topo or []:
                if cid not in desc:
                    continue
                if self.cells[cid].side_effect:
                    self.stale.add(cid)  # 仅标 stale + ⚡ 待手动确认（spec §15.3 例外）
                    stale_side.append(cid)
                    continue
                if self.graph.parents[cid] & blocked:
                    blocked.add(cid)  # 上游失败 → 本分支阻断
                    self.stale.add(cid)
                    continue
                sub = self._run_cell(self.cells[cid], attribute=True, emit_done=True)
                if sub.ok:
                    cascaded.append(cid)
                else:
                    blocked.add(cid)
        return {"ok": True, "cascaded": cascaded, "staleSideEffect": stale_side}

    def _unregister_cell_controls(self, cell_id: str) -> None:
        for cid in self._controls_by_cell.pop(cell_id, set()):
            ctl = self.controls.pop(cid, None)
            if ctl is not None:
                ctl.control_id = None

    def _register_control(self, cell_id: str, name: str, control: _ui.Control) -> None:
        cid = f"{cell_id}::{name}"
        control.control_id = cid  # controlId 由 runtime 注入（spec §15.1）
        self.controls[cid] = control
        self._controls_by_cell.setdefault(cell_id, set()).add(cid)
        self._emit_control_mime(cell_id, control)

    def _scan_controls(self, cell_id: str, committed: list[str]) -> None:
        """cell 重跑 = 旧 controlId 注销 + 重建（值回默认，spec §15.1）。

        committed 为该 cell 本次成功提交的 defs（已排序）：其中的 Control 实例
        注册并发 run.mime；收尾裸表达式在 exec 模式不求值，不存在重复发射路径。
        """
        self._unregister_cell_controls(cell_id)
        for name in committed:
            obj = self.globals.get(name)
            if isinstance(obj, _ui.Control):
                self._register_control(cell_id, name, obj)

    def _register_repl_control(self, control: _ui.Control) -> None:
        """REPL 收尾表达式是 Control：同一 mime 发射路径（不发 text/plain repr）。

        REPL 不提交 defs，controlId 的名字段尽量从 globals 反查绑定名
        （`t = slider(...)` + 收尾 `t` → "repl::t"），裸表达式退化 "repl::expr"。
        """
        self._unregister_cell_controls(REPL_ID)
        name = "expr"
        for n, v in self.globals.items():
            if v is control and n.isidentifier() and not n.startswith("__"):
                name = n
                break
        self._register_control(REPL_ID, name, control)

    def _emit_control_mime(self, cell_id: str, control: _ui.Control) -> None:
        try:
            data = control.mime_data()  # strict JSON（NaN 已在 to_jsonable 转字符串）
        except Exception:  # noqa: BLE001 — 控件序列化失败不影响执行结果
            return
        self._emit("run.mime", {"cellId": cell_id, "mime": _ui.CONTROL_MIME, "data": data})

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

    @staticmethod
    def _compile_displayhook(code: str, filename: str):
        """L-4 REPL displayhook 拆分（Jupyter/IPython 语义）。

        AST 解析后若末语句是裸表达式（ast.Expr）→ 返回 (前段 exec 码, 末表达式
        eval 码)；否则 (整体 exec 码, None)。切片保留 parse 时的原始 lineno，
        traceback 行号与源码一致。SyntaxError 由调用方统一按既有路径处理。
        """
        tree = ast.parse(code, filename, "exec")
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            head = ast.Module(body=tree.body[:-1], type_ignores=[])
            tail = ast.Expression(body=tree.body[-1].value)
            return compile(head, filename, "exec"), compile(tail, filename, "eval")
        return compile(tree, filename, "exec"), None

    def _emit_display_value(self, cell_id: str, value) -> None:
        """displayhook 回显：run.mime {cellId, mime:'text/plain', data:repr(value)}。

        repr 抛异常（劣质 __repr__）降级 str；两者都失败则静默放弃——
        回显只是展示层语义，不得把一次成功的执行变成 run.error。
        """
        try:
            text = repr(value)
        except Exception:  # noqa: BLE001
            try:
                text = str(value)
            except Exception:  # noqa: BLE001
                return
        self._emit("run.mime", {"cellId": cell_id, "mime": "text/plain", "data": text})

    def _run_cell(
        self, rec: CellRecord, *, attribute: bool, emit_done: bool, displayhook: bool = False,
    ) -> _CellRunResult:
        cell_id = rec.id
        filename = _cell_filename(cell_id)
        self.sources[filename] = rec.code.splitlines()
        self.exec_counts[cell_id] = self.exec_counts.get(cell_id, 0) + 1
        self._emit("run.started", {"cellId": cell_id})
        t0 = time.perf_counter()

        eval_compiled = None
        try:
            if displayhook:
                compiled, eval_compiled = self._compile_displayhook(rec.code, filename)
            else:
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
        # 写事件窗口：exec 期间（含异常路径）收集 file-write，退出时发 run.notify
        watcher = _WriteWatcher(cell_id, self._emit)
        value = _MISSING  # displayhook：末表达式求值结果（_MISSING = 无末表达式）
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), watcher:
                exec(compiled, self.globals)
                if eval_compiled is not None:
                    value = eval(eval_compiled, self.globals)
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
            # displayhook（L-4）：exec 与末表达式 eval 都成功才回显；None 不发。
            # 末表达式抛异常走上面的 run.error 路径，同样不回显。
            # 收尾表达式是 Control（P3.3）：走控件 mime 同一发射路径，不再发 repr 回显。
            if value is not _MISSING and value is not None:
                if isinstance(value, _ui.Control):
                    self._register_repl_control(value)
                else:
                    self._emit_display_value(cell_id, value)

        self._capture_matplotlib(cell_id)

        committed = sorted(n for n in rec.defs if n in self.globals)
        if attribute:
            old_owned = {n for n, o in self.defined_by.items() if o == cell_id}
            for n in old_owned - set(committed):
                self.defined_by.pop(n, None)
            for n in committed:
                self.defined_by[n] = cell_id
            self.stale.discard(cell_id)
            # P3.3：cell 成功执行后扫描新 defs 中的 Control → 注销旧 + 注册 + 发 mime
            self._scan_controls(cell_id, committed)

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
