import { describe, expect, it } from 'vitest';
import type { CameraModel, LotMap, Slot, Vec2, Vec2Px } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import { createDefaultScenario } from '../contracts/scenario';
import type { SimEvent } from '../contracts/events';
import type { CarState, SimState } from '../contracts/sim';
import { MIN_GAP_M } from './follow';
import {
  buildEntryRoute,
  buildExitRoute,
  gateAisleIds,
  lGateViolations,
  roadNetworkOf,
  slotAccess,
} from './network';
import { createSimState, advanceSimState } from './engine';
import {
  createState as createStateFromIndex,
  step as stepFromIndex,
  gtRow as gtRowFromIndex,
  gtEvents as gtEventsFromIndex,
} from './index';
import { progressOnRoute } from './drive';
import { describeStalls, findStalls, findStillAtEnd } from './stallCheck';
import {
  PARK_CLIP_MAX_DEPTH_BY_ROW,
  maxDepthForRow,
  parkClipEpisodes,
  summarizeEpisodes,
} from './parkClip';

/** ANS_5 / G1: chạy ≥ 5 seed, luôn có seed 123. */
const SEEDS = [123, 7, 42, 1, 2024] as const;
import { normalizeAngle } from './geometry';
import { segmentsIntersect } from './collision';
import { gtEvents } from './gtCompute';
import { DT_S } from './constants';
import currentLotJson from '../../../data/lot/lot_pucpr.json';

const CAMERA: CameraModel = {
  pitch_deg: 80,
  f_px: 288,
  height_m: 33.6,
  res: [640, 640],
  cam1_x: [0, 400],
  cam2_x: [240, 640],
};

const PX: readonly [Vec2Px, Vec2Px, Vec2Px, Vec2Px] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

interface SlotSpec {
  readonly id: Slot['id'];
  readonly x: number;
  readonly side: 1 | -1;
}

function makeSlot(id: Slot['id'], x: number, side: 1 | -1, index: number): Slot {
  const centerY = side * 5;
  const depth = 4.8;
  const width = 2.5;
  const heading = side === 1 ? Math.PI / 2 : -Math.PI / 2;
  const forward: Vec2 = [Math.cos(heading), Math.sin(heading)];
  const lateral: Vec2 = [-Math.sin(heading), Math.cos(heading)];
  const corner = (f: number, s: number): Vec2 => [
    x + forward[0] * (depth / 2) * f + lateral[0] * (width / 2) * s,
    centerY + forward[1] * (depth / 2) * f + lateral[1] * (width / 2) * s,
  ];
  return {
    id,
    row: String(index),
    center: [x, centerY],
    heading,
    polygon: [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)],
    polygon_px: PX,
    width_m: width,
    reachable: true,
  };
}

const SLOT_SPECS: readonly SlotSpec[] = [
  { id: 'S001', x: -8, side: 1 },
  { id: 'S002', x: 0, side: 1 },
  { id: 'S003', x: 8, side: 1 },
  { id: 'S004', x: -4, side: -1 },
  { id: 'S005', x: 4, side: -1 },
];

function makeSyntheticLot(): LotMap {
  return {
    name: 'test-lot',
    camera: CAMERA,
    slots: SLOT_SPECS.map((spec, index) => makeSlot(spec.id, spec.x, spec.side, index)),
    aisles: [
      {
        id: 'LANE',
        polyline: [
          [-20, 0],
          [20, 0],
        ],
        width_m: 5,
        oneway: true,
      },
    ],
    gates: {
      in: {
        p1: [-20, -2],
        p2: [-20, 2],
        p1_px: [0, 0],
        p2_px: [0, 1],
        spawn: [-25, 0, 0],
        despawn: [-19, 0],
      },
      out: {
        p1: [20, -2],
        p2: [20, 2],
        p1_px: [0, 0],
        p2_px: [0, 1],
        spawn: [19, 0, 0],
        despawn: [25, 0],
      },
    },
    decor: { grass: [], curbs: [], asphalt: [], trees: [], lamps: [] },
  };
}

function makeScenario(lot: LotMap, seed = 7): Scenario {
  const base = createDefaultScenario(seed);
  return {
    ...base,
    lot: lot.name,
    camera_mode: '2cam',
    default_speed_kmh: 10,
  };
}

function addCarEvent(
  frame: number,
  slot: Slot['id'],
  speedKmh = 10,
  parkS?: number,
): SimEvent {
  return {
    frame,
    type: 'add_car',
    params: {
      slot,
      speed_kmh: speedKmh,
      model: 'sedan',
      color: 'white',
      ...(parkS === undefined ? {} : { park_s: parkS }),
    },
  };
}

interface SimRun {
  readonly history: readonly SimState[];
  readonly final: SimState;
}

function simulate(
  lot: LotMap,
  scenario: Scenario,
  eventsFor: (state: SimState, history: readonly SimState[]) => readonly SimEvent[],
  maxFrames: number,
): SimRun {
  let state = createSimState(lot, scenario);
  const history: SimState[] = [state];
  for (let frame = 0; frame < maxFrames; frame += 1) {
    const events = eventsFor(state, history);
    state = advanceSimState(lot, state, { frame: state.frame, events }, DT_S);
    history.push(state);
  }
  return { history, final: state };
}

function carOf(state: SimState): CarState | undefined {
  return state.cars.find((car) => car.id === 'V001');
}

function gateCrossingFrames(
  history: readonly SimState[],
  gate: { p1: Vec2; p2: Vec2 },
): readonly number[] {
  const frames: number[] = [];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    for (const car of current.cars) {
      const before = previous.cars.find((candidate) => candidate.id === car.id);
      if (before === undefined) {
        continue;
      }
      if (
        segmentsIntersect(
          [before.pose.x, before.pose.y],
          [car.pose.x, car.pose.y],
          gate.p1,
          gate.p2,
        )
      ) {
        frames.push(current.frame);
      }
    }
  }
  return frames;
}

describe('network — lộ trình trừu tượng từ aisle', () => {
  it('dựng mạng có hướng, cung vào/ra kết thúc đúng **miệng ô** (P5c)', () => {
    const lot = makeSyntheticLot();
    const network = roadNetworkOf(lot);
    expect(network.nodes).toHaveLength(2);
    expect(network.edges).toHaveLength(1);
    for (const slot of lot.slots) {
      const access = slotAccess(network, slot);
      // P5c: cung phải kết thúc tại miệng ô (không quay trong dải ô), rồi đi thẳng vào tâm.
      // Bán kính cung chỉ cần dương — ràng buộc quay là do hình học bãi quyết định, không
      // phải hằng số `MIN_TURN_RADIUS_M` (xe không quay 90° ngay trong ô nữa).
      expect(access.radius_m).toBeGreaterThan(0);
      const last = access.arc[access.arc.length - 1];
      const depth = Math.max(
        ...slot.polygon.map((_, index) => {
          const a = slot.polygon[index];
          const b = slot.polygon[(index + 1) % slot.polygon.length];
          return Math.hypot(b[0] - a[0], b[1] - a[1]);
        }),
      );
      const mouth = Math.hypot(last.point[0] - slot.center[0], last.point[1] - slot.center[1]);
      expect(mouth).toBeCloseTo(depth / 2, 2);
      const angleDiff = Math.abs(
        Math.atan2(Math.sin(last.heading - slot.heading), Math.cos(last.heading - slot.heading)),
      );
      expect(angleDiff).toBeLessThan(1e-3);
    }
  });

  it('mọi ô đều lập được lộ trình vào và ra trên lot tổng hợp', () => {
    const lot = makeSyntheticLot();
    const network = roadNetworkOf(lot);
    for (const slot of lot.slots) {
      expect(buildEntryRoute(lot, network, slot, 10 / 3.6)).not.toBeNull();
      expect(buildExitRoute(lot, network, slot, 10 / 3.6)).not.toBeNull();
    }
  });

  it('L-GATE: lot tổng hợp đạt, lot hiện tại ghi chú chờ P2b', () => {
    const lot = makeSyntheticLot();
    expect(lGateViolations(lot)).toEqual([]);
    expect([...gateAisleIds(lot)]).toEqual(['LANE']);
  });
});

describe('network — lot hiện tại (P2b chưa xong)', () => {
  const currentLot = currentLotJson as unknown as LotMap;
  const violations = lGateViolations(currentLot);
  const currentNetwork = roadNetworkOf(currentLot);
  const unreachableSlots: string[] = [];
  for (const slot of currentLot.slots) {
    try {
      if (
        buildEntryRoute(currentLot, currentNetwork, slot, 10 / 3.6) === null ||
        buildExitRoute(currentLot, currentNetwork, slot, 10 / 3.6) === null
      ) {
        unreachableSlots.push(slot.id);
      }
    } catch {
      unreachableSlots.push(slot.id);
    }
  }
  const unreachable = unreachableSlots.length;
  if (unreachable > 0) {
    console.info(
      `[chờ P2b] ${unreachable}/${currentLot.slots.length} ô chưa lập được lộ trình vào/ra trên lot hiện tại: ${unreachableSlots.join(', ')}`,
    );
  }

  it('ghi nhận làn vi phạm L-GATE, không bỏ qua im lặng', () => {
    if (violations.length === 0) {
      console.info('[L-GATE] lot hiện tại đạt — chạy lại test lái 40 xe ngay được');
    } else {
      const detail = violations
        .map(
          (violation) =>
            `${violation.aisle_id}@${violation.gate} (${violation.clearance_m.toFixed(2)} m < ${violation.required_m} m)`,
        )
        .join(', ');
      console.info(`[chờ P2b] L-GATE vi phạm trên lot hiện tại: ${detail}`);
    }
    const allowed = gateAisleIds(currentLot);
    expect(allowed.size).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(allowed.has(violation.aisle_id)).toBe(false);
    }
  });

  it('lot hiện tại: mạng đường có cạnh, cổng nối được vào mạng', () => {
    expect(currentNetwork.edges.length).toBeGreaterThan(0);
    expect(currentNetwork.nodes.length).toBeGreaterThan(0);
    if (unreachable > 0) {
      console.info(`[chờ P2b] còn ${unreachable} ô chưa nối được lộ trình`);
    }
  });

  it.skipIf(violations.length > 0 || unreachable > 0)(
    'kịch bản ngẫu nhiên 40 xe (5 seed): không va chạm ngoài park_clip, không kẹt > 10 s',
    () => {
      // ANS_5 / G1: chạy **≥ 5 seed** (có 123), mỗi seed phải 0 va chạm ngoài `park_clip`,
      // 0 xe kẹt ở frame cuối, và mọi đợt clip nằm trong ngưỡng **của hàng nó**.
      for (const seed of SEEDS) {
        const scenario = makeScenario(currentLot, seed);
        const eventsFor = (state: SimState): readonly SimEvent[] =>
          state.frame === 0
            ? [
                {
                  frame: 0,
                  type: 'add_cars',
                  params: { n: 40, gap_s: 2, speed_kmh: 10 },
                },
              ]
            : [];
        const run = simulate(currentLot, scenario, eventsFor, 6_000);
        const added = run.history[run.history.length - 1].cars.length;
        expect(added).toBeGreaterThan(0);

        // 0 va chạm ngoài `park_clip`.
        const collisions = run.history.flatMap((state) =>
          state.warnings.filter((warning) => warning.kind === 'collision'),
        );
        expect(collisions).toEqual([]);

        // 0 xe kẹt — kiểm **hai** điều kiện (lead yêu cầu, vì `still_frames` bị reset khi đổi
        // state nên `warnings` không đáng tin):
        //  (a) không frame nào có xe đứng yên liên tục > 250 frame (bỏ trạng thái hợp lệ);
        //  (b) cuối kịch bản không còn xe chưa `exited` mà đứng yên > 250 frame.
        const stalls = findStalls(run.history);
        expect(stalls, `kẹt giữa chừng: ${describeStalls(stalls)}`).toEqual([]);
        const stillAtEnd = findStillAtEnd(run.history);
        expect(stillAtEnd, `còn đứng yên ở cuối: ${describeStalls(stillAtEnd)}`).toEqual([]);

        // Mọi đợt clip nằm trong ngưỡng theo hàng; log gộp theo đợt (ANS_5/lead).
        const clips = run.history.flatMap((state) =>
          state.warnings.filter((warning) => warning.kind === 'park_clip'),
        );
        const episodes = parkClipEpisodes(clips, currentLot);
        const summary = summarizeEpisodes(episodes);
        const maxByRow: Record<string, number> = {};
        for (const episode of episodes) {
          maxByRow[episode.row] = Math.max(maxByRow[episode.row] ?? 0, episode.max_depth_m);
          expect(episode.max_depth_m).toBeLessThanOrEqual(
            maxDepthForRow(episode.row) + 1e-9,
          );
          expect(episode.frame_count).toBeGreaterThan(0);
          expect(episode.neighbour_slot).toBeDefined();
          expect(episode.neighbour_car_id).toBeDefined();
        }
        // Gộp đợt không được làm mất tổng số frame.
        expect(summary.total_frames).toBe(clips.length);
        // ANS_13: leo thang `park_clip_escalated` hiếm, tối đa 0,35 m; in số lần + độ sâu lớn nhất.
        const escalated = run.history.flatMap((state) =>
          state.warnings.filter((warning) => warning.kind === 'park_clip_escalated'),
        );
        const escalatedMax = escalated.reduce((max, w) => Math.max(max, w.depth_m ?? 0), 0);
        expect(escalatedMax).toBeLessThanOrEqual(0.35 + 1e-9);
        console.info(
          `[40 xe seed=${seed}] park_clip_escalated: ${escalated.length} frame, max ${escalatedMax.toFixed(3)} m`,
        );
        console.info(
          `[40 xe seed=${seed}] frames clip=${summary.total_frames} đợt=${summary.episodes} ` +
            `dài nhất=${summary.longest_frames} maxTheoHàng=${JSON.stringify(
              Object.fromEntries(
                Object.entries(maxByRow).map(([row, value]) => [row, Number(value.toFixed(3))]),
              ),
            )} ngưỡng=${JSON.stringify(PARK_CLIP_MAX_DEPTH_BY_ROW)}`,
        );
      }
    },
    // 5 seed × 40 xe × 6000 frame.
    300_000,
  );
});

describe('engine — createState', () => {
  it('xe đỗ sẵn đúng tâm/hướng ô và mang tốc độ người dùng đặt', () => {
    const lot = makeSyntheticLot();
    const scenario: Scenario = {
      ...makeScenario(lot, 3),
      initial: {
        n_parked: 1,
        placement: [
          { slot: 'S002', car_id: 'V001', model: 'sedan', color: 'red', scale: 1.1 },
        ],
      },
    };
    const state = createSimState(lot, scenario);
    const car = carOf(state);
    expect(car).toBeDefined();
    expect(car?.state).toBe('parked');
    expect(car?.pose.x).toBeCloseTo(0, 6);
    expect(car?.pose.y).toBeCloseTo(5, 6);
    expect(car?.pose.th).toBeCloseTo(Math.PI / 2, 6);
    expect(car?.desired_speed_mps).toBeCloseTo(10 / 3.6, 9);
    expect(state.reservations).toEqual([]);
    expect(state.frame).toBe(0);
  });

  it('kịch bản khác bãi → ném lỗi (R2)', () => {
    const lot = makeSyntheticLot();
    const scenario = { ...makeScenario(lot), lot: 'other' };
    expect(() => createSimState(lot, scenario)).toThrow();
  });
});

describe('sim/index — cửa ngõ export contract thật', () => {
  it('createState/step/gtRow/gtEvents không còn ném "chưa cài đặt"', () => {
    const lot = makeSyntheticLot();
    const scenario: Scenario = {
      ...makeScenario(lot, 2),
      initial: {
        n_parked: 1,
        placement: [
          { slot: 'S002', car_id: 'V001', model: 'sedan', color: 'white' },
        ],
      },
    };
    const state = createStateFromIndex(lot, scenario);
    const next = stepFromIndex(lot, state, { frame: 0, events: [] });
    expect(next.frame).toBe(1);
    const row = gtRowFromIndex(lot, next, '2cam');
    expect(row.frame).toBe(1);
    expect(row.occupancy.S002).toBe(1);
    expect(gtEventsFromIndex(lot, [state, next])).toHaveLength(1);
  });
});

describe('engine — step thuần và tất định', () => {
  it('cùng seed + cùng sự kiện → cùng trạng thái, không sửa state vào', () => {
    const lot = makeSyntheticLot();
    const scenario = makeScenario(lot, 11);
    const eventsFor = (state: SimState): readonly SimEvent[] =>
      state.frame === 0 ? [addCarEvent(0, 'S002')] : [];
    const first = simulate(lot, scenario, eventsFor, 120);
    const second = simulate(lot, scenario, eventsFor, 120);
    expect(JSON.stringify(first.final)).toBe(JSON.stringify(second.final));

    const before = JSON.parse(JSON.stringify(first.history[10])) as SimState;
    const stepped = advanceSimState(lot, first.history[10], { frame: 10, events: [] }, DT_S);
    expect(JSON.stringify(first.history[10])).toBe(JSON.stringify(before));
    expect(stepped.frame).toBe(11);
  });
});

describe('engine — một xe vào đỗ rồi ra, GT cổng khớp tâm xe', () => {
  it('đi từ cổng vào, đỗ đúng ô, rồi lùi ra và qua cổng ra', () => {
    const lot = makeSyntheticLot();
    const scenario = makeScenario(lot, 5);
    const leaveAtRef: { frame: number | null } = { frame: null };
    const eventsFor = (state: SimState): readonly SimEvent[] => {
      if (state.frame === 0) {
        return [addCarEvent(0, 'S002', 10)];
      }
      const car = carOf(state);
      if (car?.state === 'parked' && leaveAtRef.frame === null) {
        leaveAtRef.frame = state.frame + 20;
      }
      if (leaveAtRef.frame !== null && state.frame === leaveAtRef.frame) {
        return [{ frame: state.frame, type: 'leave', params: { car_id: 'V001' } }];
      }
      return [];
    };
    const run = simulate(lot, scenario, eventsFor, 4000);
    const parkedState = run.history.find((state) => carOf(state)?.state === 'parked');
    expect(parkedState).toBeDefined();
    const parked = carOf(parkedState as SimState);
    expect(parked?.pose.x).toBeCloseTo(0, 2);
    expect(parked?.pose.y).toBeCloseTo(5, 2);
    expect(parked?.pose.th).toBeCloseTo(Math.PI / 2, 2);

    const leaving = run.history
      .map((state) => carOf(state))
      .filter((car): car is CarState => car?.state === 'leaving_slot');
    expect(leaving.length).toBeGreaterThan(0);
    expect(leaving.some((car) => car.v < 0)).toBe(true);

    const exiting = run.history
      .map((state) => carOf(state))
      .filter((car): car is CarState => car?.state === 'driving_to_exit');
    expect(exiting.length).toBeGreaterThan(0);
    expect(Math.max(...exiting.map((car) => Math.abs(car.v)))).toBeGreaterThan(2);

    const final = carOf(run.final);
    expect(final?.state).toBe('exited');

    const inCrossings = gateCrossingFrames(run.history, lot.gates.in);
    const outCrossings = gateCrossingFrames(run.history, lot.gates.out);
    expect(inCrossings).toHaveLength(1);
    expect(outCrossings).toHaveLength(1);
    const rows = gtEvents(lot, run.history);
    expect(rows).toHaveLength(1);
    expect(rows[0].gate_in_frame).toBe(inCrossings[0]);
    expect(rows[0].gate_out_frame).toBe(outCrossings[0]);
    expect(rows[0].gate_in_frame).not.toBeNull();
    expect(rows[0].gate_out_frame).not.toBeNull();
    expect(rows[0].speed_kmh).toBe(10);
  });

  it('không có cảnh báo va chạm / kẹt trên chuyến đi mẫu', () => {
    const lot = makeSyntheticLot();
    const scenario = makeScenario(lot, 5);
    const run = simulate(
      lot,
      scenario,
      (state) => (state.frame === 0 ? [addCarEvent(0, 'S002')] : []),
      1200,
    );
    const bad = run.history.flatMap((state) =>
      state.warnings.filter((warning) => warning.kind === 'collision' || warning.kind === 'stuck'),
    );
    expect(bad).toEqual([]);
  });

  it('hai xe vào hai ô cùng lúc: không chồng nhau, cùng làn giữ khoảng hở ≥ 0,8 m', () => {
    const lot = makeSyntheticLot();
    const scenario = makeScenario(lot, 9);
    const run = simulate(
      lot,
      scenario,
      (state) =>
        state.frame === 0
          ? [addCarEvent(0, 'S002'), addCarEvent(0, 'S003')]
          : [],
      1600,
    );
    let minSameLaneGap = Number.POSITIVE_INFINITY;
    for (const state of run.history) {
      const active = state.cars.filter(
        (car) => car.state !== 'exited' && car.state !== 'queued',
      );
      for (const follower of active) {
        if (follower.route === undefined) {
          continue;
        }
        for (const leader of active) {
          if (leader.id === follower.id) {
            continue;
          }
          if (Math.abs(normalizeAngle(leader.pose.th - follower.pose.th)) > 0.2) {
            continue;
          }
          const projection = progressOnRoute(follower.route, [
            leader.pose.x,
            leader.pose.y,
          ]);
          const lateralTolerance =
            (follower.width + leader.width) / 2 + 0.4;
          const routeS = follower.route_s ?? 0;
          if (
            projection.lateral <= lateralTolerance &&
            projection.s > routeS
          ) {
            minSameLaneGap = Math.min(
              minSameLaneGap,
              projection.s -
                routeS -
                (follower.length + leader.length) / 2,
            );
          }
        }
      }
    }
    expect(minSameLaneGap).toBeGreaterThanOrEqual(MIN_GAP_M - 1e-6);
    const collisions = run.history.flatMap((state) =>
      state.warnings.filter((warning) => warning.kind === 'collision'),
    );
    expect(collisions).toEqual([]);
  });
});
