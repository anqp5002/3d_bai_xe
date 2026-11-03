/**
 * Nhiễu camera 9 loại (ý tưởng §10, FE §6, D-nhiễu).
 *
 * **Thuần số học trên mảng pixel RGBA** — không three, không DOM, không `Math.random`.
 * Toàn bộ ngẫu nhiên đi qua `mulberry32(seed)` với seed **sinh theo frame**, nên cùng
 * seed ⇒ cùng pixel (Done của P8, test bằng hash).
 *
 * Thứ tự áp (quan trọng, đúng thứ tự vật lý của camera):
 * 1. `shake` — dịch/xoay nhỏ toàn khung (trước mọi thứ khác).
 * 2. `white_balance` — lệch màu toàn khung.
 * 3. `grain` — hạt nhiễu.
 * 4. `drops` — giọt nước bám ống kính (chỉ khi mưa).
 * 5. `smudge` — vệt bẩn / che góc.
 * 6. `flare` — lóa theo vị trí mặt trời.
 * 7. `jpeg` — nén JPEG (mô phỏng: lượng tử hoá theo block 8×8).
 * 8. `downscale` — giảm phân giải rồi phóng lên.
 * 9. `fps_drop` — **không** đổi pixel của frame hiện tại; thông tin "giữ frame cũ" do
 *    lớp render quyết định (xem `heldFrameIndex`).
 *
 * Nhiễu áp lên **khung 640 trước khi cắt** cam1/cam2, để vùng chồng lấn của hai cam giống
 * hệt nhau (FE §6). File này không biết gì về camera — chỉ nhận `width`/`height`.
 */

import type { NoiseConfig, NoiseKind } from '../../contracts/env';
import { NOISE_KINDS } from '../../contracts/env';

/** Một khung RGBA 8-bit, hàng trước cột sau (`width * height * 4` byte). */
export interface RgbaFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Vị trí mặt trời để tính lóa (px trên khung). `null` = mặt trời ngoài khung. */
export interface SunScreenPosition {
  readonly u: number;
  readonly v: number;
  /** Cường độ 0..1. */
  readonly intensity: number;
}

/** Bối cảnh áp nhiễu (những gì nhiễu cần biết ngoài chính khung). */
export interface NoiseContext {
  /** Số frame mô phỏng — dùng làm seed phụ (D-nhiễu: seed theo frame). */
  readonly frame: number;
  /** Đang mưa không (`drops` chỉ có tác dụng khi mưa). */
  readonly raining: boolean;
  /** Vị trí mặt trời trên khung nếu có (cho `flare`). */
  readonly sun?: SunScreenPosition | null;
}

/** Một loại nhiễu đã áp (để log/REPORT). */
export interface AppliedNoise {
  readonly kind: NoiseKind;
  readonly level: number;
}

/** Trạng thái `fps_drop`: frame nào thực sự được render mới. */
export interface FpsDropState {
  /** `true` nếu frame này phải **giữ** khung của frame trước (không render mới). */
  readonly hold: boolean;
  /** Chỉ số frame nguồn cần hiển thị. */
  readonly sourceFrame: number;
}

// --------------------------------------------------------------------------------------
// RNG (mulberry32 — cùng công thức với `sim/rng.ts`, nhưng ở đây không import `sim/`)
// --------------------------------------------------------------------------------------
/** Băm seed + frame + salt thành uint32 (tất định, không dùng `Math.random`). */
export function noiseSeed(baseSeed: number, frame: number, salt = 0): number {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`noiseSeed: frame phải là số nguyên >= 0, nhận ${String(frame)}`);
  }
  let x = (baseSeed ^ Math.imul(frame + 1, 0x9e3779b9) ^ salt) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Bộ sinh số tất định từ một seed uint32. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// --------------------------------------------------------------------------------------
// Tiện ích khung
// --------------------------------------------------------------------------------------
/** Tạo khung trong suốt để test. */
export function createFrame(width: number, height: number): RgbaFrame {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Sao chép khung (để test so sánh trước/sau). */
export function cloneFrame(frame: RgbaFrame): RgbaFrame {
  return {
    width: frame.width,
    height: frame.height,
    data: new Uint8ClampedArray(frame.data),
  };
}

/** Kẹp giá trị về 0..255 (Uint8ClampedArray tự kẹp, nhưng hàm này cho rõ ý). */
function clamp255(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 255) {
    return 255;
  }
  return value;
}

/** Băm FNV-1a 32-bit của khung — dùng cho test "cùng seed ⇒ cùng pixel". */
export function hashFrame(frame: RgbaFrame): string {
  let hash = 0x811c9dc5;
  const { data } = frame;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Thêm kích thước để hai khung khác cỡ không trùng hash.
  hash ^= frame.width * 0x9e3779b9;
  hash = Math.imul(hash, 0x01000193) >>> 0;
  hash ^= frame.height * 0x85ebca6b;
  hash = Math.imul(hash, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

// --------------------------------------------------------------------------------------
// Từng loại nhiễu
// --------------------------------------------------------------------------------------
/**
 * `shake` — rung: dịch toàn khung theo (dx, dy) với biên độ `level × 6 px`, lấy mẫu
 * cạnh (clamp) để không có viền đen. Biên độ *nhỏ hơn 1 px* thì nội suy song tuyến tính.
 */
export function applyShake(frame: RgbaFrame, level: number, seed: number): RgbaFrame {
  const amplitude = Math.max(0, Math.min(1, level)) * 6;
  if (amplitude < 0.01) {
    return frame;
  }
  const rng = makeRng(seed);
  let dx = (rng() * 2 - 1) * amplitude;
  let dy = (rng() * 2 - 1) * amplitude;
  // Rung phải thấy được: nếu cả hai trục làm tròn về 0 thì đẩy 1 trục ra 1 px
  // (ngược lại `shake` bật mà ảnh không đổi — im lặng, trái R2).
  if (Math.round(Math.abs(dx)) === 0 && Math.round(Math.abs(dy)) === 0) {
    if (dx >= dy) {
      dx = dx >= 0 ? 1 : -1;
    } else {
      dy = dy >= 0 ? 1 : -1;
    }
  }
  const out = createFrame(frame.width, frame.height);
  const { width, height, data } = frame;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Lấy mẫu tại (x - dx, y - dy) với clamp.
      const sx = Math.min(width - 1, Math.max(0, Math.round(x - dx)));
      const sy = Math.min(height - 1, Math.max(0, Math.round(y - dy)));
      const src = (sy * width + sx) * 4;
      const dst = (y * width + x) * 4;
      out.data[dst] = data[src];
      out.data[dst + 1] = data[src + 1];
      out.data[dst + 2] = data[src + 2];
      out.data[dst + 3] = data[src + 3];
    }
  }
  return out;
}

/** `grain` — hạt nhiễu Gauss xấp xỉ (tổng 3 số đều), σ = `level × 18`. */
export function applyGrain(frame: RgbaFrame, level: number, seed: number): RgbaFrame {
  const sigma = Math.max(0, Math.min(1, level)) * 18;
  if (sigma < 0.05) {
    return frame;
  }
  const rng = makeRng(seed);
  const out = createFrame(frame.width, frame.height);
  const { data } = frame;
  const length = data.length;
  for (let index = 0; index < length; index += 4) {
    // Xấp xỉ Gauss: (r1 + r2 + r3 − 1.5) có σ ≈ 0,5.
    const noise = (rng() + rng() + rng() - 1.5) * 2 * sigma;
    out.data[index] = clamp255(data[index] + noise);
    out.data[index + 1] = clamp255(data[index + 1] + noise);
    out.data[index + 2] = clamp255(data[index + 2] + noise);
    out.data[index + 3] = data[index + 3];
  }
  return out;
}

/**
 * `jpeg` — nén JPEG. Mô phỏng bằng **lượng tử hoá block 8×8** theo chất lượng: mức 1 =
 * chất lượng ~20 (nhiễu mạnh), mức 0 = chất lượng 95 (gần như không đổi).
 *
 * Không gọi canvas/`toBlob` để hàm này chạy được trong Node (test hash) — sự khác biệt
 * với JPEG thật chỉ ở chi tiết chroma subsampling, không ảnh hưởng "nhiễu có tất định".
 */
export function applyJpeg(frame: RgbaFrame, level: number): RgbaFrame {
  const quality = 95 - Math.max(0, Math.min(1, level)) * 75;
  if (quality >= 95) {
    return frame;
  }
  // Bảng lượng tử cơ sở (JPEG luma) nhân hệ số chất lượng chuẩn hoá.
  const baseTable = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
  ];
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  const table = baseTable.map((value) => Math.max(1, Math.floor((value * scale + 50) / 100)));
  const out = createFrame(frame.width, frame.height);
  const { width, height, data } = frame;
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let channel = 0; channel < 3; channel += 1) {
        for (let y = 0; y < 8; y += 1) {
          const py = by + y;
          if (py >= height) {
            continue;
          }
          for (let x = 0; x < 8; x += 1) {
            const px = bx + x;
            if (px >= width) {
              continue;
            }
            const index = (py * width + px) * 4 + channel;
            const q = table[y * 8 + x];
            // Lượng tử hoá: làm tròn về bội số của q (mô phỏng mất chi tiết của DCT).
            out.data[index] = clamp255(Math.round(data[index] / q) * q);
          }
        }
      }
      // Alpha giữ nguyên.
      for (let y = 0; y < 8; y += 1) {
        const py = by + y;
        if (py >= height) {
          continue;
        }
        for (let x = 0; x < 8; x += 1) {
          const px = bx + x;
          if (px >= width) {
            continue;
          }
          const index = (py * width + px) * 4 + 3;
          out.data[index] = data[index];
        }
      }
    }
  }
  return out;
}

/**
 * `downscale` — render nhỏ rồi phóng lên. `level` = hệ số giảm (0,1 → 0,6):
 * `factor = 1 − level × 0,9`, tối thiểu 0,1. Dùng lấy mẫu hộp (box) rồi nearest-neighbour.
 */
export function applyDownscale(frame: RgbaFrame, level: number): RgbaFrame {
  const clamped = Math.max(0, Math.min(1, level));
  if (clamped < 0.02) {
    return frame;
  }
  const factor = Math.max(0.1, 1 - clamped * 0.9);
  const smallWidth = Math.max(2, Math.round(frame.width * factor));
  const smallHeight = Math.max(2, Math.round(frame.height * factor));
  const small = downsampleBox(frame, smallWidth, smallHeight);
  return upsampleNearest(small, frame.width, frame.height);
}

/** Thu nhỏ bằng trung bình hộp. */
export function downsampleBox(frame: RgbaFrame, width: number, height: number): RgbaFrame {
  const out = createFrame(width, height);
  const scaleX = frame.width / width;
  const scaleY = frame.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < Math.min(y1, frame.height); sy += 1) {
        for (let sx = x0; sx < Math.min(x1, frame.width); sx += 1) {
          const index = (sy * frame.width + sx) * 4;
          r += frame.data[index];
          g += frame.data[index + 1];
          b += frame.data[index + 2];
          a += frame.data[index + 3];
          count += 1;
        }
      }
      const dst = (y * width + x) * 4;
      out.data[dst] = count === 0 ? 0 : Math.round(r / count);
      out.data[dst + 1] = count === 0 ? 0 : Math.round(g / count);
      out.data[dst + 2] = count === 0 ? 0 : Math.round(b / count);
      out.data[dst + 3] = count === 0 ? 0 : Math.round(a / count);
    }
  }
  return out;
}

/** Phóng to bằng nearest-neighbour (giữ khối vuông đặc trưng của ảnh giảm phân giải). */
export function upsampleNearest(frame: RgbaFrame, width: number, height: number): RgbaFrame {
  const out = createFrame(width, height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(frame.height - 1, Math.floor((y * frame.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(frame.width - 1, Math.floor((x * frame.width) / width));
      const src = (sy * frame.width + sx) * 4;
      const dst = (y * width + x) * 4;
      out.data[dst] = frame.data[src];
      out.data[dst + 1] = frame.data[src + 1];
      out.data[dst + 2] = frame.data[src + 2];
      out.data[dst + 3] = frame.data[src + 3];
    }
  }
  return out;
}

/**
 * `fps_drop` — giảm fps: frame nào được render mới, frame nào giữ khung cũ.
 *
 * `level` 0,5 ⇒ chỉ render 1 trong 2 frame; 1,0 ⇒ 1 trong 4. **GT vẫn theo frame thật**
 * (FE §6) — hàm này chỉ nói cho lớp render biết nên giữ khung nào.
 */
export function heldFrameIndex(frame: number, level: number): FpsDropState {
  const clamped = Math.max(0, Math.min(1, level));
  if (clamped < 0.05) {
    return { hold: false, sourceFrame: frame };
  }
  // level 0,05 → giữ 1/2; level 1 → giữ 3/4.
  const holdRatio = 0.5 + clamped * 0.25;
  if (holdRatio <= 0) {
    return { hold: false, sourceFrame: frame };
  }
  const period = Math.max(2, Math.round(1 / (1 - holdRatio)) + 1);
  const cycle = frame % period;
  const hold = cycle !== 0;
  return { hold, sourceFrame: hold ? frame - cycle : frame };
}

/**
 * `flare` — lóa ống kính theo vị trí mặt trời: cộng sáng dạng Gauss quanh điểm đó + một
 * vòng sáng nhỏ đối xứng qua tâm (ghost).
 */
export function applyFlare(
  frame: RgbaFrame,
  level: number,
  sun: SunScreenPosition | null | undefined,
): RgbaFrame {
  const strength = Math.max(0, Math.min(1, level));
  if (strength < 0.02 || sun === null || sun === undefined || sun.intensity <= 0) {
    return frame;
  }
  const out = createFrame(frame.width, frame.height);
  out.data.set(frame.data);
  const { width, height } = frame;
  const radius = 120 + strength * 260;
  const peak = strength * sun.intensity * 150;
  const ghostU = width - sun.u;
  const ghostV = height - sun.v;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - sun.u;
      const dy = y - sun.v;
      const main = Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius)) * peak;
      const gx = x - ghostU;
      const gy = y - ghostV;
      const ghost = Math.exp(-(gx * gx + gy * gy) / (2 * (radius * 0.35) ** 2)) * peak * 0.25;
      const add = main + ghost;
      if (add < 0.5) {
        continue;
      }
      const index = (y * width + x) * 4;
      out.data[index] = clamp255(out.data[index] + add * 1.0);
      out.data[index + 1] = clamp255(out.data[index + 1] + add * 0.95);
      out.data[index + 2] = clamp255(out.data[index + 2] + add * 0.8);
    }
  }
  return out;
}

/**
 * `drops` — giọt nước bám ống kính (chỉ khi mưa). Vẽ các đĩa mờ có viền sáng.
 * Không có tác dụng khi `raining = false` (ý tưởng §10).
 */
export function applyDrops(
  frame: RgbaFrame,
  level: number,
  seed: number,
  raining: boolean,
): RgbaFrame {
  const strength = Math.max(0, Math.min(1, level));
  if (!raining || strength < 0.02) {
    return frame;
  }
  const rng = makeRng(seed);
  const out = createFrame(frame.width, frame.height);
  out.data.set(frame.data);
  const { width, height } = frame;
  const count = Math.round(6 + strength * 34);
  for (let drop = 0; drop < count; drop += 1) {
    const cx = rng() * width;
    const cy = rng() * height;
    const radius = 3 + rng() * (6 + strength * 14);
    const brightness = 25 + strength * 45;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(width, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(height, Math.ceil(cy + radius));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > radius) {
          continue;
        }
        // Vành sáng ở mép, tâm hơi tối (giọt nước khúc xạ).
        const edge = Math.exp(-((distance - radius * 0.82) ** 2) / (2 * (radius * 0.18) ** 2));
        const core = Math.exp(-(distance * distance) / (2 * (radius * 0.45) ** 2));
        const delta = edge * brightness - core * brightness * 0.45;
        const index = (y * width + x) * 4;
        out.data[index] = clamp255(out.data[index] + delta);
        out.data[index + 1] = clamp255(out.data[index + 1] + delta);
        out.data[index + 2] = clamp255(out.data[index + 2] + delta * 1.1);
      }
    }
  }
  return out;
}

/**
 * `smudge` — vệt bẩn / che một góc ống kính: làm mờ + tối dần về một góc.
 *
 * Mô phỏng bằng hệ số nhân giảm dần theo khoảng cách tới góc, cộng làm mờ nhẹ để mất chi tiết.
 */
export function applySmudge(frame: RgbaFrame, level: number, seed: number): RgbaFrame {
  const strength = Math.max(0, Math.min(1, level));
  if (strength < 0.02) {
    return frame;
  }
  const rng = makeRng(seed);
  // Góc bị che: 4 góc, chọn tất định theo seed.
  const corner = Math.floor(rng() * 4);
  const cornerX = corner === 0 || corner === 3 ? 0 : frame.width - 1;
  const cornerY = corner < 2 ? 0 : frame.height - 1;
  const radius = (0.35 + strength * 0.45) * Math.min(frame.width, frame.height);
  const blur = downsampleBox(frame, Math.max(2, Math.round(frame.width / 6)), Math.max(2, Math.round(frame.height / 6)));
  const blurred = upsampleNearest(blur, frame.width, frame.height);
  const out = createFrame(frame.width, frame.height);
  const { width, height, data } = frame;
  const darken = 0.35 + strength * 0.5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cornerX;
      const dy = y - cornerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      // `weight` 1 ở tâm góc, 0 ngoài bán kính.
      const weight = distance >= radius ? 0 : (1 - distance / radius) ** 1.6;
      const index = (y * width + x) * 4;
      const mixBlur = weight * 0.85;
      const factor = 1 - weight * darken;
      out.data[index] = clamp255((data[index] * (1 - mixBlur) + blurred.data[index] * mixBlur) * factor);
      out.data[index + 1] = clamp255(
        (data[index + 1] * (1 - mixBlur) + blurred.data[index + 1] * mixBlur) * factor,
      );
      out.data[index + 2] = clamp255(
        (data[index + 2] * (1 - mixBlur) + blurred.data[index + 2] * mixBlur) * factor,
      );
      out.data[index + 3] = data[index + 3];
    }
  }
  return out;
}

/**
 * `white_balance` — lệch cân bằng trắng: kênh R tăng, kênh B giảm (hoặc ngược, tất định
 * theo seed) với biên độ `level × 30`.
 */
export function applyWhiteBalance(frame: RgbaFrame, level: number, seed: number): RgbaFrame {
  const strength = Math.max(0, Math.min(1, level));
  if (strength < 0.02) {
    return frame;
  }
  const rng = makeRng(seed);
  const warm = rng() < 0.5;
  const delta = strength * 34;
  const redGain = warm ? 1 + delta / 255 : 1 - delta / 255;
  const blueGain = warm ? 1 - delta / 255 : 1 + delta / 255;
  const greenGain = warm ? 1 + delta / 765 : 1 - delta / 765;
  const out = createFrame(frame.width, frame.height);
  const { data } = frame;
  for (let index = 0; index < data.length; index += 4) {
    out.data[index] = clamp255(data[index] * redGain);
    out.data[index + 1] = clamp255(data[index + 1] * greenGain);
    out.data[index + 2] = clamp255(data[index + 2] * blueGain);
    out.data[index + 3] = data[index + 3];
  }
  return out;
}

// --------------------------------------------------------------------------------------
// Áp toàn bộ
// --------------------------------------------------------------------------------------
/** Kết quả một lần áp nhiễu. */
export interface NoiseResult {
  readonly frame: RgbaFrame;
  readonly applied: readonly AppliedNoise[];
  /** `true` nếu lớp render phải giữ khung của frame trước (`fps_drop`). */
  readonly holdPrevious: boolean;
  readonly sourceFrame: number;
}

/** Thứ tự áp cố định — test kiểm thứ tự này. */
export const NOISE_ORDER: readonly NoiseKind[] = [
  'shake',
  'white_balance',
  'grain',
  'drops',
  'smudge',
  'flare',
  'jpeg',
  'downscale',
  'fps_drop',
];

/**
 * Áp toàn bộ nhiễu đang bật lên một khung.
 *
 * **Tất định**: cùng `config` + cùng `context.frame` ⇒ cùng `data` (Done của P8).
 * Hàm không sửa `input`.
 */
export function applyNoise(
  input: RgbaFrame,
  config: NoiseConfig,
  context: NoiseContext,
): NoiseResult {
  const applied: AppliedNoise[] = [];
  let frame = input;
  let holdPrevious = false;
  let sourceFrame = context.frame;

  for (const kind of NOISE_ORDER) {
    const toggle = config[kind];
    if (!toggle.on) {
      continue;
    }
    const seed = noiseSeed(config.seed, context.frame, NOISE_KINDS.indexOf(kind) + 1);
    switch (kind) {
      case 'shake':
        frame = applyShake(frame, toggle.level, seed);
        break;
      case 'white_balance':
        frame = applyWhiteBalance(frame, toggle.level, seed);
        break;
      case 'grain':
        frame = applyGrain(frame, toggle.level, seed);
        break;
      case 'drops':
        frame = applyDrops(frame, toggle.level, seed, context.raining);
        break;
      case 'smudge':
        frame = applySmudge(frame, toggle.level, seed);
        break;
      case 'flare':
        frame = applyFlare(frame, toggle.level, context.sun);
        break;
      case 'jpeg':
        frame = applyJpeg(frame, toggle.level);
        break;
      case 'downscale':
        frame = applyDownscale(frame, toggle.level);
        break;
      case 'fps_drop': {
        const state = heldFrameIndex(context.frame, toggle.level);
        holdPrevious = state.hold;
        sourceFrame = state.sourceFrame;
        break;
      }
      default: {
        const exhaustive: never = kind;
        throw new Error(`applyNoise: loại nhiễu lạ ${String(exhaustive)}`);
      }
    }
    applied.push({ kind, level: toggle.level });
  }

  return { frame, applied, holdPrevious, sourceFrame };
}

/** Danh sách loại nhiễu đang bật (cho UI/log). */
export function enabledNoiseKinds(config: NoiseConfig): readonly NoiseKind[] {
  return NOISE_KINDS.filter((kind) => config[kind].on);
}
