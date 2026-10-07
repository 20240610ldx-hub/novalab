"""server.py — 内核子进程 stdin/stdout JSON-lines 消息循环（spec §6.2 + 2026-10-06 契约增补）。

协议：
- stdin 收请求 {id, method, params}；stdout 回 {id, result} 或 {id, error:{code,message}}；
- 通知（无 id）{method, params}：run.started / run.stdout / run.stderr / run.mime /
  run.error / run.done（形状见 runtime.py docstring）；
- 日志只走 stderr；stdout 仅协议消息（每行一个 JSON，UTF-8，LF）；
- 同步循环，无心跳/异步线程（契约增补 #7）：exec 期间不应答 ping 是已知行为；
- 方法：ping / load_file / save_file / set_cells / exec_cell / exec_repl /
  introspect / control.set / shutdown（应答后进程退出）。

错误码：-32700 JSON 解析错；-32601 method 不存在；-32602 参数无效/未知 cell；
-32001 尚未打开 notebook；-32000 内核内部错（含编译错拒跑）。
"""

from __future__ import annotations

import json
import sys

from . import __version__
from .runtime import KernelError, Runtime


class Server:
    def __init__(self, stdin=None, stdout=None) -> None:
        self._in = stdin if stdin is not None else sys.stdin
        # 在任何 redirect_stdout 之前固定真实 stdout 引用（通知必须写到协议流）
        self._out = stdout if stdout is not None else sys.stdout
        self.runtime = Runtime(notify=self._on_notify)

    # ------------------------------------------------------------------ io
    def _write(self, obj: dict) -> None:
        self._out.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
        self._out.flush()

    def _on_notify(self, method: str, params: dict) -> None:
        self._write({"method": method, "params": params})

    # ------------------------------------------------------------ dispatch
    def dispatch(self, method: str, params: dict) -> dict:
        rt = self.runtime
        if method == "ping":
            return {"pong": True, "version": __version__}
        if method == "load_file":
            return rt.load_file(self._require(params, "path", str))
        if method == "save_file":
            return rt.save_file(
                self._require(params, "path", str), self._require(params, "cells", list)
            )
        if method == "set_cells":
            return rt.set_cells(self._require(params, "cells", list))
        if method == "exec_cell":
            cell_id = self._require(params, "cellId", str)
            cascade = bool(params.get("cascade", False))
            return rt.exec_cell(cell_id, cascade=cascade)
        if method == "exec_repl":
            return rt.exec_repl(self._require(params, "code", str))
        if method == "control.set":
            # P3.3（spec §15.3）：{controlId, value} → {ok, cascaded, staleSideEffect}。
            # value 允许任意 JSON 值（null/false/0/'' 均合法），故只查在场性（object 恒真）。
            return rt.control_set(
                self._require(params, "controlId", str),
                self._require(params, "value", object),
            )
        if method == "introspect":
            return rt.introspect()
        if method == "shutdown":
            return {"ok": True}
        raise KernelError(f"method not found: {method}", -32601)

    @staticmethod
    def _require(params: dict, key: str, typ: type):
        if not isinstance(params, dict) or key not in params:
            raise KernelError(f"missing param: {key}", -32602)
        value = params[key]
        if not isinstance(value, typ):
            raise KernelError(f"param {key} must be {typ.__name__}", -32602)
        return value

    # ---------------------------------------------------------------- loop
    def run(self) -> None:
        sys.stderr.write(f"[novakernel] {__version__} ready on stdio\n")
        sys.stderr.flush()
        for line in self._in:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as e:
                self._write({"id": None, "error": {"code": -32700, "message": f"parse error: {e}"}})
                continue
            if not isinstance(req, dict):
                self._write({"id": None, "error": {"code": -32700, "message": "request must be an object"}})
                continue
            rid = req.get("id")
            method = req.get("method", "")
            params = req.get("params") or {}
            try:
                result = self.dispatch(method, params)
            except KernelError as e:
                self._write({"id": rid, "error": {"code": e.code, "message": e.message}})
            except Exception as e:  # noqa: BLE001 — 协议层统一兜底，进程存活
                self._write({
                    "id": rid,
                    "error": {"code": -32000, "message": f"{type(e).__name__}: {e}"},
                })
            else:
                self._write({"id": rid, "result": result})
                if method == "shutdown":
                    break


def main() -> None:
    # Windows 管道默认可能是 GBK/cp1252：协议流强制 UTF-8 + LF
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    try:
        sys.stdout.reconfigure(newline="\n")
    except Exception:  # noqa: BLE001
        pass
    Server().run()


if __name__ == "__main__":
    main()
