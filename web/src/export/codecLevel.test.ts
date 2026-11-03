/**
 * Chọn codec H.264 theo kích thước ảnh (BRIEF_P15 mục A).
 *
 * **Vì sao có test này:** khi thêm hệ số phóng `s = 2`, ảnh cam thành 800×1280. Codec cũ
 * `avc1.42E01F` là Baseline **level 3.1** (tối đa 921 600 px) nên 800×1280 = 1 024 000 px bị
 * từ chối; exporter **lặng lẽ** rơi về đường PNG và 3600 PNG × 143 KB vượt giới hạn upload
 * 512 MB ⇒ xuất K2 chết ở bước finalize. Test này ghim bảng level để lỗi đó không tái diễn.
 *
 * Chạy: `cd sim3d/web && npx vitest run src/export/codecLevel.test.ts`
 */

import { describe, expect, it } from 'vitest';
import { H264_CONFIG, bitrateFor, codecFor } from './webCodecsEncoder';
import { TECHGAR_SCALE, techgarImageSize } from './techgarConfig';
import { outputSizesAt } from './runExport';

/** `MaxFS` × 256 pixel là giới hạn diện tích thật của từng level (H.264 Bảng A-1). */
describe('export/codecLevel — chọn level H.264 theo kích thước', () => {
  it('s=1 (mọi đầu ra) dùng Baseline 3.1 như cũ', () => {
    const sizes = outputSizesAt(1);
    for (const output of ['full', 'cam1', 'cam2'] as const) {
      const [width, height] = sizes[output];
      expect(codecFor(width, height)).toBe('avc1.42E01F');
    }
  });

  it('s=2 dùng level đủ lớn cho cam1/cam2 đã phóng', () => {
    const sizes = outputSizesAt(TECHGAR_SCALE);
    const camSize = techgarImageSize(TECHGAR_SCALE);
    // Cam 800×1280 = 1 024 000 px > 921 600 (level 3.1) ⇒ phải lên 3.2.
    expect(camSize.width * camSize.height).toBeGreaterThan(921_600);
    expect(codecFor(camSize.width, camSize.height)).toBe('avc1.42E020');
    // Không đầu ra cam nào rơi vào codec level 3.1 (nguyên nhân gốc của lỗi PNG fallback).
    for (const output of ['cam1', 'cam2'] as const) {
      const [width, height] = sizes[output];
      expect(width * height).toBeGreaterThan(921_600);
      expect(codecFor(width, height)).toBe('avc1.42E020');
    }
    // `raw_full` là ảnh toàn cảnh cho người xem, giữ 640×640 ⇒ vẫn level 3.1.
    const [fullWidth, fullHeight] = sizes.full;
    expect([fullWidth, fullHeight]).toEqual([640, 640]);
    expect(codecFor(fullWidth, fullHeight)).toBe('avc1.42E01F');
  });

  it('codec trả về luôn đủ chỗ cho số pixel (không chọn level quá nhỏ)', () => {
    for (const scale of [1, 1.5, 2, 2.5]) {
      const sizes = outputSizesAt(scale);
      for (const output of ['full', 'cam1', 'cam2'] as const) {
        const [width, height] = sizes[output];
        const codec = codecFor(width, height);
        const level = H264_CONFIG.levels.find((entry) => entry.codec === codec);
        expect(level, `${String(width)}×${String(height)} → ${codec}`).toBeDefined();
        expect(width * height).toBeLessThanOrEqual(level?.maxPixels ?? 0);
      }
    }
  });

  it('vượt level 5.0 thì báo lỗi rõ, không trả codec sai', () => {
    // 4096×2160 = 8 847 360 px > 5 652 480 px (level 5.0).
    expect(() => codecFor(4096, 2160)).toThrow(/vượt H\.264 level 5\.0/);
  });

  it('bitrate vẫn giữ tỉ lệ bit/pixel và có sàn 1 Mbps', () => {
    const base = bitrateFor(640, 640);
    expect(base).toBe(H264_CONFIG.baseBitrate);
    expect(bitrateFor(400, 640)).toBeGreaterThanOrEqual(1_000_000);
    // 800×1280 = 2,5 lần diện tích 640×640 ⇒ bitrate 2,5 lần.
    expect(bitrateFor(800, 1280)).toBe(Math.round(H264_CONFIG.baseBitrate * 2.5));
  });
});
