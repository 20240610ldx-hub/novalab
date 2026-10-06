"""test_serialize.py — NovaLab .py 格式读写（spec §4）。

往返无损（逐字节一致）只对**我们自己的格式**承诺；refs/marimo 示例按 S1 侦察结论
做"宽容导入"测试：解析不崩溃、代码文本不丢失（整文件单 cell），不解析 @app.cell 语义。
"""

import re

from conftest import FIXTURES
from novakernel import serialize

HEX8 = re.compile(r"^[0-9a-f]{8}$")

OWN_FORMAT = """\
# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas"]
# ///
# [novalab] width=compact | app_view=false

# %% [cell-id: 8f3a2c11]
import pandas as pd
df = pd.read_csv("data.csv")

# %% [cell-id: b19d0422]
df.groupby("county").sum()
"""


def test_new_cell_id_format():
    cid = serialize.new_cell_id()
    assert HEX8.match(cid)
    assert serialize.new_cell_id() != cid


def test_parse_own_format():
    nb = serialize.parse(OWN_FORMAT)
    assert [c.id for c in nb.cells] == ["8f3a2c11", "b19d0422"]
    assert nb.cells[0].code == 'import pandas as pd\ndf = pd.read_csv("data.csv")'
    assert nb.cells[1].code == 'df.groupby("county").sum()'
    assert nb.config == {"width": "compact", "app_view": "false"}
    assert nb.header_lines[0] == "# /// script"


def test_roundtrip_code_lossless():
    nb = serialize.parse(OWN_FORMAT)
    text2 = serialize.write(nb.cells, header_lines=nb.header_lines)
    nb2 = serialize.parse(text2)
    assert [(c.id, c.code) for c in nb2.cells] == [(c.id, c.code) for c in nb.cells]
    # 代码文本逐字节一致
    for a, b in zip(nb.cells, nb2.cells):
        assert a.code.encode("utf-8") == b.code.encode("utf-8")


def test_write_is_idempotent_bytes():
    nb = serialize.parse(OWN_FORMAT)
    once = serialize.write(nb.cells, header_lines=nb.header_lines)
    twice = serialize.write(serialize.parse(once).cells, header_lines=serialize.parse(once).header_lines)
    assert once.encode("utf-8") == twice.encode("utf-8")


def test_default_header_generated_when_none():
    text = serialize.write([serialize.Cell("a1b2c3d4", "x = 1")])
    assert text.startswith("# /// script\n")
    assert "# %% [cell-id: a1b2c3d4]\nx = 1\n" in text
    nb = serialize.parse(text)
    assert [c.id for c in nb.cells] == ["a1b2c3d4"]


def test_config_written_and_reparsed():
    text = serialize.write(
        [serialize.Cell("a1b2c3d4", "x = 1")],
        config={"width": "compact", "kernel_python": "3.13"},
    )
    assert '# [novalab] width=compact | kernel_python=3.13' in text
    nb = serialize.parse(text)
    assert nb.config == {"width": "compact", "kernel_python": "3.13"}


def test_unknown_config_keys_ignored_but_kept():
    text = OWN_FORMAT.replace(
        "# [novalab] width=compact | app_view=false",
        "# [novalab] width=compact | future_key=42 | app_view=false",
    )
    nb = serialize.parse(text)  # 不崩溃
    assert nb.config["width"] == "compact"
    assert nb.config["future_key"] == "42"  # 原样保留（前向兼容）
    assert nb.config["app_view"] == "false"


def test_handwritten_py_without_marker_is_single_cell():
    src = "import os\n\nprint(os.getcwd())\n"
    nb = serialize.parse(src)
    assert len(nb.cells) == 1
    assert HEX8.match(nb.cells[0].id)  # id 新生成
    assert nb.cells[0].code == "import os\n\nprint(os.getcwd())"


def test_preamble_before_first_marker_becomes_cell():
    src = "PREAMBLE = 1\n\n# %% [cell-id: aaaaaaaa]\nx = 2\n"
    nb = serialize.parse(src)
    assert len(nb.cells) == 2
    assert HEX8.match(nb.cells[0].id) and nb.cells[0].code == "PREAMBLE = 1"
    assert nb.cells[1].id == "aaaaaaaa" and nb.cells[1].code == "x = 2"


def test_empty_cell_code_roundtrip():
    cells = [serialize.Cell("aaaaaaaa", "x = 1"), serialize.Cell("bbbbbbbb", "")]
    nb = serialize.parse(serialize.write(cells))
    assert [(c.id, c.code) for c in nb.cells] == [("aaaaaaaa", "x = 1"), ("bbbbbbbb", "")]


def test_file_roundtrip_on_disk(tmp_path):
    p = tmp_path / "nb.py"
    serialize.write_file(str(p), OWN_FORMAT)
    nb = serialize.parse_file(str(p))
    text2 = serialize.write(nb.cells, header_lines=nb.header_lines)
    serialize.write_file(str(p), text2)
    nb2 = serialize.parse_file(str(p))
    assert [(c.id, c.code) for c in nb2.cells] == [(c.id, c.code) for c in nb.cells]
    raw = p.read_bytes()
    assert raw == text2.encode("utf-8")  # LF、UTF-8、无 BOM


# --------------------------------------------------------------- marimo 宽容导入
# S1 结论：真 marimo .py 是 @app.cell 装饰器式，与本格式互不直读。
# 这里只验证"宽容导入"：解析不崩溃、代码文本不丢失、写入本格式后往返无损。

MARIMO_FIXTURES = [
    "marimo_compound_interest.py",
    "marimo_stop_execution.py",
    "marimo_console_outputs.py",
]


def test_marimo_fixtures_lenient_import(tmp_path):
    for fname in MARIMO_FIXTURES:
        src = (FIXTURES / fname).read_text(encoding="utf-8")
        nb = serialize.parse(src)  # 不崩溃
        assert len(nb.cells) >= 1, fname
        # 代码文本不丢失：所有非头部正文都在 cells 里
        joined = "\n".join(c.code for c in nb.cells)
        assert "import marimo" in joined or "marimo" in joined, fname
        assert "@app.cell" in joined, fname
        # 转成本格式后 read→write→read 无损
        text = serialize.write(nb.cells, header_lines=nb.header_lines)
        nb2 = serialize.parse(text)
        assert [(c.id, c.code) for c in nb2.cells] == [(c.id, c.code) for c in nb.cells], fname
        assert serialize.write(nb2.cells, header_lines=nb2.header_lines) == text, fname


def test_marimo_fixture_pep723_header_recognized():
    src = (FIXTURES / "marimo_compound_interest.py").read_text(encoding="utf-8")
    nb = serialize.parse(src)
    assert nb.header_lines[0].strip() == "# /// script"
    assert any("dependencies" in ln for ln in nb.header_lines)
    # 头部不进 cell 代码
    assert not nb.cells[0].code.startswith("# /// script")
    assert nb.cells[0].code.startswith("import marimo")


def test_marimo_fixture_without_header():
    src = (FIXTURES / "marimo_stop_execution.py").read_text(encoding="utf-8")
    nb = serialize.parse(src)
    assert len(nb.cells) == 1
    assert nb.cells[0].code.strip("\n") == src.strip("\n")  # 整文件单 cell，无损
