"""HTTP server nội bộ của SIM3D (BE spec §1, §3).

Chỉ nghe ``127.0.0.1`` — không có tuỳ chọn đổi host, vì mở ra mạng là ngoài phạm vi
(BE §8). Mọi lỗi trả JSON ``{error, detail}`` với mã HTTP đúng, không nuốt lỗi (R2).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Final
from urllib.parse import urlsplit

from sim3d_server.config import DataPaths
from sim3d_server.http import (
    ERROR_NAMES,
    HttpError,
    Request,
    Response,
    Route,
    match_route,
)
from sim3d_server.routes import ROUTES, health_handler
from sim3d_server.static import serve_static
from sim3d_server.version import VERSION

__all__ = [
    "BIND_HOST",
    "DEFAULT_PORT",
    "App",
    "HttpError",
    "Request",
    "Response",
    "Route",
    "Sim3DRequestHandler",
    "health_handler",
    "make_server",
]

LOGGER: Final = logging.getLogger("sim3d_server")

#: Host duy nhất được phép bind (BE §1).
BIND_HOST: Final = "127.0.0.1"
#: Cổng mặc định (BE §1).
DEFAULT_PORT: Final = 8010

JSON_CONTENT_TYPE: Final = "application/json; charset=utf-8"


@dataclass(slots=True)
class App:
    """Bảng tuyến + dữ liệu, tách khỏi socket để test được không cần cổng thật."""

    paths: DataPaths
    routes: tuple[Route, ...] = ROUTES

    def dispatch(self, request: Request) -> Response:
        for route in self.routes:
            if route.method != request.method:
                continue
            params = match_route(route.pattern, request.path)
            if params is None:
                continue
            return route.handler(request, self.paths, params)
        if request.path == "/api" or request.path.startswith("/api/"):
            raise HttpError(
                HTTPStatus.NOT_FOUND,
                ERROR_NAMES[HTTPStatus.NOT_FOUND],
                f"Không có tuyến {request.method} {request.path}",
            )
        if request.method != "GET":
            raise HttpError(
                HTTPStatus.NOT_FOUND,
                ERROR_NAMES[HTTPStatus.NOT_FOUND],
                f"Không có tuyến {request.method} {request.path}",
            )
        return serve_static(self.paths, request.path)


class Sim3DRequestHandler(BaseHTTPRequestHandler):
    """Handler của ``http.server``; mọi lỗi đi qua :meth:`_send`."""

    server_version = f"sim3d_server/{VERSION}"
    protocol_version = "HTTP/1.1"

    #: Gán bởi :func:`make_server`.
    app: App

    def do_GET(self) -> None:
        self._handle("GET")

    def do_PUT(self) -> None:
        self._handle("PUT")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def _handle(self, method: str) -> None:
        split = urlsplit(self.path)
        query: dict[str, str] = {}
        if split.query:
            for pair in split.query.split("&"):
                key, _, value = pair.partition("=")
                query[key] = value
        content_length = 0
        length_header = self.headers.get("Content-Length")
        if length_header is not None:
            try:
                content_length = int(length_header)
            except ValueError:
                self.close_connection = True
                self._send(
                    Response.json(
                        HTTPStatus.BAD_REQUEST,
                        {
                            "error": ERROR_NAMES[HTTPStatus.BAD_REQUEST],
                            "detail": f"Content-Length không phải số: {length_header!r}",
                        },
                    )
                )
                return
        request = Request(
            method=method,
            path=split.path,
            query=query,
            headers=self.headers,
            body_reader=self.rfile,
            content_length=content_length,
        )
        try:
            response = self.app.dispatch(request)
        except HttpError as error:
            # Body có thể chưa đọc hết: đóng kết nối để khỏi lệch khung HTTP/1.1.
            self.close_connection = True
            self._send(
                Response.json(
                    error.status,
                    {"error": error.error, "detail": error.detail},
                )
            )
            return
        except Exception as error:
            LOGGER.exception("Lỗi không xử lý khi phục vụ %s %s", method, self.path)
            self.close_connection = True
            self._send(
                Response.json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": ERROR_NAMES[HTTPStatus.INTERNAL_SERVER_ERROR],
                        "detail": f"{type(error).__name__}: {error}",
                    },
                )
            )
            return
        self._send(response)

    def _send(self, response: Response) -> None:
        """Ghi response: JSON cho API, payload thô cho file tĩnh."""
        if response.payload is not None:
            payload = response.payload
            content_type = response.content_type
        elif response.body is None:
            payload = b""
            content_type = JSON_CONTENT_TYPE
        else:
            payload = json.dumps(response.body, ensure_ascii=False).encode("utf-8")
            content_type = JSON_CONTENT_TYPE
        self.send_response(response.status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if payload and response.status not in (
            HTTPStatus.NO_CONTENT,
            HTTPStatus.NOT_MODIFIED,
        ):
            self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        LOGGER.info("%s - %s", self.address_string(), format % args)


def make_server(paths: DataPaths, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    """Tạo server đã bind ``127.0.0.1:<port>``. ``port=0`` để lấy cổng trống (test)."""
    handler_class = type(
        "BoundSim3DRequestHandler",
        (Sim3DRequestHandler,),
        {"app": App(paths=paths)},
    )
    server = ThreadingHTTPServer((BIND_HOST, port), handler_class)
    server.daemon_threads = True
    return server
