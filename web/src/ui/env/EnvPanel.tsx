/**
 * Panel môi trường (FE §2, P9c mục 1): thanh giờ kiểu web thời tiết, sửa mốc, preset E1-E8,
 * 9 nút nhiễu (bật/tắt + mức + seed).
 *
 * **Đọc** dữ liệu thật từ `store.scenario.env` / `store.scenario.noise`. Khi bấm đổi, panel
 * gọi action của store **nếu có**; store hiện chưa có (xem `.orca/sim3d/ASK_coders-1_1.md`)
 * nên panel hiện đúng lý do chứ **không** giả vờ đã đổi — R2: không im lặng.
 */

import { useState } from 'react';
import type { EnvKeyframe, NoiseKind, Weather } from '../../contracts/env';
import { WEATHERS } from '../../contracts/env';
import { useSimStore } from '../../store/simStore';
import {
  NOISE_CONTROLS,
  PRESET_OPTIONS,
  applyKeyframeEdit,
  clockLabel,
  defaultNewKeyframe,
  keyframeMarkers,
  setNoiseLevel,
  sunSummary,
  timelineSummary,
  toggleNoise,
  weatherIcon,
  weatherLabel,
} from './envPanelModel';

/**
 * Các action môi trường mà store có (P7c của coders-3 đã thêm).
 *
 * Khai báo kiểu ở đây để panel không phải `any`, và để nếu store đổi tên thì TypeScript
 * báo ngay. Chữ ký khớp `store/simStore.ts`: `setEnvKeyframe(index, keyframe|null)`.
 */
interface EnvActions {
  readonly setEnvPreset?: (presetId: string) => void;
  readonly setEnvKeyframe?: (index: number, keyframe: EnvKeyframe | null) => void;
  /** P7c: action bulk để commit cả danh sách mốc sau khi sửa/thêm/xoá. */
  readonly setEnvKeyframes?: (keyframes: readonly EnvKeyframe[]) => void;
  readonly setNoiseToggle?: (kind: NoiseKind, toggle: { on: boolean; level: number }) => void;
  readonly setNoiseSeed?: (seed: number) => void;
}

/** Lấy action môi trường từ store (nếu có), không ném lỗi khi thiếu. */
function envActions(store: unknown): EnvActions {
  const candidate = store as Partial<EnvActions>;
  return {
    setEnvPreset: candidate.setEnvPreset,
    setEnvKeyframe: candidate.setEnvKeyframe,
    setEnvKeyframes: candidate.setEnvKeyframes,
    setNoiseToggle: candidate.setNoiseToggle,
    setNoiseSeed: candidate.setNoiseSeed,
  };
}

const WEATHER_LABEL_VI: Readonly<Record<Weather, string>> = {
  sun: 'Nắng',
  cloud: 'Mây',
  rain: 'Mưa',
  fog: 'Sương',
};

/** Tên action còn thiếu, để hiện đúng cho người dùng (không im lặng). */
const ASK_FILE = '.orca/sim3d/ASK_coders-1_1.md';

export function EnvPanel() {
  const scenario = useSimStore((store) => store.scenario);
  const actions = envActions(useSimStore((store) => store));
  const setError = useSimStore((store) => store.setError);
  const setNotice = useSimStore((store) => store.setNotice);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pending, setPending] = useState<string | null>(null);

  const keyframes = scenario?.env.keyframes ?? [];
  const noise = scenario?.noise ?? null;
  const durationSeconds = scenario === null ? 0 : Math.round(scenario.duration_frames / 25);
  const markers = keyframeMarkers(keyframes, durationSeconds);
  const selected = keyframes[selectedIndex] ?? keyframes[0] ?? null;
  const missingActions = [
    actions.setEnvPreset === undefined ? 'setEnvPreset' : null,
    actions.setEnvKeyframe === undefined ? 'setEnvKeyframe' : null,
    actions.setNoiseToggle === undefined ? 'setNoiseToggle' : null,
    actions.setNoiseSeed === undefined ? 'setNoiseSeed' : null,
  ].filter((name): name is string => name !== null);

  /** Thông báo trung thực: chưa nối được thì nói rõ tên action còn thiếu. */
  const blocked = (what: string): void => {
    setPending(`${what}: store chưa có action (xem ${ASK_FILE})`);
    setError(`${what}: store chưa có action — xem ${ASK_FILE}`);
  };

  const onPreset = (presetId: string): void => {
    if (actions.setEnvPreset === undefined) {
      blocked(`Đổi kịch bản ${presetId}`);
      return;
    }
    setPending(null);
    try {
      actions.setEnvPreset(presetId);
      setNotice(`Đổi môi trường sang ${presetId}.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * Gọi một phép sửa mốc. Store tự validate + sắp + khử trùng (P7c), nên chỉ cần chuyển
   * đúng `(index, keyframe|null)`. Panel vẫn kiểm trước bằng `applyKeyframeEdit` để báo lỗi
   * ngay trên UI thay vì để store ghi vào `error`.
   */
  const commitKeyframe = (
    index: number,
    keyframe: EnvKeyframe | null,
    message: string,
  ): boolean => {
    const check = applyKeyframeEdit(keyframes, index, keyframe);
    if (!check.ok) {
      setError(check.reason);
      return false;
    }
    if (actions.setEnvKeyframe === undefined) {
      blocked(message);
      return false;
    }
    setPending(null);
    try {
      actions.setEnvKeyframe(index, keyframe);
      setNotice(message);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const patchSelected = (patch: Partial<EnvKeyframe>): void => {
    if (selected === null) {
      return;
    }
    const next = { ...selected, ...patch };
    commitKeyframe(selectedIndex, next, `Sửa mốc ${clockLabel(next.hour)}.`);
  };

  const addKeyframe = (): void => {
    const fresh = defaultNewKeyframe(keyframes, durationSeconds);
    if (commitKeyframe(-1, fresh, `Thêm mốc ${clockLabel(fresh.hour)}.`)) {
      setSelectedIndex(keyframes.length);
    }
  };

  const removeKeyframe = (): void => {
    if (commitKeyframe(selectedIndex, null, 'Xoá mốc.')) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    }
  };

  const onNoiseToggle = (kind: NoiseKind, on: boolean): void => {
    if (noise === null) {
      return;
    }
    if (actions.setNoiseToggle === undefined) {
      blocked(`Bật/tắt nhiễu ${kind}`);
      return;
    }
    setPending(null);
    try {
      actions.setNoiseToggle(kind, toggleNoise(noise[kind], on));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onNoiseLevel = (kind: NoiseKind, level: number): void => {
    if (noise === null) {
      return;
    }
    if (actions.setNoiseToggle === undefined) {
      blocked(`Đổi mức nhiễu ${kind}`);
      return;
    }
    setPending(null);
    try {
      actions.setNoiseToggle(kind, setNoiseLevel(noise[kind], level));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onNoiseSeed = (seed: number): void => {
    if (!Number.isInteger(seed) || seed < 0) {
      setError(`Seed nhiễu phải là số nguyên >= 0, nhận ${String(seed)}`);
      return;
    }
    if (actions.setNoiseSeed === undefined) {
      blocked('Đổi seed nhiễu');
      return;
    }
    setPending(null);
    try {
      actions.setNoiseSeed(seed);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  if (scenario === null) {
    return (
      <section className="panel-section env-panel">
        <h2>Môi trường</h2>
        <p className="hint">Chưa có kịch bản — bấm “Tạo map” trước.</p>
      </section>
    );
  }

  return (
    <section className="panel-section env-panel">
      <h2>Môi trường</h2>

      {/* Thanh giờ kiểu web thời tiết (FE §2) */}
      <div className="env-timeline" role="group" aria-label="Thanh giờ môi trường">
        <div className="env-timeline-bar">
          {markers.map((marker) => (
            <button
              key={`${String(marker.index)}-${String(marker.keyframe.t_s)}`}
              type="button"
              className={`env-marker ${marker.index === selectedIndex ? 'active' : ''}`}
              style={{ left: `${String(marker.percent)}%` }}
              title={`${marker.clock} · ${marker.label} · cường độ ${marker.keyframe.intensity.toFixed(2)}`}
              onClick={() => {
                setSelectedIndex(marker.index);
              }}
            >
              <span aria-hidden="true">{marker.icon}</span>
            </button>
          ))}
          <div className="env-timeline-ticks" aria-hidden="true">
            {[0, 6, 12, 18, 24].map((hour) => (
              <span key={hour} style={{ left: `${String((hour / 24) * 100)}%` }}>
                {String(hour).padStart(2, '0')}
              </span>
            ))}
          </div>
        </div>
        <p className="kv">
          <span>Tổng quan</span>
          <b>{timelineSummary(keyframes)}</b>
        </p>
      </div>

      {/* Chọn preset E1-E8 */}
      <div className="field-row">
        <label className="field">
          <span>Kịch bản dựng sẵn</span>
          <select
            value={scenario.env.preset ?? ''}
            onChange={(event) => {
              onPreset(event.target.value);
            }}
          >
            <option value="">— tự đặt mốc —</option>
            {PRESET_OPTIONS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.id} · {preset.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Sửa mốc đang chọn */}
      {selected !== null && (
        <div className="env-editor">
          <h3>
            Mốc {selectedIndex + 1}/{keyframes.length} · {sunSummary(selected).icon}{' '}
            {clockLabel(selected.hour)}
          </h3>
          <div className="field-row">
            <label className="field">
              <span>Giờ</span>
              <input
                type="range"
                min={0}
                max={24}
                step={0.25}
                value={selected.hour}
                onChange={(event) => {
                  patchSelected({ hour: Number(event.target.value) });
                }}
              />
              <small>{clockLabel(selected.hour)}</small>
            </label>
            <label className="field">
              <span>Thời tiết</span>
              <select
                value={selected.weather}
                onChange={(event) => {
                  patchSelected({ weather: event.target.value as Weather });
                }}
              >
                {WEATHERS.map((weather) => (
                  <option key={weather} value={weather}>
                    {weatherIcon(weather, selected.hour)} {WEATHER_LABEL_VI[weather]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Cường độ {weatherLabel(selected.weather, selected.hour)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={selected.intensity}
              onChange={(event) => {
                patchSelected({ intensity: Number(event.target.value) });
              }}
            />
            <small>{selected.intensity.toFixed(2)}</small>
          </label>
          <div className="field-row compact">
            <label className="field">
              <span>Ướt mặt đường</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={selected.wet ?? 0}
                onChange={(event) => {
                  patchSelected({ wet: Number(event.target.value) });
                }}
              />
            </label>
            <label className="field">
              <span>Sương</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={selected.fog ?? 0}
                onChange={(event) => {
                  patchSelected({ fog: Number(event.target.value) });
                }}
              />
            </label>
          </div>
          <p className="kv">
            <span>Mặt trời</span>
            <b>
              {sunSummary(selected).elevationDeg.toFixed(1)}°
              {sunSummary(selected).lampsOn ? ' · đèn bật' : ''}
            </b>
          </p>
          <div className="button-row">
            <button type="button" className="btn btn-small" onClick={addKeyframe}>
              Thêm mốc
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={removeKeyframe}
              disabled={keyframes.length <= 1}
            >
              Xoá mốc
            </button>
          </div>
        </div>
      )}

      {/* 9 nút nhiễu (ý tưởng §10) */}
      <h3>Nhiễu camera</h3>
      <div className="noise-list">
        {NOISE_CONTROLS.map((control) => {
          const toggle = noise === null ? null : noise[control.kind];
          return (
            <div className="noise-row" key={control.kind}>
              <label className="noise-toggle">
                <input
                  type="checkbox"
                  checked={toggle?.on ?? false}
                  onChange={(event) => {
                    onNoiseToggle(control.kind, event.target.checked);
                  }}
                />
                <span>{control.label}</span>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={toggle?.level ?? 0.5}
                aria-label={`Mức ${control.label}`}
                title={control.scale}
                onChange={(event) => {
                  onNoiseLevel(control.kind, Number(event.target.value));
                }}
              />
              <small>{(toggle?.level ?? 0.5).toFixed(2)}</small>
            </div>
          );
        })}
      </div>
      <label className="field">
        <span>Seed nhiễu</span>
        <input
          type="number"
          min={0}
          step={1}
          value={noise?.seed ?? 0}
          onChange={(event) => {
            onNoiseSeed(Number.parseInt(event.target.value, 10));
          }}
        />
      </label>

      {pending !== null && <p className="warn-note">{pending}</p>}
      {missingActions.length > 0 && (
        <p className="hint">
          Store còn thiếu {missingActions.join(', ')} — xem <code>{ASK_FILE}</code>. Panel đọc
          đúng dữ liệu kịch bản; nút bấm báo lỗi thay vì đổi im lặng.
        </p>
      )}
    </section>
  );
}
