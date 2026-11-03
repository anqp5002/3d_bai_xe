"""Cấu hình pytest cho ``sim3d/server``.

Thêm thư mục server vào ``sys.path`` để `pytest` chạy được từ bất kỳ đâu mà vẫn
import được package ``sim3d_server``.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
