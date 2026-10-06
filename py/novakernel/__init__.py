"""novakernel — NovaLab 反应式 Python 内核。

模块地图（spec §1/§5）：
- dag.py        AST defs/refs 提取 · 拓扑排序 · 环检测        (S2/P1.2)
- runtime.py    共享 globals 拓扑 exec · 失效传播 · 级联       (S2/P1.2)
- introspect.py 变量 schema 嗅探（隐私边界内）                  (P1.2)
- serialize.py  marimo 兼容 .py 读写                           (P1.2)
- server.py     stdin/stdout JSON-lines 消息循环               (骨架已就绪)
"""

__version__ = "0.0.1"
