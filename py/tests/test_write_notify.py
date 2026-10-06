"""test_write_notify.py — exec 窗口 file-write 审计钩子（P2.9，spec 附录 A-2 #15）。

契约：exec cell 期间以写方式打开的文件 → run.notify {cellId, kind:'file-write', path}；
只读打开不发；同路径去重；path 为绝对路径；run.notify 在 run.done 之前。
"""

import os
import sys

import pytest

from novakernel.runtime import WRITE_NOTIFY_LIMIT, Runtime


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


def make(cells: list[tuple[str, str]]) -> tuple[Runtime, Collector]:
    col = Collector()
    rt = Runtime(notify=col)
    rt.set_cells([{"id": i, "code": c} for i, c in cells])
    rt.stale.clear()
    return rt, col


def writes(col: Collector, cell_id: str | None = None) -> list[str]:
    return [p["path"] for p in col.of("run.notify", cell_id) if p.get("kind") == "file-write"]


def lit(path) -> str:
    """路径 → cell 源码里的字符串字面量（Windows 反斜杠安全）。"""
    return repr(str(path))


def test_write_file_emits_run_notify(tmp_path):
    target = tmp_path / "out.csv"
    code = f"with open({lit(target)}, 'w', encoding='utf-8') as f:\n    f.write('a,b\\n1,2\\n')"
    rt, col = make([("w1", code)])
    rep = rt.exec_cell("w1")
    assert rep["ok"], rep.get("traceback")
    assert writes(col, "w1") == [str(target)]
    assert target.read_text(encoding="utf-8") == "a,b\n1,2\n"


def test_run_notify_arrives_before_run_done(tmp_path):
    target = tmp_path / "x.txt"
    rt, col = make([("w1", f"open({lit(target)}, 'w').close()")])
    rt.exec_cell("w1")
    methods = col.methods()
    assert "run.notify" in methods
    assert methods.index("run.notify") < methods.index("run.done")


def test_readonly_open_emits_nothing(tmp_path):
    src = tmp_path / "in.txt"
    src.write_text("hello", encoding="utf-8")
    rt, col = make([
        ("r1", f"data = open({lit(src)}, 'r', encoding='utf-8').read()\nprint(data)"),
    ])
    rep = rt.exec_cell("r1")
    assert rep["ok"], rep.get("traceback")
    assert rt.globals["data"] == "hello"
    assert col.of("run.notify") == []


def test_append_and_plus_modes_are_writes(tmp_path):
    a = tmp_path / "a.log"
    b = tmp_path / "b.txt"
    b.write_text("seed", encoding="utf-8")
    code = (
        f"open({lit(a)}, 'a', encoding='utf-8').close()\n"
        f"open({lit(b)}, 'r+', encoding='utf-8').close()\n"
    )
    rt, col = make([("m1", code)])
    rt.exec_cell("m1")
    assert sorted(writes(col, "m1")) == sorted([str(a), str(b)])


def test_same_path_written_multiple_times_is_deduped(tmp_path):
    target = tmp_path / "many.bin"
    code = (
        "for i in range(3):\n"
        f"    with open({lit(target)}, 'wb') as f:\n"
        "        f.write(str(i).encode())\n"
    )
    rt, col = make([("d1", code)])
    rt.exec_cell("d1")
    assert writes(col, "d1") == [str(target)]  # 只发一条


def test_write_before_exception_still_notified(tmp_path):
    target = tmp_path / "half.txt"
    rt, col = make([("e1", f"open({lit(target)}, 'w').close()\nraise ValueError('boom')")])
    rep = rt.exec_cell("e1")
    assert not rep["ok"]
    assert writes(col, "e1") == [str(target)]
    assert col.of("run.error", "e1")


def test_hook_window_closes_after_exec(tmp_path):
    """exec 结束后宿主进程（runtime 自身/测试代码）的写不再产生通知。"""
    rt, col = make([("n1", "x = 1")])
    rt.exec_cell("n1")
    (tmp_path / "after.txt").write_text("host write", encoding="utf-8")
    rt.exec_cell("n1")
    assert col.of("run.notify") == []


def test_import_pyc_cache_write_is_filtered(tmp_path, monkeypatch):
    """import 触发的 __pycache__/*.pyc 写是解释器噪音，不发通知。"""
    monkeypatch.setattr(sys, "dont_write_bytecode", False)
    mod_dir = tmp_path / "mods"
    mod_dir.mkdir()
    (mod_dir / "nova_pyc_probe.py").write_text("VALUE = 1\n", encoding="utf-8")
    monkeypatch.setattr(sys, "path", [str(mod_dir), *sys.path])
    code = "import nova_pyc_probe\ny = nova_pyc_probe.VALUE\n"
    rt, col = make([("p1", code)])
    try:
        rep = rt.exec_cell("p1")
        assert rep["ok"], rep.get("traceback")
        assert rt.globals["y"] == 1
        assert (mod_dir / "__pycache__").exists()  # 确实发生了 pyc 写
        assert col.of("run.notify") == []
    finally:
        sys.modules.pop("nova_pyc_probe", None)


def test_relative_path_reported_as_absolute(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    rt, col = make([("c1", "open('rel.csv', 'w').close()")])
    rt.exec_cell("c1")
    assert writes(col, "c1") == [os.path.abspath(os.path.join(str(tmp_path), "rel.csv"))]


def test_notify_cap_at_limit(tmp_path):
    code = "\n".join([
        "import pathlib",
        f"tmpdir = pathlib.Path({lit(tmp_path)})",
        f"for i in range({WRITE_NOTIFY_LIMIT + 30}):",
        "    open(str(tmpdir / f'f{i}.txt'), 'w').close()",
    ])
    rt, col = make([("cap1", code)])
    rt.exec_cell("cap1")
    assert len(writes(col, "cap1")) == WRITE_NOTIFY_LIMIT


def test_pandas_to_csv_emits_notify(tmp_path):
    pytest.importorskip("pandas")
    target = tmp_path / "df.csv"
    code = (
        "import pandas as pd\n"
        "df = pd.DataFrame({'a': [1, 2]})\n"
        f"df.to_csv({lit(target)})\n"
    )
    rt, col = make([("pd1", code)])
    rep = rt.exec_cell("pd1")
    assert rep["ok"], rep.get("traceback")
    assert writes(col, "pd1") == [str(target)]


def test_repl_writes_notified_under_repl_id(tmp_path):
    target = tmp_path / "repl.txt"
    col = Collector()
    rt = Runtime(notify=col)
    rt.exec_repl(f"open({lit(target)}, 'w').close()")
    assert writes(col, "repl") == [str(target)]
