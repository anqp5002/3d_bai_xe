"""Kiểu request/response, lỗi HTTP và đọc body theo luồng (BE §1, §3).

Không phụ thuộc ``http.server`` để handler test được mà không mở cổng.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import BinaryIO, Final
from urllib.parse import unquote

from sim3d_server.config import DataPaths

#: Kích thước một lần đọc khi ghi file theo luồng.
CHUNK_BYTES: Final = 1024 * 1024

#: Mã lỗi dùng trong ``{error, detail}`` (contract C-B §0.1).
ERROR_NAMES: Final[dict[int, str]] = {
    HTTPStatus.BAD_REQUEST: "bad_request",
    HTTPStatus.FORBIDDEN: "forbidden_path",
    HTTPStatus.NOT_FOUND: "not_found",
    HTTPStatus.CONFLICT: "conflict",
    HTTPStatus.REQUEST_ENTITY_TOO_LARGE: "too_large",
    HTTPStatus.UNSUPPORTED_MEDIA_TYPE: "unsupported_media",
    HTTPStatus.INTERNAL_SERVER_ERROR: "internal_error",
    HTTPStatus.NOT_IMPLEMENTED: "not_implemented",
    HTTPStatus.SERVICE_UNAVAILABLE: "ffmpeg_missing",
}


class HttpError(Exception):
    """Lỗi trả về client; ``detail`` vào JSON, ``status`` vào mã HTTP."""

    def __init__(self, status: int, error: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.error = error
        self.detail = detail


@dataclass(slots=True)
class Request:
    """Phần request mà handler được thấy (đã tách query, body đọc theo luồng)."""

    method: str
    path: str
    query: dict[str, str] = field(default_factory=dict)
    headers: Mapping[str, str] = field(default_factory=dict)
    body_reader: BinaryIO | None = None
    content_length: int = 0
    #: Số byte đã đọc — dùng để biết còn body chưa đọc khi trả lỗi.
    bytes_read: int = 0

    def header(self, name: str) -> str | None:
        """Đọc header không phân biệt hoa/thường."""
        target = name.lower()
        for key, value in self.headers.items():
            if key.lower() == target:
                return value
        return None

    def has_body(self) -> bool:
        return self.content_length > 0

    def iter_body(self, limit: int, chunk_size: int = CHUNK_BYTES) -> Iterator[bytes]:
        """Sinh từng khối body, chặn vượt ``limit`` và body ngắn hơn Content-Length."""
        if self.content_length > limit:
            raise HttpError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                ERROR_NAMES[HTTPStatus.REQUEST_ENTITY_TOO_LARGE],
                f"body {self.content_length} byte vượt giới hạn {limit} byte",
            )
        remaining = self.content_length
        while remaining > 0:
            if self.body_reader is None:
                raise HttpError(
                    HTTPStatus.BAD_REQUEST,
                    ERROR_NAMES[HTTPStatus.BAD_REQUEST],
                    "không đọc được body (thiếu luồng đọc)",
                )
            chunk = self.body_reader.read(min(chunk_size, remaining))
            if not chunk:
                raise HttpError(
                    HTTPStatus.BAD_REQUEST,
                    ERROR_NAMES[HTTPStatus.BAD_REQUEST],
                    f"body ngắn hơn Content-Length: còn thiếu {remaining} byte",
                )
            remaining -= len(chunk)
            self.bytes_read += len(chunk)
            yield chunk

    def read_body(self, limit: int) -> bytes:
        """Đọc toàn bộ body (chỉ dùng cho body nhỏ: JSON, một frame PNG)."""
        return b"".join(self.iter_body(limit))

    def read_json(self, limit: int) -> object:
        """Đọc body thành JSON; lỗi mã hoá/cú pháp là 400 kèm chi tiết."""
        body = self.read_body(limit)
        if not body:
            raise HttpError(
                HTTPStatus.BAD_REQUEST,
                ERROR_NAMES[HTTPStatus.BAD_REQUEST],
                "body rỗng; cần JSON UTF-8",
            )
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise HttpError(
                HTTPStatus.BAD_REQUEST,
                ERROR_NAMES[HTTPStatus.BAD_REQUEST],
                f"body không phải UTF-8: {error}",
            ) from error
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise HttpError(
                HTTPStatus.BAD_REQUEST,
                ERROR_NAMES[HTTPStatus.BAD_REQUEST],
                f"JSON sai: {error.msg} (dòng {error.lineno}, cột {error.colno})",
            ) from error


@dataclass(frozen=True, slots=True)
class Response:
    """Kết quả một handler: mã HTTP + body JSON hoặc payload nhị phân."""

    status: int
    body: object | None = None
    payload: bytes | None = None
    content_type: str = "application/json; charset=utf-8"

    @classmethod
    def json(cls, status: int, body: object) -> Response:
        return cls(status=status, body=body)

    @classmethod
    def no_content(cls) -> Response:
        return cls(status=HTTPStatus.NO_CONTENT)


Handler = Callable[[Request, DataPaths, dict[str, str]], Response]


@dataclass(frozen=True, slots=True)
class Route:
    """Một tuyến API: ``pattern`` có thể chứa ``{name}`` và ``{path...}`` (đuôi)."""

    method: str
    pattern: str
    handler: Handler


@dataclass(frozen=True, slots=True)
class MultipartPart:
    """Một phần của body ``multipart/form-data``."""

    name: str
    filename: str | None
    content_type: str | None
    data: bytes


_BOUNDARY_RE: Final = re.compile(r'boundary=(?:"([^"]+)"|([^;\s]+))', re.IGNORECASE)
_DISPOSITION_NAME_RE: Final = re.compile(r'name="([^"]*)"')
_DISPOSITION_FILENAME_RE: Final = re.compile(r'filename="([^"]*)"')


def _split_segments(path: str) -> list[str]:
    stripped = path.strip("/")
    return stripped.split("/") if stripped else []


def match_route(pattern: str, path: str) -> dict[str, str] | None:
    """Khớp ``pattern`` với ``path``; trả tham số hoặc ``None``.

    Segment ``{path...}`` (chỉ được ở cuối) nhận phần còn lại, giữ nguyên ``/``.
    """
    pattern_segments = _split_segments(pattern)
    path_segments = _split_segments(path)
    params: dict[str, str] = {}
    for index, segment in enumerate(pattern_segments):
        if segment == "{path...}":
            rest = unquote("/".join(path_segments[index:]))
            if not rest:
                return None
            params["path"] = rest
            return params
        if index >= len(path_segments):
            return None
        if segment.startswith("{") and segment.endswith("}"):
            params[segment[1:-1]] = unquote(path_segments[index])
            continue
        if segment != path_segments[index]:
            return None
    if len(path_segments) != len(pattern_segments):
        return None
    return params


def parse_multipart(body: bytes, content_type: str) -> list[MultipartPart]:
    """Tách body multipart (đủ dùng cho một frame PNG, không cần thư viện ngoài)."""
    match = _BOUNDARY_RE.search(content_type)
    if match is None:
        raise ValueError("thiếu boundary trong Content-Type")
    boundary = (match.group(1) or match.group(2)).encode("utf-8")
    delimiter = b"--" + boundary
    pieces = body.split(delimiter)
    if len(pieces) < 2:
        raise ValueError("body không có phần nào")
    parts: list[MultipartPart] = []
    for piece in pieces[1:]:
        if piece.startswith(b"--"):
            break
        if piece.startswith(b"\r\n"):
            piece = piece[2:]
        header_blob, separator, data = piece.partition(b"\r\n\r\n")
        if not separator:
            raise ValueError("phần multipart thiếu dòng trống ngăn header/body")
        if data.endswith(b"\r\n"):
            data = data[:-2]
        headers: dict[str, str] = {}
        for line in header_blob.split(b"\r\n"):
            key, _, value = line.decode("utf-8", "replace").partition(":")
            if key:
                headers[key.strip().lower()] = value.strip()
        disposition = headers.get("content-disposition", "")
        name_match = _DISPOSITION_NAME_RE.search(disposition)
        if name_match is None:
            raise ValueError("phần multipart thiếu name trong Content-Disposition")
        filename_match = _DISPOSITION_FILENAME_RE.search(disposition)
        parts.append(
            MultipartPart(
                name=name_match.group(1),
                filename=filename_match.group(1) if filename_match else None,
                content_type=headers.get("content-type"),
                data=data,
            )
        )
    if not parts:
        raise ValueError("body không có phần nào")
    return parts
