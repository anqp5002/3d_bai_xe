# Contract C-B — API của `sim3d_server`

Nguồn: `docs/superpowers/specs/2026-10-30-sim3d-be.md` §3 (bảng endpoint), §4 (video), §5 (`techgar_config/`),
§6 (`verify.json`). Ghi lại ở đây thành hợp đồng chốt cho FE và BE; mọi phase sau tuân theo file này.
Chỉ lead/coder-main được sửa (R1) và phải báo lead trước khi đổi.

- Base: `http://127.0.0.1:8010` — **chỉ bind `127.0.0.1`** (BE §1).
- Tiền tố: `/api`. Không có xác thực (chỉ localhost).
- FE chỉ được biết URL trong `sim3d/web/src/api/client.ts` (MEGAPLAN C-B). Lúc dev, Vite proxy `/api` →
  `127.0.0.1:8010`; lúc production BE phục vụ luôn `web/dist`.
- Mọi body là UTF-8. Lỗi **luôn** là JSON `{error, detail}` — không HTML, không body rỗng (BE §1, R2).

## 0. Quy ước chung

### 0.1 Lỗi

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
```

```json
{
  "error": "bad_request",
  "detail": "scenarios/K9.sim3d.json: schema: phải bằng 1"
}
```

| `error` | HTTP | Khi nào |
|---|---|---|
| `bad_request` | 400 | JSON sai, sai schema/trường bắt buộc, tên file sai |
| `not_found` | 404 | Không có tuyến, không có kịch bản/lần xuất/template |
| `forbidden_path` | 403 | `PUT files` có `..`, đường dẫn tuyệt đối, hoặc ngoài danh sách cho phép |
| `conflict` | 409 | Ghi đè lần xuất đã tồn tại khi không cho phép |
| `too_large` | 413 | Body vượt giới hạn (mp4 2 GB, json 16 MB, csv 512 MB) |
| `unsupported_media` | 415 | `Content-Type` không đúng |
| `internal_error` | 500 | Lỗi lập trình; `detail` có `ClassName: message` |
| `ffmpeg_missing` | 503 | `finalize` cần ghép PNG nhưng máy không có ffmpeg |

### 0.2 Giới hạn body (BE §3)

| Loại | Giới hạn |
|---|---|
| `*.mp4` | 2 GB |
| `*.json`, `*.csv` | 16 MB / 512 MB |
| `frames` PNG (mỗi lô) | 512 MB |

Ghi file **theo luồng**, không đọc cả body vào RAM.

### 0.3 Định dạng dùng chung

`Scenario` đúng `sim3d/web/src/contracts/scenario.ts` (`schema: 1`, FE §5).
`verify.json` đúng mục 6 dưới đây. Thời gian là ISO 8601 UTC (`2026-10-31T04:15:00Z`).

---

## 1. `GET /api/health`

Kiểm server sống và có ffmpeg (đường dự phòng BE §4.3).

**Response 200**

```json
{ "ok": true, "version": "0.1.0", "ffmpeg": true }
```

| Trường | Kiểu | Nghĩa |
|---|---|---|
| `ok` | bool | Server chạy được |
| `version` | string | `sim3d_server.VERSION` |
| `ffmpeg` | bool | `shutil.which("ffmpeg") is not None` |

---

## 2. `GET /api/lot/pucpr`

Trả nguyên `data/lot/lot_pucpr.json` (FE §3, sinh bởi `sim3d/tools/build_lot.py` ở P2).

**Response 200** — rút gọn (đủ 100 ô khi thật):

```json
{
  "name": "pucpr",
  "camera": {
    "pitch_deg": 80,
    "f_px": 288,
    "height_m": 33.6,
    "res": [640, 640],
    "cam1_x": [0, 400],
    "cam2_x": [240, 640]
  },
  "slots": [
    {
      "id": "S001",
      "row": "1",
      "center": [3.41, 19.72],
      "heading": 3.141592653589793,
      "polygon": [[2.37, 19.02], [2.41, 20.42], [4.45, 20.36], [4.41, 18.96]],
      "polygon_px": [[601.2, 300.5], [612.8, 312.1], [628.4, 296.7], [616.9, 285.1]],
      "width_m": 2.4,
      "reachable": true
    }
  ],
  "aisles": [
    { "id": "A_mid", "polyline": [[1.0, 21.0], [30.0, 21.0]], "width_m": 5.5, "oneway": true }
  ],
  "gates": {
    "in": {
      "p1": [29.4, 20.1],
      "p2": [29.4, 22.6],
      "p1_px": [615, 322],
      "p2_px": [615, 364],
      "spawn": [32.0, 21.35, 3.141592653589793],
      "despawn": [33.0, 21.35]
    },
    "out": {
      "p1": [1.2, 20.1],
      "p2": [1.2, 22.6],
      "p1_px": [25, 322],
      "p2_px": [25, 364],
      "spawn": [-2.0, 21.35, 0.0],
      "despawn": [-3.0, 21.35]
    }
  },
  "decor": {
    "grass": [],
    "curbs": [],
    "asphalt": [],
    "trees": [{ "pos": [29.0, 18.0], "radius_m": 1.4, "height_m": 4.2, "kind": "round" }],
    "lamps": [{ "pos": [12.0, 23.5], "height_m": 6.0, "night_light": true }]
  }
}
```

**Lỗi**: `404 not_found` khi chưa có `data/lot/lot_pucpr.json` (P2 chưa chạy).

---

## 3. `GET /api/templates`

Danh sách 8 kịch bản mẫu K1–K8 trong `data/templates/`.

**Response 200**

```json
[
  { "id": "K1", "name": "Xe đơn", "description": "1 xe vào, đỗ 15 s, ra, E1" },
  { "id": "K2", "name": "Đồng thời", "description": "3 xe vào cách 2 s, có cặp cùng màu, E3" },
  { "id": "K3", "name": "Ra–vào chéo", "description": "Xe đỗ sẵn rời đúng lúc xe mới vào lối" },
  { "id": "K4", "name": "Hàng chờ cổng", "description": "6 xe dồn cổng" },
  { "id": "K5", "name": "Cả ngày", "description": "E2, 20 chu trình rải đều" },
  { "id": "K6", "name": "Đêm mưa", "description": "E8, 8 chu trình" },
  { "id": "K7", "name": "Bãi đầy", "description": "90 xe đỗ sẵn, 5 xe ra/vào" },
  { "id": "K8", "name": "Tĩnh kiểm thu", "description": "30 xe, E1, không sự kiện, 20 s" }
]
```

`description` lấy từ trường `description` trong file mẫu nếu có, ngược lại BE đặt theo danh sách trên.

---

## 4. `GET /api/templates/<id>`

Trả nội dung `data/templates/<id>.sim3d.json`.

**Request**: `GET /api/templates/K8`

**Response 200**

```json
{
  "schema": 1,
  "lot": "pucpr",
  "seed": 8811,
  "car_scale": 1.1,
  "default_speed_kmh": 10,
  "camera_mode": "2cam",
  "initial": {
    "n_parked": 30,
    "placement": [
      { "slot": "S004", "car_id": "V001", "model": "sedan", "color": "white" },
      { "slot": "S017", "car_id": "V002", "model": "suv", "color": "red" }
    ]
  },
  "env": { "preset": "E1", "keyframes": [{ "t_s": 0, "hour": 12, "weather": "sun", "intensity": 0.8 }] },
  "noise": {
    "shake": { "on": false, "level": 0.5 },
    "grain": { "on": false, "level": 0.5 },
    "jpeg": { "on": false, "level": 0.5 },
    "downscale": { "on": false, "level": 0.5 },
    "fps_drop": { "on": false, "level": 0.5 },
    "flare": { "on": false, "level": 0.5 },
    "drops": { "on": false, "level": 0.5 },
    "smudge": { "on": false, "level": 0.5 },
    "white_balance": { "on": false, "level": 0.5 },
    "seed": 8811
  },
  "events": [],
  "duration_frames": 500
}
```

**Lỗi**: `404 not_found` (`detail: "không có template \"K9\""`). `<id>` bị chặn path traversal → `403 forbidden_path`.

---

## 5. `GET /api/scenarios`

Danh sách kịch bản người dùng trong `data/scenarios/`.

**Response 200**

```json
[
  { "name": "thu-nghiem-1", "modified_at": "2026-10-31T04:12:33Z" },
  { "name": "K2-copy", "modified_at": "2026-10-30T21:40:05Z" }
]
```

`name` = tên file bỏ đuôi `.sim3d.json`. Sắp xếp mới sửa trước.

---

## 6. `GET` / `PUT` / `DELETE /api/scenarios/<name>`

### 6.1 `GET /api/scenarios/<name>`

**Response 200**: nội dung file, đúng `Scenario` (`schema: 1`).

```json
{ "schema": 1, "lot": "pucpr", "seed": 7, "car_scale": 1.1, "default_speed_kmh": 10,
  "camera_mode": "1cam",
  "initial": { "n_parked": 0, "placement": [] },
  "env": { "preset": "E1", "keyframes": [{ "t_s": 0, "hour": 12, "weather": "sun", "intensity": 0.8 }] },
  "noise": { "shake": { "on": false, "level": 0.5 }, "grain": { "on": false, "level": 0.5 },
             "jpeg": { "on": false, "level": 0.5 }, "downscale": { "on": false, "level": 0.5 },
             "fps_drop": { "on": false, "level": 0.5 }, "flare": { "on": false, "level": 0.5 },
             "drops": { "on": false, "level": 0.5 }, "smudge": { "on": false, "level": 0.5 },
             "white_balance": { "on": false, "level": 0.5 }, "seed": 7 },
  "events": [], "duration_frames": 500 }
```

**Lỗi**: `404 not_found`; `<name>` sai ký tự (`[A-Za-z0-9_-]+`) → `400 bad_request`.

### 6.2 `PUT /api/scenarios/<name>`

**Request**

```http
PUT /api/scenarios/thu-nghiem-1 HTTP/1.1
Content-Type: application/json

{ "schema": 1, "lot": "pucpr", "seed": 7, ... }
```

**Response 204**: body rỗng (ghi xong).

**Response 400** — sai schema hoặc thiếu trường bắt buộc, `detail` chỉ đúng đường dẫn trường:

```json
{
  "error": "bad_request",
  "detail": "scenarios/thu-nghiem-1.sim3d.json: initial.placement: có 1 phần tử nhưng n_parked = 2"
}
```

Trường bắt buộc (giống `validateScenario` của FE):
`schema(=1)`, `lot`, `seed`, `car_scale` (1,00–1,30), `default_speed_kmh` (5–20), `camera_mode` (`1cam|2cam`),
`initial.n_parked` (0–100), `initial.placement`, `env.keyframes` (≥ 1), `noise` đủ 9 khoá + `seed`,
`events` (frame tăng dần, D9), `duration_frames`.

### 6.3 `DELETE /api/scenarios/<name>`

**Response 204**. **Lỗi** `404 not_found` nếu không có file.

---

## 7. `POST /api/runs`

Tạo thư mục `data/runs/<run_id>/`.

**Request**

```json
{ "name": "K8-kiem-thu", "outputs": ["full", "cam1", "cam2"], "duration_frames": 500, "fps": 25 }
```

- `name`: `[A-Za-z0-9_-]{1,40}`; dùng cho `run_id`.
- `outputs`: tập con của `["full", "cam1", "cam2"]`, không rỗng.
- `fps` phải là 25 (BE §4.2); giá trị khác → `400`.

**Response 200**

```json
{ "run_id": "20261031-041500_K8-kiem-thu" }
```

`run_id` = `YYYYMMDD-HHMMSS_<tên>`; trùng tên thì thêm hậu tố `-2`, `-3`…, **không ghi đè** (BE §2).

**Lỗi**: `400 bad_request` (thiếu `outputs`, `fps ≠ 25`), `409 conflict` nếu vượt 99 lần trùng tên trong một giây.

---

## 8. `PUT /api/runs/<run_id>/files/<path>`

FE gửi **nguyên file** đã dựng: mp4, csv, json (BE §4.1 — BE không xử lý lại video).

**Request**

```http
PUT /api/runs/20261031-041500_K8-kiem-thu/files/raw_full.mp4 HTTP/1.1
Content-Type: video/mp4
Content-Length: 18345210

<bytes>
```

**Response 204**.

**Path được phép** (so khớp chính xác, không glob):

```
scenario.sim3d.json
raw_full.mp4
raw_cam1.mp4
raw_cam2.mp4
gt_frames.csv
gt_events.csv
frame_timestamps.csv
export_log.json
techgar_config/calibration.json
techgar_config/parking_slots_cam1.json
techgar_config/parking_slots_cam2.json
techgar_config/gate_zones.json
techgar_config/roi_mask_cam1.json
techgar_config/roi_mask_cam2.json
techgar_config/MANIFEST.json
techgar_config/README.txt
```

**Lỗi**

```json
{ "error": "forbidden_path", "detail": "path không được phép: ../../backend/main_detect/config" }
```

| Mã | Khi nào |
|---|---|
| `403 forbidden_path` | Có `..`, đường dẫn tuyệt đối (`/`, `\`, `C:`), hoặc ngoài danh sách |
| `404 not_found` | `run_id` không tồn tại |
| `413 too_large` | Vượt giới hạn §0.2 |
| `415 unsupported_media` | `Content-Type` không khớp đuôi file |

BE ghi theo luồng vào `<run_id>/<path>`, tạo thư mục cha nếu là `techgar_config/`.

---

## 9. `POST /api/runs/<run_id>/frames`

Đường dự phòng khi trình duyệt không có H.264 encoder (C12, D12): gửi PNG từng frame.
Tên file do BE đặt theo `frame_index` — `%06d.png` **bắt đầu 0** (D12), ghi vào `frames_tmp/`.

**Request** — `multipart/form-data`, mỗi request một frame:

```
--boundary
Content-Disposition: form-data; name="frame_index"

0
--boundary
Content-Disposition: form-data; name="file"; filename="000000.png"
Content-Type: image/png

<bytes PNG 640×640>
--boundary--
```

**Response 204**.

**Lỗi**: `400 bad_request` (`frame_index` không phải số nguyên ≥ 0, thiếu `file`, PNG không đọc được),
`404 not_found`, `413 too_large`.

---

## 10. `POST /api/runs/<run_id>/finalize`

Nếu có `frames_tmp/` thì ghép bằng ffmpeg (BE §4.3), rồi chạy kiểm §6 và ghi `verify.json`.

**Lệnh ffmpeg (BE §4.3)**

```
ffmpeg -framerate 25 -start_number 0 -i frames_tmp/%06d.png -c:v libx264 -pix_fmt yuv420p -r 25 raw_xxx.mp4
```

Thiếu frame trong dãy → lỗi, **không lấp** (R2). Ghép xong xóa `frames_tmp/`.

**Request**

```http
POST /api/runs/20261031-041500_K8-kiem-thu/finalize HTTP/1.1
```

**Response 200** — chính là nội dung `verify.json`:

```json
{
  "ok": true,
  "run_id": "20261031-041500_K8-kiem-thu",
  "generated_at": "2026-10-31T04:17:02Z",
  "items": [
    { "id": 1, "ok": true, "detail": "raw_full.mp4: 500 frame, 25 fps, 640×640; GT 500 dòng; timestamps 500 dòng" },
    { "id": 2, "ok": true, "detail": "gt_frames.csv: đủ 100 cột S001–S100, giá trị 0/1; gt_events.csv có _u/_v/_cams" },
    { "id": 3, "ok": true, "detail": "gt_events.csv: gate_in ≤ parked ≤ depart ≤ gate_out ở mọi dòng" },
    { "id": 4, "ok": true, "detail": "techgar_config: 7 file JSON parse được, 100 ô S001–S100" },
    { "id": 5, "ok": true, "detail": "verify_overlay_0.jpg, verify_overlay_mid.jpg, verify_overlay_last.jpg" },
    { "id": 6, "ok": true, "detail": "xuất 41.2 s cho 20.0 s video (tỉ lệ 0.49× thời gian thực)" }
  ],
  "export_seconds": 41.2,
  "realtime_ratio": 0.49
}
```

**Response 200 khi hỏng** — vẫn 200 nhưng `ok: false` kèm lý do đúng (BE §6: “không im lặng”):

```json
{
  "ok": false,
  "run_id": "20261031-041500_K8-kiem-thu",
  "generated_at": "2026-10-31T04:17:02Z",
  "items": [
    { "id": 1, "ok": false, "detail": "raw_cam1.mp4: 499 frame, cần 500" },
    { "id": 2, "ok": false, "detail": "gt_frames.csv: thiếu 100 cột S001–S100" }
  ],
  "export_seconds": 39.8,
  "realtime_ratio": 0.50
}
```

**Sáu mục kiểm (BE §6) — cố định `id`:**

| id | Kiểm |
|---|---|
| 1 | Mỗi mp4 mở được bằng `cv2.VideoCapture`; đếm frame thật = `duration_frames` = số dòng `gt_frames.csv` = số dòng `frame_timestamps.csv`; fps 25; kích thước đúng §4.2 |
| 2 | `gt_frames.csv` đủ 100 cột `S001`–`S100` giá trị 0/1; mọi xe trong `gt_events.csv` có `_u/_v/_cams` |
| 3 | `gt_events.csv`: frame tăng dần và `gate_in ≤ parked ≤ depart ≤ gate_out` |
| 4 | `techgar_config/`: parse được JSON, đủ file, mỗi file slot có 1–100 ô, id thuộc `S001`–`S100` |
| 5 | Vẽ đa giác ô có xe theo GT lên 3 frame (đầu/giữa/cuối) của `raw_full.mp4` → `verify_overlay_{0,mid,last}.jpg` |
| 6 | Thời gian xuất và tỉ lệ so với thời gian thực |

**Lỗi**: `503 ffmpeg_missing` kèm hướng dẫn cài khi cần ghép PNG mà không có ffmpeg:

```json
{
  "error": "ffmpeg_missing",
  "detail": "Cần ffmpeg để ghép frames_tmp/. Cài: winget install Gyan.FFmpeg, rồi mở lại terminal."
}
```

---

## 11. `GET /api/runs` · `GET /api/runs/<run_id>`

### 11.1 `GET /api/runs`

**Response 200**

```json
[
  {
    "run_id": "20261031-041500_K8-kiem-thu",
    "created_at": "2026-10-31T04:15:00Z",
    "files": ["scenario.sim3d.json", "raw_full.mp4", "gt_frames.csv", "gt_events.csv",
              "frame_timestamps.csv", "export_log.json", "verify.json", "techgar_config/MANIFEST.json"],
    "verify": { "ok": true, "run_id": "20261031-041500_K8-kiem-thu", "generated_at": "2026-10-31T04:17:02Z",
                "items": [], "export_seconds": 41.2, "realtime_ratio": 0.49 }
  }
]
```

Mới nhất trước. `files` là đường dẫn tương đối trong `<run_id>/`.

### 11.2 `GET /api/runs/<run_id>`

**Response 200**: một phần tử như trên, `verify` là `null` nếu chưa `finalize`.

**Lỗi**: `404 not_found`.

---

## 12. `POST /api/runs/<run_id>/open-folder`

Mở thư mục lần xuất trong Explorer (`os.startfile`), **chỉ trên Windows**.

**Response 200**

```json
{ "ok": true, "path": "D:\\TechGar2\\sim3d\\data\\runs\\20261031-041500_K8-kiem-thu" }
```

**Lỗi**: `501 not_implemented` trên hệ điều hành khác (`detail: "open-folder chỉ hỗ trợ Windows"`),
`404 not_found` nếu `run_id` không tồn tại.

---

## 13. Phục vụ tĩnh `web/dist` (BE §1)

Ngoài `/api/*`, BE phục vụ `sim3d/web/dist` tại `/` để chạy production bằng một lệnh:

- `/` → `dist/index.html`
- `/assets/<file>` → file tĩnh có hash trong `dist/assets/`
- Mọi path không có phần mở rộng và không bắt đầu `/api` → `dist/index.html` (SPA), **trừ khi**
  `dist/` không tồn tại → `404 not_found` JSON kèm `detail: "chưa build web/dist (npm run build)"`.

`/api/*` **luôn** được xử lý trước, không rơi vào SPA fallback.

---

## 14. Ghi chú ràng buộc chéo (để BE/QA khỏi hiểu sai)

- `duration_frames` là **số frame** (0-based: frame 0 … `duration_frames − 1`), không phải frame cuối.
- Video 25 fps CFR (BE §4.2): full/1 cam `640×640`, cam1/cam2 `400×640`.
- `techgar_config/` do **FE** tính số liệu (FE có hình học chính xác); BE chỉ lưu + kiểm định dạng (BE §5).
- Tên file video/GT giữ đúng bộ cũ (BE §2) để script cũ dùng lại.
- `frame_timestamps.csv` của sim: `frame_idx` bắt đầu **1**, `ns = 1e12 + f × 40 000 000` với `f` là frame
  0-based (FE §4.6) — khớp `docs/pklot_video/ds/gen_dataset.py:474-475`.
