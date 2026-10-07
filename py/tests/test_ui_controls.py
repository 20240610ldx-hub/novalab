"""test_ui_controls.py — P3.3 交互控件（spec §15）：ui.py 值域校验 + runtime 注册/级联 + server dispatch。

契约（冻结）：
- control.set {controlId, value} → {ok, cascaded:[ids], staleSideEffect:[ids]}；
  级联重跑的每格发常规 run.* 通知；mutate 本身不重发 control mime（前端乐观更新）；
- run.mime 增 application/vnd.novalab.control+json，data = {controlId,kind,spec,value}
  （strict JSON 串——前端 store 的 mime data 通道是文本，见 ui.mime_data docstring）；
- cell 重跑 = 旧 controlId 注销 + 重建（值回默认）；未知 controlId → KernelError -32602。
"""

import datetime as dt
import io
import json
import math

import pytest

from novakernel import ui
from novakernel.runtime import KernelError, Runtime
from novakernel.server import Server

CONTROL_MIME = "application/vnd.novalab.control+json"

IMPORT = "from novakernel import ui"


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


def make_runtime(cells: list[dict]) -> tuple[Runtime, Collector]:
    col = Collector()
    rt = Runtime(notify=col)
    rt.set_cells(cells)
    rt.stale.clear()
    return rt, col


def control_mimes(col: Collector, cell_id: str | None = None) -> list[dict]:
    return [p for p in col.of("run.mime", cell_id) if p.get("mime") == CONTROL_MIME]


def payload(mime_params: dict) -> dict:
    return json.loads(mime_params["data"])


def strict_loads(s: str):
    """JSON.parse 等价严格度：裸 NaN/Infinity 视为坏载荷。"""
    def boom(x):
        raise AssertionError(f"non-strict JSON constant in payload: {x}")
    return json.loads(s, parse_constant=boom)


SLIDER_CELL = {"id": "c1", "code": f"{IMPORT}\ns = ui.slider(0, 10, step=2, label='n')"}


# ---------------------------------------------------------------- mime 发射


def test_slider_def_emits_control_mime_before_done():
    rt, col = make_runtime([SLIDER_CELL])
    rep = rt.exec_cell("c1")
    assert rep["ok"], rep.get("traceback")

    mimes = control_mimes(col, "c1")
    assert len(mimes) == 1
    p = payload(mimes[0])
    assert p["controlId"] == "c1::s"
    assert p["kind"] == "slider"
    assert p["spec"] == {"start": 0, "stop": 10, "step": 2, "label": "n"}
    assert p["value"] == 0  # 缺省 = start

    methods = [m for m, _ in col.msgs]
    assert methods.index("run.mime") < methods.index("run.done")
    # data 是 strict JSON（无裸 NaN）
    strict_loads(mimes[0]["data"])


def test_trailing_bare_name_in_cell_emits_once():
    # exec 模式收尾裸表达式不求值：defs 扫描是唯一发射路径，不重复发
    code = f"{IMPORT}\ns = ui.slider(0, 10)\ns"
    rt, col = make_runtime([{"id": "c1", "code": code}])
    assert rt.exec_cell("c1")["ok"]
    assert len(control_mimes(col, "c1")) == 1


def test_repl_trailing_control_uses_same_path_no_repr():
    col = Collector()
    rt = Runtime(notify=col)
    rt.exec_repl(f"{IMPORT}\nt = ui.slider(1, 3)\nt")
    mimes = control_mimes(col, "repl")
    assert len(mimes) == 1
    p = payload(mimes[0])
    assert p["controlId"] == "repl::t"  # 从 globals 反查到绑定名
    # 不再发 text/plain repr 回显（同一路径，不重复）
    assert [q for q in col.of("run.mime", "repl") if q["mime"] == "text/plain"] == []
    # REPL 控件可 mutate，不级联
    res = rt.control_set("repl::t", 2)
    assert res == {"ok": True, "cascaded": [], "staleSideEffect": []}
    assert rt.controls["repl::t"].value == 2


def test_repl_anonymous_control_id_fallback():
    col = Collector()
    rt = Runtime(notify=col)
    rt.exec_repl(f"{IMPORT}\nui.checkbox(True)")
    p = payload(control_mimes(col, "repl")[0])
    assert p["controlId"] == "repl::expr"
    assert p["value"] is True


def test_multiple_controls_one_mime_each_sorted():
    code = f"{IMPORT}\nb = ui.checkbox(False)\na = ui.text('x')"
    rt, col = make_runtime([{"id": "c1", "code": code}])
    rt.exec_cell("c1")
    ids = [payload(m)["controlId"] for m in control_mimes(col, "c1")]
    assert ids == ["c1::a", "c1::b"]  # committed defs 排序


# ------------------------------------------------------------ set + 级联


def _chain_runtime():
    cells = [
        SLIDER_CELL,
        {"id": "c2", "code": "doubled = s.value * 2"},
        {"id": "c3", "code": "quad = doubled * 2"},
    ]
    rt, col = make_runtime(cells)
    for cid in ("c1", "c2", "c3"):
        assert rt.exec_cell(cid)["ok"]
    return rt, col


def test_control_set_mutates_and_cascades_with_run_notifications():
    rt, col = make_runtime([SLIDER_CELL, {"id": "c2", "code": "doubled = s.value * 2"}])
    rt.exec_cell("c1")
    rt.exec_cell("c2")
    assert rt.globals["doubled"] == 0

    col.msgs.clear()
    res = rt.control_set("c1::s", 7)
    assert res == {"ok": True, "cascaded": ["c2"], "staleSideEffect": []}
    assert rt.globals["s"].value == 7
    assert rt.globals["doubled"] == 14
    # 级联重跑的格发常规 run.* 通知
    assert col.of("run.started", "c2") and col.of("run.done", "c2")
    assert col.of("run.started", "c1") == []  # owner 不重跑


def test_control_set_does_not_reemit_control_mime():
    rt, col = _chain_runtime()
    n_before = len(control_mimes(col, "c1"))
    rt.control_set("c1::s", 5)
    assert len(control_mimes(col, "c1")) == n_before  # 前端乐观更新，内核不重绘


def test_cascade_reaches_transitive_downstream_in_topo_order():
    rt, _ = _chain_runtime()
    res = rt.control_set("c1::s", 3)
    assert res["cascaded"] == ["c2", "c3"]
    assert rt.globals["quad"] == 12


def test_side_effect_downstream_marked_stale_not_run():
    cells = [
        SLIDER_CELL,
        {"id": "c2", "code": "with open('out.txt', 'w') as f:\n    f.write(str(s.value))"},
    ]
    rt, col = make_runtime(cells)
    rt.exec_cell("c1")
    assert rt.cells["c2"].side_effect  # 启发式命中

    res = rt.control_set("c1::s", 4)
    assert res == {"ok": True, "cascaded": [], "staleSideEffect": ["c2"]}
    assert "c2" in rt.stale
    assert rt.exec_counts.get("c2", 0) == 0  # 从未自动执行
    assert col.of("run.started", "c2") == []


def test_failed_downstream_blocks_branch():
    cells = [
        SLIDER_CELL,
        {"id": "c2", "code": "v = s.value\nraise RuntimeError('boom')"},
        {"id": "c3", "code": "w = v + 1"},
    ]
    rt, col = make_runtime(cells)
    rt.exec_cell("c1")
    res = rt.control_set("c1::s", 2)
    assert res["cascaded"] == []
    assert col.of("run.error", "c2")  # 失败格照常发 run.error
    assert rt.exec_counts.get("c3", 0) == 0  # 下游分支阻断
    assert {"c2", "c3"} <= rt.stale


# ------------------------------------------------------- 重跑重建 / 注销


def test_rerun_rebuilds_control_with_default_value():
    rt, col = make_runtime([SLIDER_CELL])
    rt.exec_cell("c1")
    old = rt.controls["c1::s"]
    rt.control_set("c1::s", 8)
    assert old.value == 8

    rt.exec_cell("c1")  # cell 重跑 = 注销 + 重建
    new = rt.controls["c1::s"]
    assert new is not old
    assert new.value == 0  # 值回默认
    assert old.control_id is None  # 旧实例已注销
    last = payload(control_mimes(col, "c1")[-1])
    assert last["value"] == 0


def test_removed_cell_unregisters_control():
    rt, _ = make_runtime([SLIDER_CELL])
    rt.exec_cell("c1")
    assert "c1::s" in rt.controls
    rt.set_cells([])  # 删除 cell
    assert rt.controls == {}
    with pytest.raises(KernelError) as ei:
        rt.control_set("c1::s", 1)
    assert ei.value.code == -32602


def test_unknown_control_id_raises_32602():
    rt, _ = make_runtime([SLIDER_CELL])
    rt.exec_cell("c1")
    with pytest.raises(KernelError) as ei:
        rt.control_set("c1::nope", 1)
    assert ei.value.code == -32602


# ------------------------------------------------------------- 值域校验


def test_slider_clamp():
    rt, _ = make_runtime([SLIDER_CELL])
    rt.exec_cell("c1")
    rt.control_set("c1::s", 999)
    assert rt.controls["c1::s"].value == 10
    rt.control_set("c1::s", -999)
    assert rt.controls["c1::s"].value == 0
    rt.control_set("c1::s", 4.5)
    assert rt.controls["c1::s"].value == 4.5
    with pytest.raises(KernelError):  # NaN 拒绝（-32602）
        rt.control_set("c1::s", float("nan"))


def test_date_iso_validation_and_normalization():
    assert ui.date(dt.date(2026, 10, 7)).value == "2026-10-07"
    assert ui.date(dt.datetime(2026, 10, 7, 13, 30)).value == "2026-10-07"
    assert ui.date("2026-01-02").value == "2026-01-02"
    assert ui.date(None).value is None

    rt, _ = make_runtime([{"id": "c1", "code": f"{IMPORT}\nd = ui.date()"}])
    rt.exec_cell("c1")
    rt.control_set("c1::d", "2026-12-31")
    assert rt.controls["c1::d"].value == "2026-12-31"
    with pytest.raises(KernelError) as ei:
        rt.control_set("c1::d", "not-a-date")
    assert ei.value.code == -32602


def test_checkbox_and_text_coercion():
    rt, _ = make_runtime([
        {"id": "c1", "code": f"{IMPORT}\ncb = ui.checkbox()\ntx = ui.text()"},
    ])
    rt.exec_cell("c1")
    rt.control_set("c1::cb", 1)
    assert rt.controls["c1::cb"].value is True
    rt.control_set("c1::tx", 123)
    assert rt.controls["c1::tx"].value == "123"
    rt.control_set("c1::tx", None)
    assert rt.controls["c1::tx"].value == ""


def test_slider_rejects_non_numeric():
    rt, _ = make_runtime([SLIDER_CELL])
    rt.exec_cell("c1")
    with pytest.raises(KernelError) as ei:
        rt.control_set("c1::s", "7")
    assert ei.value.code == -32602


# ------------------------------------------------------------------ table


def test_table_selection_multi_single_and_none():
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})

    t = ui.table(df, selection="multi")
    assert t.value == []
    t.value = [0, 5, 2, 0]  # 越界过滤 + 去重
    assert t.value == [0, 2]
    t.value = [1.0, 2.0]  # JSON round-trip 的浮点整数
    assert t.value == [1, 2]
    spec = t.spec
    assert spec["rowCount"] == 3
    assert spec["selection"] == "multi"
    assert [c["name"] for c in spec["columns"]] == ["a", "b"]
    assert spec["rows"][0] == {"a": 1, "b": "x"}

    one = ui.table(df, selection="single")
    one.value = [0, 2]
    assert one.value == [2]  # single 只留最后一个

    plain = ui.table(df)
    plain.value = [0, 1]
    assert plain.value is None  # selection=None → 不可选


def test_table_rejects_bad_selection_mode():
    pd = pytest.importorskip("pandas")
    with pytest.raises(ValueError):
        ui.table(pd.DataFrame({"a": [1]}), selection="bogus")


def test_table_dict_fallback_without_pandas():
    t = ui.table({"a": [1, 2], "b": [3, 4]}, selection="multi")
    assert t.spec["rowCount"] == 2
    t.value = [1]
    assert t.value == [1]


# ------------------------------------------------------------- JSON-safe


def test_to_jsonable_nan_and_special_values():
    assert ui.to_jsonable(float("nan")) == "NaN"
    assert ui.to_jsonable(math.inf) == "Infinity"
    assert ui.to_jsonable(-math.inf) == "-Infinity"
    assert ui.to_jsonable(dt.date(2026, 1, 1)) == "2026-01-01"
    assert ui.to_jsonable({"x": [1, float("nan")]}) == {"x": [1, "NaN"]}
    assert ui.to_jsonable((1, "a")) == [1, "a"]
    assert ui.to_jsonable(object) == str(object)


def test_table_nan_cell_serializes_strict_json():
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame({"a": [1.0, float("nan")]})
    rt, col = make_runtime([{"id": "c1", "code": f"{IMPORT}\nt = ui.table(df_src, selection='multi')"}])
    rt.globals["df_src"] = df  # 测试注入（cell 代码引用）
    rt.exec_cell("c1")
    mimes = control_mimes(col, "c1")
    assert len(mimes) == 1
    p = strict_loads(mimes[0]["data"])  # 裸 NaN 会 AssertionError
    assert p["spec"]["rows"][1]["a"] is None  # pandas to_json：NaN → null


# ------------------------------------------------------------- server 层


def test_server_dispatch_control_set():
    out = io.StringIO()
    srv = Server(stdin=io.StringIO(""), stdout=out)
    srv.dispatch("set_cells", {"cells": [SLIDER_CELL]})
    srv.dispatch("exec_cell", {"cellId": "c1"})

    res = srv.dispatch("control.set", {"controlId": "c1::s", "value": 6})
    assert res["ok"] is True and res["cascaded"] == [] and res["staleSideEffect"] == []
    assert srv.runtime.controls["c1::s"].value == 6

    # value 为 falsy（0/False/''/None）也合法——只查在场性
    assert srv.dispatch("control.set", {"controlId": "c1::s", "value": 0})["ok"]
    with pytest.raises(KernelError) as ei:
        srv.dispatch("control.set", {"controlId": "c1::s"})  # 缺 value
    assert ei.value.code == -32602
    with pytest.raises(KernelError) as ei:
        srv.dispatch("control.set", {"controlId": "c1::s", "value": "x"})
    assert ei.value.code == -32602
