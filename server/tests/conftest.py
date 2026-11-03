"""Fixture dùng chung cho test BE §7."""

from __future__ import annotations

from pathlib import Path

import pytest

from sim3d_server.config import DataPaths
from sim3d_server.server import App


@pytest.fixture()
def data_root(tmp_path: Path) -> DataPaths:
    """``data/`` tối thiểu, dưới ``tmp_path`` để ``web/dist`` cũng cô lập."""
    root = tmp_path / "data"
    for name in ("lot", "templates", "scenarios", "runs"):
        (root / name).mkdir(parents=True)
    return DataPaths.from_root(root)


@pytest.fixture()
def app(data_root: DataPaths) -> App:
    return App(paths=data_root)
