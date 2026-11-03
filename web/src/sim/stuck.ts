/**
 * Cảnh báo xe kẹt (FE §4.4.5, D8): đứng yên > 10 s mà không `parked`/`queued`.
 *
 * `SimState` của contract C-A không mang bộ đếm thời gian, nên bộ đếm nằm trong một
 * `StuckTracker` thuần dữ liệu do vòng `step` giữ lại giữa hai frame. Cảnh báo phát
 * **một lần** cho mỗi đợt đứng yên để không làm ngập thanh trạng thái.
 */

import { DT_S } from './constants';
import type { CarState, Warning } from '../contracts/sim';

/** Ngưỡng kẹt, giây (FE §4.4.5). */
export const STUCK_SECONDS = 10;
/** Ngưỡng kẹt quy ra frame ở 25 fps (250 frame = 10 s). */
export const STUCK_FRAMES = Math.round(STUCK_SECONDS / DT_S);
/** Tốc độ coi là đứng yên, m/s. */
export const STILL_SPEED_MPS = 0.05;

/** Trạng thái không tính là kẹt. */
const IGNORED_STATES: ReadonlySet<string> = new Set(['parked', 'queued', 'exited']);

export interface StuckEntry {
  /** Frame bắt đầu đứng yên. */
  readonly sinceFrame: number;
  /** Đã phát cảnh báo cho đợt này chưa. */
  readonly warned: boolean;
}

export interface StuckTracker {
  readonly entries: Readonly<Record<string, StuckEntry>>;
}

/** Bộ đếm rỗng (frame 0). */
export const EMPTY_STUCK_TRACKER: StuckTracker = { entries: {} };

/** Số giây đã đứng yên tính tới `frame`. */
export function stillSeconds(entry: StuckEntry, frame: number): number {
  return ((frame - entry.sinceFrame) * DT_S);
}

/**
 * Cập nhật bộ đếm và trả cảnh báo mới của frame này.
 * Xe chuyển động, đỗ, chờ cổng, đã ra khỏi mô phỏng → xoá bộ đếm.
 */
export function updateStuck(
  tracker: StuckTracker,
  cars: readonly CarState[],
  frame: number,
): { readonly tracker: StuckTracker; readonly warnings: readonly Warning[] } {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`updateStuck: frame phải là số nguyên ≥ 0, nhận ${String(frame)}`);
  }
  const entries: Record<string, StuckEntry> = {};
  const warnings: Warning[] = [];
  for (const car of cars) {
    if (IGNORED_STATES.has(car.state)) {
      continue;
    }
    if (!Number.isFinite(car.v) || Math.abs(car.v) > STILL_SPEED_MPS) {
      continue;
    }
    const previous = tracker.entries[car.id];
    const entry: StuckEntry = previous ?? { sinceFrame: frame, warned: false };
    const stillFrames = frame - entry.sinceFrame;
    if (!entry.warned && stillFrames > STUCK_FRAMES) {
      const seconds = (stillFrames * DT_S).toFixed(1);
      warnings.push({
        frame,
        kind: 'stuck',
        message: `${car.id} đứng yên ${seconds} s (> ${STUCK_SECONDS} s) — kiểm tra kẹt (FE §4.4.5)`,
        car_id: car.id,
        ...(car.slot === null ? {} : { slot: car.slot }),
      });
      entries[car.id] = { sinceFrame: entry.sinceFrame, warned: true };
      continue;
    }
    entries[car.id] = entry;
  }
  return { tracker: { entries }, warnings };
}
