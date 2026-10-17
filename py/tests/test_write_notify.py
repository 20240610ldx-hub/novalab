"""test_write_notify.py — exec 窗口 file-write 审计钩子（P2.9，spec 附录 A-2 #15）。

契约：exec cell 期间以写方式打开的文件 → run.notify {cellId, kind:'file-write', path}；
只读打开 → kind:'file-read'（ADR-015 溯源输入；解释器 / 库 / 源码与字体文件过滤）；
同路径去重；path 为绝对路径；run.notify 在 run.done 之前。
"""

import os
import sys

import pytest

from novakernel.runtime import READ_NOTIFY_LIMIT, WRITE_NOTIFY_LIMIT, Runtime


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


def reads(col: Collector, cell_id: str | None = None) -> list[str]:
    return [p["path"] for p in col.of("run.notify", cell_id) if p.get("kind") == "file-read"]


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


def test_readonly_open_is_a_read_not_a_write(tmp_path):
    src = tmp_path / "in.txt"
    src.write_text("hello", encoding="utf-8")
    rt, col = make([
        ("r1", f"data = open({lit(src)}, 'r', encoding='utf-8').read()\nprint(data)"),
    ])
    rep = rt.exec_cell("r1")
    assert rep["ok"], rep.get("traceback")
    assert rt.globals["data"] == "hello"
    assert writes(col) == []
    assert reads(col, "r1") == [str(src)]


def test_reads_deduped_capped_and_reported_before_done(tmp_path):
    srcs = []
    for i in range(READ_NOTIFY_LIMIT + 5):
        p = tmp_path / f"in{i}.txt"
        p.write_text(str(i), encoding="utf-8")
        srcs.append(p)
    code = "\n".join([
        "import pathlib",
        f"d = pathlib.Path({lit(tmp_path)})",
        f"for i in range({READ_NOTIFY_LIMIT + 5}):",
        "    open(str(d / f'in{i}.txt')).read()",
        "    open(str(d / f'in{i}.txt')).read()",
    ])
    rt, col = make([("rc", code)])
    assert rt.exec_cell("rc")["ok"]
    assert len(reads(col, "rc")) == READ_NOTIFY_LIMIT
    assert len(set(reads(col, "rc"))) == READ_NOTIFY_LIMIT
    methods = col.methods()
    assert max(i for i, m in enumerate(methods) if m == "run.notify") < methods.index("run.done")


def test_read_then_write_same_file_reports_both(tmp_path):
    f = tmp_path / "inplace.txt"
    f.write_text("1", encoding="utf-8")
    code = f"v = open({lit(f)}).read()\nopen({lit(f)}, 'w').write(v + '1')"
    rt, col = make([("ip", code)])
    assert rt.exec_cell("ip")["ok"]
    assert reads(col, "ip") == [str(f)]
    assert writes(col, "ip") == [str(f)]


def test_library_and_source_reads_are_filtered(tmp_path, monkeypatch):
    """import 读 .py、读库内资源文件都不算输入。"""
    mod_dir = tmp_path / "mods"
    mod_dir.mkdir()
    (mod_dir / "nova_read_probe.py").write_text("VALUE = 2\n", encoding="utf-8")
    monkeypatch.setattr(sys, "path", [str(mod_dir), *sys.path])
    code = (
        "import nova_read_probe, json, os\n"
        "y = nova_read_probe.VALUE\n"
        "lib = open(os.path.join(os.path.dirname(json.__file__), '__init__.py')).read()\n"
    )
    rt, col = make([("lib", code)])
    try:
        rep = rt.exec_cell("lib")
        assert rep["ok"], rep.get("traceback")
        assert reads(col, "lib") == []
    finally:
        sys.modules.pop("nova_read_probe", None)


def test_pandas_read_csv_is_an_input(tmp_path):
    pytest.importorskip("pandas")
    src = tmp_path / "survey.csv"
    src.write_text("a,b\n1,2\n", encoding="utf-8")
    code = f"import pandas as pd\ndf = pd.read_csv({lit(src)})\n"
    rt, col = make([("pdr", code)])
    rep = rt.exec_cell("pdr")
    assert rep["ok"], rep.get("traceback")
    assert reads(col, "pdr") == [str(src)]


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


def test_transient_write_deleted_in_same_exec_is_not_reported(tmp_path):
    """写完即删的临时文件（tempfile.gettempdir() 的可写探测同理）不是结果。"""
    keep = tmp_path / "keep.txt"
    gone = tmp_path / "gone.tmp"
    code = (
        "import os, tempfile\n"
        "tempfile.tempdir = None\n"
        "tempfile.gettempdir()\n"
        f"open({lit(gone)}, 'w').close()\n"
        f"os.remove({lit(gone)})\n"
        f"open({lit(keep)}, 'w').close()\n"
    )
    rt, col = make([("t1", code)])
    assert rt.exec_cell("t1")["ok"]
    assert writes(col, "t1") == [str(keep)]


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
        assert col.of("run.notify") == []  # 读 .py 源码也不算输入
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
