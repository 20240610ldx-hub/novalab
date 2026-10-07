"""test_convert.py — P3.6 marimo ↔ NovaLab 双向转换器（convert.py）。

golden 来源：refs/marimo/examples 真实文件复制为 fixtures/marimo_golden_*.py
（running_cells/basics.py、layouts/columns.py、layouts/sidebar.py）。
守恒断言不用 marimo 运行时：两侧 (defs, refs) 都用 dag.py 提取比较；
代码体逐行相等（marimo 体在函数内多 4 缩进 → parse 侧已 dedent）。
"""

import pytest
from conftest import FIXTURES

from novakernel import convert, dag, serialize

def _compiles(src: str) -> None:
    """ast.parse 在 ≥3.8 不拒绝顶层/同步函数内 await；compile() 才做该校验。"""
    compile(src, "<emit>", "exec")


GOLDEN = [
    "marimo_golden_basics.py",
    "marimo_golden_columns.py",
    "marimo_golden_sidebar.py",
]


def _golden(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _assert_conservation(marimo_src: str, nova_src: str) -> None:
    """语义守恒：cell 数相等、逐 cell (defs,refs) 集合相等、代码体逐行相等（dedent 后）。"""
    m_cells = convert.parse_marimo_cells(marimo_src)
    nb = serialize.parse(nova_src)
    assert len(nb.cells) == len(m_cells)
    # nova 侧是拓扑序 → marimo 侧也按同一拓扑序比较
    m_ordered = convert.topological_sort(m_cells)
    for mc, nc in zip(m_ordered, nb.cells):
        ma = convert.analyze_cell_tolerant("x", mc.body)
        na = convert.analyze_cell_tolerant("x", nc.code)
        assert (ma.defs, ma.refs, ma.syntax_error is None) == (
            na.defs, na.refs, na.syntax_error is None
        ), f"body mismatch:\n--- marimo ---\n{mc.body}\n--- nova ---\n{nc.code}"
        assert mc.body.split("\n") == nc.code.split("\n")


def _marimo_roundtrip_defs_refs(marimo_src: str) -> None:
    """marimo→nova→marimo 往返：逐 cell (defs,refs) 守恒、cell 数守恒。"""
    nova = convert.marimo_to_novalab(marimo_src)
    back = convert.novalab_to_marimo(nova)
    _compiles(back)  # 产物是合法 Python（compile 级：含 await-in-sync-def 检查）
    orig = convert.topological_sort(convert.parse_marimo_cells(marimo_src))
    rt = convert.parse_marimo_cells(back)
    assert len(rt) == len(orig)
    for a, b in zip(orig, rt):
        aa = convert.analyze_cell_tolerant("a", a.body)
        bb = convert.analyze_cell_tolerant("b", b.body)
        assert (aa.defs, aa.refs) == (bb.defs, bb.refs), f"body:\n{a.body}\n!=\n{b.body}"


@pytest.mark.parametrize("name", GOLDEN)
def test_golden_marimo_to_nova_conservation(name):
    _assert_conservation(_golden(name), convert.marimo_to_novalab(_golden(name)))


@pytest.mark.parametrize("name", GOLDEN)
def test_golden_marimo_nova_marimo_roundtrip(name):
    _marimo_roundtrip_defs_refs(_golden(name))


@pytest.mark.parametrize("name", GOLDEN)
def test_golden_nova_marimo_nova_roundtrip_code_preserved(name):
    """nova→marimo→nova 往返：代码体守恒。"""
    src = _golden(name)
    nova1 = convert.marimo_to_novalab(src)
    back = convert.novalab_to_marimo(nova1)
    nova2 = convert.marimo_to_novalab(back)
    nb1 = serialize.parse(nova1)
    nb2 = serialize.parse(nova2)
    assert [c.code for c in nb1.cells] == [c.code for c in nb2.cells]


@pytest.mark.parametrize("name", GOLDEN)
def test_golden_nova_output_shape(name):
    src = _golden(name)
    nova = convert.marimo_to_novalab(src)
    nb = serialize.parse(nova)
    assert len(nb.cells) == len(convert.parse_marimo_cells(src))
    # run guard / import marimo 头 / @app.cell 装饰器都不进 cell 体
    joined = "\n".join(c.code for c in nb.cells)
    assert "app.run()" not in joined
    assert "@app.cell" not in joined
    assert "marimo.App(" not in nova
    # 头部：PEP723 保留（golden 三个文件都有或都没有；columns/sidebar 有依赖清单）
    if "# /// script" in src:
        assert nb.header_lines[0] == "# /// script"
    for c in nb.cells:
        assert len(c.id) == 8 and all(ch in "0123456789abcdef" for ch in c.id)


def test_golden_columns_app_width_mapped_to_config():
    nova = convert.marimo_to_novalab(_golden("marimo_golden_columns.py"))
    nb = serialize.parse(nova)
    assert nb.config.get("width") == "columns"
    # 逆向还原
    back = convert.novalab_to_marimo(nova)
    assert 'width="columns"' in back


def test_golden_sidebar_topo_reorders_import_cell_first():
    """sidebar.py 里 `import marimo as mo` cell 在文件末尾，拓扑序应排到引用者之前。"""
    nova = convert.marimo_to_novalab(_golden("marimo_golden_sidebar.py"))
    nb = serialize.parse(nova)
    codes = [c.code for c in nb.cells]
    mo_idx = next(i for i, c in enumerate(codes) if "import marimo as mo" in c)
    users = [i for i, c in enumerate(codes) if "mo.md(" in c or "mo.ui." in c]
    assert users and all(mo_idx < u for u in users)


def test_golden_columns_async_cell_preserved():
    """columns.py 含 async def cell（micropip）→ nova 体保留 await，逆转换恢复 async def。"""
    nova = convert.marimo_to_novalab(_golden("marimo_golden_columns.py"))
    assert "await micropip.install" in nova
    back = convert.novalab_to_marimo(nova)
    assert "async def _(" in back
    _compiles(back)


# --------------------------------------------------------------- 手写边角 1：副作用 cell

SIDE_EFFECT_MARIMO = """\
import marimo

__generated_with = "0.25.1"
app = marimo.App()


@app.cell
def _():
    import pandas as pd

    return (pd,)


@app.cell(hide_code=True)
def _(pd):
    # 副作用 cell：写文件、无 return、无 defs
    df = pd.DataFrame({"a": [1]})
    df.to_csv("out.csv", index=False)
    return


@app.cell
def _(pd):
    n = len(pd.DataFrame())
    return (n,)


if __name__ == "__main__":
    app.run()
"""


def test_side_effect_cell_no_return():
    cells = convert.parse_marimo_cells(SIDE_EFFECT_MARIMO)
    se = [c for c in cells if "to_csv" in c.body][0]
    assert se.defs == [] and se.refs == ["pd"]
    assert se.config == {"hide_code": "True"}
    nova = convert.marimo_to_novalab(SIDE_EFFECT_MARIMO)
    nb = serialize.parse(nova)
    se_code = [c.code for c in nb.cells if "to_csv" in c.code][0]
    a = dag.analyze_cell("x", se_code)
    # NovaLab 语义：体内赋值 df 是 cell-local def（无下游引用则无碍）
    assert a.refs == {"pd"} and "df" in a.defs
    # 逆转换：有 defs（df）→ return (df,)；副作用行保留
    back = convert.novalab_to_marimo(nova)
    assert 'df.to_csv("out.csv", index=False)' in back
    _compiles(back)


# --------------------------------------------------------------- 手写边角 2：walrus / 嵌套 def/class

WALRUS_NESTED_MARIMO = """\
import marimo

app = marimo.App(app_title="Edges")


@app.cell
def _():
    items = [3, 1, 2]
    return (items,)


@app.cell
def _(items):
    # walrus 进 defs
    if (n := len(items)) > 2:
        head = items[:n]
    return (head, n)


@app.cell
def _():
    class Greeter:
        def hello(self):
            return "hi"

    def make():
        def inner():  # 嵌套 def 不应泄漏为 cell def
            secret = 1
            return secret
        return inner

    return (Greeter, make)


if __name__ == "__main__":
    app.run()
"""


def test_walrus_in_defs():
    cells = convert.parse_marimo_cells(WALRUS_NESTED_MARIMO)
    w = [c for c in cells if "(n :=" in c.body][0]
    assert set(w.defs) == {"head", "n"}
    nova = convert.marimo_to_novalab(WALRUS_NESTED_MARIMO)
    nb = serialize.parse(nova)
    wcode = [c.code for c in nb.cells if "(n :=" in c.code][0]
    a = dag.analyze_cell("x", wcode)
    assert {"n", "head"} <= a.defs and a.refs == {"items"}
    back = convert.novalab_to_marimo(nova)
    assert "return (head, n)" in back
    _compiles(back)


def test_nested_def_class_do_not_leak():
    nova = convert.marimo_to_novalab(WALRUS_NESTED_MARIMO)
    nb = serialize.parse(nova)
    code = [c.code for c in nb.cells if "class Greeter" in c.code][0]
    a = dag.analyze_cell("x", code)
    # 与 dag.py 一致：只有顶层绑定是 defs；inner/secret/hello 不泄漏
    assert a.defs == {"Greeter", "make"}
    back = convert.novalab_to_marimo(nova)
    assert "return (Greeter, make)" in back
    _compiles(back)


def test_app_title_maps_to_config():
    nova = convert.marimo_to_novalab(WALRUS_NESTED_MARIMO)
    nb = serialize.parse(nova)
    assert nb.config.get("app_title") == "Edges"
    back = convert.novalab_to_marimo(nova)
    assert 'app_title="Edges"' in back
    assert 'superapp_mode="off"' in back  # 保守配置


# --------------------------------------------------------------- 结构 / CLI / 降级

def test_novalab_to_marimo_shape():
    src = serialize.write(
        [
            serialize.Cell("aaaaaaaa", "import marimo as mo"),
            serialize.Cell("bbbbbbbb", "mo.md('# hi')"),
            serialize.Cell("cccccccc", "x = 1\ny = x + 1"),
        ],
        config={"width": "medium"},
    )
    out = convert.novalab_to_marimo(src)
    _compiles(out)  # 合法 Python（compile 级）
    assert "\nimport marimo\n" in out
    assert 'app = marimo.App(width="medium", superapp_mode="off")' in out
    assert out.rstrip().endswith('if __name__ == "__main__":\n    app.run()')
    # 无 defs 的 cell（md cell）省略 return
    md_block = out.split("@app.cell")[2]
    assert "return" not in md_block
    # defs cell：排序 return 元组；import cell → 普通 cell
    assert "return (mo,)" in out
    assert "return (x, y)" in out
    cells = convert.parse_marimo_cells(out)
    assert len(cells) == 3
    assert cells[2].defs == ["x", "y"] and cells[2].refs == []


def test_empty_cell_emits_pass():
    src = serialize.write([serialize.Cell("aaaaaaaa", "")])
    out = convert.novalab_to_marimo(src)
    _compiles(out)
    assert "    pass" in out


def test_app_function_becomes_cell():
    src = """\
import marimo

app = marimo.App()


@app.function
def helper(x):
    return x * 2


@app.cell
def _(helper):
    y = helper(3)
    return (y,)
"""
    cells = convert.parse_marimo_cells(src)
    kinds = [c.kind for c in cells]
    assert "function" in kinds and "cell" in kinds
    nova = convert.marimo_to_novalab(src)
    assert "def helper(x):" in nova  # app 级函数成为普通 cell
    nb = serialize.parse(nova)
    assert len(nb.cells) == 2
    back = convert.novalab_to_marimo(nova)
    _compiles(back)


def test_unparsable_cell_kept():
    src = (
        "import marimo\n\napp = marimo.App()\n\n"
        'app._unparsable_cell(r"""x === 1""")\n\n\n'
        'if __name__ == "__main__":\n    app.run()\n'
    )
    cells = convert.parse_marimo_cells(src)
    assert cells[0].kind == "unparsable"
    assert cells[0].body == "x === 1"
    nova = convert.marimo_to_novalab(src)
    assert "x === 1" in nova
    back = convert.novalab_to_marimo(nova)  # 语法错误 cell 仍按普通 cell emit
    assert "x === 1" in back


def test_cli_to_nova_and_back(tmp_path):
    src = tmp_path / "in.py"
    src.write_text(_golden("marimo_golden_basics.py"), encoding="utf-8")
    mid = tmp_path / "mid.py"
    out = tmp_path / "out.py"
    assert convert.main(["to-nova", str(src), str(mid)]) == 0
    text = mid.read_text(encoding="utf-8")
    assert "# %% [cell-id:" in text
    assert convert.main(["to-marimo", str(mid), str(out)]) == 0
    _compiles(out.read_text(encoding="utf-8"))
    with pytest.raises(SystemExit):
        convert.main(["bad-mode", str(src), str(mid)])  # type: ignore[list-item]


def test_stray_top_level_code_becomes_cell():
    src = """\
import marimo

app = marimo.App()

CONST = 41


@app.cell
def _(CONST):
    v = CONST + 1
    return (v,)
"""
    nb = serialize.parse(convert.marimo_to_novalab(src))
    codes = [c.code for c in nb.cells]
    assert any("CONST = 41" in c for c in codes)
    # 拓扑：CONST cell 在 v cell 之前
    assert codes.index(next(c for c in codes if "CONST = 41" in c)) < codes.index(
        next(c for c in codes if "v = CONST + 1" in c)
    )


def test_non_marimo_raises_valueerror():
    with pytest.raises(ValueError):
        convert.marimo_to_novalab("x = 1\nprint(x)\n")
    # 有 @app.cell 字样但非真 marimo（无 App 头）同样拒绝
    with pytest.raises(ValueError):
        convert.marimo_to_novalab('S = """\n@app.cell\n"""\n')
