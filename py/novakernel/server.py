"""内核子进程消息循环骨架（spec §6.2）。

协议：stdin 收 JSON-lines 请求 {id, method, params}，stdout 回 {id, result|error}
与流式通知 {method, params}。P1.2 起接入 runtime/dag/introspect。
"""

import json
import sys


def handle(method: str, params: dict) -> dict:
    if method == "ping":
        return {"pong": True, "version": "0.0.1"}
    raise ValueError(f"method not found: {method}")


def main() -> None:
    sys.stderr.write("[novakernel] ready on stdio\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        msg = {"id": req.get("id")}
        try:
            msg["result"] = handle(req.get("method", ""), req.get("params") or {})
        except Exception as exc:  # noqa: BLE001 — 协议层统一兜底
            msg["error"] = {"code": -32000, "message": str(exc)}
        sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
