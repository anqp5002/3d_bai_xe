/**
 * Tóm tắt cảnh báo của một lần chạy, tính **theo luồng** (P17n).
 *
 * Trước đây xuất và UI đều giữ toàn bộ `SimState` rồi duyệt lại (O(n²) khi live, 90.000 state khi
 * xuất 60 phút ⇒ tràn RAM). Lớp này nhận từng state đúng một lần và chỉ giữ cảnh báo
 * (`ghost_pass`, `park_clip`, `park_clip_escalated`), nên bộ nhớ ∝ số cảnh báo chứ không ∝ số frame.
 */

import type { SimState, Warning } from '../contracts/sim';

/** Một lần lách đã gộp theo xe (P17e). */
export interface ExportGhostPass {
  readonly car_id: string;
  readonly start_frame: number;
  readonly end_frame: number;
  /** Id các xe bị lách qua (đã gộp, sắp xếp). */
  readonly through: readonly string[];
  /** Độ chồng lấn lớn nhất trong lần lách này, m. */
  readonly depth_max_m: number;
}

interface OpenGhost {
  start: number;
  end: number;
  through: Set<string>;
  depth: number;
}

function closed(carId: string, open: OpenGhost): ExportGhostPass {
  return {
    car_id: carId,
    start_frame: open.start,
    end_frame: open.end,
    through: [...open.through].sort(),
    depth_max_m: Number(open.depth.toFixed(3)),
  };
}

/**
 * Gộp `ghost_pass` theo xe + khoảng frame liên tiếp. `ghost_pass` được phát mỗi frame khi còn
 * chồng lấn, nên "một lần lách" = một chuỗi frame liên tiếp có cảnh báo của cùng một xe.
 * Thứ tự kết quả: lần đóng trước xếp trước, các lần còn mở xếp cuối theo thứ tự mở (như bản cũ).
 */
export class GhostPassAccumulator {
  private readonly done: ExportGhostPass[] = [];
  private readonly open = new Map<string, OpenGhost>();

  push(state: SimState): void {
    const seenThisFrame = new Set<string>();
    for (const warning of state.warnings) {
      if (warning.kind !== 'ghost_pass' || typeof warning.car_id !== 'string') {
        continue;
      }
      const carId = warning.car_id;
      seenThisFrame.add(carId);
      const match = /chồng ([\d.]+) m/.exec(warning.message);
      const depth = match === null ? 0 : Number(match[1]);
      const through = /lách qua ([^ ]+)/.exec(warning.message)?.[1] ?? '';
      const open = this.open.get(carId);
      if (open === undefined) {
        this.open.set(carId, {
          start: state.frame,
          end: state.frame,
          through: new Set(through === '' ? [] : through.split(',')),
          depth: Number.isFinite(depth) ? depth : 0,
        });
        continue;
      }
      open.end = state.frame;
      for (const id of through === '' ? [] : through.split(',')) {
        open.through.add(id);
      }
      if (Number.isFinite(depth)) {
        open.depth = Math.max(open.depth, depth);
      }
    }
    if (this.open.size === 0) {
      return;
    }
    // Xe không còn cảnh báo ở frame này ⇒ đóng lần lách của nó.
    for (const [carId, open] of [...this.open.entries()]) {
      if (seenThisFrame.has(carId)) {
        continue;
      }
      this.done.push(closed(carId, open));
      this.open.delete(carId);
    }
  }

  /** Mọi lần lách (đã đóng, rồi đang mở) — không đổi trạng thái, dùng được khi đang chạy live. */
  snapshot(): ExportGhostPass[] {
    return [...this.done, ...[...this.open.entries()].map(([id, open]) => closed(id, open))];
  }

  /** Số lần lách (đã đóng + đang mở). */
  get count(): number {
    return this.done.length + this.open.size;
  }
}

/** Cảnh báo `park_clip` / `park_clip_escalated` của cả lần chạy (chỉ cảnh báo, không giữ state). */
export class ParkClipLog {
  readonly parkClip: Warning[] = [];
  readonly escalated: Warning[] = [];

  push(state: SimState): void {
    for (const warning of state.warnings) {
      if (warning.kind === 'park_clip') {
        this.parkClip.push(warning);
      } else if (warning.kind === 'park_clip_escalated') {
        this.escalated.push(warning);
      }
    }
  }
}
