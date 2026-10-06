"""pytest 共享配置：把 py/ 加入 sys.path（uv 虚拟项目未安装 novakernel 包）。"""

import sys
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

FIXTURES = Path(__file__).parent / "fixtures"
