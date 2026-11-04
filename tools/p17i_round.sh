#!/usr/bin/env bash
# P17i: một vòng đo. Dùng: p17i_round.sh <tên_vòng> <hệ_số> [id ...]   (mặc định 8 kịch bản B/C)
# Sinh kịch bản giãn tải vào sim3d/tools/out/p17i/<vòng>_<nhóm>/ rồi đo 4 tiến trình song song.
set -u
ROUND=$1; FACTOR=$2; shift 2
IDS=("$@"); [ ${#IDS[@]} -eq 0 ] && IDS=(B1_quay_vong_vua C3_tai_dem_mua B2_quay_vong_cao C1_tai_may B3_doi_ca C2_tai_mua_chieu B4_on_dinh_dai C4_chuyen_troi)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
for i in "${!IDS[@]}"; do
  g=$((i % 4)); D="$ROOT/tools/out/p17i/${ROUND}_g$g"; mkdir -p "$D"
  python "$ROOT/tools/gen_load_suites.py" --only "${IDS[$i]}" --out "$D" --scale "${IDS[$i]}=$FACTOR" > /dev/null
done
for g in 0 1 2 3; do
  D="$ROOT/tools/out/p17i/${ROUND}_g$g"; [ -d "$D" ] || continue
  (cd "$ROOT/web" && LOAD_DIR="$D" npx vitest run src/sim/loadMeasure.test.ts > "$D/log.txt" 2>&1 &)
done
