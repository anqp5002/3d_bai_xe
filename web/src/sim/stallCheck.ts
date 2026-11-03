/**
 * P5e — bộ kiểm **không cho xanh giả**.
 *
 * Lý do tồn tại: `SimState.warnings` chỉ chứa cảnh báo của **frame hiện tại**, và `still_frames`
 * bị **reset mỗi lần xe đổi state**. Vì vậy kiểm mỗi frame cuối (hoặc chỉ `warnings`) có thể báo
 * xanh trong khi xe đứng yên hàng nghìn frame (đo được ở K7 trước P5e: 4 xe `still` 1400–2384
 * frame mà test vẫn xanh).
 *
 * Bộ này tự tính từ **history**: đếm số frame **liên tiếp** có `|v| ≈ 0` của từng xe, bỏ qua các
 * trạng thái đứng yên hợp lệ (`parked`, `queued`, `exited`). Ngưỡng 250 frame (= 10 s @ 25 fps).
 */

import type { SimState } from '../contracts/sim';

/** Ngưỡng "kẹt" theo G1: đứng yên liên tục quá 10 s (25 fps × 10). */
export const STALL_FRAMES_LIMIT = 250;

/** Trạng thái đứng yên **hợp lệ** (không tính là kẹt). */
const STATIONARY_STATES = new Set(['parked', 'queued', 'exited']);

export interface StallFinding {
  readonly car_id: string;
  /** Số frame liên tiếp đứng yên dài nhất. */
  readonly frames: number;
  /** Frame bắt đầu đợt đứng yên dài nhất. */
  readonly start_frame: number;
  /** Trạng thái xe lúc đó. */
  readonly state: string;
  readonly slot: string | null;
}

/** Chờ đặt chỗ hợp lệ tối đa 25 s (ANS_12) — chỉ khi xe đang giữ vùng chặn có tiến triển. */
export const RESERVATION_WAIT_FRAMES_LIMIT = 625;

/** Holder "có tiến triển" = `route_s` hoặc tư thế đổi trong khoảng này (2 s @ 25 fps) (ANS_12). */
export const HOLDER_PROGRESS_WINDOW_FRAMES = 50;

type Car = SimState['cars'][number];

/** Xe đang chờ **cấp** đặt chỗ (đứng ở điểm bắt đầu thao tác mà chưa được cấp vùng). */
function waitsForGrant(car: Car, state: SimState): boolean {
  if (state.reservations.some((reservation) => reservation.car_id === car.id)) {
    return false;
  }
  if (car.state === 'leaving_slot') {
    return (car.route_s ?? 0) < 1e-6;
  }
  if (car.state === 'driving_to_slot' && car.route?.slot_start_s !== undefined) {
    return (car.route_s ?? 0) >= car.route.slot_start_s - 2;
  }
  return false;
}

/** Có xe nào đang GIỮ vùng đặt chỗ mà `route_s`/tư thế đổi trong 2 s gần nhất. */
function holderProgressing(history: readonly SimState[], index: number): boolean {
  const state = history[index];
  const before = history[Math.max(0, index - HOLDER_PROGRESS_WINDOW_FRAMES)];
  for (const reservation of state.reservations) {
    const now = state.cars.find((car) => car.id === reservation.car_id);
    const then = before.cars.find((car) => car.id === reservation.car_id);
    if (now === undefined || then === undefined) {
      return true;
    }
    if (
      Math.abs((now.route_s ?? 0) - (then.route_s ?? 0)) > 1e-6 ||
      Math.abs(now.pose.x - then.pose.x) > 1e-6 ||
      Math.abs(now.pose.y - then.pose.y) > 1e-6 ||
      Math.abs(now.pose.th - then.pose.th) > 1e-6
    ) {
      return true;
    }
  }
  return false;
}

/** Một đợt chờ đặt chỗ hợp lệ (để REPORT in thời gian chờ lớn nhất, ANS_12 mục 4). */
export interface ReservationWait {
  readonly car_id: string;
  readonly frames: number;
  readonly start_frame: number;
  readonly holders: readonly string[];
}

/**
 * Xe đứng yên **liên tục** quá giới hạn (tự tính từ history).
 *
 * ANS_12: mặc định 10 s (:data:`STALL_FRAMES_LIMIT`). Riêng xe đang CHỜ CẤP đặt chỗ mà xe giữ
 * vùng đang tiến triển (2 s gần nhất) thì được tới 25 s (:data:`RESERVATION_WAIT_FRAMES_LIMIT`);
 * frame nào holder đứng yên thì tính vào đồng hồ 10 s thường.
 */
export function findStalls(history: readonly SimState[]): StallFinding[] {
  const running = new Map<string, number>();
  const plain = new Map<string, number>();
  const startFrame = new Map<string, number>();
  const worst = new Map<string, StallFinding>();
  const progressCache = new Map<number, boolean>();
  for (let index = 0; index < history.length; index += 1) {
    const state = history[index];
    for (const car of state.cars) {
      const stationary =
        Math.abs(car.v) < 1e-6 && !STATIONARY_STATES.has(car.state);
      if (!stationary) {
        running.delete(car.id);
        plain.delete(car.id);
        continue;
      }
      if (!running.has(car.id)) {
        running.set(car.id, 0);
        plain.set(car.id, 0);
        startFrame.set(car.id, state.frame);
      }
      const frames = (running.get(car.id) ?? 0) + 1;
      running.set(car.id, frames);
      let legitWait = false;
      if (waitsForGrant(car, state)) {
        let progressing = progressCache.get(index);
        if (progressing === undefined) {
          progressing = holderProgressing(history, index);
          progressCache.set(index, progressing);
        }
        legitWait = progressing;
      }
      const plainFrames = (plain.get(car.id) ?? 0) + (legitWait ? 0 : 1);
      plain.set(car.id, plainFrames);
      const effective = Math.max(plainFrames, frames - (RESERVATION_WAIT_FRAMES_LIMIT - STALL_FRAMES_LIMIT));
      const best = worst.get(car.id);
      if (best === undefined || effective > best.frames) {
        worst.set(car.id, {
          car_id: car.id,
          frames: effective,
          start_frame: startFrame.get(car.id) ?? state.frame,
          state: car.state,
          slot: car.slot,
        });
      }
    }
  }
  return [...worst.values()]
    .filter((finding) => finding.frames > STALL_FRAMES_LIMIT)
    .sort((a, b) => b.frames - a.frames);
}

/** Thời gian chờ đặt chỗ lớn nhất của từng xe và xe nào đang giữ vùng (cho REPORT). */
export function reservationWaits(history: readonly SimState[]): ReservationWait[] {
  const run = new Map<string, { frames: number; start: number; holders: Set<string> }>();
  const worst = new Map<string, ReservationWait>();
  for (const state of history) {
    for (const car of state.cars) {
      if (!(Math.abs(car.v) < 1e-6) || !waitsForGrant(car, state)) {
        run.delete(car.id);
        continue;
      }
      const current = run.get(car.id) ?? { frames: 0, start: state.frame, holders: new Set<string>() };
      current.frames += 1;
      for (const reservation of state.reservations) {
        current.holders.add(reservation.car_id);
      }
      run.set(car.id, current);
      const best = worst.get(car.id);
      if (best === undefined || current.frames > best.frames) {
        worst.set(car.id, {
          car_id: car.id,
          frames: current.frames,
          start_frame: current.start,
          holders: [...current.holders],
        });
      }
    }
  }
  return [...worst.values()].sort((a, b) => b.frames - a.frames);
}

/**
 * Xe **còn trong bãi** ở frame cuối và đã đứng yên > ngưỡng **ngay tại cuối**.
 *
 * Đây là điều kiện thứ hai của lead: "cuối kịch bản còn xe chưa `exited` mà lịch trình đã hết".
 * Đếm bằng số frame đứng yên thật (tính ngược từ cuối history), không dựa `still_frames`.
 */
export function findStillAtEnd(history: readonly SimState[]): StallFinding[] {
  if (history.length === 0) {
    return [];
  }
  const last = history[history.length - 1];
  const findings: StallFinding[] = [];
  for (const car of last.cars) {
    if (car.state === 'exited') {
      continue;
    }
    // Đếm ngược: bao nhiêu frame cuối cùng xe đứng yên và không ở trạng thái hợp lệ.
    let frames = 0;
    let begin = history.length - 1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const snapshot = history[index].cars.find((candidate) => candidate.id === car.id);
      if (snapshot === undefined) {
        break;
      }
      const stationary =
        Math.abs(snapshot.v) < 1e-6 && !STATIONARY_STATES.has(snapshot.state);
      if (!stationary) {
        break;
      }
      frames += 1;
      begin = index;
    }
    if (frames > STALL_FRAMES_LIMIT) {
      findings.push({
        car_id: car.id,
        frames,
        start_frame: history[begin]?.frame ?? 0,
        state: car.state,
        slot: car.slot,
      });
    }
  }
  return findings.sort((a, b) => b.frames - a.frames);
}

/**
 * Xe `queued` bị **bỏ quên** (P10a).
 *
 * `STATIONARY_STATES` coi `queued` là đứng yên hợp lệ, nên `findStalls`/`findStillAtEnd` **không
 * bao giờ** bắt được xe chờ cổng quá lâu. Đó chính là lỗi của P10a: K2 có V002/V003 `queued`
 * suốt 3000 frame (không bao giờ vào bãi) mà bộ kiểm vẫn xanh, vì vậy "M1 đạt" trên K2 là rỗng.
 *
 * Hàng chờ **hợp lệ** khi có xe đang thực sự chiếm cổng/đường vào; nếu không ai ở đó mà xe vẫn
 * `queued` thì đó là kẹt. Ngưỡng đếm riêng, không dùng `STALL_FRAMES_LIMIT`.
 */
export const QUEUE_WAIT_FRAMES_LIMIT = 500;

/** Xe `queued` ở frame cuối mà không ai đang chiếm đường vào = bị bỏ quên. */
export interface QueueFinding {
  readonly car_id: string;
  readonly frames: number;
  readonly start_frame: number;
  readonly slot: string | null;
}

/** Trạng thái chứng tỏ **có** xe đang đi qua cổng vào (nên hàng chờ là hợp lệ). */
const GATE_APPROACH_STATES = new Set(['entering', 'driving_to_slot', 'parking_in']);

/**
 * Xe `queued` liên tục > :data:`QUEUE_WAIT_FRAMES_LIMIT` frame **trong khi cổng vào trống**.
 *
 * "Cổng vào trống" = không xe nào đang `entering`/`driving_to_slot`/`parking_in`. Khi đó hàng
 * chờ không còn lý do gì để đứng, nên có xe `queued` là lỗi.
 */
export function findAbandonedQueue(history: readonly SimState[]): QueueFinding[] {
  const running = new Map<string, number>();
  const startFrame = new Map<string, number>();
  const worst = new Map<string, QueueFinding>();
  for (const state of history) {
    const gateBusy = state.cars.some((car) => GATE_APPROACH_STATES.has(car.state));
    for (const car of state.cars) {
      if (car.state !== 'queued') {
        running.delete(car.id);
        continue;
      }
      if (!running.has(car.id)) {
        running.set(car.id, 0);
        startFrame.set(car.id, state.frame);
      }
      const frames = (running.get(car.id) ?? 0) + 1;
      // Có xe đang qua cổng ⇒ hàng chờ hợp lệ, không tích luỹ thêm.
      if (gateBusy) {
        running.set(car.id, 0);
        startFrame.set(car.id, state.frame);
        continue;
      }
      running.set(car.id, frames);
      const best = worst.get(car.id);
      if (best === undefined || frames > best.frames) {
        worst.set(car.id, {
          car_id: car.id,
          frames,
          start_frame: startFrame.get(car.id) ?? state.frame,
          slot: car.slot,
        });
      }
    }
  }
  return [...worst.values()]
    .filter((finding) => finding.frames > QUEUE_WAIT_FRAMES_LIMIT)
    .sort((a, b) => b.frames - a.frames);
}

/** Xe còn `queued` ở frame cuối (không bao giờ vào bãi). */
export function queueAtEnd(history: readonly SimState[]): readonly string[] {
  if (history.length === 0) {
    return [];
  }
  return history[history.length - 1].cars
    .filter((car) => car.state === 'queued')
    .map((car) => car.id)
    .sort();
}

/** Mô tả ngắn để đưa vào thông báo test. */
export function describeQueue(findings: readonly QueueFinding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.car_id}(queued@${finding.slot ?? '?'}) ${finding.frames} frame từ ${finding.start_frame}`,
    )
    .join('; ');
}

/** Mô tả ngắn để đưa vào thông báo test. */
export function describeStalls(findings: readonly StallFinding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.car_id}(${finding.state}@${finding.slot ?? '?'}) ${finding.frames} frame từ ${finding.start_frame}`,
    )
    .join('; ');
}
