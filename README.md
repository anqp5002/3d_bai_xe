# SIM3D — web dựng bãi PUCPR 3D sinh video + GT cho TechGAR

Web nội bộ, tách hoàn toàn khỏi `backend/` và `frontend/` của TechGAR (ý tưởng §4).
Dựng bãi **PUCPR** (bộ PKLot) thành cảnh 3D kiểu đồ chơi, camera khớp camera dataset,
sinh **GT theo từng frame** và **bộ config TechGAR** để chạy replay.

Spec nguồn (đọc theo thứ tự, **§14 của file ý tưởng thắng mọi chỗ khác**):

1. `docs/superpowers/specs/2026-10-30-sim3d-y-tuong.md`
2. `docs/superpowers/specs/2026-10-30-sim3d-fe.md`
3. `docs/superpowers/specs/2026-10-30-sim3d-be.md`
4. Contract đã chốt: `.orca/briefs/MEGAPLAN-SIM3D.md` mục “Contract” (C-A, C-B, C-C)

---

# A. Chạy cho người dùng (máy sạch, một lệnh)

## A.1 Cài lần đầu

Yêu cầu: **Python 3.11**, **Node.js ≥ 20** (đã kiểm 24.20.0), npm ≥ 10.
`ffmpeg` **không bắt buộc** — chỉ cần khi trình duyệt không có H.264 và phải ghép PNG.

```powershell
cd D:\TechGar2\sim3d\server
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"

cd ..\web
npm ci
```

`npm ci` (không phải `npm install`) để cài đúng `package-lock.json` — cần cho máy khác.

## A.2 Chạy web + BE bằng **một** lệnh

BE phục vụ luôn bản build của web (`sim3d_server/static.py`; `DataPaths.web_dist_dir`
= `sim3d/web/dist`). Nên chỉ cần build một lần rồi chạy BE:

```powershell
cd D:\TechGar2\sim3d\web
npm run build

cd D:\TechGar2\sim3d\server
.\.venv\Scripts\python.exe -m sim3d_server --root ../data
```

Mở **<http://127.0.0.1:8010>** — giao diện + API cùng cổng, không cần Vite.

- Kiểm BE: `curl http://127.0.0.1:8010/api/health` → `{"ok":true,"version":"0.1.0","ffmpeg":false}`
- BE chỉ bind **127.0.0.1:8010**; đổi cổng bằng `--port 8011` (nhớ sửa `vite.config.ts` nếu
  dùng `npm run dev`).
- Log chi tiết: thêm `--log-level DEBUG`.
- Chưa build `web/dist` thì BE trả 404 kèm câu "chưa build web/dist (npm run build)" — không
  im lặng.

## A.3 Chạy khi đang sửa code (hot reload)

Hai terminal. Vite proxy `/api` sang `http://127.0.0.1:8010` (đích là IPv4 vì BE chỉ bind IPv4).

```powershell
# terminal 1
cd D:\TechGar2\sim3d\server
.\.venv\Scripts\python.exe -m sim3d_server --root ../data

# terminal 2
cd D:\TechGar2\sim3d\web
npm run dev            # http://localhost:5173
```

`src/api/client.ts` là **file duy nhất** biết URL của BE (MEGAPLAN C-B).

---

# B. Xuất video + GT + config TechGAR

Trong giao diện:

1. Panel **Kịch bản** → chọn mẫu `K1`…`K8` → **Nạp mẫu** (hoặc tự thêm xe / sự kiện).
2. Chọn **1 cam** hoặc **2 cam**.
3. Panel **Xuất** → đặt tên → **Xuất**.

Kết quả nằm ở `sim3d/data/runs/<run_id>/` (`run_id` = `<YYYYMMDD-HHMMSS>_<tên>`):

| File | Nội dung |
|---|---|
| `raw_full.mp4` | 640×640, toàn cảnh (chỉ khi chọn full; **không** phóng theo `s`) |
| `raw_cam1.mp4` / `raw_cam2.mp4` | 800×1280 ở `s = 2` (cột 0–400 và 240–640 nhân `s`; U19) |
| `gt_frames.csv` | `frame` + `S001`…`S100` (1 = có xe) + `V*_u/V*_v/V*_cams` |
| `gt_events.csv` | `car, slot, gate_in_frame, parked_frame, depart_frame, …, gate_out_frame` |
| `frame_timestamps.csv` | `frame_idx` **1-based**, `cam1/cam2_monotonic_ns` (`1e12 + f × 4e7`) |
| `scenario.sim3d.json` | kịch bản đã dùng (chạy lại ra đúng kết quả này) |
| `export_log.json` | cách xuất (WebCodecs/PNG), `realtime_ratio`, `park_clip` |
| `verify.json` | 6 mục kiểm của BE; `ok:true` là dùng được |
| `techgar_config/` | 8 file cho TechGAR (xem C) |

Xuất bằng script (không cần mở trình duyệt):

```powershell
cd D:\TechGar2\sim3d\server
.\.venv\Scripts\python.exe -m sim3d_server --root ../data

# terminal khác
cd D:\TechGar2\sim3d\web
node ..\tools\export_template.mjs --template K8 --mode 2cam --name K8-cua-toi
node ..\tools\export_template.mjs --template K2 --mode 2cam --name K2-cua-toi
```

Script đọc số frame/số xe thật của template nên **không** hard-code. Nó in `verify.json` và
thoát mã 1 nếu `verify.ok` khác `true`.

---

# C. Chạy TechGAR replay trên bộ config vừa xuất

Bộ `techgar_config/` gồm 8 file (`MANIFEST.json`, `README.txt`, `calibration.json`,
`gate_zones.json`, `parking_slots_cam1.json`, `parking_slots_cam2.json`,
`roi_mask_cam1.json`, `roi_mask_cam2.json`). **`<RUN_DIR>/techgar_config/README.txt`** có
lệnh đầy đủ với đường dẫn tuyệt đối — đó là bản chuẩn, đọc file đó trước.

Tóm tắt (PowerShell, `<RUN_DIR>` = `D:\TechGar2\sim3d\data\runs\<run_id>`):

```powershell
$VENV   = "D:\TechGar2\backend\main_detect\.venv\Scripts\python.exe"
$SERVER = "D:\TechGar2\backend\main_detect\runtime_server.py"
$RUN    = "D:\TechGar2\sim3d\data\runs\20261101-004008_K2-kiem-thu"   # thay run thật
$CFG    = "$RUN\techgar_config"

& $VENV $SERVER `
  --replay-session "$RUN" `
  --slots-cam1 "$CFG\parking_slots_cam1.json" `
  --slots-cam2 "$CFG\parking_slots_cam2.json" `
  --calibration "$CFG\calibration.json" `
  --mask-cam1 "$CFG\roi_mask_cam1.json" `
  --mask-cam2 "$CFG\roi_mask_cam2.json" `
  --detector-profile "D:\TechGar2\backend\main_detect\config\two_camera.detector.json" `
  --output-dir "$RUN\runtime" `
  --session-dir "$RUN\runtime_session" `
  --api-port 8001 --no-display
```

Ba điều dễ sai (đã trả giá ở P7e/P10c):

1. **Không có cờ `--cam1-video/--cam2-video`.** Cờ thật là `--replay-session <thư mục>`; thư mục
   đó phải có `raw_cam1.mp4`, `raw_cam2.mp4`, `frame_timestamps.csv` (đúng tên).
2. **`--session-dir` phải là thư mục CHƯA tồn tại** — `two_camera.py:2035` ném
   `FileExistsError` nếu đã có. Chạy lại thì đổi tên hoặc xoá.
3. **`--live-mode` chỉ cần khi chạy kèm `gate_session_controller`.** Replay một mình thì
   **không** thêm. Lý do: controller chỉ nhận snapshot `source_mode == "live"`
   (`gate_session_controller.py:104`), còn replay mặc định phát `source_mode="replay"`
   (`two_camera.py:2864`).

Đếm cổng vào/ra (tuỳ chọn, cần `--live-mode` ở bước trên):

```powershell
& $VENV "D:\TechGar2\backend\gate_session_controller.py" `
  --runtime-url "http://127.0.0.1:8001/api/runtime/snapshot" `
  --gate-config "$CFG\gate_zones.json" `
  --port 8000
```

> **`gate_session_controller.py` KHÔNG có cờ `--live-mode`.** `parser()` của nó (dòng 855–868)
> chỉ có `--source`, `--runtime-url`, `--gate-config`, `--port`, `--poll-interval`,
> `--parked-confirm-seconds`. Truyền `--live-mode` cho controller là argparse lỗi. Ans/README cũ
> ghi sai chỗ này — bản đúng là bản trong file này.

Tự động hoá việc đếm cổng + so với GT:

```powershell
cd D:\TechGar2
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\m1_gate_eval.py "$RUN"
# → $RUN\m1_gate\gate_result.json  (pass.overall, số GT vs số controller, ca lệch)
```

Xuất ra rồi chạy lại từ log có sẵn (không replay lại): thêm `--skip-run`.
Đổi cổng khi coders-2 đang chạy song song: `--api-port 8021 --gate-port 8020`.

> **Chuyện bình thường khi replay hết frame:** `runtime_server` đóng cổng 8001 ngay khi replay
> xong, nên lần poll kế tiếp của controller có thể in `ConnectionResetError: [WinError 10054]`
> rồi dừng. Đó là dọn dẹp sau khi đã xong, không phải lỗi đếm — các dòng `[ENTRY]`/`[EXIT]` in
> trước đó vẫn đúng. `m1_gate_eval.py` tự phân loại trường hợp này (`controller_log.kind =
> "teardown"`) và ghi chú vào `gate_result.json`.

## C.1 Cờ `--legacy-…` của TechGAR (P16)

Mặc định luôn là **hành vi mới** (đã sửa). Cờ `--legacy-…` chỉ để đo A/B hoặc lùi nhanh nếu
video thật thoái lui — **không** dùng trong run nghiệm thu.

| Cờ (truyền cho `runtime_server.py`/`two_camera.py`) | Tắt cái gì | Sửa nào | Hậu quả nếu bật |
|---|---|---|---|
| `--legacy-parking-filter` | bộ lọc biên + làm mượt frame kiểu cũ | có từ trước P16 | baseline cũ của P10 |
| `--legacy-departure-token-distance` | giới hạn khoảng cách `slot_diagonal × recovery_max_expand_ratio` của token khởi hành | #3 (`slot_vehicle_binder.py`) | track đã rời ô quá xa vẫn giữ `protected_local_keys` ⇒ **mất GID** (L3) |
| `--legacy-dormant-merge-overlap` | chặn merge khi hai identity **cùng được đo** trong cùng frame ở hai vị trí cách nhau **> bề rộng ô** | #5 (`cross_camera_manager.py`) | gộp nhầm 2 xe ⇒ một GID dùng cho nhiều xe (L2) |
| `--legacy-token-key-reuse` | thu hồi key của token **hết hạn** khỏi `_abandoned_candidate_keys` | #4 (`slot_vehicle_binder.py`, hiện ở worktree `D:/TechGar2_p16d`) | key bị token ô kế nhận lại, thời gian giữ cộng dồn ⇒ track xe đang chạy bị treo |

Đo "trước sửa" khi worktree đã có fix: `real_baseline.py --runtime-arg --legacy-…`
(hoặc `--legacy-departure-token-distance` có sẵn ở `real_baseline.py`).

---

# D. Đo M1 (occupancy + độ trễ) và kiểm chất lượng

```powershell
cd D:\TechGar2

# occupancy theo frame + độ trễ đổi trạng thái (coders-2)
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\m1_eval.py "$RUN"
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\m1_eval.py "$RUN" --skip-run

# đếm cổng (coders-1)
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\m1_gate_eval.py "$RUN"

# track: recall xe-frame đang chạy + GID/đứt track theo xe (coders-2)
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\m1_track_eval.py "$RUN"
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\m1_track_eval.py "$RUN" --json out\track.json

# nghiệm thu P16 bằng MỘT lệnh: 4 run sim + video thật, chấm ĐẠT/KHÔNG ĐẠT (P16f)
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\p16_accept.py
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\p16_accept.py --only k2,k4 --skip-real

# baseline video thật (ENTRY/EXIT/GID/merge) — P16b, dùng lại được cho mọi lần đo
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\real_baseline.py --code-source head --config-set root --tag before
.\sim3d\server\.venv\Scripts\python.exe sim3d\tools\real_baseline.py --code-source worktree --config-set root --tag current --markdown out\p16b_current.md

# E2E UI thật (Playwright; cần BE đang chạy ở 8010)
cd sim3d\web
node ..\tools\e2e.mjs

# Pixel tất định: dựng frame 0/100/499 hai lần, so hash byte
node ..\tools\pixel_hash.mjs
```

## `p16_accept.py` — bộ nghiệm thu P16 (P16f)

Gọi 4 tool có sẵn (`m1_eval`, `m1_track_eval`, `m1_gate_eval`, `real_baseline`) rồi chấm theo
SPEC_P16 §3 + ANS_22; ghi `sim3d/tools/out/p16_accept.json` + `.md` (bảng ĐẠT/KHÔNG ĐẠT).

- Run sim cố định: `20261103-123426_K2-P15a`, `…125324_K4-P15a`, `…130806_K7-P15a`,
  `…132746_NightRain-P15a`.
- `--only k2,k4` chạy nhanh khi đang sửa; `--skip-real` bỏ phần video thật.
- **Song song tối đa 2 run**: cặp cổng `8040/8041` và `8050/8051`; video thật `8060/8061`.
  Không đụng 8001/8000 (đang chạy tay).
- `--min-free-gb` (mặc định **3 GB**): dưới ngưỡng thì dừng, không chạy.
- Một run sim ~13 phút (3600 frame); đầy đủ 4 run + video thật ~40 phút.

## `real_baseline.py` — baseline video thật (P16b)

Replay 3 session thật (`reidfix_r0b_session_*`) + `gate_session_controller` + đọc
`predictions.jsonl`, ra bảng ENTRY/EXIT/GID mới/merge/re-id/handoff/lost.

- `--code-source head` = bản đã commit (baseline "trước", không bị sửa giữa lúc đo);
  `--code-source worktree` = mã đang có trên đĩa. Mặc định pin mã ra `<work-root>/_code/`
  để agent khác sửa `backend/` không làm hỏng số đo (tắt bằng `--no-pin-code`).
- `--config-set root` = bộ `config/` gốc (bộ đã dùng lúc quay, theo `session_info.json`);
  `session` = bộ recovered trong `config/sessions/`. **Baseline P16b dùng `root`.**
- `--tag` đặt hậu tố thư mục để before/after không ghi đè `m1_gate/` của nhau.
- `--markdown <file>` ghi bảng markdown dán thẳng vào REPORT.
- `--min-free-gb` mặc định 2 GB. Mọi lần replay **đều thêm `--no-session-video`** cho runtime
  (quy định tiết kiệm đĩa); đừng bỏ.
- `--skip-run` đọc lại `m1_gate/` có sẵn, không replay.

## Hệ số phóng ảnh `s` và mask ROI toàn mặt bãi (P15a)

Áp dụng từ **P15a**. Hai thay đổi đi cùng nhau vì chúng bù cho nhau — chỉ làm một cái thì
TechGAR vẫn không thấy xe chạy.

### 1. `s` — phóng ảnh cam cho khớp ảnh thật

Bộ dò chuyển động của TechGAR (`backend/main_detect/src/techgar/motion_tracker.py`) được chỉnh
cho ảnh thật **1280×720** và **không có cờ CLI** để đổi ngưỡng. Ở `s = 1` xe sim chỉ ~**42×22 px**
trong khi xe thật trong session `reidfix_r0b_session_thai8` có trung vị **65×76 px**, nên đối tượng
chuyển động quá nhỏ và bị bỏ qua.

`s` mặc định **2** (`TECHGAR_SCALE` trong `web/src/export/techgarConfig.ts`) ⇒ cam **800×1280**,
xe ~**84×44 px** (75 % diện tích xe thật), tổng 1,02 Mpx ≈ 1280×720 (0,92 Mpx).

Nhân `s` cho: canvas/kích thước `raw_cam1/2.mp4`, `parking_slots_cam*.json`,
`roi_mask_cam*.json`, `image_size`, toạ độ pixel trong `calibration.json` (world vẫn cm, `k` không
đổi), `MANIFEST.json` (`image_size` + `image_scale`). **`raw_full.mp4` giữ 640×640** — đó là ảnh
toàn cảnh cho người xem, không vào TechGAR. **GT `_u`/`_v` giữ cỡ gốc 640** (toạ độ danh nghĩa).
Live view không đổi.

Codec H.264 chọn theo kích thước (`codecFor`): `avc1.42E01F` là Baseline **level 3.1**, chỉ tới
921 600 px — 800×1280 vượt nên phải dùng **3.2** (`avc1.42E020`). Nếu để nguyên, trình duyệt từ
chối cấu hình và exporter **lặng lẽ rơi về PNG**, sinh ~3600 ảnh ≈ 515 MB và vượt hạn upload
512 MB (đã xảy ra thật khi làm P15a; test `codecLevel.test.ts` ghim lại).

`verify` đọc cỡ mong đợi từ `image_size` trong `techgar_config/parking_slots_cam*.json`, không
dùng hằng số; lệch thì mục 1 báo rõ cả hai số.

### 2. Mask ROI phủ toàn mặt bãi

`buildRoiMask` cũ lấy **khung bao các ô đỗ**, nên cắt mất làn chạy phía trên/dưới (cam1
`y 147–506`, cam2 `y 143–506` trên 640) gồm cả làn A2 có vạch đếm, và chỉ phủ `x 16–393` nên hụt
đoạn đường xe chạy qua mép ảnh. TechGAR chỉ nhận vật chuyển động khi đủ `roi_support_pixels`
trong mask (`max(20, min(160, 0.08 × diện tích contour))`), nên xe bị cắt một phần là mất.

Mask mới hợp khung bao của: mọi ô trong khung cam, mọi làn `lot.aisles` (**là toạ độ world mét,
phải chiếu `projectPoint`** — không phải pixel), và đoạn cổng vào/ra (`spawn`/`despawn`/`p1`/`p2`),
mỗi đoạn được **cắt tại hai biên** khung rồi kẹp vào ảnh. Kết quả `x 0–800` (đủ bề ngang) và phủ
tới làn A3 (`v = 528` trên khung 640) — trước chỉ tới 505,78.

Test `roiMaskCoverage.test.ts` khẳng định mọi điểm của `buildEntryRoute`/`buildExitRoute` nằm trong
khung cam đều nằm trong mask, và hai vạch đếm nằm trong mask của cả hai cam.

### 3. Số đo recall (`recall_probe.py`, lệnh README, không thêm cờ motion)

| Run | cam1 | cam2 |
|---|---|---|
| Đêm mưa `20261103-105850_export-1` — **s=1, mask cũ** | 24 % | 5 % |
| Đêm mưa — s=2, mask cũ (thử) | 78 % | 58 % |
| Đêm mưa — s=2, mask mới (thử, mask toàn khung) | 83 % | 70 % |
| **K2 `20261103-123426_K2-P15a`** s=2, mask mới | **91 %** | **89 %** |
| **K4 `20261103-125324_K4-P15a`** | **88 %** | **87 %** |
| **K7 `20261103-130806_K7-P15a`** | **98 %** | **93 %** |
| **Đêm mưa `20261103-132746_NightRain-P15a`** | **79 %** ⚠ | **73 %** ⚠ |

K2/K4/K7 đạt mục tiêu ≥ 85 %. **Đêm mưa vẫn dưới mục tiêu** (79 %/73 %) — đã ghi số trong
`REPORT_P15a.md` và báo lead, **không** tự chỉnh tham số TechGAR.

## Đọc `m1_track_eval` (P15b)

`m1_track_eval.py <RUN>` đọc `<RUN>\gt_frames.csv`, `<RUN>\gt_events.csv`,
`<RUN>\techgar_config\roi_mask_cam*.json`, `<RUN>\techgar_config\MANIFEST.json` và
`<RUN>\m1\session\predictions.jsonl` (đổi bằng `--predictions`). `m1_eval.py` cũng gọi
script này và in thêm mục **Track** trong báo cáo của nó.

Hai khối số, đừng lẫn:

1. **Xe-frame đang chạy** (dòng `cam1:` / `cam2:`) — giữ đúng định nghĩa director dùng để
   đo 24 %/5 % (đêm mưa) và 29 %/27 % (K2): xe có mặt trong `gt_frames.csv` và tâm xe dịch
   chuyển > 0,3 px so với frame trước; observation được tính khi
   `observation_kind = "detection"` và `|vx| + |vy| > 0,2`. Tỉ lệ = tổng
   `min(số observation, số xe GT)` / tổng xe GT, **không lọc mask** (để so được với số cũ).
   `có GID` là phần trong số đó đã có `canonical_gid`.
2. **Theo xe** (`xe chạy đo được`, `có GID`, `đứt track`, `GID dùng cho nhiều xe`) — chỉ tính
   đoạn tuyến **nằm trong mask** của cam. Vì vậy với mask cũ (chỉ ô đỗ), `xe chạy đo được`
   thường rất nhỏ (đêm mưa: 10/57); đây là số đúng theo mask hiện tại, không phải lỗi tool.
   - `frame hợp lệ` = số frame-cam xe đang chạy và điểm GT nằm trong mask;
     `khớp` = số frame-cam ghép được với observation (`anchor_pixel` gần nhất trong
     `--match-radius`, mặc định 30 px gốc).
   - `đứt track` = đổi `(camera, local_track_id)`, đổi `canonical_gid`, hoặc mất dấu trong
     khi GT vẫn đang chạy trong mask.
   - `đứt THẬT` (P16) = đổi local track/GID, hoặc mất **≥ 25 frame (1 s)** xe-đang-chạy-trong-mask
     liên tiếp. Ngắn hơn là nhấp nháy phát hiện; xe đỗ không có frame "đang chạy" nên không bị tính
     (occupancy lo phần đó). `đứt track` cũ vẫn in để đối chiếu. Ngưỡng: `HARD_GAP_FRAMES`.
   - `GID dùng cho nhiều xe` = một `canonical_gid` bị ghép cho ≥ 2 xe (lỗi định danh).

**Cỡ ảnh `s`.** Tool đọc `image_size`/`s` từ `MANIFEST.json`, không hard-code 400×640.
GT `_u/_v` luôn ở cỡ gốc 640; export mới ghi `gt_pixel_scale` (= `s`) vào MANIFEST nên tool nhân đúng
(run cũ không khai báo thì tool đoán bằng ngưỡng u ≤ 400 — không chắc với cam2, hãy ép `--gt-scale`). Ép bằng `--gt-scale 2`. Mask cũng được co
theo `image_size` của MANIFEST nếu file mask còn ở cỡ gốc. Dòng đầu báo cáo in
`ảnh W×H · s=… · GT×…` để kiểm ngay.

`e2e.mjs` in `PASS/FAIL/SKIP` và thoát mã 1 nếu có FAIL. Nó dùng cổng Vite 5200 (khác
`shot.mjs` 5199) nên chạy song song được. Bước **"Chế độ quay (C2)"** kiểm canvas đúng pixel
(640×640 / 800×640, không co giãn), không UI phủ lên khung, Esc thoát, và 3 frame trắng đánh
dấu 1-2-3 trước khi chạy frame 0.

---

# D2. Chế độ Quay (quay màn hình)

Bấm **Quay** ở thanh trên (hoặc chọn "Quay" trong nhóm Chế độ xem):

- Toàn màn hình nền đen, khung camera **đúng pixel** ở giữa: `1 cam` = 640×640,
  `2 cam` = 800×640 (hai khung 400×640). **Không co giãn** — kéo cửa sổ không đổi kích thước
  khung, nên video quay ra khớp đúng khung dataset.
- Không có panel/nút/tooltip trong khung. Nút "Thoát (Esc)" và công tắc nằm ở góc màn hình,
  ngoài khung quay.
- Con trỏ tự ẩn sau 1 s không động chuột.
- `Space` = phát/dừng, `Esc` = thoát.

**3 frame trắng đồng bộ (C2).** Bấm Play khi đang ở frame 0 sẽ hiện **3 frame trắng in số 1, 2,
3** (mỗi frame 1/25 s) rồi mới chạy frame 0. Nhờ vậy khi quay màn hình bằng phần mềm ngoài, bạn
căn được GT với video: frame thứ `n` của video quay = frame GT `n − 3`. Tắt bằng công tắc
**"3 frame đồng bộ"** ở góc dưới-phải.

Ba frame này **chỉ ở đường phát hình**: không đi vào video xuất, không đổi `SimState`, không
đổi GT.

---

# E. Lệnh kiểm khi sửa code

```powershell
cd D:\TechGar2\sim3d\web
npm run lint        # ESLint, --max-warnings 0
npm test            # Vitest
npm run build       # tsc --noEmit + vite build

cd ..\server
.\.venv\Scripts\python.exe -m pytest -q

cd D:\TechGar2
.\sim3d\server\.venv\Scripts\python.exe -m pytest sim3d\tools -q
```

`pytest sim3d/tools` cần `PYTHONIOENCODING=utf-8` trên Windows (test đọc stdout của Node).

---

# F. Trạng thái

| Phase | Nội dung | Trạng thái |
|---|---|---|
| P1 | Khung dự án + toàn bộ contract C-A / C-B | ✅ |
| P2 | `tools/build_lot.py` → `data/lot/lot_pucpr.json` + 2 ảnh kiểm | ✅ (P2d: hàng 1 dời −16 px) |
| P3 | 3 model xe GLB (Blender) | ✅ |
| P4 | Render tĩnh + camera khớp `project()` | ✅ |
| P5 | Lõi `sim/` (đường đi, luật, GT) | ✅ phần lớn — **còn lỗi xe kẹt ở K2/K7** |
| P6 | BE đầy đủ (kịch bản, runs, verify) | ✅ |
| P7 | Xuất video + GT + `techgar_config/` | ✅ (P7e: README dùng `--replay-session`) |
| P8 | Môi trường E1–E8 + nhiễu 9 loại | ✅ |
| P9 | UI đầy đủ + 8 kịch bản mẫu | ✅ |
| P10 | M1 động (K2/K6) + QA cuối | ⏳ K2/K6 phải xuất lại sau khi sửa lỗi sim |
| P9d | Chế độ Quay (C2) + 3 frame đồng bộ, pixel tất định | ✅ |

**Chưa làm (đã ghi trong `.orca/sim3d/QA_CHECKLIST.md`):** hash file mp4 giữa 2 lần xuất,
test "không xoay tại chỗ khi v = 0", bộ config riêng cho 1 cam.

## Yêu cầu máy

- Node.js ≥ 20 (đã kiểm với 24.20.0), npm ≥ 10
- Python 3.11 (venv riêng)
- ffmpeg trong PATH — **chỉ** cho đường dự phòng PNG → mp4 (BE §4.3). Không có thì
  `GET /api/health` trả `ffmpeg: false` và `finalize` trả 503 nếu buộc phải ghép PNG.
  WebCodecs (đường chính) không cần ffmpeg.

## Bố cục

```
sim3d/
  web/                        # FE: Vite + React 18 + TS strict + Three + Zustand + Vitest
    src/
      contracts/              # C-A: lot, sim, events, scenario, env, gt  (lead/coder-main sửa)
      api/client.ts           # C-B: file DUY NHẤT biết URL của BE
      sim/                    # lõi mô phỏng thuần — R3: cấm three/react/DOM/random/clock
      render/                 # Three.js: cảnh, môi trường, nhiễu
      export/                 # vòng render offline, encoder, đóng gói
      ui/                     # React + Zustand
    dist/                     # sản phẩm build — BE phục vụ (gitignore)
    public/assets/cars/       # C-C: sedan.glb, suv.glb, hatch.glb
  server/
    sim3d_server/
      api_contract.md         # C-B: hợp đồng API + ví dụ request/response
      server.py               # ThreadingHTTPServer, chỉ bind 127.0.0.1
      static.py               # phục vụ web/dist
      config.py               # bố cục data/ + giới hạn body
    tests/                    # pytest (BE §7)
  tools/                      # script build dữ liệu, blender, ảnh kiểm, e2e, đo M1
    build_lot.py              # P2: sinh lot_pucpr.json
    gen_templates.py          # P9: sinh K1–K8.sim3d.json
    export_template.mjs       # xuất một template qua UI thật (Playwright)
    m1_eval.py                # occupancy + độ trễ (P10a)
    m1_gate_eval.py           # đếm cổng, so GT (P10c)
    pixel_hash.mjs            # pixel tất định giữa 2 lần dựng (P9d)
    check_dist.mjs            # kiểm "một lệnh": BE phục vụ web/dist
    e2e.mjs                   # E2E UI (gồm chế độ Quay C2)
  data/
    lot/lot_pucpr.json        # bản đồ bãi, CÓ trong git
    templates/K1..K8.sim3d.json  # kịch bản mẫu, CÓ trong git
    scenarios/                # kịch bản người dùng — gitignore
    runs/                     # mỗi lần xuất — gitignore
  .gitignore                  # riêng của sim3d (R10)
```

## Luật bắt buộc khi sửa code (MEGAPLAN R1–R10)

- **R2** — không im lặng khi lỗi: ném ra, log, hoặc hiện trên UI. Cấm `catch {}` rỗng.
  Không tự lấp frame thiếu khi xuất video.
- **R3** — `web/src/sim/` không import `three`/`react`/DOM, không `Math.random`,
  `Date.now`, `performance.now`. ESLint chặn (`no-restricted-imports`, `no-restricted-properties`).
- **R4** — TS `strict`, ESLint sạch, Python PEP 8 + type hints.
- **R1** — `web/src/contracts/*` và `server/sim3d_server/api_contract.md` chỉ lead/coder-main
  được sửa, và phải báo lead trước khi đổi.

## Quy ước dữ liệu (đừng đổi lẻ)

- Frame mô phỏng 0-based, `dt = 0,04 s` = 25 fps. `frame_timestamps.csv` dùng `frame_idx` **1-based**
  và `ns = 1e12 + f × 40 000 000` — khớp bộ cũ `docs/pklot_video/ds/gen_dataset.py:474-475`.
- Mã ô `S001`…`S100` (không dùng dạng `F01` của TechGAR); `ground()`/`project()` chuẩn là
  `docs/pklot_video/blender/build_blender_video.py:48-62`.
- Video: full `640×640`. cam1 = cột 0–400, cam2 = cột 240–640, mỗi khung `400×640` **ở s = 1**;
  khi xuất cho TechGAR nhân hệ số `s` (`TECHGAR_SCALE`, mặc định **2** ⇒ `800×1280`, xem C).
  GT `_u`/`_v` vẫn ở cỡ gốc 640 vì là toạ độ danh nghĩa, không phải pixel của ảnh cam đã phóng.
- GT là trạng thái thật của mô phỏng; môi trường và nhiễu **không** được đổi GT.
- World unit trong `techgar_config` là **"cm"** nhưng là cm trên bãi mô hình thu nhỏ (D2),
  `k = 5,116 / bề rộng ô trung vị` ⇒ `k ≈ 2,062`.
