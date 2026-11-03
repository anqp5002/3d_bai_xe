/**
 * Frame đánh dấu đồng bộ cho **chế độ Quay** (C2, ý tưởng dòng 67; FE §7.6 dòng 110).
 *
 * Khi bấm Play ở chế độ Quay, 3 frame đầu là **frame trắng in số thứ tự**, rồi mới chạy
 * từ frame 0 của mô phỏng — để người quay màn hình căn được GT với video quay tay.
 *
 * **Chỉ ở đường phát hình.** Theo C2 và TASK P9d:
 *
 * - KHÔNG đi vào video xuất (`export/` không đọc module này).
 * - KHÔNG đổi `sim/`: `consumedLeaderFrames` chỉ chặn `stepFrames`, không chạm `SimState`.
 * - KHÔNG đổi GT: GT sinh từ `sim.runToEnd()`, không đi qua đây.
 *
 * Logic tách khỏi React/DOM nên test bằng Node được.
 */

import type { CameraViewMode } from '../render/cameraGeometry';
/**
 * Số frame đánh dấu.
 *
 * **Phải bằng** `SYNC_LEADER_FRAMES` của `export/index.ts:13`. Khai báo lại thay vì import
 * để UI không kéo `export/runExport` vào bundle lúc chạy; test
 * `recordLeader.test.ts` canh hai hằng bằng nhau nên lệch là đỏ ngay.
 */
export const RECORD_LEADER_FRAMES = 3;

export interface LeaderDecision {
  /** Có bắt đầu chuỗi frame đánh dấu ở lần bấm Play này không. */
  readonly begin: boolean;
  /** Lý do khi không bắt đầu — để UI nói rõ, không im lặng (R2). */
  readonly reason: string | null;
}

/**
 * Có nên bắt đầu 3 frame đánh dấu ở lần bấm Play này không.
 *
 * Chỉ bắt đầu khi **đủ cả 4 điều**:
 * 1. Người dùng bật công tắc (`enabled`).
 * 2. Đang ở chế độ Quay.
 * 3. Chưa có chuỗi nào đang chạy (`alreadyActive === false`).
 * 4. Đang ở **frame 0** — vì C2 nói "rồi mới chạy từ frame 0". Bấm Play giữa lúc đang
 *    quay (frame > 0) thì không chèn frame trắng, nếu không video sẽ có frame trắng chen
 *    giữa lúc xe đang chạy và GT lệch.
 */
export function decideLeader(options: {
  readonly enabled: boolean;
  readonly viewMode: CameraViewMode;
  readonly frame: number;
  readonly alreadyActive: boolean;
}): LeaderDecision {
  if (!options.enabled) {
    return { begin: false, reason: 'công tắc 3 frame đồng bộ đang tắt' };
  }
  if (options.viewMode !== 'record') {
    return { begin: false, reason: 'không ở chế độ Quay' };
  }
  if (options.alreadyActive) {
    return { begin: false, reason: 'chuỗi frame đánh dấu đang chạy' };
  }
  if (options.frame !== 0) {
    return {
      begin: false,
      reason: `đang ở frame ${String(options.frame)} — chỉ chèn frame trắng khi bắt đầu từ frame 0`,
    };
  }
  return { begin: true, reason: null };
}

/** Giảm số frame đánh dấu còn lại; không xuống dưới 0. */
export function decrementLeader(remaining: number): number {
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return 0;
  }
  return Math.floor(remaining) - 1;
}

/** Có đang hiện frame trắng không. */
export function isLeaderShowing(remaining: number): boolean {
  return Number.isFinite(remaining) && remaining > 0;
}

/**
 * Số in trên frame trắng: **1, 2, 3** theo thứ tự (không phải số frame của GT).
 *
 * `remaining = 3` → `"1"`, `2` → `"2"`, `1` → `"3"`. Frame GT 0 bắt đầu ngay sau đó.
 */
export function leaderLabel(remaining: number): string {
  if (!isLeaderShowing(remaining)) {
    throw new Error(`leaderLabel: không còn frame đánh dấu (remaining = ${String(remaining)})`);
  }
  const index = RECORD_LEADER_FRAMES - Math.floor(remaining) + 1;
  return String(Math.min(Math.max(index, 1), RECORD_LEADER_FRAMES));
}

/**
 * Số frame GT tương ứng với frame thứ `n` của video quay tay (0-based), khi đã chèn
 * đánh dấu. Dùng để người quay biết cần trừ bao nhiêu frame.
 *
 * `n < RECORD_LEADER_FRAMES` ⇒ `null` (còn trong phần đánh dấu, chưa có GT).
 */
export function gtFrameForRecordedFrame(recorded: number, leaderEnabled: boolean): number | null {
  const offset = leaderEnabled ? RECORD_LEADER_FRAMES : 0;
  if (!Number.isFinite(recorded) || recorded < offset) {
    return null;
  }
  return Math.floor(recorded) - offset;
}
