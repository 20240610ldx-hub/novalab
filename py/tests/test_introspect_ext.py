"""test_introspect_ext.py — P3.5 嗅探扩展单测。

scipy / geopandas **未装于 venv**（只装 numpy/pandas/matplotlib）→ 用 fake 类
验证 duck-typing 探测（类名/属性）与字段提取，不硬依赖真实库。
覆盖：sparse（format/nnz/shape，无 preview）、GeoDataFrame（crs/bounds/geometry 列）、
set/frozenset/dict（len + 前 5 键）、dataclass（字段名）、bytes（hex 前 32）、
ndarray dtype 明细、结构化 preview 的 200 字符预算。
"""

import dataclasses
import json

import pytest

from novakernel import introspect

np = pytest.importorskip("numpy")
pd = pytest.importorskip("pandas")


# ---------------------------------------------------------------------
# fake scipy.sparse / geopandas（duck-typing 探测目标）
# ---------------------------------------------------------------------

def _fake_sparse(name: str = "csr_matrix", module: str = "scipy.sparse._csr",
                 fmt: str = "csr", nnz: int = 3, shape=(4, 5)):
    class Fake:
        pass

    Fake.__name__ = name
    Fake.__module__ = module
    obj = Fake()
    obj.format = fmt  # type: ignore[attr-defined]
    obj.nnz = nnz  # type: ignore[attr-defined]
    obj.shape = shape  # type: ignore[attr-defined]
    return obj


class _FakeGeomCol:
    name = "geom"
    geom_type = "Point"


def _fake_geodf(name: str = "GeoDataFrame", module: str = "geopandas.geodataframe",
                crs="EPSG:4326", bounds=(0.0, 1.0, 2.0, 3.0), geom=_FakeGeomCol()):
    class Fake:
        pass

    Fake.__name__ = name
    Fake.__module__ = module
    obj = Fake()
    obj.shape = (2, 3)  # type: ignore[attr-defined]
    obj.columns = ["geom", "pop"]  # type: ignore[attr-defined]
    obj.crs = crs  # type: ignore[attr-defined]
    obj.total_bounds = bounds  # type: ignore[attr-defined]
    obj.geometry = geom  # type: ignore[attr-defined]
    return obj


# ---------------------------------------------------------------------
# scipy.sparse（duck-typing，无 preview）
# ---------------------------------------------------------------------

def test_sparse_schema_fields_and_no_preview():
    s = introspect.describe("sp", _fake_sparse())
    assert s["name"] == "sp" and s["type"] == "csr_matrix"
    assert s["format"] == "csr" and s["nnz"] == 3 and s["shape"] == [4, 5]
    assert "preview" not in s  # spec：sparse 无 preview
    json.dumps(s)


def test_sparse_detected_by_attributes_without_scipy_module():
    # 类名/模块都不像 scipy → 仍按 nnz+format+shape 属性 duck-typing 命中
    s = introspect.describe("sp", _fake_sparse(name="MyWeirdSparse", module="tests.fake"))
    assert s["format"] == "csr" and s["nnz"] == 3


def test_sparse_bad_attrs_degrade_to_type_name():
    class Bad:
        format = "coo"
        shape = (2, 2)

        @property
        def nnz(self):
            raise RuntimeError("boom")

    s = introspect.describe("bad", Bad())
    assert s["preview"] == "Bad"  # 描述失败 → 降级而非抛出
    json.dumps(s)


# ---------------------------------------------------------------------
# geopandas GeoDataFrame（crs 名 / bounds 四元 / geometry 类型列）
# ---------------------------------------------------------------------

def test_geodataframe_schema_fields():
    s = introspect.describe("gdf", _fake_geodf())
    assert s["type"] == "GeoDataFrame"
    assert s["crs"] == "EPSG:4326"
    assert s["bounds"] == [0.0, 1.0, 2.0, 3.0] and len(s["bounds"]) == 4
    assert s["geometryColumn"] == "geom" and s["geometryType"] == "Point"
    assert s["shape"] == [2, 3]
    json.dumps(s)


def test_geodataframe_crs_none():
    s = introspect.describe("gdf", _fake_geodf(crs=None))
    assert s["crs"] is None


def test_geodataframe_nonfinite_bounds_json_safe():
    s = introspect.describe("gdf", _fake_geodf(bounds=(float("nan"), 0.0, float("inf"), 3.0)))
    assert s["bounds"] == ["nan", 0.0, "inf", 3.0]
    text = json.dumps(s)  # 严格 JSON：不允许裸 NaN/Infinity
    assert "NaN" not in text and "Infinity" not in text


def test_geodataframe_detected_by_attributes_without_name():
    # 类名不叫 GeoDataFrame → columns+geometry+crs+total_bounds 属性组合命中
    s = introspect.describe("g", _fake_geodf(name="CustomGeo", module="mygeo"))
    assert s["crs"] == "EPSG:4326" and s["geometryColumn"] == "geom"


# ---------------------------------------------------------------------
# set / frozenset / dict（len + 前 5 键预览，JSON-safe 字符串）
# ---------------------------------------------------------------------

def test_set_len_and_first5_preview():
    s = introspect.describe("st", set(range(10)))
    assert s["type"] == "set" and s["len"] == 10
    preview = json.loads(s["preview"])  # preview 本身是 JSON 字符串
    assert len(preview) == 5 and set(preview) <= set(range(10))
    json.dumps(s)


def test_frozenset_preview():
    s = introspect.describe("fs", frozenset({1, 2}))
    assert s["type"] == "frozenset" and s["len"] == 2
    assert sorted(json.loads(s["preview"])) == [1, 2]


def test_dict_preview_shows_keys_not_values():
    d = {f"k{i}": i * 1000 for i in range(8)}
    s = introspect.describe("d", d)
    assert s["len"] == 8
    assert json.loads(s["preview"]) == ["k0", "k1", "k2", "k3", "k4"]
    assert "1000" not in s["preview"]  # 值不进 preview


def test_dict_nonstring_keys_are_json_safe():
    s = introspect.describe("d", {1: "a", 2.5: "b", (3, 4): "c"})
    assert json.loads(s["preview"]) == [1, 2.5, [3, 4]]  # tuple 键 → list；json.dumps 永不炸
    json.dumps(s)


def test_keyed_preview_capped_at_200_chars():
    big = {("k" * 80 + str(i)): i for i in range(6)}
    s = introspect.describe("big", big)
    assert len(s["preview"]) <= 200


# ---------------------------------------------------------------------
# dataclass 实例（字段名列表）
# ---------------------------------------------------------------------

@dataclasses.dataclass
class Point:
    x: int
    y: int = 0


def test_dataclass_fields_listed():
    s = introspect.describe("p", Point(1, 2))
    assert s["type"] == "Point" and s["fields"] == ["x", "y"]
    assert "Point(x=1, y=2)" in s["preview"]
    json.dumps(s)


def test_dataclass_class_object_not_instance_is_generic():
    s = introspect.describe("Point", Point)  # 类本身 → 不按实例处理
    assert "fields" not in s


# ---------------------------------------------------------------------
# bytes（hex 前 32）/ ndarray dtype 明细 / preview 200 字符预算
# ---------------------------------------------------------------------

def test_bytes_preview_is_hex_first32():
    b = bytes(range(64))
    s = introspect.describe("b", b)
    assert s["preview"] == b[:32].hex() + "…" and s["len"] == 64


def test_short_bytes_hex_without_ellipsis():
    s = introspect.describe("b", b"\x00\xff")
    assert s["preview"] == "00ff"


def test_bytes_inside_structured_preview_hexified():
    df = pd.DataFrame({"b": [b"\xde\xad\xbe\xef"]})
    s = introspect.describe("df", df)
    assert s["preview"] == [{"b": "deadbeef"}]  # NaN/Inf/bytes 规则一致生效
    json.dumps(s)


def test_ndarray_dtype_detail():
    arr = np.zeros((2, 3), dtype="float32")
    s = introspect.describe("arr", arr)
    assert s["dtype"] == "float32"
    assert s["dtypeDetail"] == {"kind": "f", "itemsize": 4}
    assert s["shape"] == [2, 3] and s["preview"] == [0.0] * 6


def test_wide_dataframe_preview_falls_back_to_capped_string():
    df = pd.DataFrame({f"col_{i:03d}": [i] for i in range(60)})  # head(1) 记录 JSON > 200
    s = introspect.describe("df", df)
    preview = s["preview"]
    assert isinstance(preview, str) and len(preview) <= 200  # 超限 → 截断字符串
    json.dumps(s)


def test_object_array_long_string_preview_capped():
    arr = np.array(["x" * 300])
    s = introspect.describe("arr", arr)
    assert isinstance(s["preview"], str) and len(s["preview"]) <= 200


def test_small_structured_preview_stays_structured():
    df = pd.DataFrame({"a": [1]})
    s = introspect.describe("df", df)
    assert s["preview"] == [{"a": 1}]  # ≤200 → 保留结构（既有契约不回退）


def test_snapshot_mixed_new_types_all_json_serializable():
    g = {
        "sp": _fake_sparse(),
        "gdf": _fake_geodf(),
        "st": {1, 2, 3},
        "p": Point(1),
        "raw": bytes(range(40)),
        "arr": np.arange(4),
    }
    text = json.dumps(introspect.snapshot(g), ensure_ascii=False)
    assert "csr_matrix" in text and "GeoDataFrame" in text
    assert "NaN" not in text
