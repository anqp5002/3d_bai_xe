/**
 * Test áp môi trường lên cảnh Three.js (P8 mục 1–2).
 *
 * Dùng `Scene`/`Mesh`/`Light` **thật** của three — không cần WebGL để dựng và đọc
 * thuộc tính, nên kiểm được cường độ đèn, màu trời, sương, mưa, đèn bãi.
 */

import { describe, expect, it } from 'vitest';
import { DataTexture, FogExp2, Mesh, Scene } from 'three';
import type { MeshStandardMaterial } from 'three';
import {
  CLOUD_COUNT,
  RAIN_COUNT,
  applyEnv,
  applyEnvAtTime,
  cloudCoverFor,
  collectLampsFromScene,
  createEnvLayers,
  createLampCone,
  createLampGlow,
  fogDensityFor,
  rainIntensityFor,
  skyColorsFor,
  wetnessFor,
} from './applyEnv';
import { envPreset } from './presets';
import { interpolateEnv, type EnvKeyframe } from '../../contracts/env';
import { buildScene } from '../scene';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LotMap } from '../../contracts/lot';

const LOT: LotMap = JSON.parse(
  readFileSync(resolve(process.cwd(), '..', 'data', 'lot', 'lot_pucpr.json'), 'utf8'),
) as LotMap;

/** Cảnh + đèn + lớp môi trường để test (không cần canvas/WebGL). */
function makeFixture() {
  const built = buildScene(LOT, { shadows: true });
  const layers = createEnvLayers(built.scene, 7);
  return { scene: built.scene, lights: built.lights, layers };
}

/** Mốc môi trường đơn giản. */
function envAt(partial: Partial<EnvKeyframe>): EnvKeyframe {
  return {
    t_s: 0,
    hour: 12,
    weather: 'sun',
    intensity: 0.8,
    wet: 0,
    fog: 0,
    ...partial,
  };
}

describe('render/env/applyEnv — dựng lớp môi trường', () => {
  it('tạo đủ lớp: trời, mây, mưa, đường ướt', () => {
    const { layers } = makeFixture();
    expect(layers.sky.name).toBe('env-sky');
    expect(layers.clouds.children.length).toBe(CLOUD_COUNT);
    expect(layers.rain.name).toBe('env-rain');
    expect(layers.wetSheen.name).toBe('env-wet');
    // Mặc định ẩn hết (P4a chưa bật môi trường).
    expect(layers.clouds.visible).toBe(false);
    expect(layers.rain.visible).toBe(false);
    expect(layers.wetSheen.visible).toBe(false);
  });

  it('mưa có đúng số vệt và mọi điểm nằm trên mặt đất', () => {
    const { layers } = makeFixture();
    const position = layers.rain.geometry.getAttribute('position');
    // Mỗi vệt = 2 đỉnh (LineSegments).
    expect(position.count).toBe(RAIN_COUNT * 2);
    for (let index = 0; index < position.count; index += 1) {
      expect(position.getY(index)).toBeGreaterThanOrEqual(-1);
    }
  });

  it('cùng seed ⇒ mây và mưa giống hệt (tất định)', () => {
    const a = createEnvLayers(new Scene(), 42);
    const b = createEnvLayers(new Scene(), 42);
    const posA = a.rain.geometry.getAttribute('position');
    const posB = b.rain.geometry.getAttribute('position');
    expect(posA.count).toBe(posB.count);
    for (let index = 0; index < posA.count; index += 97) {
      expect(posA.getX(index)).toBe(posB.getX(index));
      expect(posA.getY(index)).toBe(posB.getY(index));
    }
    expect(a.clouds.children[0].position.x).toBe(b.clouds.children[0].position.x);
  });
});

describe('render/env/applyEnv — trưa nắng (E1)', () => {
  it('nắng mạnh, không mây, không mưa, không sương, đèn tắt', () => {
    const fixture = makeFixture();
    const result = applyEnv({ ...fixture, env: envAt({ hour: 12, intensity: 1 }) });
    expect(result.sun.belowHorizon).toBe(false);
    expect(result.darkness).toBe(0);
    expect(result.lampsOn).toBe(false);
    expect(result.rainIntensity).toBe(0);
    expect(result.cloudCover).toBeLessThan(0.25);
    expect(result.fogDensity).toBe(0);
    // Đèn nắng bật, sương tắt.
    expect(fixture.lights.sun.intensity).toBeGreaterThan(1);
    expect(fixture.scene.fog).toBeNull();
    expect(fixture.layers.rain.visible).toBe(false);
    expect(fixture.layers.clouds.visible).toBe(false);
  });

  it('vị trí đèn nắng khớp world (12h: cao nhất, hướng bắc)', () => {
    const fixture = makeFixture();
    const result = applyEnv({ ...fixture, env: envAt({ hour: 12 }) });
    // 12h: phương vị 90° (bắc) ⇒ x ≈ 0, z (three) ≈ -y_world < 0.
    expect(Math.abs(fixture.lights.sun.position.x)).toBeLessThan(1);
    expect(fixture.lights.sun.position.z).toBeLessThan(0);
    expect(fixture.lights.sun.position.y).toBeGreaterThan(100);
    expect(result.sun.azimuthDeg).toBeCloseTo(90, 6);
  });
});

describe('render/env/applyEnv — đêm (E6) và đèn', () => {
  it('đêm: nắng tắt, ambient tăng bù, trời tối, đèn bãi bật', () => {
    const fixture = makeFixture();
    const result = applyEnv({ ...fixture, env: envAt({ hour: 22, intensity: 0.05 }) });
    expect(result.sun.belowHorizon).toBe(true);
    expect(result.darkness).toBe(1);
    expect(result.lampsOn).toBe(true);
    expect(fixture.lights.sun.intensity).toBe(0);
    expect(fixture.lights.sun.castShadow).toBe(false);
    // Trời tối: gradient nền đổi sang màu đêm (so sánh mẫu đầu tiên của texture).
    const texture = fixture.scene.background;
    expect(texture).toBeInstanceOf(DataTexture);
    const data = (texture as DataTexture).image.data as Uint8Array;
    const topLuminance = data[0] + data[1] + data[2];
    expect(topLuminance).toBeLessThan(120);
  });

  it('đèn mesh material `lamp` được bật emissive khi trời tối', () => {
    const fixture = makeFixture();
    const count = collectLampsFromScene(fixture.layers, fixture.scene);
    expect(count).toBeGreaterThan(0);

    applyEnv({ ...fixture, env: envAt({ hour: 22 }) });
    for (const head of fixture.layers.lampLights) {
      const material = head.material as MeshStandardMaterial;
      expect(material.emissiveIntensity).toBeGreaterThan(1);
    }

    // Ban ngày thì tắt.
    applyEnv({ ...fixture, env: envAt({ hour: 12 }) });
    for (const head of fixture.layers.lampLights) {
      const material = head.material as MeshStandardMaterial;
      expect(material.emissiveIntensity).toBe(0);
    }
  });

  it('vầng sáng + chùm sáng đèn tạo được và mặc định ẩn', () => {
    const glow = createLampGlow([10, 0, -20]);
    expect(glow.visible).toBe(false);
    expect(glow.position.x).toBe(10);
    const cone = createLampCone([10, 0, -20]);
    expect(cone.visible).toBe(false);
    expect(cone).toBeInstanceOf(Mesh);
  });
});

describe('render/env/applyEnv — mây, mưa, sương, ướt', () => {
  it('mây dày (E3): hiện mây, giảm nắng', () => {
    const clear = makeFixture();
    const cloudy = makeFixture();
    applyEnv({ ...clear, env: envAt({ hour: 10, weather: 'sun', intensity: 0.9 }) });
    const result = applyEnv({
      ...cloudy,
      env: envAt({ hour: 10, weather: 'cloud', intensity: 0.85 }),
    });
    expect(result.cloudCover).toBeGreaterThan(0.7);
    expect(cloudy.layers.clouds.visible).toBe(true);
    expect(cloudy.lights.sun.intensity).toBeLessThan(clear.lights.sun.intensity);
  });

  it('mưa (E4): hạt mưa hiện, đường ướt hiện, sương tăng', () => {
    const fixture = makeFixture();
    const result = applyEnv({
      ...fixture,
      env: envAt({ hour: 16, weather: 'rain', intensity: 0.7, wet: 0.9, fog: 0.18 }),
    });
    expect(result.rainIntensity).toBeGreaterThan(0.6);
    expect(result.wetness).toBeCloseTo(0.9, 6);
    expect(fixture.layers.rain.visible).toBe(true);
    expect(fixture.layers.rainMaterial.opacity).toBeGreaterThan(0.7);
    expect(fixture.layers.wetSheen.visible).toBe(true);
    expect(result.fogDensity).toBeGreaterThan(0);
    expect(fixture.scene.fog).toBeInstanceOf(FogExp2);
  });

  it('E4 lúc tạnh: không mưa nhưng đường vẫn ướt', () => {
    const fixture = makeFixture();
    const result = applyEnv({
      ...fixture,
      env: envAt({ hour: 17.5, weather: 'cloud', intensity: 0.2, wet: 0.7, fog: 0.05 }),
    });
    expect(result.rainIntensity).toBe(0);
    expect(fixture.layers.rain.visible).toBe(false);
    expect(result.wetness).toBeCloseTo(0.7, 6);
    expect(fixture.layers.wetSheen.visible).toBe(true);
  });

  it('sương dày (E7) ⇒ FogExp2 mật độ cao; sương tan ⇒ tắt fog', () => {
    const thick = makeFixture();
    const dense = applyEnv({
      ...thick,
      env: envAt({ hour: 5.5, weather: 'fog', intensity: 0.9, fog: 0.85 }),
    });
    expect(dense.fogDensity).toBeGreaterThan(0.01);
    expect(thick.scene.fog).toBeInstanceOf(FogExp2);
    expect((thick.scene.fog as FogExp2).density).toBeCloseTo(dense.fogDensity, 9);

    const clear = makeFixture();
    applyEnv({ ...clear, env: envAt({ hour: 8, weather: 'sun', intensity: 0.6, fog: 0.08 }) });
    expect(clear.scene.fog).not.toBeNull();
    // Sương rất nhẹ ⇒ không cần fog.
    const none = makeFixture();
    applyEnv({ ...none, env: envAt({ hour: 12, weather: 'sun', intensity: 1, fog: 0 }) });
    expect(none.scene.fog).toBeNull();
  });

  it('fogDensityFor cộng cả `fog` khai báo lẫn sương theo weather', () => {
    expect(fogDensityFor(envAt({ weather: 'sun', fog: 0 }))).toBe(0);
    expect(fogDensityFor(envAt({ weather: 'fog', intensity: 1 }))).toBeGreaterThan(0.01);
    expect(fogDensityFor(envAt({ weather: 'sun', fog: 0.5 }))).toBeCloseTo(0.008, 6);
  });

  it('rainIntensityFor: 0 khi không mưa, tối thiểu 0,15 khi mưa', () => {
    expect(rainIntensityFor(envAt({ weather: 'cloud' }))).toBe(0);
    expect(rainIntensityFor(envAt({ weather: 'rain', intensity: 0.01 }))).toBeCloseTo(0.15, 6);
    expect(rainIntensityFor(envAt({ weather: 'rain', intensity: 1 }))).toBe(1);
  });

  it('wetnessFor suy ra từ weather khi mốc không khai `wet`', () => {
    expect(wetnessFor(envAt({ weather: 'sun' }))).toBe(0);
    expect(wetnessFor(envAt({ weather: 'rain', intensity: 0.6 }))).toBeCloseTo(0.6, 6);
    // Khai báo `wet` thì dùng đúng số đó.
    expect(wetnessFor(envAt({ weather: 'cloud', wet: 0.4 }))).toBeCloseTo(0.4, 6);
  });

  it('cloudCoverFor: nắng ít mây, mưa nhiều mây nhất', () => {
    const sunny = cloudCoverFor(envAt({ weather: 'sun', intensity: 1 }));
    const cloudy = cloudCoverFor(envAt({ weather: 'cloud', intensity: 0.8 }));
    const rainy = cloudCoverFor(envAt({ weather: 'rain', intensity: 0.8 }));
    expect(sunny).toBeLessThan(cloudy);
    expect(cloudy).toBeLessThanOrEqual(rainy);
    expect(rainy).toBeLessThanOrEqual(1);
  });
});

describe('render/env/applyEnv — 8 kịch bản chạy được', () => {
  it.each(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'])(
    '%s: áp ở mọi mốc không lỗi, đèn/trời nhất quán',
    (id) => {
      const preset = envPreset(id);
      for (const t of [0, preset.duration_s / 2, preset.duration_s]) {
        const fixture = makeFixture();
        const result = applyEnvAtTime(fixture, preset.keyframes, t);
        // Đêm ⇒ đèn bật; ngày nắng ⇒ đèn tắt.
        if (result.sun.belowHorizon) {
          expect(result.lampsOn).toBe(true);
        }
        // Cường độ đèn nắng không âm, không NaN.
        expect(fixture.lights.sun.intensity).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(fixture.lights.sun.intensity)).toBe(true);
        // Mọi giá trị trả ra trong khoảng hợp lệ.
        expect(result.cloudCover).toBeGreaterThanOrEqual(0);
        expect(result.cloudCover).toBeLessThanOrEqual(1);
        expect(result.wetness).toBeGreaterThanOrEqual(0);
        expect(result.wetness).toBeLessThanOrEqual(1);
        expect(result.fogDensity).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it('E4: mưa to giữa kịch bản, tạnh ở cuối', () => {
    const preset = envPreset('E4');
    const mid = makeFixture();
    const midResult = applyEnvAtTime(mid, preset.keyframes, 18);
    expect(midResult.rainIntensity).toBeGreaterThan(0.5);

    const end = makeFixture();
    const endResult = applyEnvAtTime(end, preset.keyframes, 30);
    expect(endResult.rainIntensity).toBe(0);
    expect(endResult.wetness).toBeGreaterThan(0.5);
  });

  it('E5: đèn bật khi qua 18h15 trong kịch bản', () => {
    const preset = envPreset('E5');
    const before = makeFixture();
    expect(applyEnvAtTime(before, preset.keyframes, 0).lampsOn).toBe(false);
    const after = makeFixture();
    expect(applyEnvAtTime(after, preset.keyframes, 30).lampsOn).toBe(true);
  });

  it('E7: sương dày lúc đầu, tan ở cuối', () => {
    const preset = envPreset('E7');
    const start = makeFixture();
    const end = makeFixture();
    const a = applyEnvAtTime(start, preset.keyframes, 0);
    const b = applyEnvAtTime(end, preset.keyframes, 25);
    expect(a.fogDensity).toBeGreaterThan(b.fogDensity);
  });
});

describe('render/env/applyEnv — tiện ích màu trời', () => {
  it('skyColorsFor: đêm tối hơn ngày rõ rệt', () => {
    const day = skyColorsFor(0);
    const night = skyColorsFor(1);
    const luminance = (hex: string): number =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(luminance(night.top)).toBeLessThan(luminance(day.top));
    expect(luminance(night.horizon)).toBeLessThan(luminance(day.horizon));
    expect(day.top).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('applyEnv trả đủ trường để UI/log dùng', () => {
    const fixture = makeFixture();
    const result = applyEnv({ ...fixture, env: envAt({ hour: 12 }) });
    expect(Object.keys(result).sort()).toEqual([
      'cloudCover',
      'darkness',
      'fogDensity',
      'lampsOn',
      'rainIntensity',
      'sun',
      'wetness',
    ]);
    expect(result.sun).toHaveProperty('elevationDeg');
    expect(result.sun).toHaveProperty('colorHex');
  });

  it('applyEnvAtTime khớp interpolateEnv', () => {
    const preset = envPreset('E2');
    const fixture = makeFixture();
    const result = applyEnvAtTime(fixture, preset.keyframes, 20);
    const expected = interpolateEnv(preset.keyframes, 20);
    expect(result.sun.elevationDeg).toBeCloseTo(
      // 12h ⇒ 75°.
      75,
      6,
    );
    expect(expected.hour).toBeCloseTo(12, 6);
  });
});
