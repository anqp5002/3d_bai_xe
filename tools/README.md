# `sim3d/tools/` — script phụ trợ

Thư mục này **không** nằm trong package nào; chạy trực tiếp bằng Python của `sim3d/server/.venv`
hoặc Node của máy.

| File | Phase | Việc | Done khi |
|---|---|---|---|
| `build_lot.py` | P2 | `sample_spaces.csv` + công thức camera → `data/lot/lot_pucpr.json`, xuất `out/plan.png` + `out/overlay.png` | tâm ô ≤ 3 px so với csv; có 2 ảnh |
| `blender/make_cars.py` | P3 | Blender script sinh 3 GLB `public/assets/cars/{sedan,suv,hatch}.glb` theo C-C | chạy `blender -b -P`, có ảnh `out/cars_preview.png` |
| `check_glb.py` | P3 | In bbox từng GLB + kiểm tên material/mesh | sai ≤ 2 cm so với C4 |
| `shot.mjs` | P4 | Playwright chụp `out/static_dataset.png` (640×640), `out/static_free.png` | ảnh đúng kích thước |
| `e2e.mjs` | P9 | Playwright: tạo map 30 xe, thêm 3 xe, cho 1 xe rời, lưu/mở kịch bản, xuất | chạy được, in kết quả |
| `m1_track_eval.py` | P15b | Recall xe-frame đang chạy (như `recall_probe`) + GID/đứt track/GID tái sử dụng theo xe, chỉ đoạn trong mask cam; đọc `image_size`/`s` từ MANIFEST | in 2 khối số + `m1_eval.py` có mục Track; pytest xanh |
| `m1_eval.py` | P10a | Occupancy theo frame + độ trễ đổi trạng thái; gọi `m1_track_eval` cho mục track | `metrics.json` có `track` |
| `real_baseline.py` | P16b | Baseline **video thật**: replay `--replay-session` + `gate_session_controller`, ghi JSON số GID mới / merge / re-id / handoff / occupancy / `[ENTRY]`-`[EXIT]`; chạy lại cùng lệnh để so before/after | `baseline_before.json` có ≥3 session + pytest xanh |

- Mọi output ghi vào `sim3d/tools/out/` (đã gitignore).
- Script Python dùng `.venv` của server để có `cv2`/`numpy`:
  `.\.venv\Scripts\python.exe ..\tools\build_lot.py` (chạy từ `sim3d/server`), hoặc
  `sim3d\server\.venv\Scripts\python.exe sim3d\tools\build_lot.py` (chạy từ gốc repo).
- Không cài gói global (MEGAPLAN “không làm”).
