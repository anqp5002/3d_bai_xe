/** Panel trái — sự kiện live + danh sách xe (FE §2, §4.5). */

import { useState } from 'react';
import type { GateNote } from '../contracts/gt';
import { CAR_COLOR_HEX } from '../contracts/sim';
import countSlotsPayload from '../../../data/lot/count_slots.json';
import { gateNotesFrom } from '../export/countLines';
import { useSimStore } from '../store/simStore';
import { CAR_STATE_LABEL, freeSlotIds } from '../store/scenarioModel';
import { AddCarForm } from './AddCarForm';

interface SpeedEditorProps {
  readonly carId: string;
  readonly desiredSpeedMps: number | undefined;
  readonly defaultSpeed: number;
  readonly onSet: (carId: string, speedKmh: number) => void;
}

/**
 * Ô đổi tốc độ tách riêng + `key={carId}`: đổi xe là remount, không cần effect đồng bộ
 * (tránh `setState` trong effect, và không reset giá trị khi sim chạy thêm frame).
 */
function SpeedEditor({ carId, desiredSpeedMps, defaultSpeed, onSet }: SpeedEditorProps) {
  const [speed, setSpeed] = useState(
    String(
      desiredSpeedMps === undefined ? defaultSpeed : Math.round(desiredSpeedMps * 3.6),
    ),
  );

  return (
    <div className="field-row compact">
      <label className="field">
        <span>Tốc độ xe đang chọn</span>
        <input
          type="number"
          min={5}
          max={20}
          step={1}
          value={speed}
          onChange={(event) => setSpeed(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="btn"
        onClick={() => onSet(carId, Number.parseFloat(speed))}
      >
        Đổi
      </button>
    </div>
  );
}

/** Nhãn tiếng Việt cho `gate_note` (P11c mục 2). */
const GATE_NOTE_LABEL: Readonly<Record<GateNote, string>> = {
  before_count_line: 'xe tới ô trước khi cắt vạch đếm',
  camera_blind_A3: 'lộ trình đi qua A3, camera không phủ',
  route_not_on_A2: 'lộ trình cắt vạch 0 hoặc nhiều lần',
};

export function CarsPanel() {
  const lot = useSimStore((store) => store.lot);
  const state = useSimStore((store) => store.state);
  const selectedCarId = useSimStore((store) => store.selectedCarId);
  const selectedSlotId = useSimStore((store) => store.selectedSlotId);
  const gateNotes = gateNotesFrom(countSlotsPayload);
  const selectCar = useSimStore((store) => store.selectCar);
  const removeSelectedCar = useSimStore((store) => store.removeSelectedCar);
  const removeCars = useSimStore((store) => store.removeCars);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const setCarSpeed = useSimStore((store) => store.setCarSpeed);
  const defaultSpeed = useSimStore((store) => store.mapSettings.defaultSpeedKmh);

  const cars = state === null ? [] : state.cars.filter((car) => car.state !== 'exited');
  const selectedCar = cars.find((car) => car.id === selectedCarId) ?? null;
  // Chỉ xe đang đỗ mới rời được; xe đã chọn mà không còn đỗ thì tự bỏ khỏi danh sách.
  const parkedIds = cars.filter((car) => car.state === 'parked').map((car) => car.id);
  const checkedParked = parkedIds.filter((id) => checked.has(id));
  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };
  const leaveChecked = () => {
    if (removeCars(checkedParked)) setChecked(new Set());
  };
  // Ô trống để báo "ô đã có xe"; form tự tính danh sách đầy đủ (trừ cả sự kiện tương lai).
  const free = lot !== null && state !== null ? freeSlotIds(lot, state) : [];

  return (
    <section className="panel-section">
      <h2>
        Xe <span className="badge">{cars.length}</span>
      </h2>

      <AddCarForm />

      <div className="button-row">
        <button
          type="button"
          className="btn"
          onClick={removeSelectedCar}
          disabled={selectedCarId === null}
        >
          Xe rời đi
        </button>
      </div>

      <div className="button-row">
        <button
          type="button"
          className="btn primary"
          onClick={leaveChecked}
          disabled={checkedParked.length === 0}
          title="Các xe đã tick sẽ cùng rời ô ở frame hiện tại"
        >
          Cho {checkedParked.length} xe đã chọn ra cùng lúc
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setChecked(new Set(parkedIds))}
          disabled={parkedIds.length === 0}
        >
          Chọn tất cả xe đỗ
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setChecked(new Set())}
          disabled={checkedParked.length === 0}
        >
          Bỏ chọn
        </button>
      </div>
      <p className="hint">Tick ô vuông đầu dòng để chọn nhiều xe đang đỗ.</p>

      {selectedCar === null ? (
        <p className="hint">Chọn một xe trong danh sách hoặc trên khung xem để đổi tốc độ.</p>
      ) : (
        <SpeedEditor
          key={selectedCar.id}
          carId={selectedCar.id}
          desiredSpeedMps={selectedCar.desired_speed_mps}
          defaultSpeed={defaultSpeed}
          onSet={setCarSpeed}
        />
      )}

      {selectedSlotId !== null && !free.includes(selectedSlotId) && (
        <p className="hint">Ô {selectedSlotId} đã có xe — chọn ô trống khác trên khung xem.</p>
      )}

      {/*
        P11c mục 2: cảnh báo ô không được tính đếm cổng. Danh sách sinh từ lộ trình
        (`data/lot/count_slots.json`), không hard-code số hàng — đổi định tuyến là cảnh báo đổi theo.
      */}
      {selectedSlotId !== null && gateNotes.has(selectedSlotId) && (
        <p className="warn-note">
          Xe ở ô này không được tính đếm cổng: {GATE_NOTE_LABEL[gateNotes.get(selectedSlotId) as GateNote]}.
          Lý do: vị trí vạch đếm và vùng camera không đo được lần cắt của xe ở ô này.
        </p>
      )}

      <ul className="car-list">
        {cars.map((car) => (
          <li key={car.id} className="car-item">
            <input
              type="checkbox"
              className="car-check"
              aria-label={`Chọn ${car.id} để rời đi`}
              title={car.state === 'parked' ? 'Chọn để rời đi' : 'Chỉ xe đang đỗ mới chọn được'}
              checked={checked.has(car.id) && car.state === 'parked'}
              disabled={car.state !== 'parked'}
              onChange={() => toggle(car.id)}
            />
            <button
              type="button"
              className={`car-row ${car.id === selectedCarId ? 'selected' : ''}`}
              onClick={() => selectCar(car.id)}
            >
              <span
                className="color-dot"
                style={{ background: CAR_COLOR_HEX[car.color] }}
                title={car.color}
              />
              <span className="car-id">{car.id}</span>
              <span className="car-model">{car.model}</span>
              <span className="car-state">{CAR_STATE_LABEL[car.state] ?? car.state}</span>
              <span className="car-slot">{car.slot ?? '—'}</span>
              <span className="car-scale" title="tỉ lệ thực sau D4">
                {car.scale.toFixed(2)}
              </span>
              <span className="car-speed">
                {(car.desired_speed_mps === undefined
                  ? 0
                  : car.desired_speed_mps * 3.6
                ).toFixed(0)}
                km/h
              </span>
            </button>
          </li>
        ))}
        {cars.length === 0 && <li className="empty">Chưa có xe — bấm “Thêm xe”.</li>}
      </ul>
    </section>
  );
}
