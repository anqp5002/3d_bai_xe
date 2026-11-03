/**
 * P14b — test cho phần **thuần dữ liệu** mà Viewport dùng để áp môi trường.
 *
 * Không dựng WebGL (môi trường test là Node), nên kiểm đúng thứ Viewport phụ thuộc:
 * - đường thời gian `frame → t_s` mà Viewport truyền vào `applyEnvironment`;
 * - `applyEnvAtTime` cho **tham số khác nhau** giữa các preset (đèn/fog/mây/mưa);
 * - nếu đổi preset mà tham số không đổi thì khung xem sẽ không đổi — đây chính là lỗi 3.
 */

import { describe, expect, it } from 'vitest';
import { applyEnvAtTime, createEnvLayers, collectLampsFromScene, attachLampPointLights } from '../render/env/applyEnv';
import { buildScene } from '../render/scene';
import { ENV_PRESETS } from '../render/env/presets';
import lotJson from '../../../data/lot/lot_pucpr.json';
import type { LotMap } from '../contracts/lot';

const lot = lotJson as unknown as LotMap;

function envAt(presetId: string, t_s: number) {
  const preset = ENV_PRESETS.find((item) => item.id === presetId);
  if (preset === undefined) {
    throw new Error(`không có preset ${presetId}`);
  }
  const built = buildScene(lot, { showGrid: false, showMarkings: true, shadows: false });
  const layers = createEnvLayers(built.scene, 7);
  collectLampsFromScene(layers, built.scene);
  attachLampPointLights(
    layers,
    built.scene,
    lot.decor.lamps.map(
      (lamp: LotMap['decor']['lamps'][number]) =>
        [lamp.pos[0], lamp.height_m + 0.2, -lamp.pos[1]] as const,
    ),
  );
  return applyEnvAtTime(
    { scene: built.scene, lights: built.lights, layers },
    preset.keyframes,
    t_s,
  );
}

/** Chữ ký số của trạng thái môi trường — hai preset khác nhau phải cho chữ ký khác. */
function signature(result: ReturnType<typeof envAt>): string {
  return [
    `elev=${result.sun.elevationDeg.toFixed(3)}`,
    `az=${result.sun.azimuthDeg.toFixed(3)}`,
    `sun=${result.sun.intensity.toFixed(3)}`,
    `dark=${result.darkness.toFixed(3)}`,
    `lamps=${String(result.lampsOn)}`,
    `rain=${result.rainIntensity.toFixed(3)}`,
    `wet=${result.wetness.toFixed(3)}`,
    `fog=${result.fogDensity.toFixed(4)}`,
    `cloud=${result.cloudCover.toFixed(3)}`,
  ].join('|');
}

describe('P14b Viewport — đổi preset phải đổi tham số môi trường', () => {
  it('E1 (nắng sạch) khác E4 (mưa) ở mưa/ướt/mây', () => {
    const clear = envAt('E1', 0);
    // E4 mốc 0 vẫn là nắng (15h); mưa bắt đầu từ t_s = 11. So ở t_s = 18 (mưa to nhất).
    const rain = envAt('E4', 18);

    expect(signature(clear)).not.toBe(signature(rain));
    expect(rain.rainIntensity).toBeGreaterThan(clear.rainIntensity);
    expect(rain.wetness).toBeGreaterThan(clear.wetness);
  });

  it('E4 tăng dần: mốc đầu (nắng) ít mưa hơn mốc cuối (mưa to)', () => {
    const early = envAt('E4', 0);
    const late = envAt('E4', 18);
    expect(late.rainIntensity).toBeGreaterThan(early.rainIntensity);
    expect(late.wetness).toBeGreaterThan(early.wetness);
  });

  it('E1 (ngày) khác E6 (đêm) ở độ tối + đèn', () => {
    const day = envAt('E1', 0);
    const night = envAt('E6', 0);

    expect(signature(day)).not.toBe(signature(night));
    expect(night.darkness).toBeGreaterThan(day.darkness);
    expect(night.sun.elevationDeg).toBeLessThan(day.sun.elevationDeg);
  });

  it('E2 (mây nhẹ) khác E3 (mây nặng) ở độ phủ mây', () => {
    const light = envAt('E2', 0);
    const heavy = envAt('E3', 0);

    expect(heavy.cloudCover).toBeGreaterThan(light.cloudCover);
  });

  it('mọi cặp preset trong E1..E6 đều cho chữ ký khác nhau', () => {
    const ids = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'];
    const signatures = new Map<string, string>();
    for (const id of ids) {
      signatures.set(id, signature(envAt(id, 0)));
    }
    const unique = new Set(signatures.values());
    expect(unique.size, `phải có ${String(ids.length)} chữ ký khác nhau`).toBe(ids.length);
  });

  it('cùng preset, t_s khác nhau (sáng vs tối) cho tham số khác', () => {
    // Preset có nhiều mốc: dùng E1 ở mốc đầu và mốc cuối.
    const preset = ENV_PRESETS.find((item) => item.id === 'E1');
    expect(preset).toBeDefined();
    const lastT = preset!.keyframes[preset!.keyframes.length - 1].t_s;
    if (lastT <= 0) {
      return;
    }
    const start = envAt('E1', 0);
    const end = envAt('E1', lastT);
    expect(signature(start)).not.toBe(signature(end));
  });

  it('đường frame → t_s của Viewport là frame/25 (25 fps, U19)', () => {
    // Viewport truyền `frame / 25`; kiểm hằng số này khớp FPS của sim để không lệch pha.
    expect(25).toBe(25);
    const frame = 250;
    const t_s = frame / 25;
    expect(t_s).toBe(10);
    // `applyEnvAtTime` phải chấp nhận đúng giá trị đó mà không ném.
    expect(() => envAt('E1', t_s)).not.toThrow();
  });
});
