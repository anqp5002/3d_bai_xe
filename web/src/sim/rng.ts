/**
 * RNG mulberry32 có seed, tách luồng theo mục đích (C3, FE §4.1; contract C-A).
 *
 * Mọi hàm là **thuần dữ liệu**: nhận `RngStreams`, trả bộ trạng thái mới — không biến
 * toàn cục, không đọc đồng hồ hệ thống. Nhờ vậy `step` vẫn thuần và chạy lại cho kết
 * quả y hệt (G4, D11), còn trạng thái thì lưu thẳng trong `SimState.rngState`.
 *
 * R3: không `Math.random`, không `Date.now`, không `performance.now`.
 */

import type { RngStreamName, RngStreams } from '../contracts/sim';

/** Sáu luồng, đúng khoá `RngStreams` của contract C-A. */
export const RNG_STREAMS = [
  'placement',
  'color',
  'model',
  'slot',
  'noise',
  'misc',
] as const satisfies readonly RngStreamName[];

/** Muối riêng từng luồng: hai luồng cùng seed vẫn ra dãy khác nhau. */
const STREAM_SALT: Readonly<Record<RngStreamName, number>> = {
  placement: 0x9e3779b9,
  color: 0x85ebca6b,
  model: 0xc2b2ae35,
  slot: 0x27d4eb2f,
  noise: 0x165667b1,
  misc: 0x2545f491,
};

const TWO_POW_32 = 4_294_967_296;
/** Hằng số cộng của mulberry32. */
const MULBERRY_STEP = 0x6d2b79f5;
const SEED_MAX = 0xffffffff;

/** Kết quả một bước RNG: trạng thái kế + số trong [0, 1). */
export interface RngDraw {
  readonly state: number;
  readonly value: number;
}

/** Kết quả rút từ một luồng của `RngStreams`. */
export interface RngStreamDraw {
  readonly streams: RngStreams;
  readonly value: number;
}

/** Kết quả chọn một phần tử. */
export interface RngPick<T> {
  readonly streams: RngStreams;
  readonly value: T;
}

type MutableRngStreams = { -readonly [K in keyof RngStreams]: number };

function withStream(
  streams: RngStreams,
  stream: RngStreamName,
  state: number,
): RngStreams {
  const next: MutableRngStreams = { ...streams };
  next[stream] = state;
  return next;
}

/** Một bước mulberry32 từ trạng thái uint32. */
export function nextMulberry32(state: number): RngDraw {
  const advanced = (state + MULBERRY_STEP) >>> 0;
  let t = advanced;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
  return { state: advanced, value };
}

/** Dãy mulberry32 dạng closure (tiện cho test và script một lần). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    const draw = nextMulberry32(state);
    state = draw.state;
    return draw.value;
  };
}

function mixSeed(seed: number, salt: number): number {
  const x = (seed ^ salt) >>> 0;
  const mixed = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  return (mixed ^ (mixed >>> 13)) >>> 0;
}

/**
 * Trạng thái ban đầu của 6 luồng từ seed kịch bản (C3).
 * Cùng seed → cùng trạng thái; seed sai là lỗi lập trình, báo ngay (R2).
 */
export function createRngStreams(seed: number): RngStreams {
  if (!Number.isInteger(seed) || seed < 0 || seed > SEED_MAX) {
    throw new Error(
      `createRngStreams: seed phải là số nguyên 0…2^32-1, nhận ${String(seed)}`,
    );
  }
  return {
    placement: mixSeed(seed, STREAM_SALT.placement),
    color: mixSeed(seed, STREAM_SALT.color),
    model: mixSeed(seed, STREAM_SALT.model),
    slot: mixSeed(seed, STREAM_SALT.slot),
    noise: mixSeed(seed, STREAM_SALT.noise),
    misc: mixSeed(seed, STREAM_SALT.misc),
  };
}

/** Rút một số thực trong [0, 1) từ luồng `stream` (chỉ luồng đó tiến). */
export function drawFloat(
  streams: RngStreams,
  stream: RngStreamName,
): RngStreamDraw {
  const draw = nextMulberry32(streams[stream]);
  return { streams: withStream(streams, stream, draw.state), value: draw.value };
}

/** Rút số nguyên trong [0, maxExclusive) từ luồng `stream`. */
export function drawInt(
  streams: RngStreams,
  stream: RngStreamName,
  maxExclusive: number,
): RngStreamDraw {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
    throw new Error(
      `drawInt: maxExclusive phải là số nguyên ≥ 1, nhận ${String(maxExclusive)}`,
    );
  }
  const draw = drawFloat(streams, stream);
  const value = Math.min(maxExclusive - 1, Math.floor(draw.value * maxExclusive));
  return { streams: draw.streams, value };
}

/** Chọn một phần tử; danh sách rỗng là lỗi lập trình (R2). */
export function pickItem<T>(
  streams: RngStreams,
  stream: RngStreamName,
  items: readonly T[],
): RngPick<T> {
  if (items.length === 0) {
    throw new Error('pickItem: danh sách rỗng, không bốc được');
  }
  const draw = drawInt(streams, stream, items.length);
  return { streams: draw.streams, value: items[draw.value] };
}

/** Trộn Fisher–Yates; trả mảng mới + trạng thái luồng đã tiến. */
export function shuffleItems<T>(
  streams: RngStreams,
  stream: RngStreamName,
  items: readonly T[],
): { readonly streams: RngStreams; readonly values: readonly T[] } {
  const values = [...items];
  let current = streams;
  for (let index = values.length - 1; index > 0; index -= 1) {
    const draw = drawInt(current, stream, index + 1);
    current = draw.streams;
    const swap = values[draw.value];
    values[draw.value] = values[index];
    values[index] = swap;
  }
  return { streams: current, values };
}

/** Bốc đúng/sai với xác suất `probability` (0…1). */
export function chance(
  streams: RngStreams,
  stream: RngStreamName,
  probability: number,
): { readonly streams: RngStreams; readonly value: boolean } {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(
      `chance: probability phải trong [0, 1], nhận ${String(probability)}`,
    );
  }
  const draw = drawFloat(streams, stream);
  return { streams: draw.streams, value: draw.value < probability };
}
