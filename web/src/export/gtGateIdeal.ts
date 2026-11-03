/**
 * GT "bộ đếm lý tưởng" (ANS_18) — mô phỏng lại đúng máy trạng thái của
 * `backend/gate_session_controller.py` trên quỹ đạo tâm xe thật.
 *
 * Logic backend (đọc, KHÔNG import, KHÔNG sửa):
 * - `gate_session_controller.py:498-534`:
 *   - `[ENTRY]` chỉ khi GID cắt vạch vào **đúng chiều** VÀ `session is None`;
 *   - `[EXIT]` chỉ khi cắt vạch ra đúng chiều VÀ `session is not None`;
 *   - cắt lặp không đếm thêm (vì sau ENTRY đã có session, sau EXIT đã mất session).
 * - `_crossed_in_valid_direction` → `check_line_intersection` + `get_crossing_direction`
 *   (`:242-256`): dấu tích chéo so với `direction` của cổng.
 *
 * Vì vậy bộ đếm là **máy trạng thái 2 trạng thái** (chưa có phiên / đang có phiên). File này
 * chạy đúng máy đó trên từng xe, trên vạch đếm hiện tại (`export/countLines.ts`).
 *
 * `visible` = camera có thấy điểm cắt không (suy từ `predictions.jsonl` của run: trong bán kính
 * thời gian ±N frame quanh frame cắt, có observation nào của đúng xe đó ở gần vị trí cắt không).
 * Chỉ dòng `visible=1` mới dùng để so TechGAR (ANS_18 mục 2).
 */

import type { LotMap, Vec2 } from '../contracts/lot';
import type { SimState } from '../contracts/sim';
import { buildCountLines, countLineDirection } from './countLines';

/** Một dòng của `gt_gate_ideal.csv`. */
export interface GateIdealRow {
  readonly car_id: string;
  readonly frame: number;
  readonly kind: 'entry' | 'exit';
  /** 1 = camera có thấy điểm cắt; 0 = không (không thể kỳ vọng TechGAR đếm được). */
  readonly visible: 0 | 1;
}

/** Dấu tích chéo của `from→to` so với đoạn vạch `p1→p2` (cùng công thức backend). */
function crossingSign(from: Vec2, to: Vec2, p1: Vec2, p2: Vec2): number {
  const gx = p2[0] - p1[0];
  const gy = p2[1] - p1[1];
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return dx * gy - dy * gx;
}

/**
 * Hai điểm có nằm hai bên đoạn `p1→p2` không (backend `check_line_intersection`).
 *
 * **Tính cả trường hợp điểm rơi đúng trên vạch** (`side === 0`): quỹ đạo mô phỏng lấy
 * mẫu mỗi frame nên rất dễ có một mẫu đúng `x = ±COUNT_LINE_ABS_X_M`. Nếu chỉ dùng
 * `a * b < 0` thì lần cắt đó **bị bỏ sót hoàn toàn** (lỗi đã gặp: vạch ở −20,05 và
 * quỹ đạo bước 0,5 m từ −26,05 nên có mẫu trùng đúng −20,05).
 */
function crossesLine(from: Vec2, to: Vec2, p1: Vec2, p2: Vec2): boolean {
  const side = (point: Vec2): number =>
    (p2[0] - p1[0]) * (point[1] - p1[1]) - (p2[1] - p1[1]) * (point[0] - p1[0]);
  const a = side(from);
  const b = side(to);
  return a * b < 0 || (a !== 0 && b === 0) || (a === 0 && b !== 0);
}

/**
 * Chạy máy trạng thái của backend trên quỹ đạo từng xe.
 *
 * `history` phải **liên tiếp** từ frame 0 (giống `runExport` kiểm). Xe chưa xuất hiện thì bỏ qua
 * frame đó (đúng như backend: không có `global_id` thì không có cắt).
 *
 * `visibleAt` là hàm tuỳ chọn: `(carId, frame, kind) => boolean`. Bỏ trống ⇒ mọi dòng `visible=1`
 * (dùng khi không có dữ liệu camera, ví dụ test tổng hợp).
 */
export function gtGateIdeal(
  lot: LotMap,
  history: readonly SimState[],
  visibleAt?: (carId: string, frame: number, kind: 'entry' | 'exit') => boolean,
): GateIdealRow[] {
  if (history.length === 0) {
    return [];
  }
  const lines = buildCountLines(lot);
  // Tính chiều từ chính dữ liệu (không hard-code): lot thật có p1.y > p2.y, lot test ngược lại.
  const direction = countLineDirection(lot);
  const directions = [direction.entry, direction.exit] as const;

  // Máy trạng thái: tập car_id đang có phiên.
  const hasSession = new Set<string>();
  const previous = new Map<string, Vec2>();
  const rows: GateIdealRow[] = [];

  const passesDirection = (sign: number, direction: 'positive' | 'negative'): boolean =>
    direction === 'positive' ? sign > 0 : sign < 0;

  for (const state of history) {
    const frame = state.frame;
    for (const car of state.cars) {
      const point: Vec2 = [car.pose.x, car.pose.y];
      const before = previous.get(car.id);
      previous.set(car.id, point);
      if (before === undefined) {
        continue;
      }
      // ENTRY: cắt vạch vào đúng chiều và CHƯA có phiên.
      if (
        !hasSession.has(car.id) &&
        crossesLine(before, point, lines.entry.p1, lines.entry.p2)
      ) {
        const sign = crossingSign(before, point, lines.entry.p1, lines.entry.p2);
        if (passesDirection(sign, directions[0])) {
          hasSession.add(car.id);
          rows.push({
            car_id: car.id,
            frame,
            kind: 'entry',
            visible: visibleAt === undefined || visibleAt(car.id, frame, 'entry') ? 1 : 0,
          });
          continue;
        }
      }
      // EXIT: cắt vạch ra đúng chiều và ĐANG có phiên.
      if (
        hasSession.has(car.id) &&
        crossesLine(before, point, lines.exit.p1, lines.exit.p2)
      ) {
        const sign = crossingSign(before, point, lines.exit.p1, lines.exit.p2);
        if (passesDirection(sign, directions[1])) {
          hasSession.delete(car.id);
          rows.push({
            car_id: car.id,
            frame,
            kind: 'exit',
            visible: visibleAt === undefined || visibleAt(car.id, frame, 'exit') ? 1 : 0,
          });
        }
      }
    }
  }
  return rows;
}

/** Header + CSV cho `gt_gate_ideal.csv` (ANS_18 mục 1). */
export const GATE_IDEAL_COLUMNS = ['car_id', 'frame', 'kind', 'visible'] as const;

export function gtGateIdealCsv(rows: readonly GateIdealRow[]): string {
  const lines = [GATE_IDEAL_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(`${row.car_id},${String(row.frame)},${row.kind},${String(row.visible)}`);
  }
  return `${lines.join('\n')}\n`;
}
