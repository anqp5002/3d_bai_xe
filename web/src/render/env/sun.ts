/**
 * Mô hình mặt trời theo giờ (FE §6: "mọc 6h, lặn 18h, đỉnh 75°").
 *
 * Thuần số học, không three — test bằng Node được và dùng chung cho render lẫn export.
 *
 * Quy ước trục world của sim: `X` sang phải ảnh, `Y` ra xa camera (bắc).
 * Ba toạ độ trả về là hướng **từ gốc bãi tới mặt trời** tính bằng mét (dùng làm
 * `DirectionalLight.position` sau khi đổi sang hệ three).
 */

/** Độ cao mặt trời tối đa (độ), FE §6. */
export const SUN_MAX_ELEVATION_DEG = 75;
/** Giờ mặt trời mọc. */
export const SUNRISE_HOUR = 6;
/** Giờ mặt trời lặn. */
export const SUNSET_HOUR = 18;
/** Giờ bật đèn bãi + đèn xe (E5: 18h15). */
export const LIGHTS_ON_HOUR = 18.25;
/** Khoảng cách đặt `DirectionalLight` (m) — chỉ cần lớn hơn bãi. */
export const SUN_DISTANCE_M = 120;

/** Kết quả mô hình mặt trời tại một giờ. */
export interface SunState {
  /** Độ cao so với chân trời, độ (âm = dưới chân trời). */
  readonly elevationDeg: number;
  /** Phương vị, độ: 0 = đông, 90 = bắc, 180 = tây (đi từ đông sang tây). */
  readonly azimuthDeg: number;
  /** Đã lặn chưa (độ cao ≤ 0). */
  readonly belowHorizon: boolean;
  /** Cường độ tương đối 0..1 (0 khi đã lặn hẳn). */
  readonly intensity: number;
  /** Màu nắng dạng hex (vàng ấm khi thấp, trắng khi cao). */
  readonly colorHex: string;
  /** Vị trí đèn theo world (m) — `[x, y, height]`. */
  readonly position: readonly [x: number, y: number, height: number];
  /** Bật đèn bãi/đèn xe chưa (FE §6: giờ ≥ 18h15 hoặc mưa to). */
  readonly lampsOn: boolean;
}

/** Chuẩn hoá giờ về `[0, 24)`. */
export function wrapHour(hour: number): number {
  if (!Number.isFinite(hour)) {
    throw new Error(`wrapHour: giờ phải là số hữu hạn, nhận ${String(hour)}`);
  }
  return ((hour % 24) + 24) % 24;
}

/**
 * Độ cao mặt trời (độ) tại một giờ.
 *
 * Ban ngày (6h–18h): `75·sin(π·(h−6)/12)` — 0° lúc mọc/lặn, 75° lúc 12h.
 * Ban đêm: âm, giảm dần tới −75° lúc nửa đêm (đối xứng qua 0h).
 */
export function sunElevationDeg(hour: number): number {
  const h = wrapHour(hour);
  if (h >= SUNRISE_HOUR && h <= SUNSET_HOUR) {
    return SUN_MAX_ELEVATION_DEG * Math.sin((Math.PI * (h - SUNRISE_HOUR)) / 12);
  }
  // Ban đêm: nửa chu kỳ còn lại, lấy gương qua 0h.
  const nightHour = h > SUNSET_HOUR ? h - SUNSET_HOUR : h + 24 - SUNSET_HOUR;
  return -SUN_MAX_ELEVATION_DEG * Math.sin((Math.PI * nightHour) / 12);
}

/** Phương vị mặt trời (độ): 6h = 0° (đông), 12h = 90° (bắc), 18h = 180° (tây). */
export function sunAzimuthDeg(hour: number): number {
  const h = wrapHour(hour);
  if (h >= SUNRISE_HOUR && h <= SUNSET_HOUR) {
    return (180 * (h - SUNRISE_HOUR)) / 12;
  }
  // Ban đêm: tiếp tục vòng qua bắc (180°→360°).
  const nightHour = h > SUNSET_HOUR ? h - SUNSET_HOUR : h + 24 - SUNSET_HOUR;
  return 180 + (180 * nightHour) / 12;
}

/**
 * Màu nắng theo độ cao (FE §6 "màu và cường độ theo góc").
 *
 * Thấp (0–15°): vàng cam ấm; 15–40°: vàng nhạt; trên 40°: trắng hơi ấm.
 * Nội suy tuyến tính trong không gian RGB để mượt.
 */
export function sunColorHex(elevationDeg: number): string {
  const stops: readonly (readonly [number, readonly [number, number, number]])[] = [
    [0, [255, 168, 96]],
    [15, [255, 210, 150]],
    [40, [255, 241, 214]],
    [75, [255, 250, 240]],
  ];
  const clamped = Math.max(0, Math.min(75, elevationDeg));
  for (let index = 1; index < stops.length; index += 1) {
    const [highDeg, highColor] = stops[index];
    if (clamped <= highDeg) {
      const [lowDeg, lowColor] = stops[index - 1];
      const span = highDeg - lowDeg;
      const k = span === 0 ? 0 : (clamped - lowDeg) / span;
      const rgb = lowColor.map((channel, channelIndex) =>
        Math.round(channel + (highColor[channelIndex] - channel) * k),
      );
      return `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  const last = stops[stops.length - 1][1];
  return `#${last.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Toàn bộ trạng thái mặt trời tại một giờ.
 *
 * @param hour giờ trong ngày (0–24)
 * @param rainIntensity cường độ mưa 0..1 — mưa to cũng bật đèn (FE §6)
 */
export function sunState(hour: number, rainIntensity = 0): SunState {
  const elevationDeg = sunElevationDeg(hour);
  const azimuthDeg = sunAzimuthDeg(hour);
  // Chỉ coi là "dưới chân trời" khi độ cao **âm** (0° là lúc mọc/lặn, vẫn còn sáng).
  const belowHorizon = elevationDeg < 0;
  // Cường độ: 0 dưới chân trời, tăng dần tới 1 khi cao (kẹp 0..1).
  const intensity = belowHorizon ? 0 : Math.min(1, Math.max(0, elevationDeg / 40));
  const azimuthRad = (azimuthDeg * Math.PI) / 180;
  const elevationRad = (elevationDeg * Math.PI) / 180;
  const horizontal = Math.cos(elevationRad) * SUN_DISTANCE_M;
  return {
    elevationDeg,
    azimuthDeg,
    belowHorizon,
    intensity,
    colorHex: sunColorHex(elevationDeg),
    // 0° = đông (+X), 90° = bắc (+Y): xoay quanh trục cao theo phương vị.
    position: [
      Math.cos(azimuthRad) * horizontal,
      Math.sin(azimuthRad) * horizontal,
      Math.sin(elevationRad) * SUN_DISTANCE_M,
    ],
    // FE §6: bật khi giờ >= 18h15 hoặc mưa to. Thêm "trước 6h" vì trời còn tối
    // (E7 sương sớm 5h30 mà tắt đèn thì vô lý); ghi rõ trong REPORT.
    lampsOn: wrapHour(hour) >= LIGHTS_ON_HOUR || wrapHour(hour) < SUNRISE_HOUR || rainIntensity >= 0.6,
  };
}

/** Độ "tối" của trời 0..1 (1 = đêm đen) — dùng cho sky gradient + ambient. */
export function darknessAt(hour: number): number {
  const elevation = sunElevationDeg(hour);
  if (elevation >= 10) {
    return 0;
  }
  if (elevation <= -12) {
    return 1;
  }
  // Nội suy từ 10° xuống −12°.
  return (10 - elevation) / 22;
}
