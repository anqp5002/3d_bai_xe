/** Panel trái — map & xe (FE §2): seed, số xe đỗ, tỉ lệ D4, tốc độ, mẫu/màu cho xe mới. */

import { CAR_COLORS, CAR_COLOR_HEX, CAR_MODELS } from '../contracts/sim';
import type { CarColor, CarModel } from '../contracts/sim';
import { useSimStore } from '../store/simStore';

const MAX_SEED = 0xffffffff;

function asInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function asFloat(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function MapPanel() {
  const lot = useSimStore((store) => store.lot);
  const mapSettings = useSimStore((store) => store.mapSettings);
  const setMapSettings = useSimStore((store) => store.setMapSettings);
  const spawnModel = useSimStore((store) => store.spawnModel);
  const spawnColor = useSimStore((store) => store.spawnColor);
  const setSpawnModel = useSimStore((store) => store.setSpawnModel);
  const setSpawnColor = useSimStore((store) => store.setSpawnColor);
  const generateMap = useSimStore((store) => store.generateMap);
  const loading = useSimStore((store) => store.loading);
  const notice = useSimStore((store) => store.notice);

  const reachable = lot === null ? 0 : lot.slots.filter((slot) => slot.reachable).length;
  const narrow = lot === null ? 0 : lot.slots.filter((slot) => slot.width_m < 2.1).length;

  return (
    <section className="panel-section">
      <h2>Map &amp; xe</h2>

      <label className="field">
        <span>Seed</span>
        <input
          type="number"
          min={0}
          max={MAX_SEED}
          step={1}
          value={mapSettings.seed}
          onChange={(event) =>
            setMapSettings({
              seed: clamp(asInt(event.target.value, mapSettings.seed), 0, MAX_SEED),
            })
          }
        />
      </label>

      <label className="field">
        <span>
          Xe đỗ sẵn <b>{mapSettings.nParked}</b>
          <small> / {reachable} ô dùng được</small>
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(1, reachable)}
          step={1}
          value={Math.min(mapSettings.nParked, Math.max(1, reachable))}
          onChange={(event) =>
            setMapSettings({
              nParked: clamp(asInt(event.target.value, 0), 0, reachable),
            })
          }
        />
        <input
          type="number"
          min={0}
          max={reachable}
          step={1}
          value={mapSettings.nParked}
          onChange={(event) =>
            setMapSettings({
              nParked: clamp(asInt(event.target.value, 0), 0, Math.max(0, reachable)),
            })
          }
        />
      </label>

      <label className="field">
        <span>
          Tỉ lệ xe (C5) <b>{mapSettings.carScale.toFixed(2)}</b>
        </span>
        <input
          type="range"
          min={1}
          max={1.3}
          step={0.01}
          value={mapSettings.carScale}
          onChange={(event) =>
            setMapSettings({
              carScale: clamp(asFloat(event.target.value, 1.1), 1, 1.3),
            })
          }
        />
        <p className="hint">
          D4: hệ số thực = min(chọn, (w_ô − 0,35 m) / w_xe).{' '}
          {narrow > 0
            ? `${String(narrow)} ô hẹp < 2,1 m chỉ nhận hatchback.`
            : 'Hiện chưa có ô hẹp < 2,1 m.'}
        </p>
      </label>

      <label className="field">
        <span>
          Tốc độ mặc định <b>{mapSettings.defaultSpeedKmh} km/h</b>
        </span>
        <input
          type="range"
          min={5}
          max={20}
          step={1}
          value={mapSettings.defaultSpeedKmh}
          onChange={(event) =>
            setMapSettings({
              defaultSpeedKmh: clamp(asInt(event.target.value, 10), 5, 20),
            })
          }
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Mẫu xe mới</span>
          <select
            value={spawnModel}
            onChange={(event) => setSpawnModel(event.target.value as CarModel)}
          >
            {CAR_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Màu xe mới</span>
          <select
            value={spawnColor}
            onChange={(event) => setSpawnColor(event.target.value as CarColor)}
          >
            {CAR_COLORS.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
        </label>
        <span
          className="color-dot"
          style={{ background: CAR_COLOR_HEX[spawnColor] }}
          title={spawnColor}
        />
      </div>

      <button
        type="button"
        className="btn btn-primary full"
        onClick={generateMap}
        disabled={lot === null || loading}
      >
        Tạo map
      </button>

      {notice !== null && notice.startsWith('D4:') && (
        <p className="warn-note">{notice}</p>
      )}
    </section>
  );
}
