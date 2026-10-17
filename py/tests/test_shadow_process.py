"""ADR-013 S0：真实影子进程验收（沙箱、OS 级内存上限、上游重放、协议隔离）。

每个用例起一个真实 `python -m novakernel.shadow_server` 子进程，以最小环境启动
（与 bridge ShadowManager 相同的约定），审计钩子只装在子进程里。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PY_DIR = Path(__file__).resolve().parents[1]
CANARY = "CANARY_ROW_7f3a"


def minimal_env(scratch: Path) -> dict[str, str]:
    keep = ("SYSTEMROOT", "WINDIR", "PATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    s = str(scratch)
    env.update({
        "TEMP": s, "TMP": s, "TMPDIR": s, "HOME": s, "USERPROFILE": s,
        "APPDATA": s, "LOCALAPPDATA": s, "MPLCONFIGDIR": s, "MPLBACKEND": "Agg",
        "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8", "PYTHONPATH": str(PY_DIR), "NOVALAB_SHADOW": "1",
        "OPENBLAS_NUM_THREADS": "4", "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4",
    })
    return env


class ShadowProc:
    def __init__(self, tmp_path: Path, mem_bytes: int = 2 * 1024**3) -> None:
        self.scratch = tmp_path / "scratch"
        self.workspace = tmp_path / "workspace"
        self.scratch.mkdir()
        self.workspace.mkdir()
        self.p = subprocess.Popen(
            [sys.executable, "-m", "novakernel.shadow_server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=str(self.workspace), env=minimal_env(self.scratch),
            text=True, encoding="utf-8", bufsize=1,
        )
        self.seq = 0
        self.init = self.call("init", {
            "scratchDir": str(self.scratch), "notebookDir": str(self.workspace),
            "memLimitBytes": mem_bytes,
        })

    def call(self, method: str, params: dict) -> dict:
        self.seq += 1
        assert self.p.stdin and self.p.stdout
        self.p.stdin.write(json.dumps({"id": self.seq, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            assert line, "shadow process exited"
            msg = json.loads(line)  # 非 JSON 行 = 协议被用户输出污染 → 用例失败
            if msg.get("id") == self.seq:
                assert "error" not in msg, msg
                return msg["result"]

    def close(self) -> None:
        try:
            self.call("shutdown", {})
        finally:
            self.p.wait(timeout=10)


@pytest.fixture
def proc(tmp_path):
    sp = ShadowProc(tmp_path)
    yield sp
    sp.close()


BASE = [
    {"id": "a", "code": "import numpy as np\nimport pandas as pd\n"
                        f"df = pd.DataFrame({{'name': ['{CANARY}'] + ['n'] * 19, 'pop': np.arange(20)}})"},
    {"id": "b", "code": "noise = np.random.rand(3)\nscaled = df.assign(pop=df['pop'] * 2)"},
    {"id": "c", "code": "total = scaled['pop'].sum()"},
]


def run_candidate(proc: ShadowProc, cid: str, code: str, base=BASE) -> dict:
    cand = [dict(c) for c in base]
    for c in cand:
        if c["id"] == cid:
            c["code"] = code
    return proc.call("run", {"base": base, "candidates": [{"name": "after", "cells": cand}]})


def after_cell(res: dict, cid: str) -> dict:
    return next(c for c in res["candidates"][0]["cells"] if c["id"] == cid)


def test_init_applies_real_os_memory_limit(proc):
    init = proc.init
    expected = "job-object" if sys.platform == "win32" else "rlimit-as"
    assert init["memLimit"]["mechanism"] == expected
    assert init["memLimit"]["limitBytes"] == 2 * 1024**3  # 读回 OS 实际生效值
    assert init["sandbox"] is True


def test_replay_compare_and_delta_without_rows(proc):
    res = run_candidate(proc, "b", "noise = np.random.rand(3)\nscaled = df.assign(pop=df['pop'] * 3)")
    before, after = res["before"], res["candidates"][0]
    assert [c["id"] for c in before["cells"]] == ["a", "b", "c"]
    assert all(c["ok"] for c in before["cells"] + after["cells"])
    assert after["plan"] == {"changed": ["b"], "upstream": ["a"], "closure": ["b", "c"]}
    scaled = next(v for v in after["vars"] if v["name"] == "scaled")
    assert scaled["delta"]["stats"]["pop"]["sum"] == pytest.approx(190.0)
    assert CANARY not in json.dumps(res)


def test_upstream_is_replayed_with_fixed_seed(proc):
    r1 = run_candidate(proc, "c", "total = scaled['pop'].sum() + 0")
    r2 = run_candidate(proc, "c", "total = scaled['pop'].sum() + 0")
    v1 = next(v for v in r1["candidates"][0]["vars"] if v["name"] == "total")
    assert v1["after"]["schema"]["type"] in {"int64", "int", "integer"}
    assert r1["candidates"][0]["nondeterminism"] == r2["candidates"][0]["nondeterminism"] == []


@pytest.mark.parametrize("code,kind", [
    ("from pathlib import Path\nPath('leak.txt').open('w').write('x')", "file-write"),
    ("import os\ngetattr(os, 'remove')('victim.txt')", "file-delete"),
    ("import os\ngetattr(os, 'rename')('victim.txt', 'moved.txt')", "file-rename"),
    ("import socket\nsocket.create_connection(('127.0.0.1', 9), timeout=1)", "network"),
    ("import urllib.request\nurllib.request.urlopen('http://example.invalid')", "network"),
    ("__import__('subprocess').run(['cmd', '/c', 'echo hi'])", "subprocess"),
    ("import os\ngetattr(os, 'mkdir')('newdir')", "file-write"),
])
def test_sandbox_blocks_side_effects_outside_scratch(proc, code, kind):
    victim = proc.workspace / "victim.txt"
    victim.write_text("keep")
    res = run_candidate(proc, "c", code)
    cell = after_cell(res, "c")
    assert cell["ok"] is False
    assert f"ShadowSandboxError: {kind} blocked" in cell["traceback"]
    assert {"kind": kind, "count": 1} in res["candidates"][0]["blocked"] or any(
        b["kind"] == kind and b["count"] >= 1 for b in res["candidates"][0]["blocked"]
    )
    assert sorted(p.name for p in proc.workspace.iterdir()) == ["victim.txt"]
    assert victim.read_text() == "keep"
    assert str(proc.workspace) not in json.dumps(res)  # 拦截报告不带路径


def test_scratch_writes_and_workspace_reads_are_allowed(proc):
    (proc.workspace / "input.csv").write_text("pop\n1\n2\n")
    code = ("import tempfile\nwith tempfile.NamedTemporaryFile('w', delete=False) as f:\n    f.write('ok')\n"
            "inp = pd.read_csv('input.csv')")
    res = run_candidate(proc, "c", code)
    assert after_cell(res, "c")["ok"] is True
    assert res["candidates"][0]["blocked"] == []


def test_side_effect_cells_are_skipped_not_run(proc):
    res = run_candidate(proc, "c", "total = scaled['pop'].sum()\nscaled.to_csv('out.csv')")
    cell = after_cell(res, "c")
    assert cell.get("skipped") == "side-effect"
    assert not (proc.workspace / "out.csv").exists()


def test_failed_cell_blocks_downstream(proc):
    res = run_candidate(proc, "b", "noise = np.random.rand(3)\nscaled = df.assign(pop=df['popx'])")
    assert after_cell(res, "b")["ok"] is False
    assert "KeyError: 'popx'" in after_cell(res, "b")["traceback"]
    assert after_cell(res, "c").get("skipped") == "blocked-upstream"


def test_user_output_never_corrupts_protocol_or_leaks(proc):
    code = ("import os, sys\nprint(df)\nsys.stderr.write(str(df))\n"
            f"os.write(1, b'{CANARY} raw fd write\\n')\ntotal = 1")
    res = run_candidate(proc, "c", code)
    assert after_cell(res, "c")["ok"] is True
    assert CANARY not in json.dumps(res)


def test_verify_evaluates_contracts_on_retained_state(proc):
    run_candidate(proc, "b", "noise = np.random.rand(3)\nscaled = df.assign(pop=df['pop'] * 3)")
    out = proc.call("verify", {"candidate": "after", "contracts": [
        {"id": "k1", "kind": "columns_present", "target": "scaled", "columns": ["name", "pop"]},
        {"id": "k2", "kind": "sum_conserved", "before": {"target": "scaled", "column": "pop", "phase": "before"},
         "after": {"target": "scaled", "column": "pop"}},
        {"id": "k3", "kind": "row_count", "target": "scaled", "op": "==", "ref": {"target": "df"}},
    ]})
    by = {c["id"]: c for c in out["contracts"]}
    assert by["k1"]["status"] == "pass"
    assert by["k2"]["status"] == "fail" and by["k2"]["maxAbsDiff"] == pytest.approx(190.0)
    assert by["k3"]["status"] == "pass"


def test_memory_limit_turns_huge_allocation_into_memoryerror(tmp_path):
    sp = ShadowProc(tmp_path, mem_bytes=512 * 1024**2)
    try:
        res = run_candidate(sp, "c", "buf = bytearray(2 * 1024 ** 3)")
        cell = after_cell(res, "c")
        assert cell["ok"] is False and "MemoryError" in cell["traceback"]
        # 进程仍存活，可继续下一次运行
        res2 = run_candidate(sp, "c", "total = 2")
        assert after_cell(res2, "c")["ok"] is True
    finally:
        sp.close()


# 有的 CPython 构建没有 os.pidfd_open（uv 托管的 python-build-standalone 3.14.5 即如此），
# 看门狗必须走不依赖它的路径；在当前解释器上删掉该函数模拟这种构建。
_NO_PIDFD = ("import os, runpy\n"
             "if hasattr(os, 'pidfd_open'):\n"
             "    del os.pidfd_open\n"
             "runpy.run_module('novakernel.shadow_server', run_name='__main__')\n")


@pytest.mark.parametrize("launcher", [
    pytest.param(["-m", "novakernel.shadow_server"], id="native"),
    pytest.param(["-c", _NO_PIDFD], id="no-pidfd",
                 marks=pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux /proc 路径")),
])
def test_shadow_exits_when_parent_dies(tmp_path, launcher):
    """bridge 死亡后影子进程不成为孤儿：即使正卡在死循环里，且 bridge 不是直接父进程。"""
    import time

    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    scratch = tmp_path / "scratch"
    ws = tmp_path / "ws"
    scratch.mkdir()
    ws.mkdir()
    env = minimal_env(scratch)
    env["NOVALAB_SHADOW_PARENT_PID"] = str(parent.pid)
    p = subprocess.Popen([sys.executable, *launcher], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=str(ws), env=env,
                         text=True, encoding="utf-8")
    try:
        p.stdin.write(json.dumps({"id": 1, "method": "init", "params": {
            "scratchDir": str(scratch), "notebookDir": str(ws), "memLimitBytes": 1024**3}}) + "\n")
        p.stdin.flush()
        json.loads(p.stdout.readline())
        cells = [{"id": "a", "code": "x = 1"}]
        cand = [{"id": "a", "code": "while True:\n    pass"}]
        p.stdin.write(json.dumps({"id": 2, "method": "run", "params": {
            "base": cells, "candidates": [{"name": "after", "cells": cand}]}}) + "\n")
        p.stdin.flush()
        time.sleep(1.0)
        assert p.poll() is None  # 正在死循环
        parent.kill()
        parent.wait()
        t0 = time.monotonic()
        p.wait(timeout=10)
        assert time.monotonic() - t0 < 5
    finally:
        for proc in (p, parent):
            if proc.poll() is None:
                proc.kill()
