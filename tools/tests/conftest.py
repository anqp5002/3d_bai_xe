"""Cấu hình pytest cho ``sim3d/tools``.

Thêm thư mục ``tools/`` vào ``sys.path`` để test import được ``build_lot`` khi chạy
``python -m pytest sim3d/tools -q`` từ gốc repo.
"""

from __future__ import annotations

import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
