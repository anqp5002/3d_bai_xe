/**
 * P7c — P8 trong xuất: nhiễu tất định theo frame và env/noise **không** đổi GT.
 *
 * Test Node, không cần WebGL: `applyNoise` là hàm thuần pixel; GT chỉ đọc `SimState`.
 * Phần render WebGL (ánh sáng/mưa/đèn) được kiểm bằng e2e `tools/export_k8.mjs` +
 * OpenCV/hash trong REPORT_P7c.
 */

import { describe, expect, it } from 'vitest';
import type { Scenario } from '../contracts/scenario';
import type { NoiseConfig } from '../contracts/env';
import { createNoiseConfig } from '../contracts/env';
import { applyNoise, hashFrame, type RgbaFrame } from '../render/noise/cameraNoise';
import { envPreset } from '../render/env/presets';
import { collectCarIds, gtEvents, gtEventsCsv, gtFramesCsv, gtRow } from '../sim/gtCompute';
import { DEFAULT_MAP_SETTINGS, advanceSim, buildScenario, startSim } from '../store/scenarioModel';
import { makeTestLot } from '../store/testLot';

function sampleFrame(width = 64, height = 64): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 4) % 256;
      data[offset + 1] = (y * 4) % 256;
      data[offset + 2] = ((x + y) * 2) % 256;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

function grainConfig(seed: number): NoiseConfig {
  return {
    ...createNoiseConfig(seed),
    grain: { on: true, level: 0.7 },
    seed,
  };
}

describe('P7c — nhiễu P8 tất định theo seed + frame', () => {
  it('cùng config + cùng frame ⇒ cùng hash pixel', () => {
    const config = grainConfig(123);
    const first = applyNoise(sampleFrame(), config, { frame: 7, raining: false });
    const second = applyNoise(sampleFrame(), config, { frame: 7, raining: false });
    expect(hashFrame(first.frame)).toBe(hashFrame(second.frame));
  });

  it('frame khác ⇒ seed khác ⇒ hash khác (seed theo frame)', () => {
    const config = grainConfig(123);
    const frame7 = applyNoise(sampleFrame(), config, { frame: 7, raining: false });
    const frame8 = applyNoise(sampleFrame(), config, { frame: 8, raining: false });
    expect(hashFrame(frame8.frame)).not.toBe(hashFrame(frame7.frame));
  });
});

describe('P7c — env/noise không đổi GT', () => {
  it('cùng sim, env E8 + grain bật ⇒ GT frames/events giống hệt', () => {
    const lot = makeTestLot();
    const base = buildScenario(lot, {
      ...DEFAULT_MAP_SETTINGS,
      seed: 5,
      nParked: 1,
    }).scenario;
    const styled: Scenario = {
      ...base,
      env: { preset: 'E8', keyframes: envPreset('E8').keyframes },
      noise: grainConfig(999),
    };

    const run = (scenario: Scenario) => {
      const initial = startSim(lot, scenario);
      const result = advanceSim(
        lot,
        initial,
        [],
        5,
        scenario.duration_frames,
      );
      const history = [initial, ...result.history];
      const rows = history.map((state) => gtRow(lot, state, scenario.camera_mode));
      const carIds = collectCarIds(history);
      return {
        frames: gtFramesCsv(rows, carIds),
        events: gtEventsCsv([...gtEvents(lot, history)]),
      };
    };

    expect(run(styled)).toEqual(run(base));
  });
});
