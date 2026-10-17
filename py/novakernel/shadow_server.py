"""shadow_server.py — 影子内核进程的 stdio JSON-lines 消息循环（ADR-013 S0）。

与 server.py 同一线协议（{id, method, params} → {id, result|error}），无通知。方法：
- init {scratchDir, notebookDir, memLimitBytes} → {pid, memLimit, sandbox}
  顺序：cwd → OS 内存上限（读回生效值）→ 审计钩子沙箱。之后用户代码才可能运行。
- run {base, candidates:[{name, cells}], seed?, k?, compare?} → ShadowSession.run
- verify {candidate?, contracts} → {contracts}
- ping / shutdown

协议隔离：启动即把 fd 1/2 复制出私有协议 fd，再把 fd 1/2 指向 devnull——用户代码
（含 C 扩展直接写 fd 1）的任何输出都到不了协议流和 bridge 日志。
"""

from __future__ import annotations

import json
import os
import sys

from . import __version__
from .shadow import K_DEFAULT, Sandbox, ShadowSession, apply_memory_limit


class _ProtocolError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _isolate_stdio():
    proto_fd = os.dup(1)
    null_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null_fd, 1)
    os.dup2(null_fd, 2)
    os.close(null_fd)
    out = os.fdopen(proto_fd, "w", encoding="utf-8", newline="\n", buffering=1)
    sys.stdout = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115
    sys.stderr = sys.stdout
    return out


class ShadowServer:
    def __init__(self, out) -> None:
        self._out = out
        self.sandbox: Sandbox | None = None
        self.session = ShadowSession()

    def _write(self, obj: dict) -> None:
        self._out.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
        self._out.flush()

    def dispatch(self, method: str, params: dict) -> dict:
        if method == "ping":
            return {"pong": True, "version": __version__}
        if method == "init":
            if self.sandbox is not None:
                raise _ProtocolError(-32600, "already initialized")
            scratch = params.get("scratchDir")
            nbdir = params.get("notebookDir")
            limit = params.get("memLimitBytes")
            if not isinstance(scratch, str) or not isinstance(nbdir, str) or not isinstance(limit, int):
                raise _ProtocolError(-32602, "init needs scratchDir, notebookDir, memLimitBytes")
            os.chdir(nbdir)
            mem = apply_memory_limit(limit)
            sb = Sandbox(scratch)
            sb.install()
            self.sandbox = sb
            self.session = ShadowSession(sb)
            return {"pid": os.getpid(), "memLimit": mem, "sandbox": True}
        if self.sandbox is None and method in ("run", "verify"):
            raise _ProtocolError(-32001, "not initialized")
        if method == "run":
            base = params.get("base")
            cands = params.get("candidates")
            if not isinstance(base, list) or not isinstance(cands, list) or not cands:
                raise _ProtocolError(-32602, "run needs base and candidates")
            return self.session.run(
                base, cands,
                seed=int(params.get("seed", 0)),
                k=int(params.get("k", K_DEFAULT)),
                compare=bool(params.get("compare", True)),
            )
        if method == "verify":
            contracts = params.get("contracts")
            if not isinstance(contracts, list):
                raise _ProtocolError(-32602, "verify needs contracts")
            return self.session.verify(str(params.get("candidate", "after")), contracts)
        if method == "shutdown":
            return {"ok": True}
        raise _ProtocolError(-32601, f"method not found: {method}")

    def run(self, stdin) -> None:
        for line in stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                self._write({"id": None, "error": {"code": -32700, "message": "parse error"}})
                continue
            if not isinstance(req, dict):
                self._write({"id": None, "error": {"code": -32700, "message": "request must be an object"}})
                continue
            rid = req.get("id")
            method = str(req.get("method", ""))
            params = req.get("params") or {}
            if not isinstance(params, dict):
                params = {}
            try:
                result = self.dispatch(method, params)
            except _ProtocolError as e:
                self._write({"id": rid, "error": {"code": e.code, "message": e.message}})
            except Exception as e:  # noqa: BLE001 — 错误消息不带用户数据
                self._write({"id": rid, "error": {"code": -32000, "message": type(e).__name__}})
            else:
                self._write({"id": rid, "result": result})
                if method == "shutdown":
                    break


def _watch_parent() -> None:
    """bridge 死亡 → 立刻退出，即使主线程卡在用户代码的死循环里（不留孤儿）。

    NOVALAB_SHADOW_PARENT_PID = bridge pid。Windows：OpenProcess + WaitForSingleObject
    阻塞等待（ctypes 调用期间释放 GIL）；POSIX：父进程变化即退出。必须在沙箱安装前启动。
    """
    import threading
    import time

    raw = os.environ.get("NOVALAB_SHADOW_PARENT_PID", "")
    if not raw.isdigit():
        return
    ppid = int(raw)

    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        handle = k32.OpenProcess(0x00100000, False, ppid)  # SYNCHRONIZE
        if not handle:
            os._exit(3)  # 父进程已不在

        def wait() -> None:
            k32.WaitForSingleObject(handle, 0xFFFFFFFF)
            os._exit(3)
    else:
        start = os.getppid()

        def wait() -> None:
            while os.getppid() == start:
                time.sleep(0.5)
            os._exit(3)

    threading.Thread(target=wait, name="novalab-shadow-parent-watch", daemon=True).start()


def main() -> None:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    _watch_parent()
    out = _isolate_stdio()
    ShadowServer(out).run(sys.stdin)


if __name__ == "__main__":
    main()
