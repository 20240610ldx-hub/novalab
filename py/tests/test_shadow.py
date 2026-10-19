"""ADR-013 S1/S2 影子内核纯函数单测：摘要器（M5 白名单）、traceback 脱敏、闭包规划、
非确定性检测、声明式契约求值。不装沙箱（审计钩子装上卸不掉），进程级行为见
test_shadow_process.py。"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from novakernel import shadow

CANARY = "CANARY_ROW_7f3a"


# ----------------------------------------------------------------- summarizer


def _pop_frame(n: int = 40) -> pd.DataFrame:
    rng = np.random.default_rng(1)
    return pd.DataFrame({
        "county": [f"县{i % 7}" for i in range(n)],
        "name": [CANARY if i == 3 else f"name-{i}" for i in range(n)],
        "pop": rng.integers(100, 1000, n),
        "rate": rng.random(n),
    })


def test_dataframe_summary_has_schema_and_stats_but_no_rows():
    s = shadow.summarize_value(_pop_frame())
    assert s["schema"]["type"] == "DataFrame"
    assert s["schema"]["shape"] == [40, 4]
    assert s["schema"]["columns"] == ["county", "name", "pop", "rate"]
    assert set(s["schema"]["dtypes"]) == {"county", "name", "pop", "rate"}
    pop = s["stats"]["columns"]["pop"]
    assert pop["count"] == 40 and pop["nullCount"] == 0
    for key in ("sum", "mean", "std", "min", "max", "p05", "p50", "p95"):
        assert isinstance(pop[key], (int, float))
    name = s["stats"]["columns"]["name"]
    assert name == {"count": 40, "nullCount": 0, "nUnique": 40}
    assert "preview" not in s["schema"]
    assert CANARY not in repr(s)
    assert "县0" not in repr(s)  # 分类标签不出（O4）


def test_small_cell_suppression_k10():
    df = pd.DataFrame({"pop": [987654.321, 1.0, 2.0]})
    s = shadow.summarize_value(df, k=10)
    col = s["stats"]["columns"]["pop"]
    assert col == {"count": 3, "nullCount": 0, "suppressed": True}
    assert "987654" not in repr(s)


def test_numbers_rounded_to_4_significant_digits():
    df = pd.DataFrame({"x": [123456.789] * 12})
    col = shadow.summarize_value(df)["stats"]["columns"]["x"]
    assert col["mean"] == 123500.0
    assert col["sum"] == float(f"{123456.789 * 12:.4g}")


def test_column_limit_and_ndarray_series_scalars():
    wide = pd.DataFrame({f"c{i}": range(12) for i in range(60)})
    s = shadow.summarize_value(wide, max_columns=50)
    assert len(s["stats"]["columns"]) == 50 and s["stats"]["truncatedColumns"] == 10

    arr = shadow.summarize_value(np.arange(20, dtype=float).reshape(4, 5))
    assert arr["schema"] == {"type": "ndarray", "shape": [4, 5], "dtype": "float64"}
    assert arr["stats"]["values"]["count"] == 20

    ser = shadow.summarize_value(pd.Series([1.0, None] * 6, name="s"))
    assert ser["schema"]["type"] == "Series"
    assert ser["stats"]["values"]["nullCount"] == 6

    # 标量与字符串可能就是单条原始值：只给类型（与长度）
    assert shadow.summarize_value(42.5) == {"schema": {"type": "float"}}
    assert shadow.summarize_value(CANARY) == {"schema": {"type": "str", "len": len(CANARY)}}
    assert shadow.summarize_value([1, 2, 3]) == {"schema": {"type": "list", "len": 3}}


def test_nan_inf_are_json_safe():
    df = pd.DataFrame({"x": [math.inf] + [1.0] * 11})
    col = shadow.summarize_value(df)["stats"]["columns"]["x"]
    for v in col.values():
        assert not (isinstance(v, float) and (math.isnan(v) or math.isinf(v)))


def test_delta_reports_shape_columns_dtypes_and_stat_changes():
    before = shadow.summarize_value(_pop_frame())
    after_df = _pop_frame().drop(columns=["rate"]).iloc[:30]
    after_df["pop"] = after_df["pop"].astype(float)
    after = shadow.summarize_value(after_df)
    d = shadow.delta(before, after)
    assert d["shape"] == {"before": [40, 4], "after": [30, 3]}
    assert d["columnsRemoved"] == ["rate"]
    assert d["dtypeChanges"]["pop"]["after"] == "float64"
    assert d["stats"]["pop"]["count"] == -10


# ------------------------------------------------------------ traceback scrub


def test_traceback_scrubs_literals_not_in_source_and_keeps_code_literals():
    code = "x = float(v)\n"
    try:
        exec(compile(code, "<cell c1>", "exec"), {"v": "张三"})
    except ValueError as e:
        tb = shadow.scrub_traceback(e, {"<cell c1>": code})
    assert "张三" not in tb
    assert "'<value>'" in tb
    assert '<cell c1>", line 1' in tb

    code2 = "y = d['pop']\n"
    try:
        exec(compile(code2, "<cell c2>", "exec"), {"d": {}})
    except KeyError as e:
        tb2 = shadow.scrub_traceback(e, {"<cell c2>": code2})
    assert "KeyError: 'pop'" in tb2


def test_traceback_library_paths_are_shortened():
    code = "import pandas as pd\npd.DataFrame({'a': [1]})['zz']\n"
    try:
        exec(compile(code, "<cell c3>", "exec"), {})
    except KeyError as e:
        tb = shadow.scrub_traceback(e, {"<cell c3>": code})
    assert "site-packages" not in tb
    assert "<lib>/pandas/" in tb


# ----------------------------------------------------------------- planning


CELLS = [
    {"id": "a", "code": "import math\nbase = 10"},
    {"id": "b", "code": "mid = base * 2"},
    {"id": "c", "code": "side = base + 1"},
    {"id": "d", "code": "out = mid + 1"},
]


def test_plan_closure_and_upstream():
    cand = [dict(c) for c in CELLS]
    cand[1] = {"id": "b", "code": "mid = base * 3"}
    p = shadow.plan_variant(CELLS, cand)
    assert p["changed"] == ["b"]
    assert p["closure"] == ["b", "d"]
    assert p["upstream"] == ["a"]
    base_plan = shadow.plan_baseline(CELLS, [p])
    assert base_plan["closure"] == ["b", "d"] and base_plan["upstream"] == ["a"]


def test_plan_insert_below_new_cell():
    cand = CELLS[:2] + [{"id": "__new_0__", "code": "mid2 = mid + 5"}] + CELLS[2:]
    p = shadow.plan_variant(CELLS, cand)
    assert p["changed"] == ["__new_0__"]
    assert p["closure"] == ["__new_0__"]
    assert p["upstream"] == ["a", "b"]


def test_nondeterminism_detection():
    assert shadow.detect_nondeterminism("rng = np.random.default_rng()") == ["unseeded-rng"]
    assert shadow.detect_nondeterminism("rng = np.random.default_rng(42)") == []
    assert shadow.detect_nondeterminism("import datetime\nt = datetime.datetime.now()") == ["wall-clock"]
    assert shadow.detect_nondeterminism("import uuid\nu = uuid.uuid4()") == ["entropy"]


# ---------------------------------------------------------------- contracts


def _namespaces():
    raw = pd.DataFrame({
        "poi_id": [1, 2, 3, 4, 5, 6],
        "code": ["010101", "010102", "010101", None, "010103", "010102"],
        "lon": [120.1, 121.0, 300.0, 122.2, 123.0, 119.9],
        "pop": [10, 20, 30, 40, 50, 60],
    })
    clean = raw.drop(index=[2]).reset_index(drop=True)
    mig = np.array([[0.9, 0.1], [0.2, 0.7]])
    return {"before": {"df": raw}, "after": {"df": clean, "raw": raw, "mig": mig}}


def _one(contract):
    (r,) = shadow.evaluate_contracts([contract], _namespaces())
    return r


def test_columns_dtype_notnull_unique_range():
    assert _one({"kind": "columns_present", "target": "df", "columns": ["poi_id", "lon"]})["status"] == "pass"
    r = _one({"kind": "columns_present", "target": "df", "columns": ["poi_id", "zz"]})
    assert r["status"] == "fail" and r["violations"] == 1
    assert _one({"kind": "dtype", "target": "df", "column": "pop", "expect": "int"})["status"] == "pass"
    assert _one({"kind": "dtype", "target": "df", "column": "code", "expect": "numeric"})["status"] == "fail"
    nn = _one({"kind": "not_null", "target": "df", "columns": ["code"]})
    assert nn["status"] == "fail" and nn["violations"] == 1 and nn["total"] == 5
    assert _one({"kind": "unique_key", "target": "df", "columns": ["poi_id"]})["status"] == "pass"
    uk = _one({"kind": "unique_key", "target": "df", "columns": ["code"]})
    assert uk["status"] == "fail" and uk["violations"] >= 1
    rg = _one({"kind": "range", "target": "df", "column": "lon", "min": 118, "max": 126, "phase": "before"})
    assert rg["status"] == "fail" and rg["violations"] == 1 and rg["phase"] == "before"


def test_row_count_sum_conserved_row_sums_match_rate_equivalent():
    rc = _one({"kind": "row_count", "target": "df", "op": "==", "ref": {"target": "df", "phase": "before"}})
    assert rc["status"] == "fail" and rc["violations"] == 1
    assert _one({"kind": "row_count", "target": "df", "op": "<=", "ref": {"target": "df", "phase": "before"}})["status"] == "pass"

    sc = _one({
        "kind": "sum_conserved",
        "before": {"target": "df", "column": "pop", "phase": "before"},
        "after": {"target": "df", "column": "pop"},
        "rtol": 1e-9,
    })
    assert sc["status"] == "fail" and sc["maxAbsDiff"] == 30
    same = _one({
        "kind": "sum_conserved",
        "before": {"target": "raw", "column": "pop", "phase": "after"},
        "after": {"target": "df", "column": "pop", "phase": "before"},
    })
    assert same["status"] == "pass"

    rs = _one({"kind": "row_sums", "target": "mig", "expect": 1.0, "atol": 1e-9})
    assert rs["status"] == "fail" and rs["violations"] == 1 and rs["total"] == 2

    # 空键不算匹配：5 行里 1 行 code 为空 → 0.8
    mr = _one({"kind": "match_rate", "left": "df", "right": "raw", "on": ["code"], "min": 0.99})
    assert mr["status"] == "fail" and mr["total"] == 5 and mr["violations"] == 1
    assert _one({"kind": "match_rate", "left": "df", "right": "raw", "on": ["poi_id"], "min": 0.99})["status"] == "pass"

    eq = _one({"kind": "equivalent", "targets": ["df"]})
    assert eq["status"] == "fail" and eq["reason"] == "structure-mismatch"


def test_contract_errors_are_enumerated_not_raised():
    assert _one({"kind": "not_null", "target": "nope", "columns": ["a"]})["reason"] == "unknown-target"
    assert _one({"kind": "not_null", "target": "df", "columns": ["zz"]})["reason"] == "unknown-column"
    assert _one({"kind": "frobnicate"})["reason"] == "invalid-params"
    r = _one({"kind": "range", "target": "df", "column": "code", "min": 0})
    assert r["status"] == "error" and r["reason"] == "unsupported-type"


def test_contract_results_never_echo_values():
    out = repr(shadow.evaluate_contracts(
        [{"kind": "unique_key", "target": "df", "columns": ["code"]},
         {"kind": "range", "target": "df", "column": "lon", "max": 126, "phase": "before"}],
        _namespaces(),
    ))
    assert "010101" not in out and "300" not in out


# ------------------------------------- skill-pack contracts (mapping / margins)


def _skill_ns():
    src = pd.DataFrame({"g": ["a", "b", "c", "a"], "n": [1, 2, 3, 4], "k": [1, 2, 3, 1]})
    dst = pd.DataFrame({"h": ["X", "Y"], "n": [7, 3]})
    off = pd.DataFrame({"h": ["X", "Y"], "n": [7, 2]})
    rows = pd.DataFrame({"h": ["X", "X", "X", "Y"]})
    seed = pd.DataFrame([[1.0, 2.0], [3.0, 4.0]], index=["r1", "r2"], columns=["c1", "c2"])
    return {
        "before": {"src": src},
        "after": {
            "src": src, "dst": dst, "off": off, "rows": rows, "seed": seed,
            "mat": seed.to_numpy(), "m": {"a": "X", "b": "X", "c": "Y"},
            "m_int": {1: "X", 2: "X", 3: "Y"},
            "row_t": pd.Series([7.0, 3.0], index=["r2", "r1"]), "col_t": np.array([4.0, 6.0]),
        },
    }


def _skill(contract):
    (r,) = shadow.evaluate_contracts([contract], _skill_ns())
    return r


MAPPING = {"a": "X", "b": "X", "c": "Y"}


def test_mapping_conserved_sums_per_target_category():
    ok = _skill({
        "kind": "mapping_conserved", "mapping": MAPPING,
        "before": {"target": "src", "column": "g", "value": "n", "phase": "before"},
        "after": {"target": "dst", "column": "h", "value": "n"},
    })
    assert ok == {"id": "c1", "kind": "mapping_conserved", "status": "pass", "total": 2,
                  "violations": 0, "unmapped": 0, "maxAbsDiff": 0.0}
    bad = _skill({
        "kind": "mapping_conserved", "mapping": MAPPING,
        "before": {"target": "src", "column": "g", "value": "n"},
        "after": {"target": "off", "column": "h", "value": "n"},
    })
    assert bad["status"] == "fail" and bad["violations"] == 1 and bad["maxAbsDiff"] == 1.0


def test_mapping_conserved_counts_unmapped_source_categories():
    r = _skill({
        "kind": "mapping_conserved", "mapping": {"a": "X", "b": "X"},
        "before": {"target": "src", "column": "g", "value": "n"},
        "after": {"target": "dst", "column": "h", "value": "n"},
    })
    # "c" 没有映射：未映射类别 1 个；Y 组的期望为 0、实际为 3 → 再计 1 个不守恒组
    assert r["status"] == "fail" and r["unmapped"] == 1 and r["violations"] == 2


def test_mapping_conserved_row_counts_and_namespace_mappings():
    counts = _skill({
        "kind": "mapping_conserved", "mapping": "m",
        "before": {"target": "src", "column": "g"},
        "after": {"target": "rows", "column": "h"},
    })
    assert counts["status"] == "pass" and counts["total"] == 2
    # JSON 映射的键总是字符串；数值类别按字符串形式匹配，命名空间里的 int 键也可以
    for mapping in ({"1": "X", "2": "X", "3": "Y"}, "m_int"):
        r = _skill({
            "kind": "mapping_conserved", "mapping": mapping,
            "before": {"target": "src", "column": "k", "value": "n"},
            "after": {"target": "dst", "column": "h", "value": "n"},
        })
        assert r["status"] == "pass", mapping
    assert _skill({
        "kind": "mapping_conserved", "mapping": "nope",
        "before": {"target": "src", "column": "g"}, "after": {"target": "rows", "column": "h"},
    })["reason"] == "unknown-target"


def test_margins_match_reports_residuals():
    ok = _skill({"kind": "margins_match", "target": "mat", "rows": [3, 7], "cols": [4, 6]})
    assert ok["status"] == "pass" and ok["total"] == 4 and ok["violations"] == 0 and ok["phase"] == "after"
    bad = _skill({"kind": "margins_match", "target": "mat", "rows": [3, 8]})
    assert bad["status"] == "fail" and bad["violations"] == 1 and bad["maxAbsDiff"] == 1.0
    # 表 + 带索引的 Series：按标签对齐，而不是按位置
    aligned = _skill({"kind": "margins_match", "target": "seed", "rows": "row_t", "cols": "col_t"})
    assert aligned["status"] == "pass"
    assert _skill({"kind": "margins_match", "target": "mat", "rows": [1, 2, 3]})["reason"] == "invalid-params"
    assert _skill({"kind": "margins_match", "target": "mat"})["reason"] == "invalid-params"
    rel = _skill({"kind": "margins_match", "target": "mat", "rows": [3.03, 7], "rtol": 0.02})
    assert rel["status"] == "pass"


def test_skill_contracts_never_echo_labels():
    out = repr(shadow.evaluate_contracts([
        {"kind": "mapping_conserved", "mapping": {"a": "SECRET_LABEL"},
         "before": {"target": "src", "column": "g"}, "after": {"target": "rows", "column": "h"}},
        {"kind": "margins_match", "target": "seed", "rows": "row_t"},
    ], _skill_ns()))
    assert "SECRET_LABEL" not in out and "'X'" not in out and "r1" not in out


# ------------------------------------------------- auto checks (domain-neutral)


def _auto(before: dict, after: dict) -> dict:
    return {c["id"]: c for c in shadow.auto_checks(before, after, sorted(after))}


def test_auto_checks_are_shape_based_not_name_based():
    # 名字刻意与领域无关：触发只看数据形态
    stoch = np.array([[0.5, 0.5], [0.2, 0.8]])
    broken = np.array([[0.5, 0.4], [0.2, 0.8]])
    got = _auto({"zz_q": stoch}, {"zz_q": broken})
    assert got["auto:row_stochastic:zz_q"]["status"] == "fail"
    assert got["auto:row_stochastic:zz_q"]["violations"] == 1
    ok = _auto({"zz_q": stoch}, {"zz_q": stoch.copy()})
    assert ok["auto:row_stochastic:zz_q"]["status"] == "pass"
    # 非随机矩阵不触发
    assert _auto({"m": np.eye(2) * 3}, {"m": np.eye(2)}) == {}


def test_auto_data_quality_regressions():
    b = pd.DataFrame({"x": [1.0, 2.0, 3.0] * 4, "y": list("abcdabcdabcd")})
    a = pd.DataFrame({"x": [np.inf, np.nan, np.nan] * 4, "y": [None] * 12})
    got = _auto({"t": b}, {"t": a})
    assert got["auto:all_null_column:t"]["status"] == "fail"
    assert got["auto:inf_values:t"]["status"] == "fail"
    assert got["auto:null_rate:t"]["status"] == "fail"
    empty = _auto({"t": b}, {"t": b.iloc[0:0]})
    assert empty["auto:non_empty:t"]["status"] == "fail"
    # 无回归时不报告数据质量项
    assert _auto({"t": b}, {"t": b.copy()}) == {}
    assert "abcd" not in repr(got)


def test_core_checks_contain_no_domain_vocabulary():
    import inspect

    src = inspect.getsource(shadow.auto_checks) + inspect.getsource(shadow._row_stochastic)
    for word in ("mig", "pop", "trans", "prob", "county", "poi", "人口", "迁移"):
        assert word not in src.lower()
