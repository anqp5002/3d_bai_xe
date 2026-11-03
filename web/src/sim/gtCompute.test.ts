import { describe, expect, it } from 'vitest';
import type { CameraModel, LotMap, SlotId, Vec2, Vec2Px } from '../contracts/lot';
import type { CarState, SimState } from '../contracts/sim';
import type { GateNote } from '../contracts/gt';
import { GT_EVENT_COLUMNS } from '../contracts/gt';
import {
  camsForPoint,
  collectCarIds,
  frameTimestampsCsv,
  gtEvents,
  gtEventsCsv,
  gtFramesCsv,
  gtRow,
  projectPoint,
  round1,
} from './gtCompute';

const CAMERA: CameraModel = {
  pitch_deg: 80,
  f_px: 288,
  height_m: 33.6,
  res: [640, 640],
  cam1_x: [0, 400],
  cam2_x: [240, 640],
};

const SLOT_POLYGON: readonly [Vec2, Vec2, Vec2, Vec2] = [
  [2, 2],
  [8, 2],
  [8, 8],
  [2, 8],
];
const SLOT_PX: readonly [Vec2Px, Vec2Px, Vec2Px, Vec2Px] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function makeLot(): LotMap {
  return {
    name: 'test',
    camera: CAMERA,
    slots: [
      {
        id: 'S001',
        row: '1',
        center: [5, 5],
        heading: 0,
        polygon: SLOT_POLYGON,
        polygon_px: SLOT_PX,
        width_m: 2.4,
        reachable: true,
      },
    ],
    aisles: [],
    gates: {
      in: {
        p1: [0, -5],
        p2: [0, 15],
        p1_px: [0, 0],
        p2_px: [0, 1],
        spawn: [0, 5, 0],
        despawn: [0, 5],
      },
      out: {
        p1: [20, -5],
        p2: [20, 15],
        p1_px: [0, 0],
        p2_px: [0, 1],
        spawn: [20, 5, 0],
        despawn: [20, 5],
      },
    },
    decor: { grass: [], curbs: [], asphalt: [], trees: [], lamps: [] },
  };
}

function carAt(
  id: string,
  x: number,
  y: number,
  state: CarState['state'],
  slot: SlotId | null,
  v = 0,
): CarState {
  return {
    id,
    model: 'sedan',
    color: 'white',
    length: 4.6,
    width: 1.8,
    scale: 1.1,
    pose: { x, y, th: 0 },
    v,
    state,
    slot,
  };
}

function stateAt(frame: number, car: CarState): SimState {
  return {
    frame,
    cars: [car],
    reservations: [],
    rngState: {
      placement: 1,
      color: 2,
      model: 3,
      slot: 4,
      noise: 5,
      misc: 6,
    },
    warnings: [],
  };
}

function history(entries: readonly CarState[]): readonly SimState[] {
  return entries.map((car, index) => stateAt(index, car));
}

describe('gtCompute — chiếu camera (chuẩn project() cũ)', () => {
  it('projectPoint khớp công thức build_blender_video.py:56-59', () => {
    const [u0, v0] = projectPoint(CAMERA, 0, 0);
    expect(u0).toBeCloseTo(320, 6);
    expect(v0).toBeCloseTo(370.78, 1);

    const [u10, v10] = projectPoint(CAMERA, 0, 10);
    expect(u10).toBeCloseTo(320, 6);
    expect(v10).toBeCloseTo(286.81, 1);

    const [u55] = projectPoint(CAMERA, 5, 5);
    expect(u55).toBeCloseTo(362.42, 1);
  });

  it('điểm sau mặt phẳng camera → ném lỗi (R2)', () => {
    expect(() => projectPoint(CAMERA, 0, -1000)).toThrow();
  });

  it('camsForPoint đúng cửa sổ cam1/cam2 và chế độ 1 cam', () => {
    expect(camsForPoint(CAMERA, 362, 327, '2cam')).toBe('cam1+cam2');
    expect(camsForPoint(CAMERA, 100, 327, '2cam')).toBe('cam1');
    expect(camsForPoint(CAMERA, 500, 327, '2cam')).toBe('cam2');
    expect(camsForPoint(CAMERA, 700, 327, '2cam')).toBe('');
    expect(camsForPoint(CAMERA, 500, 700, '2cam')).toBe('');
    expect(camsForPoint(CAMERA, 500, 327, '1cam')).toBe('cam1');
    expect(camsForPoint(CAMERA, 700, 327, '1cam')).toBe('');
  });
});

describe('gtCompute — gtRow theo C9', () => {
  it('tâm xe trong đa giác ô → cột ô = 1, đủ 100 cột', () => {
    const lot = makeLot();
    const row = gtRow(lot, stateAt(5, carAt('V001', 5, 5, 'parked', 'S001')), '2cam');
    expect(row.frame).toBe(5);
    expect(Object.keys(row.occupancy)).toHaveLength(100);
    expect(row.occupancy.S001).toBe(1);
    expect(row.occupancy.S100).toBe(0);
    expect(row.cars.V001).toEqual({ u: 362.4, v: 327.7, cams: 'cam1+cam2' });
  });

  it('xe ngoài đa giác/đã ra khỏi mô phỏng không chiếm ô và không có mặt', () => {
    const lot = makeLot();
    const outside = gtRow(
      lot,
      stateAt(1, carAt('V001', 50, 50, 'driving_to_slot', 'S001')),
      '2cam',
    );
    expect(outside.occupancy.S001).toBe(0);
    const exited = gtRow(lot, stateAt(2, carAt('V001', 5, 5, 'exited', null)), '2cam');
    expect(exited.occupancy.S001).toBe(0);
    expect(exited.cars.V001).toBeUndefined();
  });

  it('round1 làm tròn 1 chữ số và không trả -0', () => {
    expect(round1(362.449)).toBe(362.4);
    expect(round1(362.451)).toBe(362.5);
    expect(Object.is(round1(-0.04), -0)).toBe(false);
  });
});

describe('gtCompute — GT frame 0→1→0 đúng frame (C9)', () => {
  it('vào ô, đỗ, rời ô đổi cột đúng frame', () => {
    const lot = makeLot();
    const timeline = [
      carAt('V001', 50, 50, 'driving_to_slot', 'S001'),
      carAt('V001', 5, 5, 'parking_in', 'S001'),
      carAt('V001', 5, 5, 'parked', 'S001'),
      carAt('V001', 9, 5, 'leaving_slot', 'S001'),
    ];
    const occupancy = timeline.map(
      (car, frame) => gtRow(lot, stateAt(frame, car), '2cam').occupancy.S001,
    );
    expect(occupancy).toEqual([0, 1, 1, 0]);
  });
});

describe('gtCompute — gtEvents theo D10', () => {
  const moveIn: readonly CarState[] = [
    carAt('V001', -15, 5, 'entering', null),
    carAt('V001', -2, 5, 'driving_to_slot', 'S001', 2.78),
    carAt('V001', 1, 5, 'driving_to_slot', 'S001'),
    carAt('V001', 5, 5, 'parked', 'S001'),
    carAt('V001', 5, 5, 'parked', 'S001'),
    carAt('V001', 12, 5, 'leaving_slot', 'S001'),
    carAt('V001', 21, 5, 'driving_to_exit', 'S001'),
  ];

  it('cổng vào/ra tính theo world, ô đỗ theo C9', () => {
    const events = gtEvents(makeLot(), history(moveIn));
    expect(events).toHaveLength(1);
    const row = events[0];
    expect(row.car).toBe('V001');
    expect(row.slot).toBe('S001');
    expect(row.gate_in_frame).toBe(2);
    expect(row.parked_frame).toBe(3);
    expect(row.depart_frame).toBe(5);
    expect(row.gate_out_frame).toBe(6);
    expect(row.arrival_crosses_cameras).toBe(1);
    expect(row.initial_parked).toBe(0);
    expect(row.model).toBe('sedan');
    expect(row.color).toBe('white');
    expect(row.speed_kmh).toBe(10);
    expect(row.cam2_to_cam1_overlap_enter).toBeNull();
  });

  it('xe đỗ sẵn: gate_in/parked rỗng, depart khi bắt đầu rời, initial_parked = 1', () => {
    const events = gtEvents(
      makeLot(),
      history([
        carAt('V001', 5, 5, 'parked', 'S001'),
        carAt('V001', 5, 5, 'leaving_slot', 'S001'),
        carAt('V001', 12, 5, 'driving_to_exit', 'S001'),
      ]),
    );
    expect(events[0].initial_parked).toBe(1);
    expect(events[0].gate_in_frame).toBeNull();
    expect(events[0].parked_frame).toBeNull();
    expect(events[0].depart_frame).toBe(1);
    expect(events[0].gate_out_frame).toBeNull();
  });

  it('cam2_to_cam1_overlap_enter = frame đầu sau depart có u < 400', () => {
    const events = gtEvents(
      makeLot(),
      history([
        carAt('V001', 5, 5, 'parked', 'S001'),
        carAt('V001', 5, 5, 'leaving_slot', 'S001'),
        carAt('V001', 5, 5, 'driving_to_exit', 'S001'),
      ]),
    );
    expect(events[0].cam2_to_cam1_overlap_enter).toBe(2);
  });

  it('speed_kmh lấy tốc độ người dùng đặt, không lấy tốc độ lớn nhất quan sát', () => {
    const lot = makeLot();
    const car: CarState = {
      ...carAt('V001', 5, 5, 'parked', 'S001', 3),
      desired_speed_mps: 15 / 3.6,
    };
    const events = gtEvents(lot, [stateAt(0, car)]);
    expect(events[0].speed_kmh).toBe(15);
  });

  it('lịch sử rỗng → không có dòng nào; nhiều xe giữ thứ tự xuất hiện', () => {
    expect(gtEvents(makeLot(), [])).toEqual([]);
    const lot = makeLot();
    const both = [
      stateAt(0, carAt('V002', 50, 50, 'parked', 'S001')),
      { ...stateAt(0, carAt('V002', 50, 50, 'parked', 'S001')), cars: [
        carAt('V002', 50, 50, 'parked', 'S001'),
        carAt('V001', 60, 50, 'parked', 'S001'),
      ] },
    ];
    expect(gtEvents(lot, both).map((row) => row.car)).toEqual(['V002', 'V001']);
    expect(collectCarIds(both)).toEqual(['V002', 'V001']);
  });
});

describe('gtCompute — CSV đúng tên cột bộ cũ + tất định', () => {
  const lot = makeLot();

  it('gt_frames.csv: header, ô trống cho xe vắng, tất định', () => {
    const first = gtRow(lot, stateAt(0, carAt('V001', 5, 5, 'parked', 'S001')), '2cam');
    const second = gtRow(lot, stateAt(1, carAt('V002', 50, 50, 'parked', 'S001')), '2cam');
    const csv = gtFramesCsv([first, second], ['V001', 'V002']);
    expect(gtFramesCsv([first, second], ['V001', 'V002'])).toBe(csv);

    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const header = lines[0].split(',');
    expect(header[0]).toBe('frame');
    expect(header[1]).toBe('S001');
    expect(header[100]).toBe('S100');
    expect(header.slice(101)).toEqual([
      'V001_u',
      'V001_v',
      'V001_cams',
      'V002_u',
      'V002_v',
      'V002_cams',
    ]);

    const firstCells = lines[1].split(',');
    expect(firstCells[header.indexOf('V001_u')]).toBe('362.4');
    expect(firstCells[header.indexOf('V001_v')]).toBe('327.7');
    expect(firstCells[header.indexOf('V001_cams')]).toBe('cam1+cam2');
    expect(firstCells[header.indexOf('V002_u')]).toBe('');

    const secondCells = lines[2].split(',');
    expect(secondCells[header.indexOf('V001_u')]).toBe('');
    expect(secondCells[header.indexOf('V002_cams')]).toBe('');
  });

  it('gt_events.csv: đúng thứ tự cột, ô rỗng cho frame null, tất định', () => {
    const events = gtEvents(lot, history(moveInHistory()));
    const csv = gtEventsCsv(events);
    expect(gtEventsCsv(events)).toBe(csv);
    const [header, row] = csv.trimEnd().split('\n');
    expect(header).toBe(GT_EVENT_COLUMNS.join(','));
    // Cột cuối `gate_note` rỗng khi xe bình thường (P11c mục 2).
    expect(row).toBe('V001,S001,2,3,5,,6,1,0,sedan,white,10,');
  });

  it('ô có cờ: gate_in/gate_out RỖNG + gate_note ghi lý do (P11c mục 2)', () => {
    const notes = new Map<string, GateNote>([['S001', 'route_not_on_A2']]);
    const events = gtEvents(lot, history(moveInHistory()), notes);
    expect(events).toHaveLength(1);
    // Hai cột cổng bị xoá — không phải "xe không có cổng" mà "vị trí vạch không đo được".
    expect(events[0].gate_in_frame).toBeNull();
    expect(events[0].gate_out_frame).toBeNull();
    expect(events[0].gate_note).toBe('route_not_on_A2');
    // Các cột khác không đổi: không được "sửa" số liệu để test xanh.
    expect(events[0].parked_frame).toBe(3);
    expect(events[0].depart_frame).toBe(5);
    const csv = gtEventsCsv(events);
    const row = csv.trimEnd().split('\n')[1];
    expect(row.endsWith(',route_not_on_A2')).toBe(true);
  });

  it('ô KHÔNG có cờ thì gate_note rỗng và cột cổng giữ nguyên', () => {
    const notes = new Map<string, GateNote>([['S099', 'camera_blind_A3']]);
    const events = gtEvents(lot, history(moveInHistory()), notes);
    expect(events[0].gate_note).toBeNull();
    expect(events[0].gate_in_frame).toBe(2);
    expect(events[0].gate_out_frame).toBe(6);
  });

  it('frame_timestamps.csv: frame_idx từ 1, ns = 1e12 + f·40 000 000', () => {
    expect(frameTimestampsCsv(3)).toBe(
      [
        'frame_idx,cam1_monotonic_ns,cam2_monotonic_ns',
        '1,1000000000000,1000000000000',
        '2,1000040000000,1000040000000',
        '3,1000080000000,1000080000000',
        '',
      ].join('\n'),
    );
    expect(() => frameTimestampsCsv(-1)).toThrow();
  });
});

function moveInHistory(): readonly CarState[] {
  return [
    carAt('V001', -15, 5, 'entering', null),
    carAt('V001', -2, 5, 'driving_to_slot', 'S001', 2.78),
    carAt('V001', 1, 5, 'driving_to_slot', 'S001'),
    carAt('V001', 5, 5, 'parked', 'S001'),
    carAt('V001', 5, 5, 'parked', 'S001'),
    carAt('V001', 12, 5, 'leaving_slot', 'S001'),
    carAt('V001', 21, 5, 'driving_to_exit', 'S001'),
  ];
}
