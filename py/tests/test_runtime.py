"""test_runtime.py — 反应式执行语义黄金集（spec §5 + 契约增补形状）。"""

import hashlib
import json

import pytest

from novakernel.runtime import (
    DISPLAY_TEXT_LIMIT,
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
    # 失败的运行同样计数，且随 run.error 下发（否则前端停留在 [0]、会话视图漏掉失败 cell）
    assert errs[0]["execCount"] == 1
    # 内核自身的调度帧（runtime.py _run_cell）不进 traceback 文本与 frames：用户只看到自己的 cell
    assert "runtime.py" not in rep["traceback"]
    assert errs[0]["frames"][0]["file"] == "<cell a>"
    rt.exec_cell("a")
    assert col.of("run.error", "a")[-1]["execCount"] == 2
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


# --------------------------------------------- repl displayhook（L-4 裸表达式回显）

def test_repl_bare_expression_echoes_repr():
    # 末语句为裸表达式 → eval 后 run.mime text/plain 回显 repr；多语句只回显末句
    rt, col = make([("a", "x = 40")])
    rt.exec_cell("a")
    rep = rt.exec_repl("y = 1\nx + y + 1")
    assert rep["ok"] is True
    assert col.of("run.mime", REPL_ID) == [
        {"cellId": REPL_ID, "mime": "text/plain", "data": "42"}
    ]
    # None 结果不回显（displayhook 语义）
    rep2 = rt.exec_repl("None")
    assert rep2["ok"] is True
    assert len(col.of("run.mime", REPL_ID)) == 1


def test_repl_assignment_does_not_echo():
    rt, col = make([("a", "x = 1")])
    rt.exec_cell("a")
    rep = rt.exec_repl("q = x + 1")
    assert rep["ok"] is True
    assert rt.globals["q"] == 2
    assert col.of("run.mime", REPL_ID) == []


def test_repl_last_expression_error_goes_run_error_without_echo():
    # 末语句异常：照常 run.error（traceback 行号指向末句），不回显、不发 run.mime
    rt, col = make([("a", "x = 1")])
    rt.exec_cell("a")
    rep = rt.exec_repl("y = 2\nundefined_name")
    assert rep["ok"] is False and "NameError" in rep["traceback"]
    assert col.of("run.error", REPL_ID)
    assert col.of("run.mime", REPL_ID) == []
    assert "y" not in rt.globals  # 失败 cell 的 defs 回滚（spec §12），y 不残留


# ------------------------------- cell displayhook（L-5 普通 cell 收尾裸表达式回显）

def mime_map(col: Collector, cell_id: str) -> dict[str, str]:
    return {p["mime"]: p["data"] for p in col.of("run.mime", cell_id)}


def test_cell_trailing_expression_echoes_text_plain():
    # 末语句裸表达式 → run.mime text/plain（repr）；无 _repr_html_ 的对象不发 text/html
    rt, col = make([("a", "x = 40\nx + 2")])
    rep = rt.exec_cell("a")
    assert rep["ok"] is True
    assert col.of("run.mime", "a") == [{"cellId": "a", "mime": "text/plain", "data": "42"}]
    methods = col.methods()
    assert methods.index("run.mime") < methods.index("run.done")  # 前端按流序渲染
    assert col.json_ok()


def test_cell_trailing_dataframe_emits_html_and_plain():
    pytest.importorskip("pandas")
    code = "import pandas as pd\ndf = pd.DataFrame({'county': ['A', 'B'], 'pop': [9.1, 7.5]})\ndf"
    rt, col = make([("a", code)])
    assert rt.exec_cell("a")["ok"] is True
    mimes = mime_map(col, "a")
    assert set(mimes) == {"text/plain", "text/html"}
    assert mimes["text/plain"] == repr(rt.globals["df"])
    assert "<table" in mimes["text/html"] and "county" in mimes["text/html"]
    assert col.json_ok()


def test_cell_assignment_emits_nothing():
    rt, col = make([("a", "x = 1")])
    assert rt.exec_cell("a")["ok"] is True
    assert col.of("run.mime", "a") == []


def test_cell_trailing_none_call_emits_nothing():
    # 末语句是返回 None 的调用（print / list.append / plt.show 一类）→ 不回显
    rt, col = make([("a", "items = []\nitems.append(1)")])
    assert rt.exec_cell("a")["ok"] is True
    assert col.of("run.mime", "a") == []
    assert rt.globals["items"] == [1]  # 调用只执行一次（未被 exec + eval 重复求值）


def test_cell_trailing_expression_does_not_bind_or_define():
    # 反应式单赋值语义不变：回显值不绑定 `_`、不进 defs / defined_by，DAG 分析不受影响
    rt, col = make([("a", "x = 1\nx + 1"), ("b", "y = x * 10\ny")])
    before = {cid: (set(r.defs), set(r.refs)) for cid, r in rt.cells.items()}
    rep = rt.exec_cell("a", cascade=True)
    assert rep["ok"] and rep["cascaded"] == ["b"]
    assert "_" not in rt.globals
    assert rt.defined_by == {"x": "a", "y": "b"}
    assert col.of("run.done", "a")[0]["defs"] == ["x"]
    assert col.of("run.done", "b")[0]["defs"] == ["y"]
    assert {cid: (set(r.defs), set(r.refs)) for cid, r in rt.cells.items()} == before
    # 级联重跑的下游同样回显
    assert mime_map(col, "a") == {"text/plain": "2"}
    assert mime_map(col, "b") == {"text/plain": "10"}


def test_cell_trailing_expression_error_goes_run_error_with_line():
    # 末表达式异常：常规 run.error（行号指向末句）、不回显、defs 回滚、进 stale
    rt, col = make([("a", "x = 1\n\n\nx / 0")])
    rep = rt.exec_cell("a")
    assert rep["ok"] is False and "ZeroDivisionError" in rep["traceback"]
    assert 'File "<cell a>", line 4' in rep["traceback"]
    err = col.of("run.error", "a")
    assert len(err) == 1
    assert err[0]["frames"][-1] == {
        "file": "<cell a>", "line": 4, "fn": "<module>", "srcLine": "x / 0",
    }
    assert col.of("run.mime", "a") == []
    assert col.of("run.done", "a") == []
    assert "x" not in rt.globals and "a" in rt.stale


def test_cell_trailing_figure_emits_only_png():
    # figure 捕获照旧：收尾 `fig` / `ax.plot(...)` 只发 image/png，不附 <Figure …> repr
    pytest.importorskip("matplotlib")
    setup = "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nfig, ax = plt.subplots()\n"
    for tail in ("ax.plot([1, 2, 3])\nfig", "ax.plot([1, 2, 3])"):
        rt, col = make([("p", setup + tail)])
        assert rt.exec_cell("p")["ok"] is True
        mimes = col.of("run.mime", "p")
        assert [m["mime"] for m in mimes] == ["image/png"], tail
        assert len(mimes[0]["data"]) > 1000


def test_cell_display_text_capped_and_oversized_html_dropped():
    code = "\n".join([
        "class Big:",
        "    def __repr__(self):",
        f"        return 'r' * {DISPLAY_TEXT_LIMIT + 50}",
        "    def _repr_html_(self):",
        f"        return '<b>' + 'h' * {DISPLAY_TEXT_LIMIT} + '</b>'",
        "Big()",
    ])
    rt, col = make([("a", code)])
    assert rt.exec_cell("a")["ok"] is True
    mimes = mime_map(col, "a")
    assert set(mimes) == {"text/plain"}  # 超限 html 整条放弃（截断会破坏标签）
    plain = mimes["text/plain"]
    assert plain.startswith("r" * DISPLAY_TEXT_LIMIT) and plain.endswith("…[truncated]")
    assert len(plain) == DISPLAY_TEXT_LIMIT + len("…[truncated]")


def test_cell_display_failures_never_fail_the_run():
    # _repr_html_ 抛异常 / 返回非 str → 静默降级为 text/plain；repr 内的 print 进 run.stdout
    code = "\n".join([
        "class Noisy:",
        "    def __repr__(self):",
        "        print('from repr')",
        "        return 'Noisy()'",
        "    def _repr_html_(self):",
        "        raise RuntimeError('boom')",
        "Noisy()",
    ])
    rt, col = make([("a", code), ("b", "class NotStr:\n    def _repr_html_(self):\n        return 42\nNotStr")])
    assert rt.exec_cell("a")["ok"] is True
    assert mime_map(col, "a") == {"text/plain": "Noisy()"}
    assert "".join(p["text"] for p in col.of("run.stdout", "a")) == "from repr\n"
    assert col.of("run.error", "a") == []
    # 类对象本身（未绑定 _repr_html_）同样只回显 repr
    assert rt.exec_cell("b")["ok"] is True
    assert set(mime_map(col, "b")) == {"text/plain"}


def test_repl_echo_stays_text_plain_only():
    # REPL 契约（L-4）不变：有 _repr_html_ 的对象也只回显 text/plain
    rt, col = make([("a", "class H:\n    def _repr_html_(self):\n        return '<i>h</i>'\nh = H()")])
    rt.exec_cell("a")
    assert rt.exec_repl("h")["ok"] is True
    assert [p["mime"] for p in col.of("run.mime", REPL_ID)] == ["text/plain"]


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
    saved = rt.save_file(str(p2), [{"id": c["id"], "code": c["code"]} for c in state["cells"]])
    assert saved == {"ok": True, "baselineSha256": hashlib.sha256(p2.read_bytes()).hexdigest()}
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
