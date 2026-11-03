/**
 * Test quy tắc **"áp nhiễu TRƯỚC khi cắt cam"** (FE §6, P8 mục 3).
 *
 * Lý do: cam1 = cột 0–400, cam2 = cột 240–640 nên vùng 240–400 **nhìn thấy ở cả hai cam**.
 * Nếu áp nhiễu sau khi cắt thì vùng đó sẽ khác nhau giữa hai video — TechGAR sẽ thấy hai
 * ảnh khác nhau của cùng một chỗ, sai handoff. Test chứng minh: áp nhiễu trên khung 640
 * rồi cắt ⇒ vùng chồng lấn **giống hệt** ở cam1 và cam2.
 */

import { describe, expect, it } from 'vitest';
import { createNoiseConfig, NOISE_KINDS, type NoiseConfig, type NoiseKind } from '../../contracts/env';
import { applyNoise, hashFrame, type RgbaFrame } from './cameraNoise';

/** Khung 640×640 giả lập cảnh (gradient + khối màu). */
function bigFrame(width = 640, height = 640): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = (x * 255) / width;
      data[index + 1] = (y * 255) / height;
      data[index + 2] = ((x >> 4) + (y >> 4)) % 2 === 0 ? 60 : 180;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Cắt cột `[u0, u1)` của khung. */
function crop(frame: RgbaFrame, u0: number, u1: number): RgbaFrame {
  const width = u1 - u0;
  const data = new Uint8ClampedArray(width * frame.height * 4);
  for (let y = 0; y < frame.height; y += 1) {
    const start = (y * frame.width + u0) * 4;
    data.set(frame.data.subarray(start, start + width * 4), y * width * 4);
  }
  return { width, height: frame.height, data };
}

/** Cắt vùng chồng lấn 240–400 của một khung 400 rộng (cam1). */
function overlapOfCam1(cam1: RgbaFrame): RgbaFrame {
  return crop(cam1, 240, 400);
}

/** Vùng chồng lấn trong cam2 nằm ở cột 0–160. */
function overlapOfCam2(cam2: RgbaFrame): RgbaFrame {
  return crop(cam2, 0, 160);
}

function configFor(kind: NoiseKind, level = 0.9): NoiseConfig {
  return { ...createNoiseConfig(2024), [kind]: { on: true, level } };
}

describe('render/noise — áp trước khi cắt cam (FE §6)', () => {
  it.each([...NOISE_KINDS])('%s: vùng chồng lấn giống hệt ở cam1 và cam2', (kind) => {
    const frame = bigFrame();
    const context = { frame: 5, raining: true, sun: { u: 320, v: 200, intensity: 0.8 } };
    const noised = applyNoise(frame, configFor(kind), context).frame;

    // Áp TRƯỚC, cắt SAU.
    const cam1 = crop(noised, 0, 400);
    const cam2 = crop(noised, 240, 640);
    expect(hashFrame(overlapOfCam1(cam1))).toBe(hashFrame(overlapOfCam2(cam2)));
  });

  it('cả 9 loại cùng bật: vùng chồng lấn vẫn giống hệt', () => {
    const base = createNoiseConfig(777);
    const all = NOISE_KINDS.reduce<NoiseConfig>(
      (config, kind) => ({ ...config, [kind]: { on: true, level: 0.8 } }),
      base,
    );
    const noised = applyNoise(bigFrame(), all, {
      frame: 2,
      raining: true,
      sun: { u: 300, v: 180, intensity: 1 },
    }).frame;
    const cam1 = crop(noised, 0, 400);
    const cam2 = crop(noised, 240, 640);
    expect(hashFrame(overlapOfCam1(cam1))).toBe(hashFrame(overlapOfCam2(cam2)));
  });

  it('nếu áp nhiễu SAU khi cắt thì vùng chồng lấn KHÁC nhau (chứng minh test có tác dụng)', () => {
    const frame = bigFrame();
    const config = configFor('grain', 0.9);
    // Sai: cắt trước rồi mới áp nhiễu từng cam.
    const cam1 = applyNoise(crop(frame, 0, 400), config, { frame: 5, raining: false }).frame;
    const cam2 = applyNoise(crop(frame, 240, 640), config, { frame: 5, raining: false }).frame;
    expect(hashFrame(overlapOfCam1(cam1))).not.toBe(hashFrame(overlapOfCam2(cam2)));
  });

  it('kích thước sau khi cắt đúng U19: cam1 400×640, cam2 400×640', () => {
    const noised = applyNoise(bigFrame(), configFor('jpeg'), {
      frame: 0,
      raining: false,
      sun: null,
    }).frame;
    const cam1 = crop(noised, 0, 400);
    const cam2 = crop(noised, 240, 640);
    expect([cam1.width, cam1.height]).toEqual([400, 640]);
    expect([cam2.width, cam2.height]).toEqual([400, 640]);
    // Và vùng chồng lấn rộng đúng 160 px.
    expect(overlapOfCam1(cam1).width).toBe(160);
  });

  it('nhiễu không làm đổi GT: hash khung 640 tất định theo frame', () => {
    const config = configFor('shake', 0.7);
    const a = applyNoise(bigFrame(), config, { frame: 9, raining: false });
    const b = applyNoise(bigFrame(), config, { frame: 9, raining: false });
    // Cùng frame ⇒ cùng pixel dù cắt thế nào.
    expect(hashFrame(a.frame)).toBe(hashFrame(b.frame));
  });
});
