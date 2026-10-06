"""test_dag.py — AST defs/refs 提取黄金集 + 图构建（spec §5，S2 门验收用例）。"""

from novakernel import dag


def analyze(code: str, cid: str = "aaaaaaaa") -> dag.CellAnalysis:
    return dag.analyze_cell(cid, code)


# ---------------------------------------------------------------- defs 基础

def test_assign_and_local_refs():
    a = analyze("x = 1\ny = x + 2")
    assert a.defs == {"x", "y"}
    assert a.refs == set()  # x 本 cell 已定义 → 不算外部引用


def test_tuple_unpack_with_star():
    a = analyze("a, (b, *c) = f()")
    assert a.defs == {"a", "b", "c"}
    assert a.refs == {"f"}


def test_augassign_counts_as_def():
    a = analyze("n += 1")
    assert a.defs == {"n"}
    assert a.refs == set()  # n 同时是 load，但本 cell 定义 → 减掉


def test_annassign_with_and_without_value():
    a = analyze("x: int = 3\ny: int")
    assert a.defs == {"x", "y"}


def test_for_and_with_targets():
    a = analyze("for i in range(3):\n    pass\nwith open('f') as fh:\n    pass")
    assert a.defs == {"i", "fh"}
    assert a.refs == set()  # range/open 是 builtin


def test_import_variants():
    a = analyze("import a.b\nimport c.d as cd\nfrom e import f\nfrom g import h as i2")
    assert a.defs == {"a", "cd", "f", "i2"}


def test_del_counts_as_def():
    a = analyze("del tmp")
    assert a.defs == {"tmp"}


def test_except_as_binding():
    a = analyze("try:\n    pass\nexcept ValueError as e:\n    err = e")
    assert a.defs == {"e", "err"}
    assert a.refs == set()  # ValueError 是 builtin


def test_function_and_class_defs_with_body_refs():
    code = "def f():\n    x = 1\n    return x + df\nclass C:\n    attr = 1"
    a = analyze(code)
    assert a.defs == {"f", "C"}
    assert a.refs == {"df"}  # 函数体自由变量按运行时语义计 refs；x/attr 是局部


def test_closure_locals_not_refs():
    code = "def outer():\n    x = 1\n    def inner():\n        return x\n    return inner"
    a = analyze(code)
    assert a.defs == {"outer"}
    assert a.refs == set()


def test_global_stmt_in_function_is_cell_def():
    code = "def bump():\n    global counter\n    counter = counter + 1"
    a = analyze(code)
    assert a.defs == {"bump", "counter"}
    assert a.refs == set()


# ---------------------------------------------------------------- lambda / comprehension

def test_lambda_params_not_refs_body_free_vars_are():
    a = analyze("g = lambda a, b=1: a + b + df")
    assert a.defs == {"g"}
    assert a.refs == {"df"}


def test_comprehension_target_does_not_leak():
    a = analyze("ys = [x for x in range(3)]")
    assert a.defs == {"ys"}
    assert "x" not in a.defs and "x" not in a.refs


def test_comprehension_outer_iterable_and_free_vars():
    a = analyze("tot = sum(v * 2 for v in items if v > lo)")
    assert a.defs == {"tot"}
    assert a.refs == {"items", "lo"}


def test_nested_comprehension_scopes():
    a = analyze("m = [[j for j in row] for row in matrix]")
    assert a.defs == {"m"}
    assert a.refs == {"matrix"}


# ---------------------------------------------------------------- walrus

def test_walrus_toplevel_is_def():
    a = analyze("if (n := len(data)) > 3:\n    pass")
    assert a.defs == {"n"}
    assert a.refs == {"data"}


def test_walrus_in_comprehension_leaks_to_cell_defs():
    a = analyze("res = [last := x for x in seq]")
    assert a.defs == {"res", "last"}  # PEP 572：泄漏到包含作用域
    assert a.refs == {"seq"}


def test_walrus_in_lambda_stays_local():
    a = analyze("f = lambda: (y := 2)")
    assert a.defs == {"f"}
    assert "y" not in a.defs and "y" not in a.refs


# ---------------------------------------------------------------- match

def test_match_capture_patterns():
    code = (
        "for p in points:\n"
        "    match p:\n"
        "        case [a, *rest]:\n"
        "            t = a\n"
        "        case {'k': v, **kw}:\n"
        "            t = v\n"
        "        case Point(x=px):\n"
        "            t = px\n"
        "        case _:\n"
        "            t = 0\n"
    )
    a = analyze(code)
    assert a.defs == {"p", "a", "rest", "v", "kw", "px", "t"}
    assert a.refs == {"points", "Point"}
    assert "_" not in a.defs


def test_match_or_and_guard():
    code = "match cmd:\n    case 'run' | 'go':\n        act(cmd)\n    case other if other != 'x':\n        h(other)"
    a = analyze(code)
    assert "other" in a.defs
    assert a.refs == {"cmd", "act", "h"}


# ---------------------------------------------------------------- builtins / 语法错误

def test_builtins_excluded_from_refs():
    a = analyze("print(len([1, 2]))")
    assert a.refs == set()
    assert a.defs == set()


def test_syntax_error_recorded_not_raised():
    a = analyze("def f(:")
    assert a.syntax_error is not None
    assert "SyntaxError" in a.syntax_error
    assert a.defs == set()


def test_underscore_never_def_or_ref():
    a = analyze("for _ in range(3):\n    pass\nprint(_)")
    assert "_" not in a.defs
    assert "_" not in a.refs


# ---------------------------------------------------------------- 图构建

def _graph(cells: list[tuple[str, str]]) -> dag.Graph:
    ids = [cid for cid, _ in cells]
    analyses = {cid: dag.analyze_cell(cid, code) for cid, code in cells}
    return dag.build_graph(ids, analyses)


def test_edges_from_defs_refs():
    g = _graph([("a1", "x = 1"), ("b2", "y = x + 1")])
    assert g.edges == [("a1", "b2")]
    assert g.compile_error is None


def test_multiple_definition_compile_error_names_cells():
    g = _graph([("a1b2c3d4", "df = 1"), ("e5f6a7b8", "df = 2")])
    assert g.compile_error is not None
    assert "df" in g.compile_error
    assert "a1b2c3d4" in g.compile_error and "e5f6a7b8" in g.compile_error


def test_underscore_double_use_is_not_multiple_definition():
    g = _graph([("a1", "for _ in range(3):\n    pass"), ("b2", "for _ in range(4):\n    pass")])
    assert g.compile_error is None


def test_cycle_detected_and_listed():
    g = _graph([("c1", "x = y + 1"), ("c2", "y = x + 1")])
    assert g.topo is None
    assert g.compile_error is not None
    assert "circular" in g.compile_error
    assert "c1" in g.compile_error and "c2" in g.compile_error


def test_topo_order_respects_edges_and_is_stable():
    # 文档序故意与依赖序相反
    g = _graph([("c", "z = x + 1"), ("b", "pass_b = 1"), ("a", "x = 1")])
    assert g.topo is not None
    assert g.topo.index("a") < g.topo.index("c")
    # 稳定：并列按文档序 → b 在 a 前（indeg 均为 0，文档序 b < a）
    assert g.topo == ["b", "a", "c"]


def test_downstream_transitive_closure():
    g = _graph([("a", "x=1"), ("b", "y=x+1"), ("c", "z=y+1"), ("d", "w=2")])
    assert g.downstream({"a"}) == {"b", "c"}
    assert g.downstream({"b"}) == {"c"}
    assert g.downstream({"d"}) == set()


# ---------------------------------------------------------------- 副作用启发式

def test_side_effect_open_write_modes():
    assert dag.detect_side_effect("with open('out.csv', 'w') as f:\n    f.write('x')")
    assert dag.detect_side_effect("f = open('log.txt', mode='a')")
    assert dag.detect_side_effect("open('f', 'r+')")
    assert not dag.detect_side_effect("open('data.csv').read()")
    assert not dag.detect_side_effect("with open('data.csv', 'r') as f:\n    t = f.read()")


def test_side_effect_known_calls():
    assert dag.detect_side_effect("df.to_csv('x.csv')")
    assert dag.detect_side_effect("requests.post(url, json=d)")
    assert dag.detect_side_effect("shutil.rmtree(p)")
    assert dag.detect_side_effect("os.remove(p)")
    assert dag.detect_side_effect("subprocess.run(['ls'])")
    assert dag.detect_side_effect("p.write_text('hi')")
    assert not dag.detect_side_effect("pd.read_csv('x.csv')")
    assert not dag.detect_side_effect("x = df.groupby('a').sum()")
