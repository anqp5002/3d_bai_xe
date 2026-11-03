"""Cấu hình pytest cho ``sim3d/tools`` (chạy ``python -m pytest sim3d/tools -q``).

``sim3d/tools/out/`` là thư mục **kết quả** (JSON/log/bản mã pin của
``real_baseline.py``). Bản mã pin có thể chứa ``tests/`` của backend; nếu để pytest
quét vào đó thì ``pytest sim3d/tools`` gom nhầm test của backend và lỗi import.
Vì vậy bỏ hẳn ``out/`` khỏi thu gom — test thật nằm ở ``sim3d/tools/tests/``.
"""

from __future__ import annotations

collect_ignore = ["out"]
