"""``python -m sim3d_server`` — chạy BE nội bộ (BE spec §1).

Chỉ bind ``127.0.0.1``; không có cờ đổi host vì mở ra mạng là ngoài phạm vi (BE §8).
"""

from __future__ import annotations

import argparse
import logging
import sys

from sim3d_server.config import DataPaths
from sim3d_server.server import DEFAULT_PORT, make_server
from sim3d_server.version import VERSION


def build_parser() -> argparse.ArgumentParser:
    """Tham số dòng lệnh. ``--root`` mặc định ``../data`` như README."""
    parser = argparse.ArgumentParser(
        prog="python -m sim3d_server",
        description="SIM3D server nội bộ (chỉ nghe 127.0.0.1).",
    )
    parser.add_argument(
        "--root",
        default="../data",
        help="thư mục data/ của sim3d (mặc định: ../data)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"cổng TCP (mặc định {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        help="mức log (mặc định INFO)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Chạy server tới khi bị Ctrl+C. Trả mã thoát."""
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        paths = DataPaths.from_root(args.root)
    except NotADirectoryError as error:
        print(f"Lỗi: {error}", file=sys.stderr)
        return 2
    server = make_server(paths, args.port)
    host, port = server.server_address[:2]
    print(f"sim3d_server {VERSION} — http://{host}:{port} (root {paths.root})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Dừng server.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
