import { describe, expect, it } from 'vitest';
import {
  GATE_NOTES,
  GT_EVENT_COLUMNS,
  FRAME_TIMESTAMP_COLUMNS,
  TIMESTAMP_BASE_NS,
  TIMESTAMP_STEP_NS,
  carFrameColumns,
  frameTimestampRow,
  gtFrameHeader,
} from './gt';
import { SLOT_IDS } from './lot';

describe('contracts/gt', () => {
  it('frame_timestamps giống bộ cũ: frame_idx từ 1, ns = 1e12 + f × 40ms', () => {
    expect(frameTimestampRow(0)).toEqual({
      frame_idx: 1,
      cam1_monotonic_ns: TIMESTAMP_BASE_NS,
      cam2_monotonic_ns: TIMESTAMP_BASE_NS,
    });
    expect(frameTimestampRow(3).frame_idx).toBe(4);
    expect(frameTimestampRow(3).cam1_monotonic_ns).toBe(TIMESTAMP_BASE_NS + 3 * TIMESTAMP_STEP_NS);
    expect(TIMESTAMP_STEP_NS).toBe(40_000_000);
  });

  it('frameTimestampRow từ chối frame âm hoặc không nguyên (R2)', () => {
    expect(() => frameTimestampRow(-1)).toThrow(/số nguyên/);
    expect(() => frameTimestampRow(1.5)).toThrow(/số nguyên/);
  });

  it('header gt_frames.csv = frame + 100 ô + bộ ba cột mỗi xe', () => {
    const header = gtFrameHeader(SLOT_IDS, ['V001', 'V002']);
    expect(header.slice(0, 2)).toEqual(['frame', 'S001']);
    expect(header[100]).toBe('S100');
    expect(header.slice(101)).toEqual([
      'V001_u',
      'V001_v',
      'V001_cams',
      'V002_u',
      'V002_v',
      'V002_cams',
    ]);
    expect(header).toHaveLength(1 + 100 + 6);
  });

  it('carFrameColumns đúng tên cột bộ cũ', () => {
    expect(carFrameColumns('V007')).toEqual(['V007_u', 'V007_v', 'V007_cams']);
  });

  it('thứ tự cột gt_events.csv: 8 cột cũ, 4 cột mở rộng D10, rồi gate_note (P11c)', () => {
    expect(GT_EVENT_COLUMNS).toEqual([
      'car',
      'slot',
      'gate_in_frame',
      'parked_frame',
      'depart_frame',
      'cam2_to_cam1_overlap_enter',
      'gate_out_frame',
      'arrival_crosses_cameras',
      'initial_parked',
      'model',
      'color',
      'speed_kmh',
      // P11c mục 2: cột cuối, chỉ để giải thích khi cột cổng bị rỗng có chủ đích.
      'gate_note',
    ]);
  });

  it('GATE_NOTES đúng 3 lý do ANS_17', () => {
    expect([...GATE_NOTES]).toEqual([
      'before_count_line',
      'camera_blind_A3',
      'route_not_on_A2',
    ]);
  });

  it('thứ tự cột frame_timestamps.csv không đổi', () => {
    expect(FRAME_TIMESTAMP_COLUMNS).toEqual(['frame_idx', 'cam1_monotonic_ns', 'cam2_monotonic_ns']);
  });
});
