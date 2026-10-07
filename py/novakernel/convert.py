"""convert.py — marimo ↔ NovaLab .py 双向转换器（P3.6，spike-s1-memo §5 / spec §4）。

真 marimo 磁盘格式：``app = marimo.App(...)`` 头 + ``@app.cell`` 装饰的 ``def _(refs):``
函数体 + 尾部 ``return (defs,)``；文件内**无 cell id**。NovaLab 格式：PEP723 头 +
``# [novalab]`` 配置行 + ``# %% [cell-id: 8hex]`` 块（serialize.py）。

映射规则（marimo → NovaLab）：

- refs = cell 函数参数；defs = 尾部 return 的名字（``return (x,)`` / ``return x,`` /
  裸 ``return``（副作用 cell，无 defs）三态均支持）；return 语句从代码体剥离
  （模块层 return 是 SyntaxError）；
- 代码体 = 函数体源码去 4 缩进（含首语句前的注释行；体即代码，**不剥 docstring**——
  marimo 里首行字符串表达式是合法输出）；
- cell 顺序 = 依赖拓扑排序（dag.build_graph 的稳定 Kahn，并列按文档序；环时退回文档序）；
  setup 块（``with app.setup:``）强制排第一；
- cell id：marimo 不落盘 → 重新生成 8hex；
- 头部：PEP723 块原样保留；``App(width=..., app_title=...)`` → ``# [novalab]`` 键；
  其余 App kwargs → ``# [marimo-app] k=v`` 注释行保留（逆向时还原为 App kwargs）；
  ``__generated_with`` 版本戳丢弃；``if __name__ == "__main__": app.run()`` 尾块丢弃；
- ``@app.function`` / ``@app.class_definition`` → 整个 def 源码成为普通 cell；
  ``app._unparsable_cell(r'''...''')`` → 字符串内容成为 cell（可能带语法错误，宽容）；
- ``async def`` cell：NovaLab 格式无 async 槽位 → 降级为同步体；逆向（→marimo）时
  按"体含顶层 await"自动恢复 ``async def``。

已知不可逆点（详见 P3.6 报告）：cell id、cell 级配置（hide_code/column/disabled/
expand_output）、``__generated_with``、cell 间游离注释、return 元组中的非 Name 元素、
声明 defs 与体内全部赋值的差异（NovaLab 语义：所有赋值都是 defs）。

CLI：``python -m novakernel.convert {to-nova|to-marimo} IN OUT``。
"""

from __future__ import annotations

import ast
import re
import sys
from dataclasses import dataclass, field

from . import dag, serialize

__all__ = [
    "MarimoCell",
    "MarimoNotebook",
    "analyze_cell_tolerant",
    "main",
    "marimo_to_novalab",
    "novalab_to_marimo",
    "parse_marimo",
    "parse_marimo_cells",
    "topological_sort",
]

# 直接映射进 # [novalab] 的 App 配置键；其余进 # [marimo-app] 注释保留
_APP_KNOWN_KEYS = ("width", "app_title")
# novalab→marimo 的版本戳（对齐 refs/marimo pin 0.25.1）
GENERATED_WITH = "0.25.1"
# 保守配置（marimo 对未知 App kwargs 告警丢弃，app.py:244-248，文件仍可加载）
_CONSERVATIVE_APP_KWARGS = 'superapp_mode="off"'

_MARIMO_APP_COMMENT_RE = re.compile(r"^# \[marimo-app\] (\w+)=(.+?)\s*$")


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class MarimoCell:
    kind: str = "cell"          # cell | setup | function | class_definition | unparsable | stray
    is_async: bool = False
    func_name: str = "_"
    refs: list[str] = field(default_factory=list)   # 声明的 refs = 函数参数
    defs: list[str] = field(default_factory=list)   # 声明的 defs = return 元组名字
    config: dict[str, str] = field(default_factory=dict)  # 装饰器 kwargs（源码形式）
    body: str = ""              # 已 dedent、已剥尾部 return、首尾换行已 strip


@dataclass
class MarimoNotebook:
    header_lines: list[str] = field(default_factory=list)   # 前导注释（PEP723 等）
    app_config: dict[str, str] = field(default_factory=dict)  # App kwargs（unparse 源码）
    has_app: bool = False
    generated_with: str | None = None
    cells: list[MarimoCell] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 源码行工具
# ---------------------------------------------------------------------------

def _dedent_lines(lines: list[str], n: int) -> list[str]:
    """每行剥去恰好 n 个前导空格；空行保持空；不足 n 的行（多行字符串内部）原样保留。"""
    pad = " " * n
    out: list[str] = []
    for ln in lines:
        if ln.startswith(pad):
            out.append(ln[n:])
        elif not ln.strip():
            out.append("")
        else:
            out.append(ln)
    return out


def _stmt_first_line(stmt: ast.AST) -> int:
    """语句起始行（1-based），计入装饰器行。"""
    starts = [stmt.lineno]
    for d in getattr(stmt, "decorator_list", []):
        starts.append(d.lineno)
    return min(starts)


def _extract_func_body(
    lines: list[str], func: ast.FunctionDef | ast.AsyncFunctionDef
) -> tuple[str, list[str]]:
    """提取函数体源码（dedent、剥尾部 return、回收首语句前注释行）。

    返回 (body_code, declared_defs)。
    """
    stmts = list(func.body)
    defs: list[str] = []
    if stmts and isinstance(stmts[-1], ast.Return):
        ret = stmts.pop()
        v = ret.value
        if v is None:
            names: list[ast.expr] = []
        elif isinstance(v, ast.Tuple):
            names = list(v.elts)
        else:
            names = [v]  # 手写 `return x`
        for e in names:
            if isinstance(e, ast.Name):
                defs.append(e.id)
            # 非 Name 元素（marimo codegen 不产生）：丢弃，见不可逆点
    if not stmts:
        return "", defs

    start = _stmt_first_line(stmts[0])
    idx = start - 1  # 0-based
    # 回收首语句（含其装饰器）之前的注释/空行；def 头行非注释非空 → 自然止步
    while idx > 0:
        prev = lines[idx - 1]
        if prev.strip().startswith("#") or not prev.strip():
            idx -= 1
        else:
            break
    end = stmts[-1].end_lineno or start
    seg = lines[idx:end]
    code = "\n".join(_dedent_lines(seg, stmts[0].col_offset)).strip("\n")
    return code, defs


# ---------------------------------------------------------------------------
# marimo 解析
# ---------------------------------------------------------------------------

def _deco_info(d: ast.expr) -> tuple[str, dict[str, str]] | None:
    """``@app.cell`` / ``@app.cell(kw=...)`` → ("cell", kwargs)；其他 → None。"""
    node: ast.expr = d
    kwargs: dict[str, str] = {}
    if isinstance(d, ast.Call):
        node = d.func
        for kw in d.keywords:
            if kw.arg:
                kwargs[kw.arg] = ast.unparse(kw.value)
    if (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "app"
    ):
        return node.attr, kwargs
    return None


def _is_app_attr(e: ast.expr, attr: str) -> bool:
    return (
        isinstance(e, ast.Attribute)
        and e.attr == attr
        and isinstance(e.value, ast.Name)
        and e.value.id == "app"
    )


def _is_run_guard(stmt: ast.AST) -> bool:
    """``if __name__ == "__main__": app.run()`` 尾块。"""
    if not isinstance(stmt, ast.If):
        return False
    t = stmt.test
    return (
        isinstance(t, ast.Compare)
        and len(t.ops) == 1
        and isinstance(t.ops[0], ast.Eq)
        and (
            (isinstance(t.left, ast.Name) and t.left.id == "__name__")
            or (len(t.comparators) == 1 and isinstance(t.comparators[0], ast.Name)
                and t.comparators[0].id == "__name__")
        )
    )


def _func_refs(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    a = func.args
    return [x.arg for x in list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs)]


def parse_marimo(src: str) -> MarimoNotebook:
    """AST 解析真 marimo .py → MarimoNotebook（cells 按文档序）。

    非 marimo 文件也能"尽力"解析：无 @app.cell 时 top-level 游离语句成为 stray cell。
    语法错误直接抛 SyntaxError（调用方 serialize.parse 捕获后降级单 cell）。
    """
    lines = src.split("\n")

    # 前导注释/空行 = 头部（PEP723 块整体是注释行）
    header: list[str] = []
    for ln in lines:
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            header.append(ln)
        else:
            break

    tree = ast.parse(src)
    nb = MarimoNotebook(header_lines=header)

    def _setup_or_stray_body(stmts: list[ast.stmt], kind: str) -> MarimoCell:
        start = _stmt_first_line(stmts[0])
        idx = start - 1
        while idx > 0:
            prev = lines[idx - 1]
            if prev.strip().startswith("#") or not prev.strip():
                idx -= 1
            else:
                break
        end = stmts[-1].end_lineno or start
        seg = lines[idx:end]
        code = "\n".join(_dedent_lines(seg, stmts[0].col_offset)).strip("\n")
        return MarimoCell(kind=kind, body=code)

    for stmt in tree.body:
        # @app.cell / @app.function / @app.class_definition 装饰的函数
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.decorator_list:
            info = _deco_info(stmt.decorator_list[0])
            if info is not None:
                name, kwargs = info
                if name == "cell":
                    body, defs = _extract_func_body(lines, stmt)
                    nb.cells.append(MarimoCell(
                        kind="cell",
                        is_async=isinstance(stmt, ast.AsyncFunctionDef),
                        func_name=stmt.name,
                        refs=_func_refs(stmt),
                        defs=defs,
                        config=kwargs,
                        body=body,
                    ))
                    continue
                if name in ("function", "class_definition"):
                    # app 级函数/类定义：整个 def（去掉 @app.* 装饰器行）成为一个 cell
                    rest_deco = stmt.decorator_list[1:]
                    start = min([stmt.lineno] + [d.lineno for d in rest_deco])
                    seg = lines[start - 1:stmt.end_lineno]
                    code = "\n".join(_dedent_lines(seg, stmt.col_offset)).strip("\n")
                    nb.cells.append(MarimoCell(
                        kind=name, func_name=stmt.name,
                        is_async=isinstance(stmt, ast.AsyncFunctionDef), body=code,
                    ))
                    continue
        # app._unparsable_cell(r"""...""")
        if (
            isinstance(stmt, ast.Expr)
            and isinstance(stmt.value, ast.Call)
            and isinstance(stmt.value.func, ast.Attribute)
            and isinstance(stmt.value.func.value, ast.Name)
            and stmt.value.func.value.id == "app"
            and stmt.value.func.attr == "_unparsable_cell"
        ):
            call = stmt.value
            arg0 = call.args[0] if call.args else None
            if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
                code = arg0.value
            else:
                code = ast.unparse(call)
            cfg = {kw.arg: ast.unparse(kw.value) for kw in call.keywords if kw.arg}
            nb.cells.append(MarimoCell(kind="unparsable", config=cfg, body=code.strip("\n")))
            continue
        # with app.setup: → setup cell（拓扑时强制第一）
        if (
            isinstance(stmt, ast.With)
            and len(stmt.items) == 1
            and stmt.items[0].optional_vars is None
            and _is_app_attr(stmt.items[0].context_expr, "setup")
            and stmt.body
        ):
            nb.cells.append(_setup_or_stray_body(stmt.body, "setup"))
            continue
        # app = marimo.App(...) / __generated_with = "..."
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            tname = stmt.targets[0].id
            if tname == "app" and isinstance(stmt.value, ast.Call):
                f = stmt.value.func
                if (
                    isinstance(f, ast.Attribute) and f.attr == "App"
                    and isinstance(f.value, ast.Name) and f.value.id == "marimo"
                ):
                    nb.has_app = True
                    for kw in stmt.value.keywords:
                        if kw.arg:
                            nb.app_config[kw.arg] = ast.unparse(kw.value)
                    continue
            if tname == "__generated_with" and isinstance(stmt.value, ast.Constant):
                nb.generated_with = str(stmt.value.value)
                continue
        # run guard 丢弃
        if _is_run_guard(stmt):
            continue
        # 顶层 import marimo 丢弃（其他 import → stray cell 保留代码）
        if isinstance(stmt, ast.Import) and all(a.name == "marimo" for a in stmt.names):
            continue
        # 其余 top-level 语句 → stray cell（尽力不丢代码）
        seg = lines[_stmt_first_line(stmt) - 1:stmt.end_lineno]
        nb.cells.append(MarimoCell(kind="stray", body="\n".join(seg).strip("\n")))

    return nb


def parse_marimo_cells(src: str) -> list[MarimoCell]:
    """便捷入口：文档序的 MarimoCell 列表。"""
    return parse_marimo(src).cells


# ---------------------------------------------------------------------------
# async 宽容分析（顶层 await 体：dag.analyze_cell 会 SyntaxError）
# ---------------------------------------------------------------------------

def _parse_top_level_await(code: str) -> ast.Module | None:
    """按"允许顶层 await"解析；失败返回 None。（ast.parse 无 flags 参数 → 用 compile）"""
    try:
        return compile(  # type: ignore[return-value]
            code, "<cell>", "exec",
            ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | ast.PyCF_ONLY_AST,
        )
    except SyntaxError:
        return None


def _has_top_level_await(tree: ast.AST) -> bool:
    """体内是否存在**非嵌套函数内**的 await / async with / async for。

    注意：Python ≥3.8 的 ast.parse 不再拒绝顶层 await（错误推迟到 compile 阶段），
    因此 async 判定必须走 AST 扫描而非"parse 失败"探测。
    """
    stack = list(getattr(tree, "body", []))
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.Await, ast.AsyncWith, ast.AsyncFor)):
            return True
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue  # 嵌套函数内的 await 合法，不使 cell 成为 async
        stack.extend(ast.iter_child_nodes(n))
    return False


def _needs_async_wrap(code: str) -> bool:
    """cell 体是否必须以 ``async def`` 包装（含顶层 await/async with/async for）。"""
    if not code.strip():
        return False
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    return _has_top_level_await(tree)


class _StripAsync(ast.NodeTransformer):
    """顶层 Await → 其操作数；AsyncWith/AsyncFor → 同步等价（仅供 defs/refs 分析）。"""

    def visit_Await(self, node: ast.Await) -> ast.AST:  # noqa: N802
        return self.visit(node.value)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> ast.AST:  # noqa: N802
        new = ast.With(items=node.items, body=node.body)
        return self.generic_visit(ast.copy_location(new, node))

    def visit_AsyncFor(self, node: ast.AsyncFor) -> ast.AST:  # noqa: N802
        new = ast.For(
            target=node.target, iter=node.iter, body=node.body, orelse=node.orelse
        )
        return self.generic_visit(ast.copy_location(new, node))

    # 嵌套函数体内的 await 合法，不深入
    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:  # noqa: N802
        return node

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> ast.AST:  # noqa: N802
        return node

    def visit_Lambda(self, node: ast.Lambda) -> ast.AST:  # noqa: N802
        return node


def analyze_cell_tolerant(cell_id: str, code: str) -> dag.CellAnalysis:
    """dag.analyze_cell + 顶层 await 宽容：async 降级体也能提取 defs/refs。"""
    a = dag.analyze_cell(cell_id, code)
    if a.syntax_error is None:
        return a
    try:
        if not _needs_async_wrap(code):
            return a
        tree = _parse_top_level_await(code)
        if tree is None:
            return a
        tree = _StripAsync().visit(tree)
        ast.fix_missing_locations(tree)
        a2 = dag.analyze_cell(cell_id, ast.unparse(tree))
        return a2 if a2.syntax_error is None else a
    except Exception:
        return a


# ---------------------------------------------------------------------------
# 拓扑排序（refs→defs 边，稳定 Kahn；复用 dag.build_graph）
# ---------------------------------------------------------------------------

def topological_sort(cells: list[MarimoCell]) -> list[MarimoCell]:
    """依赖拓扑排序（并列按文档序）；setup cell 强制第一；有环退回文档序。"""
    setup = [c for c in cells if c.kind == "setup"]
    rest = [c for c in cells if c.kind != "setup"]
    if not rest:
        return setup
    ids = [str(i) for i in range(len(rest))]
    analyses = {ids[i]: analyze_cell_tolerant(ids[i], rest[i].body) for i in range(len(rest))}
    g = dag.build_graph(ids, analyses)
    ordered = rest if g.topo is None else [rest[int(i)] for i in g.topo]
    return setup + ordered


# ---------------------------------------------------------------------------
# marimo → NovaLab
# ---------------------------------------------------------------------------

def _nova_header(nb: MarimoNotebook) -> list[str]:
    header = list(nb.header_lines)
    while header and not header[0].strip():
        header.pop(0)
    while header and not header[-1].strip():
        header.pop()
    if not header:
        header = list(serialize.DEFAULT_HEADER_LINES)

    cfg: dict[str, str] = {}
    extra: list[str] = []
    for k, v in nb.app_config.items():
        val = None
        if k in _APP_KNOWN_KEYS:
            try:
                lit = ast.literal_eval(v)
                if isinstance(lit, str):
                    val = lit
            except (ValueError, SyntaxError):
                val = None
        if val is not None:
            cfg[k] = val
        else:
            extra.append(f"# [marimo-app] {k}={v}")  # 未知键进注释保留
    if cfg:
        header.append(serialize.format_config(cfg))
    header.extend(extra)
    return header


def marimo_to_novalab(src: str) -> str:
    """真 marimo .py → NovaLab .py（拓扑序、新 8hex id）。

    非 marimo 源（无 @app.cell 且无 marimo.App 头）抛 ValueError——调用方
    （serialize.parse 宽容导入分支）据此降级为单 cell。
    """
    nb = parse_marimo(src)
    if not nb.has_app:
        raise ValueError("not a marimo notebook: no `app = marimo.App(...)` header found")
    ordered = topological_sort(nb.cells)
    cells = [serialize.Cell(serialize.new_cell_id(), c.body) for c in ordered]
    return serialize.write(cells, header_lines=_nova_header(nb))


# ---------------------------------------------------------------------------
# NovaLab → marimo
# ---------------------------------------------------------------------------

def novalab_to_marimo(src: str) -> str:
    """NovaLab .py → 真 marimo .py。

    文件序即拓扑序（NovaLab 保存时已保证）；每 cell 的 refs/defs 用 dag.py 重新提取：
    refs → ``def _(refs):`` 参数（排序），defs → ``return (defs,)``（排序；无 defs 省略
    return）；体含顶层 await → ``async def``。id 不落盘（marimo 无 cell id）。
    """
    nb = serialize.parse(src)

    app_kwargs: list[tuple[str, str]] = []
    if "width" in nb.config:
        app_kwargs.append(("width", f'"{nb.config["width"]}"'))
    if "app_title" in nb.config:
        app_kwargs.append(("app_title", f'"{nb.config["app_title"]}"'))
    header_out: list[str] = []
    for ln in nb.header_lines:
        m = _MARIMO_APP_COMMENT_RE.match(ln)
        if m:  # marimo→nova 时保留的未知 App 键 → 还原
            app_kwargs.append((m.group(1), m.group(2).strip()))
            continue
        if serialize.NOVALAB_CONFIG_RE.match(ln):
            continue  # 已映射进 App kwargs / 属 NovaLab 专有配置
        header_out.append(ln)
    while header_out and not header_out[-1].strip():
        header_out.pop()

    out: list[str] = list(header_out)
    if out:
        out.append("")
    out.append("import marimo")
    out.append("")
    out.append(f'__generated_with = "{GENERATED_WITH}"')
    kwargs_src = ", ".join(f"{k}={v}" for k, v in app_kwargs)
    kwargs_src = f"{kwargs_src}, {_CONSERVATIVE_APP_KWARGS}" if kwargs_src else _CONSERVATIVE_APP_KWARGS
    out.append(f"app = marimo.App({kwargs_src})")

    for cell in nb.cells:
        a = analyze_cell_tolerant(cell.id, cell.code)
        refs = sorted(a.refs)
        defs = sorted(a.defs)
        prefix = "async " if _needs_async_wrap(cell.code) else ""
        out.append("")
        out.append("")
        out.append("@app.cell")
        out.append(f"{prefix}def _({', '.join(refs)}):")
        if cell.code.strip():
            out.extend(("    " + ln) if ln else "" for ln in cell.code.split("\n"))
        else:
            out.append("    pass")  # 空 cell：marimo 函数体不能为空
        if defs:
            out.append("")
            tup = f"({defs[0]},)" if len(defs) == 1 else "(" + ", ".join(defs) + ")"
            out.append(f"    return {tup}")

    out.append("")
    out.append("")
    out.append('if __name__ == "__main__":')
    out.append("    app.run()")
    return "\n".join(out).rstrip("\n") + "\n"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    import argparse

    p = argparse.ArgumentParser(
        prog="python -m novakernel.convert",
        description="marimo ↔ NovaLab .py 双向转换器（P3.6）",
    )
    p.add_argument("mode", choices=["to-nova", "to-marimo"])
    p.add_argument("infile", help="输入 .py")
    p.add_argument("outfile", help="输出 .py")
    args = p.parse_args(argv)

    with open(args.infile, "r", encoding="utf-8") as f:  # universal newlines
        src = f.read()
    out = marimo_to_novalab(src) if args.mode == "to-nova" else novalab_to_marimo(src)
    serialize.write_file(args.outfile, out)  # UTF-8 + LF
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
