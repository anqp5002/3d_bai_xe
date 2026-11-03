"""Tiện ích thời gian dùng chung (`verify.json`, danh sách kịch bản, lần xuất)."""

from __future__ import annotations

from datetime import UTC, datetime

#: Định dạng ISO 8601 UTC của contract C-B (§0.3).
ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def iso_utc(moment: datetime) -> str:
    """Chuyển ``moment`` về chuỗi ISO 8601 UTC (``2026-10-31T04:15:00Z``)."""
    return moment.astimezone(UTC).strftime(ISO_FORMAT)


def now_utc() -> datetime:
    return datetime.now(UTC)


def parse_iso_utc(text: str) -> datetime:
    """Đọc chuỗi ISO 8601 có ``Z`` hoặc offset; sai thì ``ValueError``."""
    return datetime.fromisoformat(text)
