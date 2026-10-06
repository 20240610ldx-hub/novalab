"""test_matplotlib_mime.py — matplotlib inline 验证（P2.9，spec 附录 A-2 #17）。

契约：cell 以 Agg 后端画图（pyplot 收尾）→ 成功后 run.mime 收到 image/png base64；
figure 关闭后不重复发送（第二次 exec 只发新 figure 的一条）。
"""

import base64

import pytest

from novakernel.runtime import Runtime

pytest.importorskip("matplotlib")

PLOT_CODE = "\n".join([
    "import matplotlib",
    "matplotlib.use('Agg')",
    "import matplotlib.pyplot as plt",
    "fig, ax = plt.subplots()",
    "ax.plot([1, 2, 3], [4, 5, 6])",
    "ax.set_title('inline check')",
    "fig",
])


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


def make_runtime(code: str) -> tuple[Runtime, Collector]:
    col = Collector()
    rt = Runtime(notify=col)
    rt.set_cells([{"id": "plot", "code": code}])
    rt.stale.clear()
    return rt, col


def test_pyplot_figure_emits_png_mime():
    rt, col = make_runtime(PLOT_CODE)
    rep = rt.exec_cell("plot")
    assert rep["ok"], rep.get("traceback")

    mimes = col.of("run.mime", "plot")
    assert len(mimes) == 1
    assert mimes[0]["mime"] == "image/png"

    raw = base64.b64decode(mimes[0]["data"])
    assert raw.startswith(b"\x89PNG\r\n\x1a\n")
    assert len(raw) > 1000  # 非空白占位图

    # mime 在 run.done 之前（前端按流序渲染）
    methods = [m for m, _ in col.msgs]
    assert methods.index("run.mime") < methods.index("run.done")


def test_figure_closed_after_capture_no_duplicate_on_rerun():
    rt, col = make_runtime(PLOT_CODE)
    rt.exec_cell("plot")
    assert len(col.of("run.mime", "plot")) == 1

    import matplotlib.pyplot as plt

    assert plt.get_fignums() == []  # 捕获后 figure 已关闭

    rt.exec_cell("plot")
    # 第二次 exec 只新增一条（新画的 figure），旧 figure 不重复发送
    assert len(col.of("run.mime", "plot")) == 2


def test_error_cell_emits_no_mime():
    rt, col = make_runtime(PLOT_CODE + "\nraise RuntimeError('after plot')")
    rep = rt.exec_cell("plot")
    assert not rep["ok"]
    assert col.of("run.mime", "plot") == []
    # 失败路径不捕获 → figure 仍开着，测试内自行清理防泄漏到其他用例
    import matplotlib.pyplot as plt

    plt.close("all")
