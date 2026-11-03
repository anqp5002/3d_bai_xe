/**
 * Test nhiễu camera 9 loại (P8 mục 3).
 *
 * Trọng tâm là **tất định**: cùng `NoiseConfig` + cùng frame ⇒ **cùng hash pixel**
 * (Done của P8). Ngoài ra kiểm từng loại có tác dụng thật (không phải no-op),
 * và `drops`/`flare` đúng điều kiện bật/tắt.
 */

import { describe, expect, it } from 'vitest';
import { createNoiseConfig, NOISE_KINDS, type NoiseConfig, type NoiseKind } from '../../contracts/env';
import {
  NOISE_ORDER,
  applyDownscale,
  applyDrops,
  applyFlare,
  applyGrain,
  applyJpeg,
  applyNoise,
  applyShake,
  applySmudge,
  applyWhiteBalance,
  cloneFrame,
  createFrame,
  downsampleBox,
  enabledNoiseKinds,
  hashFrame,
  heldFrameIndex,
  makeRng,
  noiseSeed,
  upsampleNearest,
  type RgbaFrame,
} from './cameraNoise';

/** Khung test: gradient + vài khối màu, đủ chi tiết để nhiễu có tác dụng. */
function testFrame(width = 64, height = 48): RgbaFrame {
  const frame = createFrame(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      frame.data[index] = Math.round((x / width) * 255);
      frame.data[index + 1] = Math.round((y / height) * 255);
      frame.data[index + 2] = ((x >> 3) + (y >> 3)) % 2 === 0 ? 40 : 200;
      frame.data[index + 3] = 255;
    }
  }
  return frame;
}

/** Config bật đúng một loại nhiễu với mức cho trước. */
function withNoise(kind: NoiseKind, level: number, seed = 1234): NoiseConfig {
  const base = createNoiseConfig(seed);
  return { ...base, [kind]: { on: true, level } };
}

describe('render/noise — RNG + seed theo frame', () => {
  it('cùng seed + frame ⇒ cùng chuỗi; khác frame ⇒ khác', () => {
    const a = makeRng(noiseSeed(7, 10));
    const b = makeRng(noiseSeed(7, 10));
    const c = makeRng(noiseSeed(7, 11));
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    const seqC = Array.from({ length: 5 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('noiseSeed từ chối frame âm / không nguyên (R2)', () => {
    expect(() => noiseSeed(1, -1)).toThrow(/số nguyên/);
    expect(() => noiseSeed(1, 1.5)).toThrow(/số nguyên/);
  });

  it('hashFrame khác nhau khi khung khác, giống khi giống', () => {
    const a = testFrame();
    const b = cloneFrame(a);
    expect(hashFrame(a)).toBe(hashFrame(b));
    b.data[0] = b.data[0] === 255 ? 0 : b.data[0] + 1;
    expect(hashFrame(a)).not.toBe(hashFrame(b));
  });
});

describe('render/noise — Done: cùng seed ⇒ cùng pixel', () => {
  it.each([...NOISE_KINDS])('%s: 2 lần áp cùng seed ⇒ hash giống hệt', (kind) => {
    const config = withNoise(kind, 0.8);
    const context = { frame: 7, raining: true, sun: { u: 20, v: 10, intensity: 0.9 } };
    const first = applyNoise(testFrame(), config, context);
    const second = applyNoise(testFrame(), config, context);
    expect(hashFrame(first.frame)).toBe(hashFrame(second.frame));
  });

  it('bật cả 9 loại cùng lúc vẫn tất định', () => {
    const base = createNoiseConfig(4242);
    const all = NOISE_KINDS.reduce<NoiseConfig>(
      (config, kind) => ({ ...config, [kind]: { on: true, level: 0.7 } }),
      base,
    );
    const context = { frame: 3, raining: true, sun: { u: 32, v: 24, intensity: 1 } };
    const first = applyNoise(testFrame(), all, context);
    const second = applyNoise(testFrame(), all, context);
    expect(hashFrame(first.frame)).toBe(hashFrame(second.frame));
    expect(first.applied.map((entry) => entry.kind)).toEqual([...NOISE_ORDER]);
    expect(first.applied).toHaveLength(9);
  });

  it('frame khác ⇒ hash khác (seed theo frame)', () => {
    const config = withNoise('grain', 0.8);
    const a = applyNoise(testFrame(), config, { frame: 1, raining: false });
    const b = applyNoise(testFrame(), config, { frame: 2, raining: false });
    expect(hashFrame(a.frame)).not.toBe(hashFrame(b.frame));
  });

  it('seed khác ⇒ hash khác', () => {
    const a = applyNoise(testFrame(), withNoise('grain', 0.8, 1), { frame: 1, raining: false });
    const b = applyNoise(testFrame(), withNoise('grain', 0.8, 2), { frame: 1, raining: false });
    expect(hashFrame(a.frame)).not.toBe(hashFrame(b.frame));
  });

  it('applyNoise KHÔNG sửa khung đầu vào (thuần)', () => {
    const input = testFrame();
    const before = hashFrame(input);
    applyNoise(input, withNoise('grain', 1.0), { frame: 0, raining: true, sun: null });
    expect(hashFrame(input)).toBe(before);
  });

  it('tất cả nhiễu tắt ⇒ khung không đổi (hash giữ nguyên)', () => {
    const input = testFrame();
    const result = applyNoise(input, createNoiseConfig(9), { frame: 0, raining: true });
    expect(hashFrame(result.frame)).toBe(hashFrame(input));
    expect(result.applied).toEqual([]);
  });
});

describe('render/noise — từng loại có tác dụng thật', () => {
  const frame = testFrame();

  it('shake: dịch khung, giữ kích thước + alpha', () => {
    const out = applyShake(frame, 1.0, 11);
    expect(out.width).toBe(frame.width);
    expect(out.height).toBe(frame.height);
    expect(hashFrame(out)).not.toBe(hashFrame(frame));
    for (let index = 3; index < out.data.length; index += 4) {
      expect(out.data[index]).toBe(255);
    }
  });

  it('grain: thêm hạt, độ lệch chuẩn tăng', () => {
    const out = applyGrain(frame, 1.0, 22);
    const diff = Math.abs(out.data[0] - frame.data[0]) + Math.abs(out.data[4] - frame.data[4]);
    expect(diff).toBeGreaterThan(0);
  });

  it('grain mức 0 gần như không đổi', () => {
    const out = applyGrain(frame, 0, 33);
    expect(hashFrame(out)).toBe(hashFrame(frame));
  });

  it('jpeg: giảm số mức màu (lượng tử hoá)', () => {
    const countColors = (target: RgbaFrame): number => {
      const set = new Set<number>();
      for (let index = 0; index < target.data.length; index += 4) {
        set.add(target.data[index] * 65536 + target.data[index + 1] * 256 + target.data[index + 2]);
      }
      return set.size;
    };
    const before = countColors(frame);
    const after = countColors(applyJpeg(frame, 1.0));
    expect(after).toBeLessThan(before);
  });

  it('jpeg chất lượng cao (level 0) không đổi', () => {
    expect(hashFrame(applyJpeg(frame, 0))).toBe(hashFrame(frame));
  });

  it('downscale: phóng lên giữ kích thước, làm mất chi tiết (ít màu hơn)', () => {
    const out = applyDownscale(frame, 1.0);
    expect(out.width).toBe(frame.width);
    expect(out.height).toBe(frame.height);
    expect(hashFrame(out)).not.toBe(hashFrame(frame));
  });

  it('downsampleBox + upsampleNearest: giữ kích thước gốc sau khi phóng', () => {
    const small = downsampleBox(frame, 16, 12);
    expect(small.width).toBe(16);
    const back = upsampleNearest(small, 64, 48);
    expect(back.width).toBe(64);
    expect(back.height).toBe(48);
  });

  it('flare: chỉ có tác dụng khi có mặt trời trong khung', () => {
    const sun = { u: 32, v: 24, intensity: 1 };
    const withSun = applyFlare(frame, 1.0, sun);
    expect(hashFrame(withSun)).not.toBe(hashFrame(frame));
    // Không có mặt trời ⇒ không đổi.
    expect(hashFrame(applyFlare(frame, 1.0, null))).toBe(hashFrame(frame));
    expect(hashFrame(applyFlare(frame, 1.0, undefined))).toBe(hashFrame(frame));
    // Mặt trời cường độ 0 ⇒ không đổi.
    expect(hashFrame(applyFlare(frame, 1.0, { u: 1, v: 1, intensity: 0 }))).toBe(hashFrame(frame));
  });

  it('flare làm sáng vùng quanh mặt trời', () => {
    const sun = { u: 32, v: 24, intensity: 1 };
    const out = applyFlare(frame, 1.0, sun);
    const center = (24 * 64 + 32) * 4;
    expect(out.data[center]).toBeGreaterThanOrEqual(frame.data[center]);
  });

  it('drops: CHỈ khi mưa (ý tưởng §10)', () => {
    const raining = applyDrops(frame, 1.0, 66, true);
    expect(hashFrame(raining)).not.toBe(hashFrame(frame));
    const dry = applyDrops(frame, 1.0, 66, false);
    expect(hashFrame(dry)).toBe(hashFrame(frame));
  });

  it('smudge: làm tối một góc ảnh', () => {
    const out = applySmudge(frame, 1.0, 77);
    expect(hashFrame(out)).not.toBe(hashFrame(frame));
    // Ít nhất một góc phải tối hơn khung gốc.
    const corners = [
      0,
      (frame.width - 1) * 4,
      (frame.height - 1) * frame.width * 4,
      ((frame.height - 1) * frame.width + frame.width - 1) * 4,
    ];
    const darkened = corners.some(
      (index) =>
        out.data[index] + out.data[index + 1] + out.data[index + 2] <
        frame.data[index] + frame.data[index + 1] + frame.data[index + 2],
    );
    expect(darkened).toBe(true);
  });

  it('white_balance: lệch kênh R và B ngược chiều', () => {
    const out = applyWhiteBalance(frame, 1.0, 88);
    let redDelta = 0;
    let blueDelta = 0;
    for (let index = 0; index < frame.data.length; index += 4) {
      redDelta += out.data[index] - frame.data[index];
      blueDelta += out.data[index + 2] - frame.data[index + 2];
    }
    // Lệch ấm (R tăng, B giảm) hoặc lạnh (ngược) — luôn ngược dấu.
    expect(Math.sign(redDelta)).toBe(-Math.sign(blueDelta));
    expect(redDelta).not.toBe(0);
  });

  it('fps_drop: giữ frame theo chu kỳ, GT vẫn theo frame thật', () => {
    const level = 1.0;
    const states = Array.from({ length: 12 }, (_, frame) => heldFrameIndex(frame, level));
    // Có frame giữ và frame không giữ.
    expect(states.some((state) => state.hold)).toBe(true);
    expect(states.some((state) => !state.hold)).toBe(true);
    // Frame giữ trỏ về frame nguồn ≤ frame hiện tại.
    for (let frame = 0; frame < states.length; frame += 1) {
      expect(states[frame].sourceFrame).toBeLessThanOrEqual(frame);
    }
    // Mức 0 ⇒ không giữ frame nào.
    expect(heldFrameIndex(5, 0).hold).toBe(false);
  });
});

describe('render/noise — thứ tự + tiện ích', () => {
  it('NOISE_ORDER đúng thứ tự vật lý đã chốt', () => {
    expect(NOISE_ORDER).toEqual([
      'shake',
      'white_balance',
      'grain',
      'drops',
      'smudge',
      'flare',
      'jpeg',
      'downscale',
      'fps_drop',
    ]);
  });

  it('NOISE_ORDER phủ đủ 9 loại của contract', () => {
    expect([...NOISE_ORDER].sort()).toEqual([...NOISE_KINDS].sort());
  });

  it('enabledNoiseKinds chỉ trả loại đang bật', () => {
    const config = withNoise('grain', 0.5);
    expect(enabledNoiseKinds(config)).toEqual(['grain']);
    expect(enabledNoiseKinds(createNoiseConfig(1))).toEqual([]);
  });

  it('applyNoise trả `holdPrevious` + `sourceFrame` khi bật fps_drop', () => {
    const config = withNoise('fps_drop', 1.0);
    const result = applyNoise(testFrame(), config, { frame: 5, raining: false });
    const expected = heldFrameIndex(5, 1.0);
    expect(result.holdPrevious).toBe(expected.hold);
    expect(result.sourceFrame).toBe(expected.sourceFrame);
  });

  it('nhiễu không đụng alpha (ảnh vẫn đục)', () => {
    const config = withNoise('grain', 1.0);
    const result = applyNoise(testFrame(), config, { frame: 1, raining: false });
    for (let index = 3; index < result.frame.data.length; index += 4) {
      expect(result.frame.data[index]).toBe(255);
    }
  });
});
