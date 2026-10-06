"""test_runtime.py — 反应式执行语义黄金集（spec §5 + 契约增补形状）。"""

import json

import pytest

from novakernel.runtime import (
    REPL_ID,
    CellNotFoundError,
    KernelError,
    NoNotebookError,
    Runtime,
)


class Collector:
    def __init__(self) -> None:
        self.msgs: list[tuple[str, dict]] = []

    def __call__(self, method: str, params: dict) -> None:
        self.msgs.append((method, params))

    def of(self, method: str, cell_id: str | None = None) -> list[dict]:
        return [
            p
            for m, p in self.msgs
            if m == method and (cell_id is None or p.get("cellId") == cell_id)
        ]

    def methods(self) -> list[str]:
        return [m for m, _ in self.msgs]

    def json_ok(self) -> bool:
        try:
            for _, p in self.msgs:
                json.dumps(p)
        except (TypeError, ValueError):
            return False
        return True


def make(cells: list[tuple[str, str]] | None = None) -> tuple[Runtime, Collector]:
    col = Collector()
    rt = Runtime(notify=col)
    if cells is not None:
        rt.set_cells([{"id": i, "code": c} for i, c in cells])
        rt.stale.clear()  # 测试装置：模拟"已全部执行过"的中性起点
    return rt, col


def test_first_set_cells_marks_everything_stale():
    # 语义记录：首次 set_cells（无先前状态）→ 全部 cell 视为未运行 = stale
    rt, _ = make(None)
    out = rt.set_cells([{"id": "a", "code": "x=1"}, {"id": "b", "code": "y=x+1"}])
    assert out["staleSet"] == ["a", "b"]


# ---------------------------------------------------------------- 基本执行

def test_exec_cell_commits_defs_and_run_done():
    rt, col = make([("a1", "x = 40 + 2")])
    rep = rt.exec_cell("a1")
    assert rep == {"cellId": "a1", "ok": True, "cascaded": [], "durationMs": rep["durationMs"]}
    assert rt.globals["x"] == 42
    done = col.of("run.done", "a1")
    assert len(done) == 1
    assert done[0]["defs"] == ["x"]
    assert done[0]["execCount"] == 1
    assert done[0]["cascaded"] == []
    assert col.of("run.started", "a1")


def test_cascade_runs_downstream_in_topological_order():
    rt, col = make([("a", "x = 1"), ("b", "y = x + 1"), ("c", "z = y * 2")])
    rep = rt.exec_cell("a", cascade=True)
    assert rep["ok"] and rep["cascaded"] == ["b", "c"]
    assert rt.globals["z"] == 4
    dones = [p["cellId"] for p in col.of("run.done")]
    assert dones == ["b", "c", "a"]  # 触发 cell 的 run.done 在级联后、带 cascaded
    assert col.of("run.done", "a")[0]["cascaded"] == ["b", "c"]
    assert col.of("run.started", "b") and col.of("run.started", "c")
    assert rt.stale == set()


def test_cascade_false_does_not_rerun_downstream_but_marks_stale():
    rt, col = make([("a", "x = 1"), ("b", "y = x + 1")])
    rt.exec_cell("a")
    rt.exec_cell("b")
    assert rt.globals["y"] == 2
    rt.set_cells([{"id": "a", "code": "x = 10"}, {"id": "b", "code": "y = x + 1"}])
    assert rt.stale == {"a", "b"}
    rep = rt.exec_cell("a", cascade=False)
    assert rep["cascaded"] == []
    assert rt.globals["y"] == 2  # 未重跑
    assert rt.stale == {"b"}  # a 已清 stale，b 仍 stale
    assert not col.of("run.started", "b")[1:]  # b 只有第一次执行的 started


def test_stale_transitive_closure_on_edit():
    rt, _ = make([("a", "x=1"), ("b", "y=x+1"), ("c", "z=y+1"), ("d", "w=2")])
    out = rt.set_cells([
        {"id": "a", "code": "x=100"},
        {"id": "b", "code": "y=x+1"},
        {"id": "c", "code": "z=y+1"},
        {"id": "d", "code": "w=2"},
    ])
    assert set(out["staleSet"]) == {"a", "b", "c"}  # d 不受影响
    assert out["staleSet"] == ["a", "b", "c"]  # 文档序


def test_set_cells_result_carries_cells_defs_refs_side_effect():
    rt, _ = make()
    out = rt.set_cells([{"id": "a1", "code": "x = 1"}, {"id": "b2", "code": "df.to_csv('f.csv')\ny = x"}])
    cells = {c["id"]: c for c in out["cells"]}
    assert cells["a1"]["defs"] == ["x"] and cells["a1"]["refs"] == []
    assert not cells["a1"]["sideEffect"]
    assert cells["b2"]["sideEffect"] is True
    assert cells["b2"]["refs"] == ["df", "x"]
    assert out["edges"] == [{"from": "a1", "to": "b2"}]


# ---------------------------------------------------------------- 幽灵变量

def test_ghost_variable_removed_before_exec():
    rt, _ = make([("a", "alpha = 1\nbeta = 2"), ("b", "s = alpha + beta")])
    rt.exec_cell("a")
    rt.exec_cell("b")
    assert rt.globals["s"] == 3
    rt.set_cells([{"id": "a", "code": "alpha = 5"}, {"id": "b", "code": "s = alpha + beta"}])
    rt.exec_cell("a")  # 新代码不再定义 beta
    assert "beta" not in rt.globals  # 幽灵变量已清除
    assert "alpha" in rt.globals
    assert "b" in rt.stale


def test_removed_cell_defs_purged_and_consumers_stale():
    rt, _ = make([("a", "x = 1"), ("b", "y = x + 1")])
    rt.exec_cell("a")
    rt.exec_cell("b")
    out = rt.set_cells([{"id": "b", "code": "y = x + 1"}])
    assert "x" not in rt.globals
    assert out["staleSet"] == ["b"]


# ---------------------------------------------------------------- 失败语义

def test_failed_cell_defs_not_committed():
    rt, col = make([("a", "x = 1\nraise ValueError('boom')")])
    rep = rt.exec_cell("a")
    assert rep["ok"] is False
    assert "ValueError" in rep["traceback"]
    assert "x" not in rt.globals
    errs = col.of("run.error", "a")
    assert len(errs) == 1
    frame = errs[0]["frames"][-1]
    assert frame["file"] == "<cell a>"
    assert frame["srcLine"] == "raise ValueError('boom')"
    assert frame["line"] == 2 and frame["fn"] == "<module>"
    assert not col.of("run.done", "a")
    assert rt.stale == {"a"}


def test_failed_rerun_restores_previous_value():
    rt, _ = make([("a", "x = 1")])
    rt.exec_cell("a")
    rt.set_cells([{"id": "a", "code": "x = 2\n1 / 0"}])
    rep = rt.exec_cell("a")
    assert rep["ok"] is False
    assert rt.globals["x"] == 1  # 旧值还原


def test_inplace_mutation_persists_on_failure():
    # spec §12：globals 不整体回滚——既有对象的就地变更保留；失败 cell 自身 defs 不提交
    rt, _ = make([("a", "lst = []"), ("b", "lst.append(1)\nraise RuntimeError('x')")])
    rt.exec_cell("a")
    rep = rt.exec_cell("b")
    assert rep["ok"] is False
    assert rt.globals["lst"] == [1]  # 就地变更存活
    assert rt.defined_by["lst"] == "a"


def test_cascade_blocks_branch_after_failure():
    rt, col = make([
        ("a", "x = 1"),
        ("b", "y = x + missing_name"),
        ("c", "z = y + 1"),
    ])
    rep = rt.exec_cell("a", cascade=True)
    assert rep["ok"] is True
    assert rep["cascaded"] == []  # b 失败 → 不进 cascaded
    assert col.of("run.error", "b")
    assert "z" not in rt.globals
    assert not col.of("run.started", "c")  # c 被阻断，未执行
    assert rt.stale == {"b", "c"}


def test_side_effect_cell_skipped_in_cascade(tmp_path):
    out_file = tmp_path / "out.txt"
    rt, col = make([
        ("a", "x = 1"),
        ("b", f"open(r'{out_file}', 'w').write(str(x))"),  # 副作用 cell
        ("c", "y = x + 1"),
    ])
    rt.exec_cell("a")
    rt.set_cells([
        {"id": "a", "code": "x = 2"},
        {"id": "b", "code": f"open(r'{out_file}', 'w').write(str(x))"},
        {"id": "c", "code": "y = x + 1"},
    ])
    assert rt.stale == {"a", "b", "c"}
    rep = rt.exec_cell("a", cascade=True)
    assert rep["cascaded"] == ["c"]  # b 被跳过
    assert not col.of("run.started", "b")
    assert not out_file.exists()  # 副作用确实没发生
    assert rt.globals["y"] == 3
    assert rt.stale == {"b"}  # 保持 stale 待手动确认


def test_syntax_error_cell_reports_run_error():
    rt, col = make([("a", "x = 1")])
    rt.set_cells([{"id": "a", "code": "def f(:"}])
    assert rt.compile_error is not None
    with pytest.raises(KernelError):  # 编译错 → 拒绝运行
        rt.exec_cell("a")
    rt.set_cells([{"id": "a", "code": "x = 1"}])  # 修复
    assert rt.exec_cell("a")["ok"] is True


def test_compile_error_blocks_all_exec():
    rt, _ = make([("a", "df = 1"), ("b", "df = 2")])
    assert rt.compile_error is not None and "df" in rt.compile_error
    with pytest.raises(KernelError) as ei:
        rt.exec_cell("a")
    assert "multiple definitions" in str(ei.value.message)


# ---------------------------------------------------------------- repl

def test_repl_shares_globals_with_cells():
    rt, col = make([("a", "x = 40")])
    rt.exec_cell("a")
    rep = rt.exec_repl("print(x + 2)\nq = x * 2")
    assert rep == {"cellId": REPL_ID, "ok": rep["ok"], "cascaded": [], "durationMs": rep["durationMs"]}
    assert rep["ok"] is True
    assert rt.globals["q"] == 80  # 同一 globals
    outs = col.of("run.stdout", REPL_ID)
    assert "".join(o["text"] for o in outs) == "42\n"
    done = col.of("run.done", REPL_ID)
    assert done and done[0]["defs"] == ["q"]


def test_repl_failure_isolated():
    rt, col = make([("a", "x = 1")])
    rt.exec_cell("a")
    rep = rt.exec_repl("1 / 0")
    assert rep["ok"] is False and "ZeroDivisionError" in rep["traceback"]
    assert col.of("run.error", REPL_ID)
    assert rt.globals["x"] == 1
    assert REPL_ID not in rt.stale  # repl 不进 stale 语义


def test_repl_does_not_steal_cell_attribution():
    rt, _ = make([("a", "x = 1")])
    rt.exec_cell("a")
    rt.exec_repl("x = 999")
    assert rt.defined_by["x"] == "a"


# ---------------------------------------------------------------- 通知流

def test_stdout_stderr_capture_notifications():
    rt, col = make([("a", "import sys\nfor i in range(3):\n    print('line', i)\nsys.stderr.write('warn!\\n')")])
    assert rt.exec_cell("a")["ok"] is True
    stdout = "".join(p["text"] for p in col.of("run.stdout", "a"))
    stderr = "".join(p["text"] for p in col.of("run.stderr", "a"))
    assert stdout == "line 0\nline 1\nline 2\n"
    assert stderr == "warn!\n"
    assert col.json_ok()


def test_exec_counts_increment():
    rt, _ = make([("a", "x = 1")])
    rt.exec_cell("a")
    rt.exec_cell("a")
    assert rt.exec_counts["a"] == 2


# ---------------------------------------------------------------- 协议错误

def test_exec_without_notebook_raises_no_notebook():
    rt, _ = make(None)
    with pytest.raises(NoNotebookError) as ei:
        rt.exec_cell("whatever")
    assert ei.value.code == -32001


def test_exec_unknown_cell_raises_not_found():
    rt, _ = make([("a", "x=1")])
    with pytest.raises(CellNotFoundError) as ei:
        rt.exec_cell("nope")
    assert ei.value.code == -32602


# ---------------------------------------------------------------- 文件往返

def test_load_save_exec_roundtrip(tmp_path):
    from novakernel import serialize

    p1 = tmp_path / "nb.py"
    text = serialize.write(
        [{"id": "a1b2c3d4", "code": "x = 21 * 2"}, {"id": "e5f6a7b8", "code": "print(x)"}],
    )
    p1.write_text(text, encoding="utf-8")

    rt, col = make(None)
    state = rt.load_file(str(p1))
    assert [c["id"] for c in state["cells"]] == ["a1b2c3d4", "e5f6a7b8"]
    assert state["dagEdges"] == [{"from": "a1b2c3d4", "to": "e5f6a7b8"}]
    assert state["staleSet"] == []
    assert state["execCounts"] == {"a1b2c3d4": 0, "e5f6a7b8": 0}
    assert isinstance(state["schemas"], list)

    assert rt.exec_cell("a1b2c3d4")["ok"]
    rep = rt.exec_cell("e5f6a7b8")
    assert rep["ok"]
    assert "".join(p["text"] for p in col.of("run.stdout", "e5f6a7b8")) == "42\n"

    p2 = tmp_path / "saved.py"
    assert rt.save_file(str(p2), [{"id": c["id"], "code": c["code"]} for c in state["cells"]]) == {"ok": True}
    nb2 = serialize.parse_file(str(p2))
    assert [(c.id, c.code) for c in nb2.cells] == [
        ("a1b2c3d4", "x = 21 * 2"),
        ("e5f6a7b8", "print(x)"),
    ]


def test_introspect_returns_schemas():
    rt, _ = make([("a", "data = [1, 2, 3]\nimport os")])
    rt.exec_cell("a")
    schemas = {s["name"]: s for s in rt.introspect()["schemas"]}
    assert "data" in schemas and schemas["data"]["len"] == 3
    assert "os" not in schemas  # module 跳过
