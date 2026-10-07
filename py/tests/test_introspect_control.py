"""introspect × Control（P3.3 接线）：活对象进 schema 为 Control[kind] + 值预览。"""

from novakernel import ui
from novakernel.introspect import describe


def test_control_schema_type_and_preview():
    s = ui.slider(0, 10, value=3)
    sch = describe("s", s)
    assert sch["type"] == "Control[slider]"
    assert sch["preview"] == 3


def test_control_schema_json_safe_value():
    t = ui.checkbox(True)
    sch = describe("t", t)
    assert sch["type"] == "Control[checkbox]"
    assert sch["preview"] is True
