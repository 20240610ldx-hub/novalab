"""Content conflicts use synthetic tmp_path notebooks; no user code is executed."""

import hashlib
import io
import json
import os
import stat
import tempfile
from pathlib import Path

import pytest

from novakernel import serialize
from novakernel.runtime import KernelError, Runtime
from novakernel.server import Server


CELL_ID = "aaaaaaaa"
HEADER = ["# /// script", '# requires-python = ">=3.11"', "# dependencies = []", "# ///", "# [novalab] mode=manual"]
ORIGINAL = serialize.write([{"id": CELL_ID, "code": "x = 1"}], header_lines=HEADER).encode("utf-8")
CANDIDATE = [{"id": CELL_ID, "code": "x = 2\nprivate_candidate = 'synthetic-only'"}]


def saved_ok(target):
    """D4: a successful save reports the fingerprint of the bytes now on disk (its new baseline)."""
    return {"ok": True, "baselineSha256": hashlib.sha256(target.read_bytes()).hexdigest()}


def setup(tmp_path, raw=ORIGINAL):
    target = tmp_path / "notebook.py"
    target.write_bytes(raw)
    notes = []
    runtime = Runtime(notify=lambda method, params: notes.append((method, params)))
    runtime.load_file(str(target))
    # Seed state directly: conflict/backup must not reset or mutate a live kernel.
    runtime.globals["sentinel"] = object()
    runtime.exec_counts[CELL_ID] = 7
    runtime.stale.add(CELL_ID)
    return runtime, target, notes


def state_identity(runtime):
    return (runtime.globals, runtime.cells, runtime.graph, runtime.controls,
            dict(runtime.exec_counts), set(runtime.stale), dict(runtime.defined_by),
            list(runtime.header_lines), dict(runtime.config))


def assert_conflict(exc, target, candidate=CANDIDATE):
    assert exc.code == -32002
    assert exc.data["kind"] == "external-modification"
    assert exc.data["notebookPath"] == str(target)
    recovery = Path(exc.data["recoveryPath"])
    assert recovery.parent == target.parent
    assert recovery.suffix == ".py"
    assert recovery.read_bytes() == serialize.write(candidate, header_lines=HEADER).encode("utf-8")
    assert "synthetic-only" not in exc.message
    assert "private_candidate" not in json.dumps(exc.data)
    return recovery


def test_same_length_same_mtime_conflict_preserves_disk_and_runtime(tmp_path):
    runtime, target, notes = setup(tmp_path)
    before = state_identity(runtime)
    original_stat = target.stat()
    external = ORIGINAL.replace(b"x = 1", b"x = 9")
    assert len(external) == len(ORIGINAL)
    target.write_bytes(external)
    os.utime(target, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    with pytest.raises(KernelError) as caught:
        runtime.save_file(str(target), CANDIDATE)
    assert_conflict(caught.value, target)
    assert target.read_bytes() == external
    assert state_identity(runtime) == before
    assert notes == []
    # Rejection never acknowledges the external version as a new baseline.
    with pytest.raises(KernelError) as again:
        runtime.save_file(str(target), CANDIDATE)
    assert again.value.data["recoveryPath"] == caught.value.data["recoveryPath"]
    assert target.read_bytes() == external
    target.write_bytes(ORIGINAL)
    assert runtime.save_file(str(target), CANDIDATE) == saved_ok(target)


def test_deleted_target_is_conflict_without_recreating_target(tmp_path):
    runtime, target, notes = setup(tmp_path)
    before = state_identity(runtime)
    target.unlink()
    with pytest.raises(KernelError) as caught:
        runtime.save_file(str(target), CANDIDATE)
    assert_conflict(caught.value, target)
    assert not target.exists()
    assert state_identity(runtime) == before
    assert notes == []


def test_load_reads_raw_bytes_once_and_normalizes_newlines(tmp_path, monkeypatch):
    raw = ORIGINAL.replace(b"\n", b"\r\n")
    runtime, target, _ = setup(tmp_path, raw)
    assert runtime.cells[CELL_ID].code == "x = 1"
    assert runtime.header_lines == HEADER + [""]
    # load_file must parse the very same bytes used as its baseline, not parse_file re-reading.
    monkeypatch.setattr(serialize, "parse_file", lambda path: pytest.fail("second file read"))
    runtime.load_file(str(target))
    assert runtime.save_file(str(target), [{"id": CELL_ID, "code": "x = 2"}]) == saved_ok(target)
    assert b"\r" not in target.read_bytes()


def test_line_ending_only_change_is_a_content_conflict(tmp_path):
    runtime, target, _ = setup(tmp_path)
    external = ORIGINAL.replace(b"\n", b"\r\n")
    target.write_bytes(external)
    with pytest.raises(KernelError) as caught:
        runtime.save_file(str(target), CANDIDATE)
    assert_conflict(caught.value, target)
    assert target.read_bytes() == external


def test_success_advances_baseline_to_actual_saved_bytes(tmp_path):
    runtime, target, notes = setup(tmp_path)
    assert runtime.save_file(str(target), CANDIDATE) == saved_ok(target)
    second = [{"id": CELL_ID, "code": "x = 3"}]
    assert runtime.save_file(str(target), second) == saved_ok(target)
    assert target.read_bytes() == serialize.write(second, header_lines=HEADER).encode("utf-8")
    assert runtime.exec_counts[CELL_ID] == 7
    assert notes == []


def test_write_failure_keeps_baseline_and_original_runtime(tmp_path, monkeypatch):
    runtime, target, notes = setup(tmp_path)
    before = state_identity(runtime)
    write_file = serialize.write_file

    def fail_write(path, text):
        raise OSError("synthetic disk failure")

    monkeypatch.setattr(serialize, "write_file", fail_write)
    with pytest.raises(OSError, match="synthetic disk failure"):
        runtime.save_file(str(target), CANDIDATE)
    assert target.read_bytes() == ORIGINAL
    assert state_identity(runtime) == before
    monkeypatch.setattr(serialize, "write_file", write_file)
    assert runtime.save_file(str(target), CANDIDATE) == saved_ok(target)
    assert notes == []


def test_directory_write_failure_stays_internal_and_retry_uses_original_bytes(tmp_path):
    runtime, target, _ = setup(tmp_path)
    target.unlink()
    target.mkdir()
    server = Server(stdin=io.StringIO(json.dumps({
        "id": 1, "method": "save_file", "params": {"path": str(target), "cells": CANDIDATE},
    }) + "\n"), stdout=io.StringIO())
    server.runtime = runtime
    server.run()
    response = json.loads(server._out.getvalue())
    assert response["error"]["code"] == -32000
    assert "data" not in response["error"]
    target.rmdir()
    target.write_bytes(ORIGINAL)
    assert runtime.save_file(str(target), CANDIDATE) == saved_ok(target)


def test_backup_is_pure_and_keeps_baseline(tmp_path):
    runtime, target, notes = setup(tmp_path)
    before = state_identity(runtime)
    result = runtime.backup_file(str(target), CANDIDATE)
    assert Path(result["recoveryPath"]).read_bytes() == serialize.write(CANDIDATE, header_lines=HEADER).encode("utf-8")
    assert target.read_bytes() == ORIGINAL
    assert state_identity(runtime) == before
    assert notes == []
    assert runtime.save_file(str(target), CANDIDATE) == saved_ok(target)


def test_backup_failure_has_safe_data_and_keeps_state(tmp_path, monkeypatch):
    runtime, target, notes = setup(tmp_path)
    before = state_identity(runtime)

    def fail(*args, **kwargs):
        raise RuntimeError("private_candidate = 'synthetic-only'")

    monkeypatch.setattr(tempfile, "mkstemp", fail)
    with pytest.raises(KernelError) as caught:
        runtime.backup_file(str(target), CANDIDATE)
    assert caught.value.code == -32000
    assert caught.value.data == {
        "kind": "recovery-failure", "notebookPath": str(target), "recoveryPath": None,
        "recoveryError": "Unable to preserve the local notebook copy.",
    }
    assert "synthetic-only" not in str(caught.value) + json.dumps(caught.value.data)
    assert target.read_bytes() == ORIGINAL
    assert state_identity(runtime) == before
    assert notes == []


def test_backup_of_external_changed_file_does_not_acknowledge_external_baseline(tmp_path):
    runtime, target, _ = setup(tmp_path)
    external = ORIGINAL.replace(b"x = 1", b"x = 9")
    target.write_bytes(external)
    copied = runtime.backup_file(str(target), CANDIDATE)["recoveryPath"]
    with pytest.raises(KernelError) as caught:
        runtime.save_file(str(target), CANDIDATE)
    assert caught.value.data["recoveryPath"] == copied
    assert target.read_bytes() == external


def test_backup_reuses_only_existing_unchanged_candidate(tmp_path):
    runtime, target, _ = setup(tmp_path)
    first = runtime.backup_file(str(target), CANDIDATE)["recoveryPath"]
    assert runtime.backup_file(str(target), CANDIDATE)["recoveryPath"] == first
    different = runtime.backup_file(str(target), [{"id": CELL_ID, "code": "x = 3"}])["recoveryPath"]
    assert different != first
    Path(first).write_bytes(b"external recovery edit")
    fresh = runtime.backup_file(str(target), CANDIDATE)["recoveryPath"]
    assert fresh not in {first, different}
    assert Path(first).read_bytes() == b"external recovery edit"
    Path(fresh).unlink()
    assert runtime.backup_file(str(target), CANDIDATE)["recoveryPath"] != fresh


@pytest.mark.skipif(os.name == "nt", reason="Windows mode bits do not represent an NTFS DACL")
def test_recovery_is_private_on_posix(tmp_path):
    runtime, target, _ = setup(tmp_path)
    recovery = Path(runtime.backup_file(str(target), CANDIDATE)["recoveryPath"])
    assert stat.S_IMODE(recovery.stat().st_mode) == 0o600


def test_recovery_creation_failure_still_refuses_external_overwrite(tmp_path, monkeypatch):
    runtime, target, notes = setup(tmp_path)
    before = state_identity(runtime)
    external = ORIGINAL.replace(b"x = 1", b"x = 9")
    target.write_bytes(external)

    def fail(*args, **kwargs):
        raise PermissionError("private_candidate = 'synthetic-only'")

    monkeypatch.setattr(tempfile, "mkstemp", fail)
    with pytest.raises(KernelError) as caught:
        runtime.save_file(str(target), CANDIDATE)
    assert caught.value.code == -32002
    assert caught.value.data["recoveryPath"] is None
    assert caught.value.data["kind"] == "external-modification"
    assert caught.value.data["recoveryError"]
    assert "synthetic-only" not in str(caught.value) + json.dumps(caught.value.data)
    assert target.read_bytes() == external
    assert state_identity(runtime) == before
    assert notes == []


def test_recovery_fsync_failure_removes_partial_copy_and_refuses_overwrite(tmp_path, monkeypatch):
    runtime, target, _ = setup(tmp_path)
    external = ORIGINAL.replace(b"x = 1", b"x = 9")
    target.write_bytes(external)

    def fail(fd):
        raise OSError("synthetic fsync failure")

    monkeypatch.setattr(os, "fsync", fail)
    with pytest.raises(KernelError) as caught:
        runtime.save_file(str(target), CANDIDATE)
    assert caught.value.code == -32002
    assert caught.value.data["recoveryPath"] is None
    assert target.read_bytes() == external
    assert list(tmp_path.glob("*.py")) == [target]


def test_explicit_reload_establishes_new_baseline(tmp_path):
    runtime, target, notes = setup(tmp_path)
    external = ORIGINAL.replace(b"x = 1", b"x = 9")
    target.write_bytes(external)
    runtime.load_file(str(target))
    assert runtime.cells[CELL_ID].code == "x = 9"
    assert runtime.save_file(str(target), CANDIDATE) == saved_ok(target)
    assert notes == []


def test_normalized_loaded_path_alias_is_protected(tmp_path):
    runtime, target, _ = setup(tmp_path)
    alias = os.path.join(str(tmp_path), ".", target.name)
    target.write_bytes(ORIGINAL.replace(b"x = 1", b"x = 9"))
    with pytest.raises(KernelError) as caught:
        runtime.save_file(alias, CANDIDATE)
    assert caught.value.code == -32002
    assert caught.value.data["notebookPath"] == alias
    assert target.read_bytes() != ORIGINAL


def test_loaded_save_to_existing_other_path_is_bounded_rejection(tmp_path):
    runtime, target, notes = setup(tmp_path)
    before = state_identity(runtime)
    other = tmp_path / "other.py"
    other.write_bytes(b"external other content\n")
    with pytest.raises(KernelError) as caught:
        runtime.save_file(str(other), CANDIDATE)
    assert caught.value.code == -32602
    assert other.read_bytes() == b"external other content\n"
    assert target.read_bytes() == ORIGINAL
    assert state_identity(runtime) == before
    assert notes == []


def test_loaded_save_to_new_path_and_unloaded_save_remain_compatible(tmp_path):
    runtime, _, _ = setup(tmp_path)
    new = tmp_path / "new.py"
    assert runtime.save_file(str(new), CANDIDATE) == saved_ok(new)
    assert runtime.save_file(str(new), [{"id": CELL_ID, "code": "x = 4"}]) == saved_ok(new)
    standalone = Runtime()
    fresh = tmp_path / "fresh.py"
    assert standalone.save_file(str(fresh), [{"id": CELL_ID, "code": "x = 5"}]) == saved_ok(fresh)
    assert fresh.read_bytes() == serialize.write([{"id": CELL_ID, "code": "x = 5"}]).encode("utf-8")
    fresh.write_bytes(b"external changed after first save\n")
    with pytest.raises(KernelError) as caught:
        standalone.save_file(str(fresh), [{"id": CELL_ID, "code": "x = 6"}])
    assert caught.value.code == -32002
    assert fresh.read_bytes() == b"external changed after first save\n"


def test_server_propagates_conflict_data_without_candidate_body(tmp_path):
    runtime, target, _ = setup(tmp_path)
    target.write_bytes(ORIGINAL.replace(b"x = 1", b"x = 9"))
    out = io.StringIO()
    request = {"id": 17, "method": "save_file", "params": {"path": str(target), "cells": CANDIDATE}}
    server = Server(stdin=io.StringIO(json.dumps(request) + "\n"), stdout=out)
    server.runtime = runtime
    server.run()
    response = json.loads(out.getvalue())
    assert response["id"] == 17
    assert response["error"]["code"] == -32002
    assert response["error"]["data"]["kind"] == "external-modification"
    assert Path(response["error"]["data"]["recoveryPath"]).exists()
    assert "synthetic-only" not in out.getvalue()


def test_server_backup_contract_and_invalid_params(tmp_path):
    runtime, target, notes = setup(tmp_path)
    server = Server(stdin=io.StringIO(), stdout=io.StringIO())
    server.runtime = runtime
    before = state_identity(runtime)
    result = server.dispatch("backup_file", {"path": str(target), "cells": CANDIDATE})
    assert set(result) == {"recoveryPath"}
    assert Path(result["recoveryPath"]).exists()
    for params in ({"cells": CANDIDATE}, {"path": str(target)}, {"path": 7, "cells": []},
                   {"path": str(target), "cells": {}}, {"path": str(target), "cells": [{}]}):
        with pytest.raises(KernelError) as caught:
            server.dispatch("backup_file", params)
        assert caught.value.code == -32602
    assert state_identity(runtime) == before
    assert notes == []


def test_load_reports_sha256_of_raw_baseline_bytes(tmp_path):
    """D4: the fingerprint covers the exact bytes read (CRLF kept), not the normalized text."""
    raw = ORIGINAL.replace(b"\n", b"\r\n")
    target = tmp_path / "notebook.py"
    target.write_bytes(raw)
    state = Runtime(notify=lambda *_: None).load_file(str(target))
    assert state["baselineSha256"] == hashlib.sha256(raw).hexdigest()


def test_refused_save_reports_no_new_baseline_and_reload_reports_external(tmp_path):
    """D4: a conflict never advances the fingerprint; an explicit reload reports the external bytes."""
    runtime, target, _ = setup(tmp_path)
    external = ORIGINAL + b"# external\n"
    target.write_bytes(external)
    with pytest.raises(KernelError):
        runtime.save_file(str(target), CANDIDATE)
    assert runtime.load_file(str(target))["baselineSha256"] == hashlib.sha256(external).hexdigest()


def test_server_load_and_save_carry_baseline_fingerprint(tmp_path):
    target = tmp_path / "notebook.py"
    target.write_bytes(ORIGINAL)
    lines = [
        {"id": 1, "method": "load_file", "params": {"path": str(target)}},
        {"id": 2, "method": "save_file", "params": {"path": str(target), "cells": CANDIDATE}},
    ]
    out = io.StringIO()
    Server(stdin=io.StringIO("".join(json.dumps(line) + "\n" for line in lines)), stdout=out).run()
    replies = {m["id"]: m for m in map(json.loads, out.getvalue().splitlines()) if "id" in m}
    assert replies[1]["result"]["baselineSha256"] == hashlib.sha256(ORIGINAL).hexdigest()
    assert replies[2]["result"] == {"ok": True, "baselineSha256": hashlib.sha256(target.read_bytes()).hexdigest()}
