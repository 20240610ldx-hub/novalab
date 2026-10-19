"""shadow.py — ADR-013 影子执行核心（S0–S2）。

影子内核是独立进程（见 shadow_server.py），从源码按 DAG 重放上游闭包（方案 C），
再执行候选闭包；用户内核与工作区不被触碰。本模块提供：

- 摘要器（第 0 层 M5 闸）：只**构造** schema + 汇总统计，不出任何行、不出 head(1)、
  不出分类标签；非空计数 < k 的列只给 count/nullCount（小格抑制，O4 = k 10）；
  标量与字符串只给类型（单个值可能就是一条原始记录）。
- traceback 脱敏：异常消息里不在 cell 源码中出现的引号字面量替换为 '<value>'，
  库路径缩短为 <lib>/…，链上有 ShadowSandboxError 时报告它。
- 闭包规划：changed ∪ downstream(changed) 为闭包，其祖先为上游；上游先于闭包执行
  （上游节点不依赖闭包节点，否则它们本身就在闭包内）。
- 非确定性检测（AST）：未设种子的 RNG、墙钟、熵源。
- 声明式契约求值：只返回状态与计数（total / violations / maxAbsDiff），不回显值。
- 沙箱：进程级审计钩子（PEP 578，**防误伤不防恶意**）。scratch 目录外的写入、删除、
  改名，全部网络，子进程，注册表写入，向其他进程发信号一律拒绝（O3）。
- OS 级内存上限：Windows Job Object（ProcessMemoryLimit + ActiveProcessLimit=1），
  POSIX RLIMIT_AS；生效值从 OS 读回（O2 = min(4 GiB, 物理内存 × 40%) 由 bridge 计算）。
- ShadowSession：按变体（baseline 'before' + N 个候选）执行并保留命名空间供 verify。
  变体列表即"一个候选 × N 组参数"的扫描接口（Owner 2026-10-17 后续功能）。
"""

from __future__ import annotations

import ast
import builtins as _builtins_mod
import contextlib
import gc
import io
import math
import os
import random
import re
import sys
import time
import traceback as tbmod
from typing import Any

from . import dag

__all__ = [
    "ShadowSandboxError",
    "ShadowSession",
    "Sandbox",
    "apply_memory_limit",
    "auto_checks",
    "delta",
    "detect_nondeterminism",
    "evaluate_contracts",
    "plan_baseline",
    "plan_variant",
    "scrub_traceback",
    "summarize_namespace",
    "summarize_value",
]

K_DEFAULT = 10
MAX_COLUMNS = 50
MAX_SCHEMA_COLUMNS = 200
MAX_VARS = 20
TRACEBACK_LIMIT = 8192
MESSAGE_LIMIT = 2000
_QUANTILES = (("p05", 0.05), ("p50", 0.5), ("p95", 0.95))
_INT_KEYS = frozenset({"count", "nullCount", "nUnique"})
_THIS_FILE = os.path.normcase(os.path.abspath(__file__))


# ===================================================================== summarizer


def _r4(x: Any) -> float | None:
    """4 位有效数字；NaN/Inf → None（调用方丢弃该键，保证 JSON-safe）。"""
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    if f == 0:
        return 0.0
    return float(f"{f:.4g}")


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


def _type_name(v: Any) -> str:
    return type(v).__name__


def _is_frame(v: Any) -> bool:
    return (
        not isinstance(v, type)
        and hasattr(v, "columns")
        and hasattr(v, "dtypes")
        and hasattr(v, "iloc")
        and hasattr(v, "shape")
    )


def _is_series(v: Any) -> bool:
    t = type(v)
    return (t.__module__ or "").startswith(("pandas", "geopandas")) and t.__name__ in ("Series", "GeoSeries")


def _is_ndarray(v: Any) -> bool:
    t = type(v)
    return t.__module__ == "numpy" and t.__name__ == "ndarray"


def _numeric_series(s: Any) -> bool:
    import pandas.api.types as pt  # s 是 pandas 对象：pandas 已导入

    return bool(pt.is_numeric_dtype(s.dtype)) and not bool(pt.is_bool_dtype(s.dtype))


def _numeric_stats(vals: Any) -> dict:
    """vals: 已去空的 float numpy 数组（非空）。"""
    import numpy as np

    out: dict = {
        "sum": _r4(vals.sum()),
        "mean": _r4(vals.mean()),
        "std": _r4(vals.std(ddof=1)) if vals.size > 1 else None,
        "min": _r4(vals.min()),
        "max": _r4(vals.max()),
    }
    with np.errstate(all="ignore"):
        for key, q in _QUANTILES:
            out[key] = _r4(np.quantile(vals, q))
    return _clean(out)


def _series_stats(s: Any, k: int) -> dict:
    n = int(len(s))
    nulls = int(s.isna().sum())
    count = n - nulls
    out: dict = {"count": count, "nullCount": nulls}
    if count < k:
        out["suppressed"] = True
        return out
    if _numeric_series(s):
        try:
            vals = s.dropna().to_numpy(dtype=float)
            out.update(_numeric_stats(vals))
        except (TypeError, ValueError):
            pass
    else:
        try:
            out["nUnique"] = int(s.nunique(dropna=True))
        except TypeError:  # 不可哈希元素（list/dict 单元格）
            pass
    return out


def _array_stats(arr: Any, k: int) -> dict:
    import numpy as np

    if arr.dtype.kind in "iuf":
        flat = np.asarray(arr, dtype=float).ravel()
        mask = np.isnan(flat)
        nulls = int(mask.sum())
        vals = flat[~mask]
        out: dict = {"count": int(vals.size), "nullCount": nulls}
        if vals.size < k:
            out["suppressed"] = True
            return out
        out.update(_numeric_stats(vals))
        return out
    return {"count": int(arr.size), "nullCount": 0}


def summarize_value(value: Any, *, k: int = K_DEFAULT, max_columns: int = MAX_COLUMNS) -> dict:
    """单个变量的 M5 摘要 {schema, stats?}；永不包含行、预览或分类标签。"""
    if _is_frame(value):
        cols = list(value.columns)
        schema: dict = {
            "type": _type_name(value),
            "shape": [int(x) for x in value.shape],
            "columns": [str(c) for c in cols[:MAX_SCHEMA_COLUMNS]],
            "dtypes": {str(c): str(dt) for c, dt in list(value.dtypes.items())[:MAX_SCHEMA_COLUMNS]},
        }
        if len(cols) > MAX_SCHEMA_COLUMNS:
            schema["columnsTruncated"] = len(cols) - MAX_SCHEMA_COLUMNS
        stats_cols: dict = {}
        for i, c in enumerate(cols[:max_columns]):
            try:
                stats_cols[str(c)] = _series_stats(value.iloc[:, i], k)
            except Exception:  # noqa: BLE001 — 单列失败只丢该列
                continue
        stats: dict = {"columns": stats_cols}
        if len(cols) > max_columns:
            stats["truncatedColumns"] = len(cols) - max_columns
        return {"schema": schema, "stats": stats}
    if _is_series(value):
        schema = {"type": _type_name(value), "shape": [int(len(value))], "dtype": str(value.dtype)}
        try:
            return {"schema": schema, "stats": {"values": _series_stats(value, k)}}
        except Exception:  # noqa: BLE001
            return {"schema": schema}
    if _is_ndarray(value):
        schema = {"type": "ndarray", "shape": [int(x) for x in value.shape], "dtype": str(value.dtype)}
        try:
            return {"schema": schema, "stats": {"values": _array_stats(value, k)}}
        except Exception:  # noqa: BLE001
            return {"schema": schema}
    if isinstance(value, (bool, int, float, complex)) or (
        (type(value).__module__ or "") == "numpy" and hasattr(value, "item")
    ):
        return {"schema": {"type": _type_name(value)}}
    if isinstance(value, (str, bytes, bytearray)):
        return {"schema": {"type": _type_name(value), "len": len(value)}}
    schema = {"type": _type_name(value)}
    try:
        schema["len"] = int(len(value))  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        pass
    return {"schema": schema}


def _skip_name(name: str, value: Any) -> bool:
    import types

    return name.startswith("_") or isinstance(value, types.ModuleType)


def summarize_namespace(ns: dict, names: list[str] | set[str], *, k: int = K_DEFAULT) -> list[dict]:
    out: list[dict] = []
    for name in sorted(names):
        if name not in ns or _skip_name(name, ns[name]):
            continue
        try:
            out.append({"name": name, **summarize_value(ns[name], k=k)})
        except Exception:  # noqa: BLE001
            out.append({"name": name, "schema": {"type": _type_name(ns[name])}})
        if len(out) >= MAX_VARS:
            break
    return out


def _stat_diff(b: dict, a: dict) -> dict:
    out: dict = {}
    for key, av in a.items():
        bv = b.get(key)
        if key == "suppressed" or not isinstance(av, (int, float)) or not isinstance(bv, (int, float)):
            continue
        if key in _INT_KEYS:
            d = int(av) - int(bv)
            if d:
                out[key] = d
        else:
            d = _r4(float(av) - float(bv))
            if d:
                out[key] = d
    return out


def delta(before: dict, after: dict) -> dict:
    """改前 → 改后：类型、shape、增删列、dtype 变化、统计量差值（只留非零）。"""
    d: dict = {}
    bs, as_ = before.get("schema", {}), after.get("schema", {})
    if bs.get("type") != as_.get("type"):
        d["type"] = {"before": bs.get("type"), "after": as_.get("type")}
    if bs.get("shape") != as_.get("shape") and ("shape" in bs or "shape" in as_):
        d["shape"] = {"before": bs.get("shape"), "after": as_.get("shape")}
    if "columns" in bs and "columns" in as_:
        added = [c for c in as_["columns"] if c not in bs["columns"]]
        removed = [c for c in bs["columns"] if c not in as_["columns"]]
        if added:
            d["columnsAdded"] = added
        if removed:
            d["columnsRemoved"] = removed
        changes = {
            c: {"before": bs["dtypes"][c], "after": as_["dtypes"][c]}
            for c in as_.get("dtypes", {})
            if c in bs.get("dtypes", {}) and bs["dtypes"][c] != as_["dtypes"][c]
        }
        if changes:
            d["dtypeChanges"] = changes
    elif bs.get("dtype") != as_.get("dtype") and "dtype" in as_:
        d["dtypeChanges"] = {"values": {"before": bs.get("dtype"), "after": as_.get("dtype")}}
    bst, ast_ = before.get("stats") or {}, after.get("stats") or {}
    stats: dict = {}
    if "columns" in bst and "columns" in ast_:
        for c, a in ast_["columns"].items():
            if c in bst["columns"]:
                sd = _stat_diff(bst["columns"][c], a)
                if sd:
                    stats[c] = sd
    elif "values" in bst and "values" in ast_:
        sd = _stat_diff(bst["values"], ast_["values"])
        if sd:
            stats["values"] = sd
    if stats:
        d["stats"] = stats
    return d


# ================================================================ traceback scrub

_QUOTED = re.compile(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"")


def _scrub_message(msg: str, source_text: str) -> str:
    def repl(m: re.Match) -> str:
        content = m.group(1) if m.group(1) is not None else m.group(2)
        if content and content in source_text:
            return m.group(0)
        return "'<value>'"

    msg = _QUOTED.sub(repl, msg)
    if len(msg) > MESSAGE_LIMIT:
        msg = msg[:MESSAGE_LIMIT] + "…[truncated]"
    return msg


def _short_path(fn: str) -> str:
    norm = fn.replace("\\", "/")
    marker = "site-packages/"
    i = norm.find(marker)
    if i >= 0:
        return "<lib>/" + norm[i + len(marker):]
    for base in {sys.base_prefix, sys.prefix}:
        b = base.replace("\\", "/").rstrip("/") + "/"
        if norm.startswith(b):
            return "<stdlib>/" + norm[len(b):]
    return os.path.basename(norm) or "<unknown>"


def _report_exc(exc: BaseException) -> BaseException:
    """链上有沙箱拦截时报告它（库可能把 PermissionError 包成别的异常）。"""
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, ShadowSandboxError):
            return cur
        cur = cur.__cause__ or cur.__context__
    return exc


def scrub_traceback(exc: BaseException, sources: dict[str, str]) -> str:
    """脱敏 traceback：cell 帧带源码行，库帧短路径，消息字面量脱敏，8KB 上限。"""
    rep = _report_exc(exc)
    source_text = "\n".join(sources.values())
    lines = ["Traceback (most recent call last):"]
    for fr in tbmod.extract_tb(exc.__traceback__):
        fn = fr.filename
        if not fn.startswith("<") and os.path.normcase(os.path.abspath(fn)) == _THIS_FILE:
            continue  # 影子内部的 exec 帧
        if fn in sources:
            src_lines = sources[fn].splitlines()
            src = src_lines[fr.lineno - 1].strip() if fr.lineno and 1 <= fr.lineno <= len(src_lines) else ""
            disp = fn
        else:
            src = ""  # 非 cell 帧只给位置：源码行可能来自工作区里任意文件
            disp = _short_path(fn)
        lines.append(f'  File "{disp}", line {fr.lineno}, in {fr.name}')
        if src:
            lines.append(f"    {src}")
    msg = _scrub_message(str(rep), source_text)
    lines.append(f"{type(rep).__name__}: {msg}" if msg else type(rep).__name__)
    text = "\n".join(lines)
    if len(text) > TRACEBACK_LIMIT:
        text = text[:TRACEBACK_LIMIT] + "…[truncated]"
    return text


# ===================================================================== planning


def _graph(cells: list[dict]) -> dag.Graph:
    analyses = {c["id"]: dag.analyze_cell(c["id"], c["code"]) for c in cells}
    return dag.build_graph([c["id"] for c in cells], analyses)


def _ancestors(g: dag.Graph, ids: set[str]) -> set[str]:
    seen: set[str] = set()
    stack = list(ids)
    while stack:
        u = stack.pop()
        for p in g.parents.get(u, ()):
            if p not in seen:
                seen.add(p)
                stack.append(p)
    return seen


def _ordered(g: dag.Graph, ids: set[str]) -> list[str]:
    order = g.topo or g.order_ids
    return [i for i in order if i in ids]


def plan_variant(base: list[dict], cand: list[dict]) -> dict:
    base_code = {c["id"]: c["code"] for c in base}
    g = _graph(cand)
    changed = [c["id"] for c in cand if base_code.get(c["id"]) != c["code"]]
    closure = set(changed) | g.downstream(set(changed))
    upstream = _ancestors(g, closure) - closure
    out = {"changed": changed, "upstream": _ordered(g, upstream), "closure": _ordered(g, closure)}
    if g.compile_error:
        out["compileError"] = g.compile_error
    return out


def plan_baseline(base: list[dict], plans: list[dict]) -> dict:
    ids = {c["id"] for c in base}
    g = _graph(base)
    seeds: set[str] = set()
    changed: list[str] = []
    for p in plans:
        seeds |= {c for c in p["closure"] if c in ids}
        changed += [c for c in p["changed"] if c in ids and c not in changed]
    closure = seeds | g.downstream(seeds)
    upstream = _ancestors(g, closure) - closure
    out = {"changed": changed, "upstream": _ordered(g, upstream), "closure": _ordered(g, closure)}
    if g.compile_error:
        out["compileError"] = g.compile_error
    return out


# ============================================================== nondeterminism


def _dotted(node: ast.AST) -> str:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def _no_seed(call: ast.Call) -> bool:
    if not call.args and not call.keywords:
        return True
    first = call.args[0] if call.args else call.keywords[0].value
    return isinstance(first, ast.Constant) and first.value is None


def detect_nondeterminism(code: str) -> list[str]:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    reasons: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _dotted(node.func)
        last = name.rsplit(".", 1)[-1]
        reason = None
        if last in ("default_rng", "RandomState") and _no_seed(node):
            reason = "unseeded-rng"
        elif name.endswith(("random.Random",)) and _no_seed(node):
            reason = "unseeded-rng"
        elif last in ("now", "utcnow", "today") and name.split(".")[-2:-1] and name.split(".")[-2] in ("datetime", "date", "Timestamp"):
            reason = "wall-clock"
        elif name in ("time.time", "time.time_ns", "time.perf_counter", "time.monotonic"):
            reason = "wall-clock"
        elif name in ("uuid.uuid1", "uuid.uuid4", "os.urandom") or name.startswith("secrets.") or last == "SystemRandom":
            reason = "entropy"
        if reason and reason not in reasons:
            reasons.append(reason)
    return reasons


# =================================================================== contracts


class _ContractError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


_TARGET_KINDS = {"columns_present", "dtype", "range", "not_null", "unique_key", "row_count", "row_sums", "margins_match"}


def _get(nss: dict, target: Any, phase: str) -> Any:
    if not isinstance(target, str) or phase not in ("before", "after"):
        raise _ContractError("invalid-params")
    ns = nss.get(phase)
    if ns is None or target not in ns:
        raise _ContractError("unknown-target")
    return ns[target]


def _need_frame(v: Any) -> Any:
    if not _is_frame(v):
        raise _ContractError("unsupported-type")
    return v


def _column(v: Any, column: Any) -> Any:
    if column is None:
        if _is_series(v):
            return v
        if _is_ndarray(v):
            import pandas as pd

            return pd.Series(v.ravel())
        raise _ContractError("invalid-params")
    df = _need_frame(v)
    if column not in df.columns:
        raise _ContractError("unknown-column")
    return df[column]


def _columns(df: Any, cols: Any) -> list:
    if not isinstance(cols, list) or not cols:
        raise _ContractError("invalid-params")
    for c in cols:
        if c not in df.columns:
            raise _ContractError("unknown-column")
    return cols


def _dtype_matches(dtype: Any, expect: str) -> bool:
    import pandas.api.types as pt
    import pandas as pd

    if expect == "int":
        return bool(pt.is_integer_dtype(dtype)) and not pt.is_bool_dtype(dtype)
    if expect == "float":
        return bool(pt.is_float_dtype(dtype))
    if expect == "numeric":
        return bool(pt.is_numeric_dtype(dtype)) and not pt.is_bool_dtype(dtype)
    if expect == "string":
        return bool(pt.is_string_dtype(dtype)) or dtype == object
    if expect == "bool":
        return bool(pt.is_bool_dtype(dtype))
    if expect == "datetime":
        return bool(pt.is_datetime64_any_dtype(dtype))
    if expect == "category":
        return isinstance(dtype, pd.CategoricalDtype)
    raise _ContractError("invalid-params")


def _numeric_values(s: Any) -> Any:
    if not _numeric_series(s):
        raise _ContractError("unsupported-type")
    return s.dropna().to_numpy(dtype=float)


def _status(ok: bool) -> str:
    return "pass" if ok else "fail"


def _eval_one(c: dict, nss: dict) -> dict:
    import numpy as np

    kind = c.get("kind")
    phase = c.get("phase", "after")
    res: dict = {}
    if kind in _TARGET_KINDS:
        res["phase"] = phase
    if kind == "columns_present":
        df = _need_frame(_get(nss, c.get("target"), phase))
        cols = c.get("columns")
        if not isinstance(cols, list) or not cols:
            raise _ContractError("invalid-params")
        missing = sum(1 for col in cols if col not in df.columns)
        res.update(status=_status(missing == 0), total=len(cols), violations=missing)
    elif kind == "dtype":
        s = _column(_get(nss, c.get("target"), phase), c.get("column"))
        ok = _dtype_matches(s.dtype, str(c.get("expect")))
        res.update(status=_status(ok), total=1, violations=0 if ok else 1)
    elif kind == "range":
        vals = _numeric_values(_column(_get(nss, c.get("target"), phase), c.get("column")))
        lo, hi = c.get("min"), c.get("max")
        if lo is None and hi is None:
            raise _ContractError("invalid-params")
        inclusive = c.get("inclusive", True)
        bad = np.zeros(vals.shape, dtype=bool)
        if lo is not None:
            bad |= vals < float(lo) if inclusive else vals <= float(lo)
        if hi is not None:
            bad |= vals > float(hi) if inclusive else vals >= float(hi)
        v = int(bad.sum())
        res.update(status=_status(v == 0), total=int(vals.size), violations=v)
    elif kind == "not_null":
        df = _need_frame(_get(nss, c.get("target"), phase))
        cols = _columns(df, c.get("columns"))
        v = int(df[cols].isna().any(axis=1).sum())
        res.update(status=_status(v == 0), total=int(len(df)), violations=v)
    elif kind == "unique_key":
        df = _need_frame(_get(nss, c.get("target"), phase))
        cols = _columns(df, c.get("columns"))
        v = int(df.duplicated(subset=cols, keep="first").sum())
        res.update(status=_status(v == 0), total=int(len(df)), violations=v)
    elif kind == "row_count":
        n = len(_get(nss, c.get("target"), phase))
        ref = c.get("ref")
        if isinstance(ref, dict):
            refn = len(_get(nss, ref.get("target"), ref.get("phase", "after")))
        elif isinstance(ref, (int, float)) and not isinstance(ref, bool):
            refn = ref
        else:
            raise _ContractError("invalid-params")
        tol = float(c.get("tolerance", 0))
        op = c.get("op", "==")
        if op == "==":
            ok = abs(n - refn) <= tol
        elif op == "<=":
            ok = n <= refn + tol
        elif op == ">=":
            ok = n >= refn - tol
        else:
            raise _ContractError("invalid-params")
        res.update(status=_status(ok), total=int(n), violations=0 if ok else int(abs(n - refn)))
    elif kind == "sum_conserved":
        b, a = c.get("before"), c.get("after")
        if not isinstance(b, dict) or not isinstance(a, dict):
            raise _ContractError("invalid-params")
        rtol = float(c.get("rtol", 1e-9))
        atol = float(c.get("atol", 0.0))

        def sums(spec: dict, default_phase: str) -> Any:
            v = _get(nss, spec.get("target"), spec.get("phase", default_phase))
            by = spec.get("by")
            if by:
                df = _need_frame(v)
                _columns(df, list(by))
                _column(df, spec.get("column"))
                return df.groupby(list(by), dropna=False)[spec["column"]].sum()
            return float(_numeric_values(_column(v, spec.get("column"))).sum())

        sb, sa = sums(b, "before"), sums(a, "after")
        if isinstance(sb, float) != isinstance(sa, float):
            raise _ContractError("invalid-params")
        if isinstance(sb, float):
            diff = abs(sa - sb)
            ok = diff <= atol + rtol * abs(sb)
            res.update(status=_status(ok), total=1, violations=0 if ok else 1, maxAbsDiff=_r4(diff) or 0.0)
        else:
            joined = sb.to_frame("b").join(sa.to_frame("a"), how="outer")
            bb = joined["b"].to_numpy(dtype=float)
            aa = joined["a"].to_numpy(dtype=float)
            missing = np.isnan(bb) | np.isnan(aa)
            diff = np.abs(np.nan_to_num(aa) - np.nan_to_num(bb))
            bad = missing | (diff > atol + rtol * np.abs(np.nan_to_num(bb)))
            v = int(bad.sum())
            res.update(status=_status(v == 0), total=int(len(joined)), violations=v,
                       maxAbsDiff=_r4(diff.max()) if diff.size else 0.0)
    elif kind == "row_sums":
        v = _get(nss, c.get("target"), phase)
        if _is_frame(v):
            mat = v.to_numpy(dtype=float)
        elif _is_ndarray(v) and v.dtype.kind in "iuf":
            mat = v.astype(float)
        else:
            raise _ContractError("unsupported-type")
        if mat.ndim != 2:
            raise _ContractError("unsupported-type")
        axis = int(c.get("axis", 1))
        sums_ = np.nansum(mat, axis=axis)
        diff = np.abs(sums_ - float(c.get("expect", 1.0)))
        bad = int((diff > float(c.get("atol", 1e-9))).sum())
        res.update(status=_status(bad == 0), total=int(sums_.size), violations=bad,
                   maxAbsDiff=_r4(diff.max()) if diff.size else 0.0)
    elif kind == "match_rate":
        lp = c.get("phase", "after")
        left = _need_frame(_get(nss, c.get("left"), lp))
        right = _need_frame(_get(nss, c.get("right"), c.get("rightPhase", lp)))
        on = c.get("on")
        _columns(left, on)
        _columns(right, on)
        rk = right[on].dropna()
        keys = set(map(tuple, rk.astype(object).itertuples(index=False, name=None)))
        lk = left[on]
        nullrow = lk.isna().any(axis=1).to_numpy()
        matched = 0
        for isnull, key in zip(nullrow, lk.astype(object).itertuples(index=False, name=None)):
            if not isnull and tuple(key) in keys:
                matched += 1
        total = int(len(left))
        rate = matched / total if total else 1.0
        mn = c.get("min")
        if not isinstance(mn, (int, float)):
            raise _ContractError("invalid-params")
        res.update(status=_status(rate >= float(mn)), total=total, violations=total - matched)
    elif kind == "equivalent":
        targets = c.get("targets")
        if not isinstance(targets, list) or not targets:
            raise _ContractError("invalid-params")
        rtol = float(c.get("rtol", 1e-9))
        total = 0
        bad = 0
        mismatch = False
        for t in targets:
            b = _get(nss, t, "before")
            a = _get(nss, t, "after")
            n, v, struct_ok = _compare(b, a, rtol)
            total += n
            bad += v
            mismatch |= not struct_ok
        res.update(status=_status(bad == 0 and not mismatch), total=total, violations=bad)
        if mismatch:
            res["reason"] = "structure-mismatch"
    elif kind == "mapping_conserved":
        res.update(_mapping_conserved(c, nss))
    elif kind == "margins_match":
        res.update(_margins_match(c, nss, phase))
    else:
        raise _ContractError("invalid-params")
    return res


# 技能包契约（ADR-016）：类别映射守恒、边际配平残差。与上面一样只返回计数与最大偏差，
# 不回显类别标签或数值本身（映射表是 Agent 自己给的，但源数据里的类别不是）。

_MAX_MAPPING = 5000


def _label_key(v: Any) -> str:
    """类别比较键：JSON 映射的键只能是字符串，所以两边统一按 str 比较。"""
    return str(v)


def _mapping(c: dict, nss: dict) -> dict:
    m = c.get("mapping")
    if isinstance(m, str):
        m = _get(nss, m, "after")
        if _is_series(m):
            m = m.to_dict()
    if not isinstance(m, dict) or not m or len(m) > _MAX_MAPPING:
        raise _ContractError("invalid-params")
    return {_label_key(k): _label_key(v) for k, v in m.items()}


def _category_totals(spec: Any, nss: dict, default_phase: str, mapping: dict | None) -> tuple[dict, int]:
    """(类别 → 合计, 未映射类别数)。value 省略时按行计数；mapping 给出时先把类别映射过去。"""
    import pandas as pd

    if not isinstance(spec, dict):
        raise _ContractError("invalid-params")
    df = _need_frame(_get(nss, spec.get("target"), spec.get("phase", default_phase)))
    cats = _column(df, spec.get("column"))
    value = spec.get("value")
    if value is None:
        vals = pd.Series(1.0, index=df.index)
    else:
        vals = _column(df, value)
        if not _numeric_series(vals):
            raise _ContractError("unsupported-type")
        vals = vals.astype(float).fillna(0.0)
    keys = cats.map(lambda v: None if pd.isna(v) else _label_key(v))
    unmapped = 0
    if mapping is not None:
        present = set(keys.dropna())
        unmapped = sum(1 for k in present if k not in mapping) + (1 if keys.isna().any() else 0)
        keys = keys.map(lambda k: mapping.get(k) if k is not None else None)
    totals = vals[keys.notna()].groupby(keys[keys.notna()]).sum()
    return {k: float(v) for k, v in totals.items()}, unmapped


def _mapping_conserved(c: dict, nss: dict) -> dict:
    mapping = _mapping(c, nss)
    rtol = float(c.get("rtol", 1e-9))
    atol = float(c.get("atol", 1e-9))
    expected, unmapped = _category_totals(c.get("before"), nss, "before", mapping)
    actual, _ = _category_totals(c.get("after"), nss, "after", None)
    groups = set(expected) | set(actual)
    diffs = [abs(actual.get(g, 0.0) - expected.get(g, 0.0)) for g in groups]
    bad = sum(1 for g, d in zip(groups, diffs) if d > atol + rtol * abs(expected.get(g, 0.0)))
    return {
        "status": _status(bad == 0 and unmapped == 0),
        "total": len(groups),
        "violations": bad + unmapped,
        "unmapped": unmapped,
        "maxAbsDiff": (_r4(max(diffs)) or 0.0) if diffs else 0.0,
    }


def _margin_target(spec: Any, nss: dict, labels: Any) -> Any:
    """边际目标：数字列表，或命名空间里的 Series / 数组 / 列表。带索引且与矩阵标签同集合时按标签对齐。"""
    import numpy as np

    if isinstance(spec, str):
        spec = _get(nss, spec, "after")
    if _is_series(spec):
        if labels is not None and set(spec.index) == set(labels) and len(spec) == len(labels):
            spec = spec.reindex(labels)
        if not _numeric_series(spec):
            raise _ContractError("unsupported-type")
        return spec.to_numpy(dtype=float)
    if _is_ndarray(spec):
        if spec.dtype.kind not in "iuf" or spec.ndim != 1:
            raise _ContractError("unsupported-type")
        return spec.astype(float)
    if isinstance(spec, (list, tuple)) and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in spec):
        return np.asarray(spec, dtype=float)
    raise _ContractError("invalid-params")


def _margins_match(c: dict, nss: dict, phase: str) -> dict:
    import numpy as np

    v = _get(nss, c.get("target"), phase)
    mat = _matrix(v)
    if mat is None:
        raise _ContractError("unsupported-type")
    if c.get("rows") is None and c.get("cols") is None:
        raise _ContractError("invalid-params")
    rtol = float(c.get("rtol", 0.0))
    atol = float(c.get("atol", 1e-6))
    actual: list = []
    target: list = []
    for key, axis, labels in (("rows", 1, getattr(v, "index", None)), ("cols", 0, getattr(v, "columns", None))):
        if c.get(key) is None:
            continue
        t = _margin_target(c.get(key), nss, list(labels) if labels is not None else None)
        s = np.nansum(mat, axis=axis)
        if t.shape != s.shape:
            raise _ContractError("invalid-params")
        actual.append(s)
        target.append(t)
    a = np.concatenate(actual)
    t = np.concatenate(target)
    diff = np.abs(a - t)
    bad = int((diff > atol + rtol * np.abs(t)).sum())
    return {"status": _status(bad == 0), "total": int(diff.size), "violations": bad,
            "maxAbsDiff": _r4(diff.max()) if diff.size else 0.0}


def _compare(b: Any, a: Any, rtol: float) -> tuple[int, int, bool]:
    """(比较元素数, 不等元素数, 结构一致)。"""
    import numpy as np

    if _is_frame(b) and _is_frame(a):
        if list(b.columns) != list(a.columns) or b.shape != a.shape or list(map(str, b.dtypes)) != list(map(str, a.dtypes)):
            return 0, 0, False
        total = 0
        bad = 0
        for i in range(b.shape[1]):
            n, v, _ = _compare_series(b.iloc[:, i], a.iloc[:, i], rtol)
            total += n
            bad += v
        return total, bad, True
    if _is_series(b) and _is_series(a):
        if len(b) != len(a) or str(b.dtype) != str(a.dtype):
            return 0, 0, False
        return _compare_series(b, a, rtol)
    if _is_ndarray(b) and _is_ndarray(a):
        if b.shape != a.shape or b.dtype != a.dtype:
            return 0, 0, False
        if b.dtype.kind in "iuf":
            eq = np.isclose(b.astype(float), a.astype(float), rtol=rtol, atol=0.0, equal_nan=True)
            return int(eq.size), int((~eq).sum()), True
        eq = b == a
        return int(np.size(eq)), int(np.size(eq) - np.sum(eq)), True
    if type(b) is not type(a):
        return 0, 0, False
    try:
        same = bool(b == a)
    except Exception:  # noqa: BLE001
        return 0, 0, False
    return 1, 0 if same else 1, True


def _compare_series(b: Any, a: Any, rtol: float) -> tuple[int, int, bool]:
    import numpy as np

    n = int(len(b))
    if _numeric_series(b) and _numeric_series(a):
        eq = np.isclose(b.to_numpy(dtype=float), a.to_numpy(dtype=float), rtol=rtol, atol=0.0, equal_nan=True)
        return n, int((~eq).sum()), True
    bn = b.isna().to_numpy()
    an = a.isna().to_numpy()
    same = (b.to_numpy(dtype=object) == a.to_numpy(dtype=object)) | (bn & an)
    return n, int(n - np.sum(same)), True


def evaluate_contracts(contracts: list[dict], namespaces: dict) -> list[dict]:
    out: list[dict] = []
    for i, c in enumerate(contracts if isinstance(contracts, list) else []):
        if not isinstance(c, dict):
            c = {}
        cid = str(c.get("id") or f"c{i + 1}")[:64]
        kind = str(c.get("kind"))[:32]
        base: dict = {"id": cid, "kind": kind}
        try:
            base.update(_eval_one(c, namespaces))
        except _ContractError as e:
            base.update(status="error", reason=e.reason)
        except (KeyError, TypeError, ValueError, AttributeError):
            base.update(status="error", reason="invalid-params")
        except Exception:  # noqa: BLE001 — 契约求值永不抛出原文
            base.update(status="error", reason="evaluation-failed")
        out.append(base)
    return out


# ================================================================ auto checks
# ADR-013 §4.3：领域中立——触发只看数据形态，不看变量名、列名或学科词汇。

_NULL_RATE_JUMP = 0.10
_STOCH_ATOL = 1e-6


def _matrix(v: Any) -> Any:
    """二维数值矩阵（表或数组）→ float ndarray；否则 None。"""
    import numpy as np

    try:
        if _is_frame(v):
            if v.shape[1] == 0 or not all(_numeric_series(v.iloc[:, i]) for i in range(v.shape[1])):
                return None
            m = v.to_numpy(dtype=float)
        elif _is_ndarray(v) and v.dtype.kind in "iuf":
            m = v.astype(float)
        else:
            return None
    except Exception:  # noqa: BLE001
        return None
    return m if m.ndim == 2 and m.size > 0 else None


def _row_stochastic(m: Any) -> int | None:
    """按行和为 1 → 1；按列和为 1 → 0；都不是 → None（只认非负矩阵）。"""
    import numpy as np

    if m is None or np.isnan(m).any() or (m < 0).any():
        return None
    for axis in (1, 0):
        if np.allclose(m.sum(axis=axis), 1.0, atol=_STOCH_ATOL):
            return axis
    return None


def _quality(v: Any) -> dict | None:
    """表/数组的数据质量快照：行数、全空列数、Inf 个数、各列空值率。"""
    import numpy as np

    try:
        if _is_frame(v):
            nulls = v.isna()
            rates = {str(c): float(nulls.iloc[:, i].mean()) if len(v) else 0.0 for i, c in enumerate(v.columns)}
            all_null = int(sum(1 for i in range(v.shape[1]) if len(v) and bool(nulls.iloc[:, i].all())))
            inf = 0
            for i in range(v.shape[1]):
                s = v.iloc[:, i]
                if _numeric_series(s):
                    inf += int(np.isinf(s.to_numpy(dtype=float)).sum())
            return {"rows": int(len(v)), "allNull": all_null, "inf": inf, "rates": rates}
        if _is_ndarray(v) and v.dtype.kind in "iuf":
            flat = v.astype(float).ravel()
            return {"rows": int(v.shape[0]) if v.ndim else 1, "allNull": 0,
                    "inf": int(np.isinf(flat).sum()), "rates": {"values": float(np.isnan(flat).mean()) if flat.size else 0.0}}
    except Exception:  # noqa: BLE001
        return None
    return None


def auto_checks(before_ns: dict, after_ns: dict, names: list[str]) -> list[dict]:
    """改前/改后同名对象的默认检查；结果只含状态与计数。"""
    out: list[dict] = []
    for name in names:
        if name not in after_ns or name not in before_ns or _skip_name(name, after_ns[name]):
            continue
        b, a = before_ns[name], after_ns[name]
        axis = _row_stochastic(_matrix(b))
        if axis is not None:
            ma = _matrix(a)
            if ma is None:
                out.append({"id": f"auto:row_stochastic:{name}", "kind": "row_stochastic", "status": "fail",
                            "reason": "structure-mismatch"})
            else:
                import numpy as np

                diff = np.abs(np.nan_to_num(ma, nan=np.inf).sum(axis=axis) - 1.0)
                bad = int((diff > _STOCH_ATOL).sum())
                out.append({"id": f"auto:row_stochastic:{name}", "kind": "row_stochastic", "status": _status(bad == 0),
                            "total": int(diff.size), "violations": bad, "maxAbsDiff": _r4(diff.max()) or 0.0})
        qb, qa = _quality(b), _quality(a)
        if qb is None or qa is None:
            continue
        if qb["rows"] > 0 and qa["rows"] == 0:
            out.append({"id": f"auto:non_empty:{name}", "kind": "non_empty", "status": "fail",
                        "total": 0, "violations": 1})
        if qa["allNull"] > qb["allNull"]:
            out.append({"id": f"auto:all_null_column:{name}", "kind": "all_null_column", "status": "fail",
                        "violations": qa["allNull"] - qb["allNull"]})
        if qa["inf"] > qb["inf"]:
            out.append({"id": f"auto:inf_values:{name}", "kind": "inf_values", "status": "fail",
                        "violations": qa["inf"] - qb["inf"]})
        jumps = sum(1 for c, r in qa["rates"].items() if c in qb["rates"] and r - qb["rates"][c] > _NULL_RATE_JUMP)
        if jumps:
            out.append({"id": f"auto:null_rate:{name}", "kind": "null_rate", "status": "fail",
                        "total": len(qa["rates"]), "violations": jumps})
    return out


# ===================================================================== sandbox


class ShadowSandboxError(PermissionError):
    def __init__(self, kind: str) -> None:
        super().__init__(f"{kind} blocked")
        self.kind = kind


_WRITE_MODE_CHARS = frozenset("wax+")
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

_NETWORK = frozenset({
    "socket.connect", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex",
    "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg", "socket.bind",
    "urllib.Request", "http.client.connect", "ftplib.connect", "smtplib.connect",
    "poplib.connect", "imaplib.open", "nntplib.connect", "telnetlib.Telnet.open", "webbrowser.open",
})
_SUBPROCESS = frozenset({
    "subprocess.Popen", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.startfile",
    "os.fork", "os.forkpty", "_winapi.CreateProcess", "pty.spawn",
})
_REGISTRY = frozenset({
    "winreg.CreateKey", "winreg.DeleteKey", "winreg.DeleteValue", "winreg.SetValue",
    "winreg.SaveKey", "winreg.LoadKey",
})
_PROCESS_CONTROL = frozenset({"os.kill", "os.killpg", "signal.pthread_kill"})
# event → 被写路径参数下标
_PATH_WRITE = {
    "os.mkdir": 0, "os.truncate": 0, "os.chmod": 0, "os.chown": 0, "os.utime": 0,
    "os.chflags": 0, "os.lchmod": 0, "os.symlink": 1, "os.link": 1,
    "shutil.copyfile": 1, "shutil.copytree": 1, "shutil.move": 1, "shutil.copymode": 1,
    "shutil.copystat": 1, "shutil.chown": 0,
}
_PATH_DELETE = {"os.remove": 0, "os.rmdir": 0, "shutil.rmtree": 0}

_ACTIVE_SANDBOX: "Sandbox | None" = None


def _audit_hook(event: str, args: tuple) -> None:
    sb = _ACTIVE_SANDBOX
    if sb is not None and not sb._busy:
        sb._on_event(event, args)


class Sandbox:
    """进程级拦截（PEP 578 审计钩子不可卸载，只在影子进程里安装）。"""

    def __init__(self, scratch_dir: str) -> None:
        self.scratch = os.path.normcase(os.path.realpath(os.path.abspath(scratch_dir)))
        self.devnull = os.path.normcase(os.path.abspath(os.devnull))
        self.blocked: dict[str, int] = {}
        self.ctypes_loads = 0
        self._busy = False

    def install(self) -> None:
        global _ACTIVE_SANDBOX
        sys.dont_write_bytecode = True
        _ACTIVE_SANDBOX = self
        sys.addaudithook(_audit_hook)

    def reset_counts(self) -> None:
        self.blocked = {}
        self.ctypes_loads = 0

    def _inside(self, path: Any) -> bool:
        if isinstance(path, int):
            return True  # 已打开的 fd：打开时已经过检查
        try:
            p = os.fsdecode(path) if isinstance(path, bytes) else os.fspath(path)
        except TypeError:
            return False
        try:
            key = os.path.normcase(os.path.realpath(os.path.abspath(p)))
        except (OSError, ValueError):
            return False
        if key == self.devnull or os.path.normcase(p) in ("nul", "/dev/null"):
            return True
        return key == self.scratch or key.startswith(self.scratch + os.sep)

    def _block(self, kind: str) -> None:
        self.blocked[kind] = self.blocked.get(kind, 0) + 1
        raise ShadowSandboxError(kind)

    def _on_event(self, event: str, args: tuple) -> None:
        if event == "open":
            mode = args[1] if len(args) > 1 else None
            if isinstance(mode, str):
                write = bool(_WRITE_MODE_CHARS.intersection(mode))
            else:
                flags = args[2] if len(args) > 2 else 0
                try:
                    write = bool(int(flags) & _WRITE_FLAGS)
                except (TypeError, ValueError):
                    write = False
            if write:
                self._guard_path(args[0] if args else None, "file-write")
            return
        if event in _NETWORK:
            self._block("network")
        if event in _SUBPROCESS:
            self._block("subprocess")
        if event in _REGISTRY:
            self._block("registry")
        if event == "winreg.ConnectRegistry" and args and args[0] is not None:
            self._block("network")  # 只读本机注册表放行（dateutil 导入即读时区键）；远程即网络
        if event in _PROCESS_CONTROL:
            self._block("process-control")
        if event == "os.rename":
            src = args[0] if args else None
            dst = args[1] if len(args) > 1 else None
            self._busy = True
            try:
                ok = self._inside(src) and self._inside(dst)
            finally:
                self._busy = False
            if not ok:
                self._block("file-rename")
            return
        idx = _PATH_DELETE.get(event)
        if idx is not None:
            self._guard_path(args[idx] if len(args) > idx else None, "file-delete")
            return
        idx = _PATH_WRITE.get(event)
        if idx is not None:
            self._guard_path(args[idx] if len(args) > idx else None, "file-write")
            return
        if event == "ctypes.dlopen":
            self.ctypes_loads += 1

    def _guard_path(self, path: Any, kind: str) -> None:
        self._busy = True  # realpath 自身可能触发审计事件：防重入
        try:
            ok = self._inside(path)
        finally:
            self._busy = False
        if not ok:
            self._block(kind)


# ================================================================ memory limit


def _win_job_limit(limit: int) -> dict:
    import ctypes
    from ctypes import wintypes

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class EXTENDED(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BASIC),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.GetCurrentProcess.restype = wintypes.HANDLE

    job = k32.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
    info = EXTENDED()
    info.BasicLimitInformation.LimitFlags = 0x100 | 0x400 | 0x8  # PROCESS_MEMORY | DIE_ON_UNHANDLED | ACTIVE_PROCESS
    info.BasicLimitInformation.ActiveProcessLimit = 1  # OS 级禁止派生子进程
    info.ProcessMemoryLimit = limit
    if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
    if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
    readback = EXTENDED()
    if not k32.QueryInformationJobObject(job, 9, ctypes.byref(readback), ctypes.sizeof(readback), None):
        raise OSError(ctypes.get_last_error(), "QueryInformationJobObject failed")
    _KEEP.append(job)  # 句柄随进程存活
    return {
        "mechanism": "job-object",
        "limitBytes": int(readback.ProcessMemoryLimit),
        "activeProcessLimit": int(readback.BasicLimitInformation.ActiveProcessLimit),
    }


_KEEP: list = []


def apply_memory_limit(limit: int) -> dict:
    """OS 级内存上限；失败返回 {mechanism: None, error}（bridge 据此拒绝运行）。"""
    try:
        if sys.platform == "win32":
            return _win_job_limit(int(limit))
        import resource

        try:
            resource.setrlimit(resource.RLIMIT_AS, (int(limit), int(limit)))
            soft, _ = resource.getrlimit(resource.RLIMIT_AS)
            return {"mechanism": "rlimit-as", "limitBytes": int(soft)}
        except (ValueError, OSError):
            resource.setrlimit(resource.RLIMIT_DATA, (int(limit), int(limit)))
            soft, _ = resource.getrlimit(resource.RLIMIT_DATA)
            return {"mechanism": "rlimit-data", "limitBytes": int(soft)}
    except Exception as e:  # noqa: BLE001
        return {"mechanism": None, "limitBytes": None, "error": type(e).__name__}


# =================================================================== session


class _Discard(io.TextIOBase):
    def writable(self) -> bool:
        return True

    def write(self, s: Any) -> int:  # type: ignore[override]
        return len(s) if isinstance(s, str) else 0


class ShadowSession:
    def __init__(self, sandbox: Sandbox | None = None) -> None:
        self.sandbox = sandbox
        self.namespaces: dict[str, dict] = {}

    def run(self, base: list[dict], candidates: list[dict], *, seed: int = 0, k: int = K_DEFAULT,
            compare: bool = True) -> dict:
        self.namespaces = {}
        gc.collect()
        plans = [plan_variant(base, c["cells"]) for c in candidates]
        out: dict = {"before": None, "candidates": []}
        before_vars: dict[str, dict] = {}
        if compare:
            bplan = plan_baseline(base, plans)
            before = self._run_variant("before", base, bplan, seed, k)
            before_vars = {v["name"]: v for v in before.pop("_vars")}
            before["vars"] = list(before_vars.values())
            out["before"] = before
        for cand, plan in zip(candidates, plans):
            res = self._run_variant(str(cand["name"]), cand["cells"], plan, seed, k)
            after_vars = {v["name"]: v for v in res.pop("_vars")}
            merged: list[dict] = []
            for name in sorted(set(after_vars) | set(before_vars)):
                entry: dict = {"name": name}
                b = before_vars.get(name)
                a = after_vars.get(name)
                if b is not None:
                    entry["before"] = {k_: v for k_, v in b.items() if k_ != "name"}
                if a is not None:
                    entry["after"] = {k_: v for k_, v in a.items() if k_ != "name"}
                if b is not None and a is not None:
                    d = delta(entry["before"], entry["after"])
                    if d:
                        entry["delta"] = d
                merged.append(entry)
                if len(merged) >= MAX_VARS:
                    break
            res["vars"] = merged
            if compare and "before" in self.namespaces and res["name"] in self.namespaces:
                res["autoChecks"] = auto_checks(
                    self.namespaces["before"], self.namespaces[res["name"]], sorted(after_vars))
            else:
                res["autoChecks"] = []
            out["candidates"].append(res)
        return out

    def verify(self, candidate: str, contracts: list[dict]) -> dict:
        nss = {"after": self.namespaces.get(candidate)}
        if "before" in self.namespaces:
            nss["before"] = self.namespaces["before"]
        if nss["after"] is None:
            return {"contracts": [], "error": "no-run"}
        return {"contracts": evaluate_contracts(contracts, nss)}

    # ------------------------------------------------------------------ internal
    def _seed(self, seed: int, seeded_numpy: list[bool]) -> None:
        if not seeded_numpy[0] and "numpy" in sys.modules:
            try:
                sys.modules["numpy"].random.seed(seed)
                seeded_numpy[0] = True
            except Exception:  # noqa: BLE001
                pass

    def _run_variant(self, name: str, cells: list[dict], plan: dict, seed: int, k: int) -> dict:
        t0 = time.perf_counter()
        if self.sandbox is not None:
            self.sandbox.reset_counts()
        by_id = {c["id"]: c["code"] for c in cells}
        result: dict = {"name": name, "plan": {kk: plan[kk] for kk in ("changed", "upstream", "closure")}}
        if plan.get("compileError"):
            result.update(cells=[], _vars=[], blocked=[], nondeterminism=[], figures=0,
                          compileError=_scrub_message(plan["compileError"], "\n".join(by_id.values())),
                          durationMs=0)
            return result
        g = _graph(cells)
        ns: dict = {"__name__": "__shadow__", "__builtins__": _builtins_mod}
        random.seed(seed)
        seeded_numpy = [False]
        self._seed(seed, seeded_numpy)
        bad: set[str] = set()
        reports: list[dict] = []
        nondet: list[dict] = []
        figures = 0
        sink = _Discard()
        closure = set(plan["closure"])
        for cid in plan["upstream"] + plan["closure"]:
            code = by_id[cid]
            rep: dict = {"id": cid, "role": "closure" if cid in closure else "upstream"}
            for reason in detect_nondeterminism(code):
                nondet.append({"cellId": cid, "reason": reason})
            if g.parents.get(cid, set()) & bad:
                rep.update(ok=False, skipped="blocked-upstream", durationMs=0)
                bad.add(cid)
                reports.append(rep)
                continue
            if dag.detect_side_effect(code):
                rep.update(ok=False, skipped="side-effect", durationMs=0)
                bad.add(cid)
                reports.append(rep)
                continue
            filename = f"<cell {cid}>"
            c0 = time.perf_counter()
            try:
                compiled = compile(code, filename, "exec")
                with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                    exec(compiled, ns)
                rep["ok"] = True
            except BaseException as e:  # noqa: BLE001 — 影子进程必须存活
                rep["ok"] = False
                rep["traceback"] = scrub_traceback(e, {filename: code})
                bad.add(cid)
                if isinstance(e, MemoryError):
                    gc.collect()
            rep["durationMs"] = int((time.perf_counter() - c0) * 1000)
            self._seed(seed, seeded_numpy)
            figures += self._close_figures()
            reports.append(rep)
        names: set[str] = set()
        for cid in plan["closure"]:
            names |= g.defs.get(cid, set())
        result.update(
            cells=reports,
            _vars=summarize_namespace(ns, names, k=k),
            blocked=[{"kind": kk, "count": n} for kk, n in sorted((self.sandbox.blocked if self.sandbox else {}).items())],
            nondeterminism=nondet,
            figures=figures,
            durationMs=int((time.perf_counter() - t0) * 1000),
        )
        if self.sandbox is not None and self.sandbox.ctypes_loads:
            result["ctypesLoads"] = self.sandbox.ctypes_loads
        self.namespaces["before" if name == "before" else name] = ns
        return result

    @staticmethod
    def _close_figures() -> int:
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is None:
            return 0
        try:
            n = len(plt.get_fignums())
            plt.close("all")
            return n
        except Exception:  # noqa: BLE001
            return 0
