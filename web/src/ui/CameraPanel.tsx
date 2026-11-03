/** Panel phải — camera (1/2 cam). Panel Môi trường thật nằm ở `ui/env/EnvPanel.tsx`. */

import { useSimStore } from '../store/simStore';
import {
  CAMERA_COUNT_LABEL,
  ONE_CAM_NOTE,
  VIEW_MODE_LABEL,
} from '../store/scenarioModel';

export function CameraPanel() {
  const viewMode = useSimStore((store) => store.viewMode);
  const cameraCount = useSimStore((store) => store.cameraCount);

  return (
    <section className="panel-section">
      <h2>Camera</h2>
      <p className="kv">
        <span>Chế độ</span>
        <b>{VIEW_MODE_LABEL[viewMode]}</b>
      </p>
      <p className="kv">
        <span>Số cam</span>
        <b>{CAMERA_COUNT_LABEL[cameraCount]}</b>
      </p>
      {cameraCount === '1cam' && <p className="warn-note">{ONE_CAM_NOTE}</p>}
      <p className="hint">
        Đổi chế độ / 1–2 cam ở thanh ngay trên khung xem. Click xe để chọn; click ô
        trống để chọn đích cho “Thêm xe”.
      </p>
      {/*
        P14b lỗi 6: khối giữ chỗ "MÔI TRƯỜNG (P8)" đã bị xoá. Panel Môi trường thật
        (`ui/env/EnvPanel.tsx`) đã được nối từ P9c, nên khối ghi "sẽ được nối ở P8" chỉ gây
        hiểu nhầm là tính năng chưa có.
      */}
    </section>
  );
}
