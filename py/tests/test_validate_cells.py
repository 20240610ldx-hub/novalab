"""Static candidate validation must leave an executed runtime entirely unchanged."""

from copy import deepcopy

import pytest

from novakernel.runtime import KernelError, NoNotebookError, Runtime


def populated_runtime(existing_compile_error):
    notes = []
    rt = Runtime(notify=lambda method, params: notes.append((method, params)))
    cells = [
        {"id": "a", "code": "from novakernel import ui\ns = ui.slider(0, 10)\naudit = []"},
        {"id": "b", "code": "y = s.value + 1"},
        {"id": "c", "code": "audit.append(y)\nz = y * 2"},
        {"id": "d", "code": "marker = 0"},
    ]
    rt.set_cells(cells)
    assert rt.exec_cell("a", cascade=True)["ok"]
    assert rt.exec_cell("d")["ok"]
    assert rt.control_set("a::s", 7)["cascaded"] == ["b", "c"]
    # Preserve a meaningful preexisting stale flag, and optionally a compile error.
    cells[-1] = {"id": "d", "code": "def broken(:" if existing_compile_error else "marker = 1"}
    rt.set_cells(cells)
    assert rt.stale == {"d"}
    assert bool(rt.compile_error) == existing_compile_error
    notes.clear()
    return rt, cells, notes


def snapshot(rt):
    # Keep identities as well as contents: replacing the globals/controls/graph with
    # copies is not valid rollback either, since running user objects hold references.
    refs = vars(rt).copy()
    state = deepcopy({
        key: value for key, value in refs.items()
        if key not in {"globals", "controls", "_notify_raw"}
    })
    return refs, state, {
        "globals": dict(rt.globals),
        "controls": dict(rt.controls),
        "control_values": {key: deepcopy(value.payload()) for key, value in rt.controls.items()},
        "audit": list(rt.globals["audit"]),
    }


def assert_unchanged(rt, before, notes):
    refs, state, objects = before
    assert vars(rt).keys() == refs.keys()
    for key, value in refs.items():
        assert getattr(rt, key) is value, key
    for key, value in state.items():
        assert getattr(rt, key) == value, key
    assert rt.globals.keys() == objects["globals"].keys()
    for key, value in objects["globals"].items():
        assert rt.globals[key] is value, key
    assert rt.controls.keys() == objects["controls"].keys()
    for key, value in objects["controls"].items():
        assert rt.controls[key] is value
        assert value.payload() == objects["control_values"][key]
    assert rt.globals["audit"] == objects["audit"]
    assert notes == []  # no hidden execution, output, or cascade


@pytest.mark.parametrize("existing_compile_error", [False, True])
@pytest.mark.parametrize("kind", ["update", "insert", "remove", "syntax", "multiple", "cycle"])
def test_validate_preserves_all_live_state(kind, existing_compile_error, tmp_path):
    rt, original, notes = populated_runtime(existing_compile_error)
    # Candidates need not retain a preexisting compile error.
    candidate = [dict(c) for c in original]
    candidate[-1]["code"] = "marker = 2"
    written = tmp_path / "must-not-exist.txt"
    if kind == "update":
        candidate[1]["code"] = "y = s.value + 100\ns.value = 2\naudit.append(y)"
    elif kind == "insert":
        candidate.insert(1, {
            "id": "new",
            "code": f"open({str(written)!r}, 'w').write('executed')\naudit.append(99)",
        })
    elif kind == "remove":
        candidate.pop(0)  # Must not purge globals, counts or unregister the live slider.
    elif kind == "syntax":
        candidate[1]["code"] = "def invalid(:"
    elif kind == "multiple":
        candidate[1]["code"] = "s = 2"
    elif kind == "cycle":
        candidate[1]["code"] = "y = z + 1"

    before = snapshot(rt)
    out = rt.validate_cells(candidate)
    assert_unchanged(rt, before, notes)
    assert not written.exists()
    assert ("compileError" in out) == (kind in {"syntax", "multiple", "cycle"})
    assert "staleSet" not in out and "execCounts" not in out
    # Same analyzer, graph rules, payload and diagnostics as committing this candidate.
    committed = Runtime().set_cells(candidate)
    assert out == {key: value for key, value in committed.items() if key != "staleSet"}
    # Returned mutable data is detached from the live notebook too.
    out["cells"].clear()
    out["edges"].clear()
    assert_unchanged(rt, before, notes)


@pytest.mark.parametrize("cells, message", [
    (None, "param cells must be list"),
    ({}, "param cells must be list"),
    ([None], "each cell needs {id, code}"),
    ([{"id": "a"}], "each cell needs {id, code}"),
    ([{"code": "x=1"}], "each cell needs {id, code}"),
    ([{"id": "a", "code": "x=1"}, {"id": "a", "code": "y=1"}], "duplicate cell ids"),
    ([{"id": 1, "code": "x=1"}, {"id": "1", "code": "y=1"}], "duplicate cell ids"),
])
@pytest.mark.parametrize("method", ["validate_cells", "set_cells"])
def test_invalid_candidates_keep_parameter_error_contract_and_state(cells, message, method):
    rt, _, notes = populated_runtime(False)
    before = snapshot(rt)
    with pytest.raises(KernelError) as caught:
        getattr(rt, method)(cells)
    assert caught.value.code == -32602
    assert message in caught.value.message
    assert_unchanged(rt, before, notes)


def test_validate_before_load_does_not_open_a_notebook():
    rt = Runtime()
    out = rt.validate_cells([{"id": "a", "code": "x = 1"}])
    assert out == {
        "cells": [{"id": "a", "code": "x = 1", "defs": ["x"], "refs": [], "sideEffect": False}],
        "edges": [],
    }
    assert rt.graph is None and rt.cells == {} and rt.exec_counts == {}
    with pytest.raises(NoNotebookError):
        rt.exec_cell("a")
