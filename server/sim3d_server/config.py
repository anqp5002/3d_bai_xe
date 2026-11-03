"""Đường dẫn dữ liệu, giới hạn body và hằng số dùng chung (BE spec §2, §3).

``api_contract.md`` là nguồn chốt của các con số ở đây; đổi thì phải báo lead (R1).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

#: Thư mục con dưới ``data/`` (BE §2).
LOT_DIRNAME = "lot"
TEMPLATES_DIRNAME = "templates"
SCENARIOS_DIRNAME = "scenarios"
RUNS_DIRNAME = "runs"

#: Tên bãi duy nhất hiện hỗ trợ (ý tưởng §4: chỉ PUCPR).
LOT_PUCPR_FILENAME = "lot_pucpr.json"

#: Hậu tố kịch bản người dùng + mẫu (FE §5, BE §2).
SCENARIO_SUFFIX = ".sim3d.json"

#: Giới hạn body cho từng loại file, byte (BE §3, contract C-B §0.2).
MAX_VIDEO_BYTES = 2 * 1024**3
MAX_JSON_BYTES = 16 * 1024**2
MAX_CSV_BYTES = 512 * 1024**2
MAX_FRAMES_BYTES = 512 * 1024**2

#: fps cố định của mọi video (U19, BE §4.2).
FPS = 25

#: Ba đầu ra FE có thể chọn (BE §3 `POST /api/runs`).
OUTPUT_NAMES = ("full", "cam1", "cam2")

#: Kích thước khung theo BE §4.2: full/1 cam 640×640, cam1/cam2 400×640.
VIDEO_SIZES: dict[str, tuple[int, int]] = {
    "full": (640, 640),
    "cam1": (400, 640),
    "cam2": (400, 640),
}

#: Đường dẫn tương đối được phép ghi vào một lần xuất (contract C-B §8).
ALLOWED_RUN_FILES = frozenset(
    {
        "scenario.sim3d.json",
        "raw_full.mp4",
        "raw_cam1.mp4",
        "raw_cam2.mp4",
        "gt_frames.csv",
        "gt_events.csv",
        # ANS_18: GT "bộ đếm lý tưởng" (mô phỏng máy trạng thái gate_session_controller).
        "gt_gate_ideal.csv",
        "frame_timestamps.csv",
        "export_log.json",
        "techgar_config/calibration.json",
        "techgar_config/parking_slots_cam1.json",
        "techgar_config/parking_slots_cam2.json",
        "techgar_config/gate_zones.json",
        "techgar_config/roi_mask_cam1.json",
        "techgar_config/roi_mask_cam2.json",
        "techgar_config/MANIFEST.json",
        "techgar_config/README.txt",
    }
)

#: 7 file JSON bắt buộc trong ``techgar_config/`` (BE §5, contract C-B §8).
TECHGAR_JSON_FILES = (
    "calibration.json",
    "parking_slots_cam1.json",
    "parking_slots_cam2.json",
    "gate_zones.json",
    "roi_mask_cam1.json",
    "roi_mask_cam2.json",
    "MANIFEST.json",
)

#: File có mảng ``slots[]`` cần kiểm id/ô (BE §6 mục 4).
TECHGAR_SLOT_FILES = ("parking_slots_cam1.json", "parking_slots_cam2.json")

#: Toàn bộ file bắt buộc trong ``techgar_config/`` (JSON + README).
TECHGAR_REQUIRED_FILES = (*TECHGAR_JSON_FILES, "README.txt")

#: Mã ô của sim (D1/R7; `lot.ts`).
SLOT_IDS = tuple(f"S{index:03d}" for index in range(1, 101))
SLOT_ID_SET = frozenset(SLOT_IDS)

#: Tên file được phép: chữ, số, ``_``, ``-`` (contract C-B §4, §6, §7).
NAME_RE = re.compile(r"[A-Za-z0-9_-]+")
RUN_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,40}")

#: Tên + mô tả mặc định của 8 kịch bản mẫu (contract C-B §3).
TEMPLATE_DEFAULTS: dict[str, tuple[str, str]] = {
    "K1": ("Xe đơn", "1 xe vào, đỗ 15 s, ra, E1"),
    "K2": ("Đồng thời", "3 xe vào cách 2 s, có cặp cùng màu, E3"),
    "K3": ("Ra–vào chéo", "Xe đỗ sẵn rời đúng lúc xe mới vào lối"),
    "K4": ("Hàng chờ cổng", "6 xe dồn cổng"),
    "K5": ("Cả ngày", "E2, 20 chu trình rải đều"),
    "K6": ("Đêm mưa", "E8, 8 chu trình"),
    "K7": ("Bãi đầy", "90 xe đỗ sẵn, 5 xe ra/vào"),
    "K8": ("Tĩnh kiểm thu", "30 xe, E1, không sự kiện, 20 s"),
}


@dataclass(frozen=True, slots=True)
class DataPaths:
    """Bố cục ``data/`` đã chuẩn hoá thành đường dẫn tuyệt đối."""

    root: Path

    @classmethod
    def from_root(cls, root: str | Path) -> DataPaths:
        """Chuẩn hoá ``--root`` thành đường dẫn tuyệt đối.

        Không tạo thư mục: ``--root`` sai là lỗi cấu hình, phải báo ngay (R2).
        """
        resolved = Path(root).expanduser().resolve()
        if not resolved.is_dir():
            raise NotADirectoryError(f"--root không phải thư mục: {resolved}")
        return cls(root=resolved)

    @property
    def lot_file(self) -> Path:
        return self.root / LOT_DIRNAME / LOT_PUCPR_FILENAME

    @property
    def templates_dir(self) -> Path:
        return self.root / TEMPLATES_DIRNAME

    @property
    def scenarios_dir(self) -> Path:
        return self.root / SCENARIOS_DIRNAME

    @property
    def runs_dir(self) -> Path:
        return self.root / RUNS_DIRNAME

    @property
    def web_dist_dir(self) -> Path:
        """``sim3d/web/dist`` — BE phục vụ tĩnh (BE §1, contract C-B §13)."""
        return self.root.parent / "web" / "dist"
