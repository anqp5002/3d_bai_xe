"""SIM3D server — BE nội bộ của web SIM3D (BE spec §1).

Chỉ nghe ``127.0.0.1:8010``, dùng ``http.server`` stdlib, không xác thực.
Chạy: ``python -m sim3d_server --root ../data``.
"""

from sim3d_server.version import VERSION

__all__ = ["VERSION"]
