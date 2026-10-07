"""ui.py — 交互控件（spec §15，P3.3）：Control 基类 + 工厂 + JSON-safe 序列化。

Control 是「活对象」：驻留 cell 的 globals/defs，runtime 持有 registry
{controlId: Control}（controlId = "<cellId>::<变量名>"，由 runtime 注入 control_id），
前端经 control.set 回传值 → runtime mutate 后按 DAG 级联重跑下游（spec §15.3，
Owner 裁决：控件级联绕过 mark-only；side-effect cell 仅标 stale）。

值域校验收敛在 validate()：slider clamp 到 [min,max]、checkbox 布尔化、text 字符串化、
date 归一为 ISO 'YYYY-MM-DD'（非法串 ValueError）、table 值 = 选中行索引列表
（越界过滤/去重；selection=None 恒 None；'single' 只留最后一个）。

to_jsonable：NaN/±Infinity → JS 可解析的字符串（"NaN"/"Infinity"/"-Infinity"，
裸 NaN 会破坏前端 JSON.parse）、date/datetime → isoformat、其余非基本类型 → str。
控件 mime 载荷必须是 strict JSON（allow_nan=False 兜底，见 mime_data）。
"""

from __future__ import annotations

import datetime as _dt
import json
import math

__all__ = [
    "CONTROL_MIME",
    "Control",
    "checkbox",
    "date",
    "slider",
    "table",
    "text",
    "to_jsonable",
]

CONTROL_MIME = "application/vnd.novalab.control+json"

# table spec 只携带 head N 行（run.mime 载荷 sanity；rowCount 给全量）
TABLE_ROW_LIMIT = 100


def to_jsonable(v):
    """递归转成 strict-JSON-safe 基本类型（NaN→字符串，见模块 docstring）。"""
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        if math.isfinite(v):
            return v
        if math.isnan(v):
            return "NaN"
        return "Infinity" if v > 0 else "-Infinity"
    if isinstance(v, _dt.datetime):
        return v.isoformat()
    if isinstance(v, (_dt.date, _dt.time)):
        return v.isoformat()
    if isinstance(v, dict):
        return {str(k): to_jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set, frozenset)):
        return [to_jsonable(x) for x in v]
    return str(v)


class Control:
    """控件基类：.value（校验后当前值）、.kind、.spec（渲染参数）、.payload()。

    control_id 由 runtime 在注册时注入（cell 内代码不感知）；子类覆写
    validate()（值域校验，构造与 set 共用）与 spec。
    """

    kind = "control"

    def __init__(self, value) -> None:
        self.control_id: str | None = None
        self._value = self.validate(value)

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, v) -> None:
        self._value = self.validate(v)

    def validate(self, v):
        return v

    @property
    def spec(self) -> dict:
        return {}

    def payload(self) -> dict:
        """run.mime control 载荷（冻结契约）：{controlId, kind, spec, value}。"""
        return {
            "controlId": self.control_id,
            "kind": self.kind,
            "spec": to_jsonable(self.spec),
            "value": to_jsonable(self.value),
        }

    def mime_data(self) -> str:
        """strict JSON 串。前端 store 的 mime data 通道是文本（asText 会把对象
        打成 "[object Object]"），故 data 字段承载 payload 的 JSON 序列化；
        ControlRenderer 对字符串/对象两种形态都兼容。allow_nan=False 兜底：
        to_jsonable 漏网的 NaN 宁可抛错（runtime 吞掉不发）也不发坏 JSON。"""
        return json.dumps(self.payload(), ensure_ascii=False, allow_nan=False)

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.kind} value={self._value!r}>"


def _num(x, name: str):
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        raise TypeError(f"slider: {name} must be a number, got {type(x).__name__}")
    if isinstance(x, float) and math.isnan(x):
        raise ValueError(f"slider: {name} must not be NaN")
    return x


class Slider(Control):
    kind = "slider"

    def __init__(self, start, stop, step=1, value=None, label=None) -> None:
        self._start = _num(start, "start")
        self._stop = _num(stop, "stop")
        self._step = _num(step, "step")
        if self._step == 0:
            raise ValueError("slider: step must be non-zero")
        self._lo = min(self._start, self._stop)
        self._hi = max(self._start, self._stop)
        self._label = None if label is None else str(label)
        super().__init__(self._lo if value is None else value)

    def validate(self, v):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise TypeError(f"slider value must be a number, got {type(v).__name__}")
        if isinstance(v, float) and math.isnan(v):
            raise ValueError("slider value must not be NaN")
        return max(self._lo, min(self._hi, v))  # clamp（spec §15.1 值域校验）

    @property
    def spec(self) -> dict:
        return {
            "start": self._lo,  # 归一为升序，前端 input[range] 直接用
            "stop": self._hi,
            "step": self._step,
            "label": self._label,
        }


class Checkbox(Control):
    kind = "checkbox"

    def __init__(self, value=False) -> None:
        super().__init__(value)

    def validate(self, v):
        return bool(v)


class Text(Control):
    kind = "text"

    def __init__(self, value="") -> None:
        super().__init__(value)

    def validate(self, v):
        if v is None:
            return ""
        return v if isinstance(v, str) else str(v)


class Date(Control):
    kind = "date"

    def __init__(self, value=None) -> None:
        super().__init__(value)

    def validate(self, v):
        """值 = ISO 'YYYY-MM-DD' 串或 None；date/datetime 对象归一为 ISO 串。"""
        if v is None:
            return None
        if isinstance(v, _dt.datetime):
            return v.date().isoformat()
        if isinstance(v, _dt.date):
            return v.isoformat()
        if isinstance(v, str):
            return _dt.date.fromisoformat(v.strip()).isoformat()  # 非法串 ValueError
        raise TypeError(f"date value must be ISO string or date, got {type(v).__name__}")


def _table_spec(df) -> dict:
    """df → {columns:[{name,dtype}], rows: head N（JSON-safe）, rowCount}。

    主路径 pandas DataFrame（to_json(orient='records')：NaN→null、Timestamp→epoch ms，
    天然 JSON-safe）；dict-of-columns 兜底（无 pandas 场景/测试）。
    """
    columns: list[dict] = []
    rows: list = []
    row_count = 0
    cols_attr = getattr(df, "columns", None)
    to_json = getattr(df, "to_json", None)
    if cols_attr is not None and callable(to_json):
        try:
            row_count = int(len(df))
            columns = [{"name": str(c), "dtype": str(df[c].dtype)} for c in cols_attr]
            head = df.head(TABLE_ROW_LIMIT)
            parsed = json.loads(head.to_json(orient="records", force_ascii=False))
            if isinstance(parsed, list):
                rows = parsed
        except Exception:  # noqa: BLE001 — 转换失败退化为空 rows（rowCount 仍在）
            rows = []
    elif isinstance(df, dict):
        names = [str(k) for k in df]
        series = {str(k): list(v) for k, v in df.items()}
        row_count = max((len(v) for v in series.values()), default=0)
        columns = [{"name": n, "dtype": "object"} for n in names]
        rows = [
            {n: (series[n][i] if i < len(series[n]) else None) for n in names}
            for i in range(min(row_count, TABLE_ROW_LIMIT))
        ]
    else:
        raise TypeError("table: expected a pandas DataFrame or dict of columns")
    return {"columns": columns, "rows": to_jsonable(rows), "rowCount": row_count}


class Table(Control):
    kind = "table"

    def __init__(self, df, selection=None) -> None:
        if selection not in (None, "single", "multi"):
            raise ValueError("table: selection must be None, 'single' or 'multi'")
        self._selection_mode = selection
        self._spec = _table_spec(df)
        super().__init__(None)  # value = 选中行索引列表或 None

    def validate(self, v):
        if self._selection_mode is None:
            return None
        if v is None:
            return []
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            v = [v]
        if not isinstance(v, (list, tuple)):
            raise TypeError(f"table selection must be a list of row indices, got {type(v).__name__}")
        out: list[int] = []
        for x in v:
            if isinstance(x, float) and x.is_integer():
                x = int(x)  # JSON round-trip 可能把 3 变成 3.0
            if isinstance(x, bool) or not isinstance(x, int):
                raise TypeError("table selection must be row indices (int)")
            if 0 <= x < self._spec["rowCount"] and x not in out:
                out.append(x)
        if self._selection_mode == "single":
            out = out[-1:]
        return out

    @property
    def spec(self) -> dict:
        return {**self._spec, "selection": self._selection_mode}


# -------------------------------------------------------------------- 工厂
def slider(start, stop, step=1, value=None, label=None) -> Slider:
    """数值滑杆：value 缺省 = start；越界 set 自动 clamp。"""
    return Slider(start, stop, step=step, value=value, label=label)


def checkbox(value=False) -> Checkbox:
    return Checkbox(value)


def text(value="") -> Text:
    return Text(value)


def date(value=None) -> Date:
    """日期：None 或 ISO 'YYYY-MM-DD'（date/datetime 对象也接受，归一为 ISO 串）。"""
    return Date(value)


def table(df, selection=None) -> Table:
    """表格选择：value = 选中行索引列表（selection=None 时恒 None）。"""
    return Table(df, selection=selection)
