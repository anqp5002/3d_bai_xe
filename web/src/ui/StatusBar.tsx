/** Thanh trạng thái: BE, frame, cảnh báo hiện tại (FE §2). */

import { useSimStore } from '../store/simStore';
import { ParkClipCounter } from './ParkClipCounter';
import { GhostPassAlert } from './GhostPassAlert';

const WARNING_LABEL: Readonly<Record<string, string>> = {
  collision: 'VA CHẠM',
  stuck: 'KẸT',
  slot_occupied: 'Ô ĐÃ CÓ XE',
  gate_queue_long: 'HÀNG CỔNG DÀI',
  event_rejected: 'SỰ KIỆN BỊ TỪ CHỐI',
};

export function StatusBar() {
  const health = useSimStore((store) => store.health);
  const loading = useSimStore((store) => store.loading);
  const error = useSimStore((store) => store.error);
  const notice = useSimStore((store) => store.notice);
  const lot = useSimStore((store) => store.lot);
  const state = useSimStore((store) => store.state);
  const selectedCarId = useSimStore((store) => store.selectedCarId);
  const loadInitial = useSimStore((store) => store.loadInitial);

  const warnings = state?.warnings ?? [];
  const activeCars =
    state === null ? 0 : state.cars.filter((car) => car.state !== 'exited').length;

  return (
    <div className="statusbar">
      <div className="status-left">
        {loading && <span className="muted">Đang tải…</span>}
        {health !== null && (
          <span className={health.ok ? 'ok' : 'error'}>
            BE {health.ok ? 'OK' : 'lỗi'} · v{health.version} · ffmpeg{' '}
            {health.ffmpeg ? 'có' : 'không'}
          </span>
        )}
        {lot !== null && (
          <span>
            Bãi {lot.name} · {lot.slots.filter((slot) => slot.reachable).length} ô
          </span>
        )}
        {state !== null && (
          <span>
            frame {state.frame} · {activeCars} xe
            {selectedCarId === null ? '' : ` · chọn ${selectedCarId}`}
          </span>
        )}
        {/* P7d mục 3: bộ đếm `park_clip` của kịch bản (ANS_4 mục 4). */}
        <ParkClipCounter />
        {/* ANS_29: xe đi xuyên nhau (ghost_pass) = cảnh báo đỏ, không bao giờ im lặng. */}
        <GhostPassAlert />
      </div>

      <div className="status-right">
        {error !== null && (
          <span className="error status-error">
            {error}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                void loadInitial();
              }}
            >
              Thử lại
            </button>
          </span>
        )}
        {notice !== null && <span className="notice">{notice}</span>}
        {warnings.slice(0, 4).map((warning, index) => (
          <span
            key={`${String(warning.frame)}-${String(index)}`}
            className={warning.kind === 'collision' ? 'error' : 'warn'}
            title={`frame ${String(warning.frame)}`}
          >
            {WARNING_LABEL[warning.kind] ?? warning.kind}: {warning.message}
          </span>
        ))}
        {warnings.length > 4 && (
          <span className="muted">+{warnings.length - 4} cảnh báo khác</span>
        )}
      </div>
    </div>
  );
}
