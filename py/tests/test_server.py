"""test_server.py — stdio JSON-lines 协议端到端（subprocess 冒烟，spec §6.2 + 契约增补）。"""

import json
import subprocess
import sys
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[1]


def run_session(
    requests: list[dict], timeout: float = 60.0
) -> tuple[list[dict], list[tuple[str, dict]], str, int]:
    """启动内核子进程，喂入请求行，返回 (响应, 通知[(method, params)], stderr, returncode)。"""
    payload = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests)
    proc = subprocess.run(
        [sys.executable, "-m", "novakernel.server"],
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(PY_ROOT),
        timeout=timeout,
    )
    responses, notifications = [], []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        msg = json.loads(line)
        if "method" in msg:
            notifications.append((msg["method"], msg.get("params") or {}))
        else:
            responses.append(msg)
    return responses, notifications, proc.stderr, proc.returncode


def by_id(responses: list[dict], rid: int) -> dict:
    return next(r for r in responses if r.get("id") == rid)


def test_ping_and_shutdown():
    resps, notifs, stderr, rc = run_session([
        {"id": 1, "method": "ping"},
        {"id": 2, "method": "shutdown"},
    ])
    assert rc == 0
    pong = by_id(resps, 1)["result"]
    assert pong["pong"] is True and isinstance(pong["version"], str)
    assert by_id(resps, 2) == {"id": 2, "result": {"ok": True}}
    assert "novakernel" in stderr  # 日志只走 stderr


def test_unknown_method_and_parse_error():
    resps, _, _, rc = run_session([
        {"id": 1, "method": "no_such_method"},
        {"id": 2, "method": "shutdown"},
    ])
    assert by_id(resps, 1)["error"]["code"] == -32601
    assert rc == 0


def test_invalid_json_line_gets_null_id_error():
    proc = subprocess.run(
        [sys.executable, "-m", "novakernel.server"],
        input='{"broken": \n{"id": 9, "method": "shutdown"}\n',
        capture_output=True, text=True, encoding="utf-8",
        cwd=str(PY_ROOT), timeout=60,
    )
    msgs = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.strip()]
    assert msgs[0]["id"] is None and msgs[0]["error"]["code"] == -32700
    assert msgs[1] == {"id": 9, "result": {"ok": True}}


def test_exec_before_load_is_minus_32001():
    resps, _, _, _ = run_session([
        {"id": 1, "method": "exec_cell", "params": {"cellId": "x"}},
        {"id": 2, "method": "shutdown"},
    ])
    assert by_id(resps, 1)["error"]["code"] == -32001


def test_full_flow_set_cells_exec_cascade_introspect(tmp_path):
    resps, notifs, _, rc = run_session([
        {"id": 1, "method": "set_cells", "params": {"cells": [
            {"id": "aaaaaaaa", "code": "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})"},
            {"id": "bbbbbbbb", "code": "total = int(df['a'].sum())\nprint('total', total)"},
        ]}},
        {"id": 2, "method": "exec_cell", "params": {"cellId": "aaaaaaaa", "cascade": True}},
        {"id": 3, "method": "introspect", "params": {}},
        {"id": 4, "method": "exec_repl", "params": {"code": "print(total * 2)"}},
        {"id": 5, "method": "shutdown"},
    ])
    assert rc == 0

    r1 = by_id(resps, 1)["result"]
    assert {c["id"] for c in r1["cells"]} == {"aaaaaaaa", "bbbbbbbb"}
    assert r1["edges"] == [{"from": "aaaaaaaa", "to": "bbbbbbbb"}]
    bcell = next(c for c in r1["cells"] if c["id"] == "bbbbbbbb")
    assert bcell["defs"] == ["total"] and bcell["refs"] == ["df"]

    r2 = by_id(resps, 2)["result"]
    assert r2["cellId"] == "aaaaaaaa" and r2["ok"] is True
    assert r2["cascaded"] == ["bbbbbbbb"]
    assert isinstance(r2["durationMs"], int)

    # 通知形状（冻结契约）
    started = [p["cellId"] for m, p in notifs if m == "run.started"]
    assert started == ["aaaaaaaa", "bbbbbbbb", "repl"]  # 级联两格 + 后面的 repl
    stdout_b = "".join(p["text"] for m, p in notifs if m == "run.stdout" and p["cellId"] == "bbbbbbbb")
    assert stdout_b == "total 3\n"
    done_b = next(p for m, p in notifs if m == "run.done" and p["cellId"] == "bbbbbbbb")
    assert done_b["defs"] == ["total"] and done_b["execCount"] == 1
    done_a = next(p for m, p in notifs if m == "run.done" and p["cellId"] == "aaaaaaaa")
    assert done_a["cascaded"] == ["bbbbbbbb"] and done_a["defs"] == ["df", "pd"]
    # run.done(a) 在级联之后发出；repl 的 done 来自后面的 exec_repl
    done_ids = [p["cellId"] for m, p in notifs if m == "run.done"]
    assert done_ids == ["bbbbbbbb", "aaaaaaaa", "repl"]

    schemas = {s["name"]: s for s in by_id(resps, 3)["result"]["schemas"]}
    assert schemas["df"]["type"] == "DataFrame"
    assert schemas["total"]["preview"] == "3"

    r4 = by_id(resps, 4)["result"]
    assert r4["cellId"] == "repl" and r4["ok"] is True
    stdout_repl = "".join(p["text"] for m, p in notifs if m == "run.stdout" and p["cellId"] == "repl")
    assert stdout_repl == "6\n"


def test_load_save_file_flow(tmp_path):
    nb = tmp_path / "nb.py"
    nb.write_text(
        "# %% [cell-id: 11111111]\nx = 21 * 2\n\n# %% [cell-id: 22222222]\ny = x + 1\n",
        encoding="utf-8",
    )
    out = tmp_path / "out.py"
    resps, notifs, _, rc = run_session([
        {"id": 1, "method": "load_file", "params": {"path": str(nb)}},
        {"id": 2, "method": "exec_cell", "params": {"cellId": "11111111", "cascade": True}},
        {"id": 3, "method": "save_file", "params": {"path": str(out), "cells": [
            {"id": "11111111", "code": "x = 21 * 2"},
            {"id": "22222222", "code": "y = x + 1"},
        ]}},
        {"id": 4, "method": "shutdown"},
    ])
    assert rc == 0
    state = by_id(resps, 1)["result"]
    assert [c["id"] for c in state["cells"]] == ["11111111", "22222222"]
    assert state["dagEdges"] == [{"from": "11111111", "to": "22222222"}]
    assert state["staleSet"] == []
    assert state["execCounts"] == {"11111111": 0, "22222222": 0}
    assert by_id(resps, 2)["result"]["cascaded"] == ["22222222"]
    assert by_id(resps, 3)["result"] == {"ok": True}
    assert "# %% [cell-id: 11111111]" in out.read_text(encoding="utf-8")


def test_run_error_notification_envelope(tmp_path):
    resps, notifs, _, rc = run_session([
        {"id": 1, "method": "set_cells", "params": {"cells": [
            {"id": "aaaaaaaa", "code": "x = 1\nraise RuntimeError('kaboom')"},
        ]}},
        {"id": 2, "method": "exec_cell", "params": {"cellId": "aaaaaaaa"}},
        {"id": 3, "method": "shutdown"},
    ])
    assert rc == 0
    r2 = by_id(resps, 2)["result"]  # 运行期异常 → ok:false 的 RunReport，不是协议错误
    assert r2["ok"] is False and "kaboom" in r2["traceback"]
    err = next(p for m, p in notifs if m == "run.error")
    assert err["cellId"] == "aaaaaaaa"
    assert err["frames"][-1]["srcLine"] == "raise RuntimeError('kaboom')"
    assert err["frames"][-1]["file"] == "<cell aaaaaaaa>"
