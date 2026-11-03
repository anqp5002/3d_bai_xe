/**
 * Luật bám xe trong cùng làn (U7, FE §4.4.1) + bản sửa M1/D7.
 *
 * D7 thắng chữ U7 ở chỗ: ngưỡng ½ chiều dài chỉ là **điều kiện kích hoạt** luật
 * "không nhanh hơn xe trước"; muốn không bao giờ chồng xe thì phải thêm **phanh nhìn xa**
 *
 *     v ≤ sqrt(2 · a · max(0, gap − gap_min))
 *
 * với `a = 1,5 m/s²`, `gap_min = 0,8 m`. Hai giới hạn áp cùng lúc, lấy giá trị nhỏ hơn.
 * Hàm thuần, chỉ tính vận tốc mục tiêu — việc tích phân nằm ở P5b (đường đi).
 */

/** Ngưỡng kích hoạt luật ½ chiều dài (U7). */
export const FOLLOW_LENGTH_FACTOR = 0.5;
/** Khoảng hở an toàn tối thiểu giữa hai cản, m (FE §4.4.1, D7). */
export const MIN_GAP_M = 0.8;
/** Giảm tốc dùng cho phanh nhìn xa, m/s² (D7). */
export const MAX_DECEL_MPS2 = 1.5;

/** Vì sao vận tốc mục tiêu bị giới hạn. */
export type FollowLimit = 'none' | 'length' | 'brake' | 'stop';

export interface FollowInput {
  /** Tốc độ mong muốn của xe sau, m/s. */
  readonly desiredSpeed: number;
  /** Tốc độ hiện tại của xe trước, m/s (xe trước dừng → 0). */
  readonly leaderSpeed: number;
  /**
   * Khoảng hở cản sau xe trước → cản trước xe sau, m, đo dọc đường đi.
   * `Infinity` (hoặc không hữu hạn) = không có xe trước.
   */
  readonly gap: number;
  /** Chiều dài xe sau, m (đã nhân hệ số tỉ lệ). */
  readonly carLength: number;
}

export interface FollowDecision {
  /** Vận tốc mục tiêu sau khi áp cả hai luật, m/s (≥ 0). */
  readonly targetSpeed: number;
  /** Giới hạn phanh nhìn xa, m/s. */
  readonly safeSpeed: number;
  /** Luật nào quyết định `targetSpeed`. */
  readonly limit: FollowLimit;
}

/** Vận tốc tối đa còn phanh kịp trước khoảng hở `gap` (D7). */
export function safeSpeedForGap(
  gap: number,
  decel: number = MAX_DECEL_MPS2,
  minGap: number = MIN_GAP_M,
): number {
  if (!Number.isFinite(gap)) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(decel) || decel <= 0) {
    throw new Error(`safeSpeedForGap: decel phải > 0, nhận ${String(decel)}`);
  }
  if (!Number.isFinite(minGap) || minGap < 0) {
    throw new Error(`safeSpeedForGap: minGap phải ≥ 0, nhận ${String(minGap)}`);
  }
  return Math.sqrt(2 * decel * Math.max(0, gap - minGap));
}

/**
 * Quyết định vận tốc mục tiêu của xe sau (U7 + D7).
 *
 * Thứ tự:
 * 1. `gap ≤ gap_min` → dừng (không bao giờ chồng).
 * 2. `gap < ½ chiều dài xe sau` → không nhanh hơn xe trước.
 * 3. Luôn thêm giới hạn phanh nhìn xa — lấy giá trị nhỏ hơn.
 */
export function followSpeed(input: FollowInput): FollowDecision {
  const desired = Number.isFinite(input.desiredSpeed)
    ? Math.max(0, input.desiredSpeed)
    : 0;
  if (!Number.isFinite(input.carLength) || input.carLength <= 0) {
    throw new Error(
      `followSpeed: carLength phải > 0, nhận ${String(input.carLength)}`,
    );
  }
  if (Number.isNaN(input.gap)) {
    throw new Error('followSpeed: gap không được NaN');
  }
  if (Number.isFinite(input.gap) && input.gap <= MIN_GAP_M) {
    return { targetSpeed: 0, safeSpeed: 0, limit: 'stop' };
  }

  const safeSpeed = safeSpeedForGap(input.gap);
  const lengthLimited = input.gap < FOLLOW_LENGTH_FACTOR * input.carLength;
  const baseSpeed = lengthLimited
    ? Math.min(desired, Math.max(0, input.leaderSpeed))
    : desired;

  if (safeSpeed < baseSpeed) {
    return { targetSpeed: safeSpeed, safeSpeed, limit: 'brake' };
  }
  return {
    targetSpeed: baseSpeed,
    safeSpeed,
    limit: lengthLimited ? 'length' : 'none',
  };
}
