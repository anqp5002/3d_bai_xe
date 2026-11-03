/**
 * Test phần thuần của panel môi trường (P9c mục 1).
 *
 * Kiểm những chỗ dễ sai mà UI không tự bắt được: vị trí mốc trên thanh giờ, sửa/xoá mốc
 * có giữ bất biến của contract không, nhãn giờ, và 9 nút nhiễu phủ đủ khoá.
 */

import { describe, expect, it } from 'vitest';
import type { EnvKeyframe } from '../../contracts/env';
import { NOISE_KINDS, createNoiseConfig } from '../../contracts/env';
import {
  NOISE_CONTROLS,
  PRESET_OPTIONS,
  applyKeyframeEdit,
  clockLabel,
  defaultNewKeyframe,
  keyframeMarkers,
  noiseControlsCoverContract,
  presetById,
  setNoiseLevel,
  sunSummary,
  timelineSummary,
  toggleNoise,
  validateKeyframe,
  weatherIcon,
  weatherLabel,
} from './envPanelModel';

const KF = (
  t_s: number,
  hour: number,
  weather: EnvKeyframe['weather'] = 'sun',
  intensity = 0.8,
): EnvKeyframe => ({ t_s, hour, weather, intensity, wet: 0, fog: 0 });

describe('ui/env — thanh giờ', () => {
  it('clockLabel định dạng HH:MM, kể cả giờ lẻ và giờ > 24', () => {
    expect(clockLabel(0)).toBe('00:00');
    expect(clockLabel(6)).toBe('06:00');
    expect(clockLabel(7.5)).toBe('07:30');
    expect(clockLabel(19.25)).toBe('19:15');
    expect(clockLabel(25)).toBe('01:00');
  });

  it('markers đặt % theo GIỜ TRONG NGÀY, không theo t_s (P14b lỗi 5)', () => {
    const markers = keyframeMarkers([KF(0, 6), KF(10, 12), KF(20, 18)]);
    expect(markers).toHaveLength(3);
    expect(markers[0].percent).toBeCloseTo((6 / 24) * 100, 9);
    expect(markers[1].percent).toBeCloseTo((12 / 24) * 100, 9);
    expect(markers[2].percent).toBeCloseTo((18 / 24) * 100, 9);
  });

  it('mốc 15:00 nằm ở 62,5 % (đúng ảnh anh An báo, trước đây dồn về 0 %)', () => {
    const [marker] = keyframeMarkers([KF(0, 15)]);
    expect(marker.percent).toBeCloseTo(62.5, 6);
    expect(marker.percent).toBeGreaterThan(50);
  });

  it('dải 15:00 → 17:30 trải rộng trên thanh, không dồn một chỗ', () => {
    const markers = keyframeMarkers([
      KF(0, 15),
      KF(900, 16),
      KF(1800, 17),
      KF(2700, 17.5),
    ]);
    const last = markers[markers.length - 1].percent;
    const first = markers[0].percent;
    expect(first).toBeCloseTo(62.5, 6);
    expect(last).toBeCloseTo((17.5 / 24) * 100, 6);
    expect(last - first, 'dải phải trải ít nhất 8 % chiều ngang').toBeGreaterThan(8);
  });

  it('giờ vượt 24 được cuộn (25 h = 01:00 = 4,17 %)', () => {
    const [marker] = keyframeMarkers([KF(0, 25)]);
    expect(marker.percent).toBeCloseTo((1 / 24) * 100, 6);
    expect(marker.clock).toBe('01:00');
  });

  it('markers rỗng khi không có mốc', () => {
    expect(keyframeMarkers([])).toEqual([]);
  });

  it('markers có nhãn giờ + biểu tượng đúng', () => {
    const [noon] = keyframeMarkers([KF(0, 12, 'sun')]);
    expect(noon.clock).toBe('12:00');
    expect(noon.icon).toBe('☀');
    const [night] = keyframeMarkers([KF(0, 22, 'sun')]);
    expect(night.icon).toBe('🌙');
    const [rain] = keyframeMarkers([KF(0, 15, 'rain')]);
    expect(rain.icon).toBe('🌧');
  });

  it('weatherIcon/weatherLabel đúng cho 4 loại + đêm', () => {
    expect(weatherIcon('cloud', 12)).toBe('☁');
    expect(weatherIcon('fog', 6)).toBe('🌫');
    expect(weatherLabel('sun', 12)).toBe('Nắng');
    expect(weatherLabel('sun', 22)).toBe('Đêm');
    expect(weatherLabel('rain', 12)).toBe('Mưa');
  });

  it('timelineSummary: 1 mốc hiện giờ, nhiều mốc hiện khoảng', () => {
    expect(timelineSummary([KF(0, 12)])).toContain('12:00');
    expect(timelineSummary([KF(0, 6), KF(30, 18)])).toContain('→');
    expect(timelineSummary([])).toBe('—');
  });

  it('sunSummary trả độ cao + cờ đèn', () => {
    const noon = sunSummary(KF(0, 12));
    expect(noon.elevationDeg).toBeCloseTo(75, 6);
    expect(noon.lampsOn).toBe(false);
    const night = sunSummary(KF(0, 22));
    expect(night.lampsOn).toBe(true);
    expect(night.icon).toBe('🌙');
  });
});

describe('ui/env — sửa mốc (giữ bất biến của contract)', () => {
  it('sửa một mốc: giữ nguyên số mốc, sắp lại theo t_s', () => {
    const frames = [KF(0, 6), KF(20, 18)];
    const result = applyKeyframeEdit(frames, 0, KF(0, 8));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.keyframes).toHaveLength(2);
    expect(result.keyframes[0].hour).toBe(8);
  });

  it('thêm mốc (index = -1) và sắp theo t_s', () => {
    const result = applyKeyframeEdit([KF(0, 6), KF(20, 18)], -1, KF(10, 12));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.keyframes.map((keyframe) => keyframe.hour)).toEqual([6, 12, 18]);
  });

  it('KHÔNG cho xoá mốc cuối cùng (contract: keyframes ≥ 1)', () => {
    const result = applyKeyframeEdit([KF(0, 12)], 0, null);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('ít nhất 1 mốc');
  });

  it('xoá mốc khi còn > 1 thì được', () => {
    const result = applyKeyframeEdit([KF(0, 6), KF(20, 18)], 1, null);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.keyframes).toHaveLength(1);
  });

  it('KHÔNG cho hai mốc cùng t_s (nội suy không xác định)', () => {
    const result = applyKeyframeEdit([KF(0, 6), KF(10, 12)], -1, KF(10, 15));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('trùng thời điểm');
  });

  it('từ chối giờ ngoài 0–24, cường độ ngoài 0–1, t_s âm', () => {
    expect(applyKeyframeEdit([KF(0, 12)], -1, KF(5, 25)).ok).toBe(false);
    expect(applyKeyframeEdit([KF(0, 12)], -1, { ...KF(5, 12), intensity: 1.5 }).ok).toBe(false);
    expect(applyKeyframeEdit([KF(0, 12)], -1, { ...KF(5, 12), t_s: -1 }).ok).toBe(false);
  });

  it('index không tồn tại thì từ chối, không im lặng', () => {
    const result = applyKeyframeEdit([KF(0, 12)], 5, KF(3, 13));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('Không có mốc thứ 5');
  });

  it('validateKeyframe nhận mốc hợp lệ', () => {
    expect(validateKeyframe(KF(0, 12))).toBeNull();
    expect(validateKeyframe(KF(0, 12, 'rain', 0.5))).toBeNull();
  });

  it('defaultNewKeyframe lấy giữa khoảng trống lớn nhất, thừa hưởng mốc trước', () => {
    const fresh = defaultNewKeyframe([KF(0, 6), KF(10, 12)], 30);
    // Khoảng trống lớn nhất là 10→30, giữa = 20.
    expect(fresh.t_s).toBeCloseTo(20, 6);
    expect(fresh.hour).toBe(12);
    expect(fresh.weather).toBe('sun');
  });

  it('defaultNewKeyframe khi chưa có mốc nào thì trả mốc mặc định hợp lệ', () => {
    const fresh = defaultNewKeyframe([], 20);
    expect(validateKeyframe(fresh)).toBeNull();
    expect(fresh.t_s).toBe(0);
  });
});

describe('ui/env — 9 nút nhiễu + preset', () => {
  it('NOISE_CONTROLS phủ đúng 9 khoá của contract', () => {
    expect(NOISE_CONTROLS).toHaveLength(9);
    expect(noiseControlsCoverContract()).toBe(true);
    expect(NOISE_CONTROLS.map((control) => control.kind).sort()).toEqual([...NOISE_KINDS].sort());
  });

  it('mỗi nút có nhãn tiếng Việt + mô tả mức', () => {
    for (const control of NOISE_CONTROLS) {
      expect(control.label.length).toBeGreaterThan(0);
      expect(control.scale.length).toBeGreaterThan(0);
    }
  });

  it('PRESET_OPTIONS đủ E1–E8, đúng thứ tự', () => {
    expect(PRESET_OPTIONS).toHaveLength(8);
    expect(PRESET_OPTIONS.map((preset) => preset.id)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
      'E6',
      'E7',
      'E8',
    ]);
    for (const preset of PRESET_OPTIONS) {
      expect(preset.name.length).toBeGreaterThan(0);
    }
  });

  it('presetById trả preset thật, mã lạ thì ném lỗi (R2)', () => {
    expect(presetById('E4').name).toBe('Mưa chiều');
    expect(() => presetById('E9')).toThrow(/E1–E8/);
  });

  it('toggleNoise giữ mức cũ khi bật lại', () => {
    const current = { on: false, level: 0.7 };
    expect(toggleNoise(current, true)).toEqual({ on: true, level: 0.7 });
    expect(toggleNoise(current, false)).toEqual({ on: false, level: 0.7 });
  });

  it('setNoiseLevel kẹp 0–1 và giữ trạng thái bật', () => {
    const current = { on: true, level: 0.5 };
    expect(setNoiseLevel(current, 2)).toEqual({ on: true, level: 1 });
    expect(setNoiseLevel(current, -1)).toEqual({ on: true, level: 0 });
    expect(setNoiseLevel(current, 0.25)).toEqual({ on: true, level: 0.25 });
  });

  it('config nhiễu mặc định của kịch bản có đủ 9 khoá tắt', () => {
    const noise = createNoiseConfig(8811);
    for (const kind of NOISE_KINDS) {
      expect(noise[kind].on).toBe(false);
      expect(noise[kind].level).toBeGreaterThanOrEqual(0);
    }
    expect(noise.seed).toBe(8811);
  });
});
