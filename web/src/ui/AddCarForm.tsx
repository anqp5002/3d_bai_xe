/**
 * Form "Thêm xe" (P14a / BRIEF_P14 lỗi 1+2).
 *
 * Tách khỏi `CarsPanel` vì form có khá nhiều state cục bộ (số xe, giây, giãn cách,
 * tốc độ, chế độ chọn ô, danh sách ô đã chọn). Component chỉ đọc/ghi store và
 * gọi `addCars`; toàn bộ logic sinh sự kiện nằm ở `store/addCarsPlan.ts` (đã test bằng Node).
 */

import { useMemo, useState } from 'react';
import type { GateNote } from '../contracts/gt';
import type { CarColor, CarModel } from '../contracts/sim';
import type { SlotId } from '../contracts/lot';
import countSlotsPayload from '../../../data/lot/count_slots.json';
import { gateNotesFrom } from '../export/countLines';
import { useSimStore } from '../store/simStore';
import { freeSlotIdsWithPending } from '../store/scenarioModel';
import {
  ADD_CAR_MAX,
  ADD_CAR_MIN,
  ADD_GAP_DEFAULT_S,
  ADD_SPEED_MAX_KMH,
  ADD_SPEED_MIN_KMH,
  type SlotPickMode,
} from '../store/addCarsPlan';

/** Nhãn tiếng Việt cho `gate_note` (P11c mục 2). */
const GATE_NOTE_LABEL: Readonly<Record<GateNote, string>> = {
  before_count_line: 'xe tới ô trước khi cắt vạch đếm',
  camera_blind_A3: 'lộ trình đi qua A3, camera không phủ',
  route_not_on_A2: 'lộ trình cắt vạch 0 hoặc nhiều lần',
};

const MODELS: readonly (CarModel | null)[] = [null, 'sedan', 'suv', 'hatch'];
const COLORS: readonly (CarColor | null)[] = [
  null,
  'white',
  'black',
  'silver',
  'gray',
  'red',
  'blue',
  'green',
  'sand',
];

const MODEL_LABEL = (model: CarModel | null): string => (model === null ? 'ngẫu nhiên' : model);
const COLOR_LABEL = (color: CarColor | null): string => (color === null ? 'ngẫu nhiên' : color);

export function AddCarForm() {
  const lot = useSimStore((store) => store.lot);
  const state = useSimStore((store) => store.state);
  const scenario = useSimStore((store) => store.scenario);
  const eventLog = useSimStore((store) => store.eventLog);
  const selectedSlotId = useSimStore((store) => store.selectedSlotId);
  const defaultSpeed = useSimStore((store) => store.mapSettings.defaultSpeedKmh);
  const addCars = useSimStore((store) => store.addCars);
  const gateNotes = useMemo(() => gateNotesFrom(countSlotsPayload), []);

  const [count, setCount] = useState('1');
  const [mode, setMode] = useState<SlotPickMode>('random');
  const [gapSeconds, setGapSeconds] = useState(String(ADD_GAP_DEFAULT_S));
  const [speedKmh, setSpeedKmh] = useState(String(defaultSpeed));
  const [startSeconds, setStartSeconds] = useState('');
  const [model, setModel] = useState<CarModel | null>(null);
  const [color, setColor] = useState<CarColor | null>(null);
  const [multiSlots, setMultiSlots] = useState<readonly SlotId[]>([]);
  const [result, setResult] = useState<string | null>(null);

  if (lot === null || state === null || scenario === null) {
    return <p className="hint">Chưa có bản đồ — tạo map trước.</p>;
  }

  const pending = eventLog.filter((event) => event.frame >= state.frame);
  const freeSlots = freeSlotIdsWithPending(lot, state, pending);
  // Ô đang chọn trên khung xem: nếu còn trống thì ưu tiên điền sẵn.
  const selectedIsFree = selectedSlotId !== null && freeSlots.includes(selectedSlotId);
  const dropdownValue = selectedIsFree ? String(selectedSlotId) : '';

  const countNumber = Number.parseInt(count, 10);
  const canSubmit =
    Number.isFinite(countNumber) &&
    countNumber >= ADD_CAR_MIN &&
    countNumber <= ADD_CAR_MAX &&
    freeSlots.length > 0;

  const toggleMultiSlot = (slot: SlotId): void => {
    setMultiSlots((current) =>
      current.includes(slot) ? current.filter((item) => item !== slot) : [...current, slot],
    );
  };

  const submit = (): void => {
    setResult(null);
    const chosen = selectedIsFree && selectedSlotId !== null ? [selectedSlotId] : multiSlots;
    const outcome = addCars({
      count: countNumber,
      ...(startSeconds.trim() === '' ? {} : { startSeconds: Number.parseFloat(startSeconds) }),
      gapSeconds: Number.parseFloat(gapSeconds),
      speedKmh: Number.parseFloat(speedKmh),
      mode,
      chosenSlots: chosen,
      model,
      color,
    });
    const parts = [
      `Đã thêm ${String(outcome.added)} xe`,
      outcome.frames.length > 0
        ? `(frame ${outcome.frames.join(', ')})`
        : '',
      outcome.rejected.length > 0
        ? ` · bị từ chối ${String(outcome.rejected.length)}: ` +
          outcome.rejected.map((item) => item.reason).join('; ')
        : '',
    ];
    setResult(parts.filter((part) => part !== '').join(' '));
    if (outcome.added > 0) {
      setMultiSlots([]);
    }
  };

  return (
    <div className="add-car-form">
      <div className="field-row">
        <label className="field">
          <span>Số xe (1–50)</span>
          <input
            type="number"
            min={ADD_CAR_MIN}
            max={ADD_CAR_MAX}
            step={1}
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Tốc độ (km/h)</span>
          <input
            type="number"
            min={ADD_SPEED_MIN_KMH}
            max={ADD_SPEED_MAX_KMH}
            step={1}
            value={speedKmh}
            onChange={(event) => setSpeedKmh(event.target.value)}
          />
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          <span>Giây bắt đầu</span>
          <input
            type="number"
            min={0}
            step={0.1}
            placeholder={`${(state.frame / 25).toFixed(1)} (hiện tại)`}
            value={startSeconds}
            onChange={(event) => setStartSeconds(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Giãn cách (giây)</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={gapSeconds}
            onChange={(event) => setGapSeconds(event.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>Ô đích</span>
        <select
          value={mode === 'random' ? 'random' : dropdownValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'random') {
              setMode('random');
              setMultiSlots([]);
              return;
            }
            setMode('from-list');
            setMultiSlots([value as SlotId]);
          }}
        >
          <option value="random">ngẫu nhiên</option>
          {freeSlots.map((slot) => (
            <option key={slot} value={slot}>
              {slot}
              {gateNotes.has(slot) ? ` ⚠ (${GATE_NOTE_LABEL[gateNotes.get(slot) as GateNote]})` : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        hoặc click ô trên khung xem để chọn ô đích. ⚠ = ô không được tính đếm cổng.
      </p>

      {countNumber > 1 && (
        <label className="field">
          <span>Chọn ô khi N &gt; 1</span>
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as SlotPickMode)}
          >
            <option value="random">N ô ngẫu nhiên</option>
            <option value="from-list">lần lượt từ danh sách ô đã chọn</option>
          </select>
        </label>
      )}

      {countNumber > 1 && mode === 'from-list' && (
        <>
          <p className="hint">
            Chọn {String(countNumber)} ô (click trên khung xem hoặc tick dưới đây) — đã chọn{' '}
            {String(multiSlots.length)}.
          </p>
          <div className="slot-multi">
            {freeSlots.map((slot) => (
              <label key={slot} className="slot-chip">
                <input
                  type="checkbox"
                  checked={multiSlots.includes(slot)}
                  onChange={() => toggleMultiSlot(slot)}
                />
                {slot}
                {gateNotes.has(slot) ? ' ⚠' : ''}
              </label>
            ))}
          </div>
        </>
      )}

      <div className="field-row">
        <label className="field">
          <span>Mẫu xe</span>
          <select value={model ?? ''} onChange={(event) => setModel(event.target.value === '' ? null : (event.target.value as CarModel))}>
            {MODELS.map((item) => (
              <option key={item ?? 'random'} value={item ?? ''}>
                {MODEL_LABEL(item)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Màu xe</span>
          <select value={color ?? ''} onChange={(event) => setColor(event.target.value === '' ? null : (event.target.value as CarColor))}>
            {COLORS.map((item) => (
              <option key={item ?? 'random'} value={item ?? ''}>
                {COLOR_LABEL(item)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
        Thêm {Number.isFinite(countNumber) && countNumber > 1 ? `${String(countNumber)} xe` : 'xe'}
      </button>

      {freeSlots.length === 0 && (
        <p className="warn-note">Không còn ô trống — cho xe rời đi trước khi thêm.</p>
      )}
      {result !== null && <p className="hint">{result}</p>}
    </div>
  );
}
