"""introspect.py — 变量 schema 嗅探（spec §5 introspect / §8 隐私边界内的元信息）。

对共享 globals 中**非 module、非 dunder** 的每个名字产出：
``{name, type, shape?, columns?, dtype?, len?, preview}``

- pandas DataFrame：shape / columns(含 dtype) / len / preview = head(1).to_dict("records")
  的 JSON 安全化结果；
- numpy ndarray：shape / dtype(+dtypeDetail 明细 kind/itemsize) / len / preview = flatten 前 8 个元素；
- scipy.sparse（P3.5，duck-typing 探测，不 import scipy）：format / nnz / shape，无 preview；
- geopandas GeoDataFrame（P3.5，duck-typing 探测，不 import geopandas）：
  crs 名 / bounds 四元 / geometry 列名与类型（+shape）；
- set / frozenset / dict（P3.5）：len + 前 5 键（dict 取键，set 取元素）的 JSON 字符串预览；
- dataclass 实例（P3.5）：fields 字段名列表 + repr 预览；
- bytes / bytearray（P3.5）：preview = 前 32 字节 hex（超长加 …）；
- 其他：preview = repr 截断 200 字符；有 __len__ 的附 len；
- 结构化 preview（records/list）序列化后超过 200 字符 → 降级为截断字符串
  （"大对象 preview 一律 ≤200 字符且 JSON-safe"：NaN/Inf → 字符串，bytes → hex 前 32）；
- preview 序列化失败一律降级为 type 名（保证 json.dumps 永不炸）。

pandas/numpy/scipy/geopandas 均为**可选**依赖：按 type 的 module/name + 属性
duck-typing 识别，绝不 import（venv 只装 numpy/pandas/matplotlib，scipy/geopandas
用 fake 类单测，见 tests/test_introspect_ext.py）。
"""

from __future__ import annotations

import dataclasses
import itertools
import json
import math
import types

__all__ = ["describe", "snapshot"]

_MAX_DEPTH = 6
_REPR_LIMIT = 200
_BYTES_HEX = 32  # bytes → hex 预览的前缀字节数
_KEY_PREVIEW = 5  # set/frozenset/dict 预览的键数
_FLAT_PREVIEW = 8  # ndarray flatten 预览的元素数


def _truncate(s: str) -> str:
    return s[:_REPR_LIMIT]


def _hex_preview(b: bytes) -> str:
    """bytes → 前 32 字节的 hex 字符串；更长加省略号（JSON-safe，无转义噪音）。"""
    try:
        h = bytes(b[:_BYTES_HEX]).hex()
    except Exception:
        return type(b).__name__
    return h + ("…" if len(b) > _BYTES_HEX else "")


def _safe_repr(obj: object) -> str:
    try:
        return _truncate(repr(obj))
    except Exception:  # repr 抛异常 → 降级为 type 名
        return type(obj).__name__


def _json_safe(obj: object, depth: int = 0) -> object:
    """把任意值转成 JSON 可序列化结构；失败降级为字符串。"""
    if depth > _MAX_DEPTH:
        return _safe_repr(obj)
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else str(obj)  # NaN/Inf → "nan"/"inf"
    if isinstance(obj, (list, tuple)):
        return [_json_safe(x, depth + 1) for x in obj]
    if isinstance(obj, dict):
        return {str(k): _json_safe(v, depth + 1) for k, v in obj.items()}
    if isinstance(obj, (bytes, bytearray)):
        return _hex_preview(obj)
    item = getattr(obj, "item", None)  # numpy 标量
    if callable(item) and not isinstance(obj, type):
        try:
            return _json_safe(obj.item(), depth + 1)  # type: ignore[operator]
        except Exception:
            pass
    iso = getattr(obj, "isoformat", None)  # datetime / pandas Timestamp
    if callable(iso):
        try:
            return obj.isoformat()  # type: ignore[operator]
        except Exception:
            pass
    return _safe_repr(obj)


def _fit_preview(safe: object) -> object:
    """结构化 preview 的 200 字符预算：JSON 序列化后仍 ≤200 → 保留结构；
    超限 → 降级为截断字符串（保证前端/agent payload 拿到的 preview 有界）。"""
    try:
        text = json.dumps(safe, ensure_ascii=False, default=str)
    except Exception:
        return _safe_repr(safe)
    if len(text) <= _REPR_LIMIT:
        return safe
    return _truncate(text)


def _module_root(v: object) -> str:
    return type(v).__module__.split(".", 1)[0]


def _is_dataframe(v: object) -> bool:
    t = type(v)
    return t.__name__ == "DataFrame" and t.__module__.split(".", 1)[0] == "pandas"


def _is_ndarray(v: object) -> bool:
    t = type(v)
    return t.__name__ == "ndarray" and t.__module__.split(".", 1)[0] == "numpy"


def _is_geodataframe(v: object) -> bool:
    """geopandas 未装 → duck-typing：类名 GeoDataFrame，或同时具备
    columns/geometry/crs/total_bounds 属性（DataFrame-like + 地理元信息）。"""
    if type(v).__name__ == "GeoDataFrame":
        return True
    return all(hasattr(v, a) for a in ("columns", "geometry", "crs", "total_bounds"))


def _is_sparse(v: object) -> bool:
    """scipy 未装 → duck-typing：scipy.sparse 模块的 *_matrix/*_array 类名，
    或同时具备 nnz/format/shape 属性（排除 GeoDataFrame 误报）。"""
    t = type(v)
    if _module_root(v) == "scipy" and (
        t.__name__.endswith("_matrix") or t.__name__.endswith("_array")
    ):
        return True
    return (
        hasattr(v, "nnz") and hasattr(v, "format") and hasattr(v, "shape")
        and not _is_geodataframe(v)
    )


def _describe_geodataframe(name: str, value: object, tname: str) -> dict:
    schema: dict = {"name": name, "type": tname}
    shape = getattr(value, "shape", None)
    if shape is not None:
        schema["shape"] = [int(x) for x in shape]
    crs = getattr(value, "crs", None)
    schema["crs"] = str(crs) if crs is not None else None
    tb = getattr(value, "total_bounds", None)
    if tb is not None:
        schema["bounds"] = _json_safe([float(x) for x in tb])  # NaN/Inf → 字符串
    geom = getattr(value, "geometry", None)
    if geom is not None:
        schema["geometryColumn"] = str(getattr(geom, "name", "") or "geometry")
        gtype = getattr(geom, "geom_type", None)
        if isinstance(gtype, str):
            schema["geometryType"] = gtype
    return schema


def _describe_sparse(name: str, value: object, tname: str) -> dict:
    # spec P3.5：format/nnz/shape，无 preview（稀疏结构 repr 无信息量）
    return {
        "name": name,
        "type": tname,
        "shape": [int(x) for x in value.shape],  # type: ignore[attr-defined]
        "format": str(value.format),  # type: ignore[attr-defined]
        "nnz": int(value.nnz),  # type: ignore[attr-defined]
    }


def _describe_keyed(name: str, value: object, tname: str) -> dict:
    """set/frozenset/dict：len + 前 5 键（dict 迭代即键）的 JSON 字符串预览。"""
    keys = list(itertools.islice(iter(value), _KEY_PREVIEW))  # type: ignore[call-overload]
    try:
        text = json.dumps(_json_safe(keys), ensure_ascii=False, default=str)
    except Exception:
        text = repr(keys)
    return {
        "name": name,
        "type": tname,
        "len": len(value),  # type: ignore[arg-type]
        "preview": _truncate(text),
    }


def describe(name: str, value: object) -> dict:
    """单个变量的 schema；任何异常降级为 {name, type, preview: type名}。"""
    tname = type(value).__name__
    try:
        if _is_geodataframe(value):
            return _describe_geodataframe(name, value, tname)
        if _is_dataframe(value):
            schema: dict = {"name": name, "type": tname}
            schema["shape"] = [int(x) for x in value.shape]  # type: ignore[attr-defined]
            schema["columns"] = [
                {"name": str(c), "dtype": str(value[c].dtype)}  # type: ignore[index]
                for c in value.columns  # type: ignore[attr-defined]
            ]
            schema["len"] = int(len(value))  # type: ignore[arg-type]
            schema["preview"] = _fit_preview(
                _json_safe(value.head(1).to_dict(orient="records"))  # type: ignore[attr-defined]
            )
            return schema
        if _is_sparse(value):
            return _describe_sparse(name, value, tname)
        if _is_ndarray(value):
            schema = {"name": name, "type": tname}
            schema["shape"] = [int(x) for x in value.shape]  # type: ignore[attr-defined]
            dtype = value.dtype  # type: ignore[attr-defined]
            schema["dtype"] = str(dtype)
            # P3.5 dtype 明细：kind（i/f/U/S/O…）+ itemsize（字节）
            schema["dtypeDetail"] = {"kind": str(dtype.kind), "itemsize": int(dtype.itemsize)}
            if value.ndim > 0:  # type: ignore[attr-defined]
                schema["len"] = int(len(value))  # type: ignore[arg-type]
            schema["preview"] = _fit_preview(
                _json_safe(value.flatten()[:_FLAT_PREVIEW].tolist())  # type: ignore[attr-defined]
            )
            return schema
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            schema = {"name": name, "type": tname}
            schema["fields"] = [f.name for f in dataclasses.fields(value)]
            try:
                schema["len"] = len(value)  # type: ignore[arg-type]
            except TypeError:
                pass
            schema["preview"] = _safe_repr(value)
            return schema
        if isinstance(value, (set, frozenset, dict)):
            return _describe_keyed(name, value, tname)
        schema = {"name": name, "type": tname}
        try:
            schema["len"] = len(value)  # type: ignore[arg-type]
        except TypeError:
            pass
        if isinstance(value, (bytes, bytearray)):
            schema["preview"] = _hex_preview(value)
        else:
            schema["preview"] = _safe_repr(value)
        return schema
    except Exception:
        return {"name": name, "type": tname, "preview": tname}


def snapshot(globals_dict: dict) -> list[dict]:
    """globals → schemas 列表（跳过 module 与 _ 前缀名，按名字排序保证确定性）。"""
    out: list[dict] = []
    for name, value in globals_dict.items():
        if name.startswith("_"):
            continue
        if isinstance(value, types.ModuleType):
            continue
        out.append(describe(name, value))
    out.sort(key=lambda s: s["name"])
    return out
