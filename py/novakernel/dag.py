"""dag.py — AST defs/refs 提取 · Kahn 拓扑排序 · 环/多重定义检测 · 副作用启发式（spec §5）。

作用域语义按 Python 真实规则处理：

- comprehension 拥有独立作用域：target 变量**不**泄漏为 cell defs；
- walrus（NamedExpr）在 comprehension 内按 3.8+ 语义泄漏到最近的非 comprehension 作用域；
- lambda / def 的参数与体内绑定是局部名，不作 defs；函数/lambda/comprehension 体内的
  自由变量读取（运行时解析到 globals）计入 refs（保守近似，与 marimo 行为一致）；
- class body 的绑定是类局部（不作 defs）；嵌套方法解析名字时按 Python 规则跳过类作用域；
- 函数体内 ``global x`` 后的赋值使 x 成为 cell def；
- ``del x`` 计入 defs（spec §5）；
- ``_``（含 match 通配符与惯用丢弃名）永不计为 def，避免多 cell 使用 ``_`` 触发
  假的多重定义编译错误。

近似/限制（记录于最终报告）：
- ``from x import *`` 无法枚举绑定名 → 不产生 defs；
- 装饰器/默认值表达式内的 walrus 不做泄漏分析（极罕见）。
"""

from __future__ import annotations

import ast
import builtins
import heapq
import re
from dataclasses import dataclass, field

__all__ = [
    "CellAnalysis",
    "Graph",
    "analyze_cell",
    "build_graph",
    "detect_side_effect",
    "target_names",
]

_BUILTINS = frozenset(dir(builtins))
# exec 环境注入名，不算外部引用
_IGNORED_REFS = frozenset(
    {"__name__", "__doc__", "__file__", "__builtins__", "__spec__", "__package__", "__loader__"}
)

_TYPEALIAS = getattr(ast, "TypeAlias", None)  # Python 3.12+


# ---------------------------------------------------------------------------
# 名字收集工具
# ---------------------------------------------------------------------------

def target_names(node: ast.AST) -> set[str]:
    """从赋值 target（Name/Tuple/List/Starred 嵌套）收集绑定名。"""
    out: set[str] = set()

    def rec(n: ast.AST) -> None:
        if isinstance(n, ast.Name):
            out.add(n.id)
        elif isinstance(n, (ast.Tuple, ast.List)):
            for e in n.elts:
                rec(e)
        elif isinstance(n, ast.Starred):
            rec(n.value)

    rec(node)
    return out


def _import_binding(alias: ast.alias, dotted_root: bool = True) -> str:
    if alias.asname:
        return alias.asname
    if dotted_root:
        return alias.name.split(".")[0]
    return alias.name


def _collect_scope_locals(
    nodes: list[ast.AST], args: ast.arguments | None = None
) -> tuple[set[str], set[str]]:
    """预收集一个函数/类作用域内的局部绑定名与 global 声明名。

    规则：不深入嵌套的 def/class/lambda（它们是独立作用域，但其**名字**是本作用域局部）；
    深入 comprehension 只为捕获按 PEP 572 泄漏到本作用域的 walrus 目标（comprehension 的
    target 本身不加入）。
    """
    loc: set[str] = set()
    glo: set[str] = set()

    if args is not None:
        for a in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs):
            loc.add(a.arg)
        if args.vararg:
            loc.add(args.vararg.arg)
        if args.kwarg:
            loc.add(args.kwarg.arg)

    def walk(node: ast.AST) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            loc.add(node.name)
            return
        if _TYPEALIAS is not None and isinstance(node, _TYPEALIAS):
            loc.update(target_names(node.name))
            return
        if isinstance(node, ast.Lambda):
            return  # 独立作用域；其中的 walrus 属于 lambda 自己
        if isinstance(node, ast.Global):
            glo.update(node.names)
            return
        if isinstance(node, ast.Nonlocal):
            return
        if isinstance(node, ast.NamedExpr):
            loc.update(target_names(node.target))
            walk(node.value)
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            for g in node.generators:
                walk(g.iter)  # iter/ifs 中的 walrus 泄漏到本作用域
                for c in g.ifs:
                    walk(c)
            for fld in ("elt", "key", "value"):
                sub = getattr(node, fld, None)
                if isinstance(sub, ast.AST):
                    walk(sub)
            return
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            loc.add(node.id)
            return
        if isinstance(node, ast.ExceptHandler):
            if node.name:
                loc.add(node.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)):
            if node.name:
                loc.add(node.name)
        elif isinstance(node, ast.MatchMapping):
            if node.rest:
                loc.add(node.rest)
        elif isinstance(node, ast.arg):
            return
        for child in ast.iter_child_nodes(node):
            walk(child)

    for n in nodes:
        walk(n)
    return loc - glo, glo


# ---------------------------------------------------------------------------
# defs/refs 提取
# ---------------------------------------------------------------------------

class _Scope:
    __slots__ = ("kind", "locals", "global_declared", "parent")

    def __init__(
        self,
        kind: str,  # module | function | class | comprehension
        locals_: set[str],
        parent: "_Scope | None",
        global_declared: set[str] | None = None,
    ) -> None:
        self.kind = kind
        self.locals = locals_
        self.global_declared = global_declared or set()
        self.parent = parent


class _Extractor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.defs: set[str] = set()
        self.refs: set[str] = set()
        self.module = _Scope("module", set(), None)
        self.stack: list[_Scope] = [self.module]

    # -- scope helpers ------------------------------------------------------
    def _push(self, scope: _Scope) -> None:
        self.stack.append(scope)

    def _pop(self) -> None:
        self.stack.pop()

    def _load(self, name: str) -> None:
        # 沿作用域链解析；类作用域仅对其自身语句可见（嵌套 def/comprehension 跳过它）
        start = len(self.stack) - 1
        for i in range(start, -1, -1):
            s = self.stack[i]
            if s.kind == "class" and i != start:
                continue
            if name in s.locals:
                return
        self.refs.add(name)

    def _store(self, name: str) -> None:
        if name == "_":
            return  # 丢弃名：不作 def（见模块 docstring）
        s = self.stack[-1]
        if s.kind == "module":
            self.defs.add(name)
        elif s.kind == "function" and name in s.global_declared:
            self.defs.add(name)  # global 声明 → 实际绑定发生在模块层
        # comprehension target / 普通函数局部 / 类局部：预收集已覆盖，无需动作

    def _delete(self, name: str) -> None:
        if name == "_":
            return
        if self.stack[-1].kind == "module":
            self.defs.add(name)  # spec §5：del 计入 defs

    # -- names / expressions -------------------------------------------------
    def visit_Name(self, node: ast.Name) -> None:  # noqa: N802
        if isinstance(node.ctx, ast.Load):
            self._load(node.id)
        elif isinstance(node.ctx, ast.Store):
            self._store(node.id)
        else:
            self._delete(node.id)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:  # noqa: N802
        # walrus 绑定到最近的非 comprehension 作用域（PEP 572）
        name = node.target.id
        i = len(self.stack) - 1
        while self.stack[i].kind == "comprehension":
            i -= 1
        s = self.stack[i]
        if name != "_":
            if s.kind == "module":
                self.defs.add(name)
            else:
                s.locals.add(name)
        self.visit(node.value)  # 值表达式在当前（可能是 comprehension）作用域求值

    def visit_arg(self, node: ast.arg) -> None:  # noqa: N802
        # 参数名是函数局部（预收集）；注解在外层作用域求值
        if node.annotation:
            self.visit(node.annotation)

    def visit_Lambda(self, node: ast.Lambda) -> None:  # noqa: N802
        self.visit(node.args)  # 默认值在外层作用域求值
        loc, glo = _collect_scope_locals([node.body], node.args)
        self._push(_Scope("function", loc, self.stack[-1], glo))
        self.visit(node.body)
        self._pop()

    def _visit_func(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self._store(node.name)
        for d in node.decorator_list:
            self.visit(d)
        self.visit(node.args)  # 注解/默认值在外层作用域求值
        if node.returns:
            self.visit(node.returns)
        loc, glo = _collect_scope_locals(node.body, node.args)
        self._push(_Scope("function", loc, self.stack[-1], glo))
        for st in node.body:
            self.visit(st)
        self._pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self._visit_func(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self._visit_func(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:  # noqa: N802
        self._store(node.name)
        for d in node.decorator_list:
            self.visit(d)
        for b in node.bases:
            self.visit(b)
        for kw in node.keywords:
            self.visit(kw)
        loc, _ = _collect_scope_locals(node.body)
        self._push(_Scope("class", loc, self.stack[-1]))
        for st in node.body:
            self.visit(st)
        self._pop()

    def _visit_comp(self, node: ast.AST) -> None:
        gens = node.generators  # type: ignore[attr-defined]
        self.visit(gens[0].iter)  # 最外层 iter 在包含作用域求值
        loc: set[str] = set()
        for g in gens:
            loc |= target_names(g.target)
        self._push(_Scope("comprehension", loc, self.stack[-1]))
        self.visit(gens[0].target)
        for c in gens[0].ifs:
            self.visit(c)
        for g in gens[1:]:
            self.visit(g.iter)
            self.visit(g.target)
            for c in g.ifs:
                self.visit(c)
        for fld in ("elt", "key", "value"):
            sub = getattr(node, fld, None)
            if isinstance(sub, ast.AST):
                self.visit(sub)
        self._pop()

    def visit_ListComp(self, node: ast.ListComp) -> None:  # noqa: N802
        self._visit_comp(node)

    def visit_SetComp(self, node: ast.SetComp) -> None:  # noqa: N802
        self._visit_comp(node)

    def visit_DictComp(self, node: ast.DictComp) -> None:  # noqa: N802
        self._visit_comp(node)

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:  # noqa: N802
        self._visit_comp(node)

    # -- imports / handlers ---------------------------------------------------
    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        for a in node.names:
            self._store(_import_binding(a, dotted_root=True))

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        for a in node.names:
            if a.name == "*":
                continue  # 无法枚举绑定名（限制，见 docstring）
            self._store(_import_binding(a, dotted_root=False))

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:  # noqa: N802
        if node.type:
            self.visit(node.type)
        if node.name:
            self._store(node.name)
        for st in node.body:
            self.visit(st)

    # -- match (3.10+) ---------------------------------------------------------
    def visit_Match(self, node: ast.Match) -> None:  # noqa: N802
        self.visit(node.subject)
        for case in node.cases:
            self._walk_pattern(case.pattern)
            if case.guard:
                self.visit(case.guard)
            for st in case.body:
                self.visit(st)

    def _walk_pattern(self, p: ast.AST | None) -> None:
        if p is None:
            return
        if isinstance(p, ast.MatchValue):
            self.visit(p.value)  # Name/Attribute Load，如 case Color.RED
        elif isinstance(p, ast.MatchSingleton):
            pass
        elif isinstance(p, ast.MatchSequence):
            for sub in p.patterns:
                self._walk_pattern(sub)
        elif isinstance(p, ast.MatchMapping):
            for k in p.keys:
                self.visit(k)
            for sub in p.patterns:
                self._walk_pattern(sub)
            if p.rest:
                self._store(p.rest)
        elif isinstance(p, ast.MatchClass):
            self.visit(p.cls)
            for sub in p.patterns:
                self._walk_pattern(sub)
            for sub in p.kwd_patterns:
                self._walk_pattern(sub)
        elif isinstance(p, ast.MatchStar):
            if p.name and p.name != "_":
                self._store(p.name)
        elif isinstance(p, ast.MatchAs):
            if p.name and not (p.name == "_" and p.pattern is None):
                self._store(p.name)
            if p.pattern:
                self._walk_pattern(p.pattern)
        elif isinstance(p, ast.MatchOr):
            for sub in p.patterns:
                self._walk_pattern(sub)


@dataclass
class CellAnalysis:
    cell_id: str
    defs: set[str] = field(default_factory=set)
    refs: set[str] = field(default_factory=set)
    syntax_error: str | None = None


def analyze_cell(cell_id: str, code: str) -> CellAnalysis:
    """提取单个 cell 的 defs/refs；语法错误不抛出，记入 syntax_error。"""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return CellAnalysis(
            cell_id=cell_id,
            syntax_error=f"cell {cell_id}: SyntaxError: {e.msg} (line {e.lineno})",
        )
    ex = _Extractor()
    for st in tree.body:
        ex.visit(st)
    defs = {d for d in ex.defs if d != "_"}
    refs = {
        r
        for r in ex.refs
        if r not in defs and r != "_" and r not in _BUILTINS and r not in _IGNORED_REFS
    }
    return CellAnalysis(cell_id=cell_id, defs=defs, refs=refs)


# ---------------------------------------------------------------------------
# 图构建：边 / Kahn 拓扑 / 环 / 多重定义
# ---------------------------------------------------------------------------

@dataclass
class Graph:
    order_ids: list[str]                       # 文档顺序
    defs: dict[str, set[str]]
    refs: dict[str, set[str]]
    edges: list[tuple[str, str]]               # (definer, referencer)
    adj: dict[str, list[str]]
    parents: dict[str, set[str]]
    topo: list[str] | None                     # None = 存在环
    compile_error: str | None
    definer: dict[str, str]                    # name → 唯一定义 cell

    def downstream(self, ids: set[str]) -> set[str]:
        """传递闭包：ids 的全部（真）下游。"""
        seen: set[str] = set()
        dq = [i for i in ids if i in self.adj]
        while dq:
            u = dq.pop()
            for v in self.adj.get(u, ()):
                if v not in seen:
                    seen.add(v)
                    dq.append(v)
        return seen


def _find_cycle(nodes: list[str], adj: dict[str, list[str]]) -> list[str]:
    """在残留子图中找一个环，返回如 [a, b, c, a]。"""
    color = {n: 0 for n in nodes}  # 0 白 1 灰 2 黑
    path: list[str] = []

    def dfs(u: str) -> list[str] | None:
        color[u] = 1
        path.append(u)
        for v in adj.get(u, ()):
            if v not in color:
                continue
            if color[v] == 1:
                return path[path.index(v):] + [v]
            if color[v] == 0:
                found = dfs(v)
                if found:
                    return found
        path.pop()
        color[u] = 2
        return None

    for n in nodes:
        if color[n] == 0:
            cyc = dfs(n)
            if cyc:
                return cyc
    return list(nodes[:1])


def build_graph(order_ids: list[str], analyses: dict[str, CellAnalysis]) -> Graph:
    messages: list[str] = []

    # 1) 语法错误（按文档序）
    for cid in order_ids:
        a = analyses[cid]
        if a.syntax_error:
            messages.append(a.syntax_error)

    # 2) 多重定义 = 编译错误（marimo 规则）
    owners: dict[str, list[str]] = {}
    for cid in order_ids:
        for name in analyses[cid].defs:
            owners.setdefault(name, []).append(cid)
    definer: dict[str, str] = {}
    for name, lst in owners.items():
        if len(lst) > 1:
            messages.append(
                f"multiple definitions of '{name}' (cells {', '.join(lst)})"
            )
        else:
            definer[name] = lst[0]

    # 3) 边：refs(c2) ∩ defs(c1)
    defs = {cid: analyses[cid].defs for cid in order_ids}
    refs = {cid: analyses[cid].refs for cid in order_ids}
    idx = {cid: i for i, cid in enumerate(order_ids)}
    edge_set: set[tuple[str, str]] = set()
    for c2 in order_ids:
        for name in refs[c2]:
            c1 = definer.get(name)
            if c1 is not None and c1 != c2:
                edge_set.add((c1, c2))
    edges = sorted(edge_set, key=lambda e: (idx[e[0]], idx[e[1]]))

    adj: dict[str, list[str]] = {cid: [] for cid in order_ids}
    parents: dict[str, set[str]] = {cid: set() for cid in order_ids}
    for a, b in edges:
        adj[a].append(b)
        parents[b].add(a)

    # 4) Kahn 拓扑（稳定：并列时按文档序）
    indeg = {cid: len(parents[cid]) for cid in order_ids}
    heap = [(idx[cid], cid) for cid in order_ids if indeg[cid] == 0]
    heapq.heapify(heap)
    topo: list[str] = []
    while heap:
        _, u = heapq.heappop(heap)
        topo.append(u)
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                heapq.heappush(heap, (idx[v], v))

    if len(topo) < len(order_ids):
        remaining = [cid for cid in order_ids if indeg[cid] > 0]
        sub_adj = {u: [v for v in adj[u] if indeg[v] > 0] for u in remaining}
        cycle = _find_cycle(remaining, sub_adj)
        messages.append("circular dependency: " + " -> ".join(cycle))
        topo = None

    return Graph(
        order_ids=list(order_ids),
        defs=defs,
        refs=refs,
        edges=edges,
        adj=adj,
        parents=parents,
        topo=topo,
        compile_error="\n".join(messages) if messages else None,
        definer=definer,
    )


# ---------------------------------------------------------------------------
# 副作用启发式（spec §5：副作用 cell 默认不进 auto-cascade）
# ---------------------------------------------------------------------------

_SIDE_EFFECT_RE = re.compile(
    r"\.(?:to_csv|to_parquet|to_excel|to_sql|to_pickle|to_hdf|to_feather"
    r"|write_text|write_bytes|unlink|rmdir|mkdir|makedirs)\s*\("
    r"|\b(?:requests|httpx|session|sess|client)\s*\.\s*(?:post|put|delete|patch)\s*\("
    r"|\bshutil\s*\.\s*(?:rmtree|move|copy|copy2|copyfile|copytree|chown)\s*\("
    r"|\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs|rename|replace|mkdir|makedirs|system)\s*\("
    r"|\bsubprocess\s*\.\s*(?:run|call|check_call|check_output|Popen)\s*\("
)

_WRITE_MODE_CHARS = frozenset("wax+")


def _open_mode(node: ast.Call) -> str | None:
    if len(node.args) >= 2:
        m = node.args[1]
        if isinstance(m, ast.Constant) and isinstance(m.value, str):
            return m.value
    for kw in node.keywords:
        if kw.arg == "mode" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
            return kw.value.value
    return None


def detect_side_effect(code: str) -> bool:
    """启发式：写文件 / 网络写请求 / 删除 / 子进程 → True。"""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return bool(_SIDE_EFFECT_RE.search(code))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            fname = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else None)
            if fname == "open":
                mode = _open_mode(node)
                if mode and any(ch in _WRITE_MODE_CHARS for ch in mode):
                    return True
    return bool(_SIDE_EFFECT_RE.search(code))
