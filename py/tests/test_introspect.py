"""test_introspect.py — 变量 schema 嗅探（spec §5/§8：元信息 + head(1)/repr≤200 预览）。"""

import json

import pytest

from novakernel import introspect

pd = pytest.importorskip("pandas")
np = pytest.importorskip("numpy")


def test_dataframe_schema():
    df = pd.DataFrame({"county": ["a", "b"], "pop": [1, 2]})
    s = introspect.describe("df", df)
    assert s["name"] == "df" and s["type"] == "DataFrame"
    assert s["shape"] == [2, 2]
    assert s["len"] == 2
    # pandas 3.x 字符串列 dtype 为 "str"（旧版 "object"）→ 只断言形状，不断言具体 dtype 字符串
    assert [c["name"] for c in s["columns"]] == ["county", "pop"]
    assert all(isinstance(c["dtype"], str) and c["dtype"] for c in s["columns"])
    assert s["preview"] == [{"county": "a", "pop": 1}]  # head(1).to_dict(records)
    json.dumps(s)  # 必须可序列化


def test_dataframe_preview_nan_becomes_string():
    df = pd.DataFrame({"x": [float("nan"), 1.0]})
    s = introspect.describe("df", df)
    text = json.dumps(s)  # 严格 JSON：不允许裸 NaN
    assert "NaN" not in text
    assert s["preview"][0]["x"] == "nan"


def test_ndarray_schema():
    arr = np.arange(12).reshape(3, 4)
    s = introspect.describe("arr", arr)
    assert s["type"] == "ndarray"
    assert s["shape"] == [3, 4]
    assert s["dtype"] == str(arr.dtype)
    assert s["len"] == 3
    assert s["preview"] == list(range(8))  # flatten 前 8 个
    json.dumps(s)


def test_ndarray_float_nonfinite_preview_safe():
    arr = np.array([1.0, np.nan, np.inf])
    s = introspect.describe("arr", arr)
    assert s["preview"] == [1.0, "nan", "inf"]
    json.dumps(s)


def test_repr_truncated_to_200_chars():
    s = introspect.describe("big", "x" * 500)
    assert len(s["preview"]) <= 200
    assert s["len"] == 500


def test_preview_failure_degrades_to_type_name():
    class Bad:
        def __repr__(self):
            raise RuntimeError("no repr for you")

    s = introspect.describe("bad", Bad())
    assert s["preview"] == "Bad"
    assert s["type"] == "Bad"
    json.dumps(s)


def test_dataframe_describe_failure_degrades():
    class FakeFrame:
        pass

    FakeFrame.__name__ = "DataFrame"
    FakeFrame.__module__ = "pandas.core.frame"
    obj = FakeFrame()  # 冒充 DataFrame 但没有 shape/columns → 必须降级而非抛出
    s = introspect.describe("fake", obj)
    assert s["preview"] == "DataFrame"
    json.dumps(s)


def test_plain_values_get_len_and_repr():
    s = introspect.describe("lst", [1, 2, 3])
    assert s == {"name": "lst", "type": "list", "len": 3, "preview": "[1, 2, 3]"}
    s2 = introspect.describe("n", 42)
    assert "len" not in s2 and s2["preview"] == "42"


def test_snapshot_skips_modules_and_dunders():
    import os

    g = {
        "__name__": "__novakernel__",
        "__builtins__": {},
        "_private": 1,
        "os": os,
        "x": [1],
        "f": lambda: None,
    }
    schemas = introspect.snapshot(g)
    names = [s["name"] for s in schemas]
    assert names == ["f", "x"]  # module/dunder/_ 前缀被跳过；按名字排序


def test_snapshot_all_json_serializable():
    g = {
        "df": pd.DataFrame({"a": [1]}),
        "arr": np.zeros((2, 2)),
        "ts": pd.Timestamp("2026-10-06"),
        "bytes": b"\x00\xff",
        "nested": {"k": [np.int64(3), np.float64("nan")]},
    }
    text = json.dumps(introspect.snapshot(g), ensure_ascii=False)
    assert "2026-10-06" in text  # Timestamp → isoformat
