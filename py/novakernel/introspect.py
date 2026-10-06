"""introspect.py — 变量 schema 嗅探（spec §5 introspect / §8 隐私边界内的元信息）。

对共享 globals 中**非 module、非 dunder** 的每个名字产出：
``{name, type, shape?, columns?, dtype?, len?, preview}``

- pandas DataFrame：shape / columns(含 dtype) / len / preview = head(1).to_dict("records")
  的 JSON 安全化结果；
- numpy ndarray：shape / dtype / len / preview = flatten 前 8 个元素；
- 其他：preview = repr 截断 200 字符；有 __len__ 的附 len；
- preview 序列化失败一律降级为 type 名（保证 json.dumps 永不炸）。

pandas/numpy 均为**可选**依赖：按 type 的 module/name 识别，不 import。
"""

from __future__ import annotations

import math
import types

__all__ = ["describe", "snapshot"]

_MAX_DEPTH = 6
_REPR_LIMIT = 200


def _truncate(s: str) -> str:
    return s[:_REPR_LIMIT]


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
    if isinstance(obj, bytes):
        return _safe_repr(obj)
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


def _is_dataframe(v: object) -> bool:
    t = type(v)
    return t.__name__ == "DataFrame" and t.__module__.split(".", 1)[0] == "pandas"


def _is_ndarray(v: object) -> bool:
    t = type(v)
    return t.__name__ == "ndarray" and t.__module__.split(".", 1)[0] == "numpy"


def describe(name: str, value: object) -> dict:
    """单个变量的 schema；任何异常降级为 {name, type, preview: type名}。"""
    tname = type(value).__name__
    try:
        if _is_dataframe(value):
            schema: dict = {"name": name, "type": tname}
            schema["shape"] = [int(x) for x in value.shape]  # type: ignore[attr-defined]
            schema["columns"] = [
                {"name": str(c), "dtype": str(value[c].dtype)}  # type: ignore[index]
                for c in value.columns  # type: ignore[attr-defined]
            ]
            schema["len"] = int(len(value))  # type: ignore[arg-type]
            schema["preview"] = _json_safe(
                value.head(1).to_dict(orient="records")  # type: ignore[attr-defined]
            )
            return schema
        if _is_ndarray(value):
            schema = {"name": name, "type": tname}
            schema["shape"] = [int(x) for x in value.shape]  # type: ignore[attr-defined]
            schema["dtype"] = str(value.dtype)  # type: ignore[attr-defined]
            if value.ndim > 0:  # type: ignore[attr-defined]
                schema["len"] = int(len(value))  # type: ignore[arg-type]
            schema["preview"] = _json_safe(
                value.flatten()[:8].tolist()  # type: ignore[attr-defined]
            )
            return schema
        schema = {"name": name, "type": tname}
        try:
            schema["len"] = len(value)  # type: ignore[arg-type]
        except TypeError:
            pass
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
