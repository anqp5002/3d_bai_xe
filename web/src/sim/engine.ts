/**
 * Vòng mô phỏng: `createState` + `step` (FE §4.1–§4.5; D7, D8, D9, D10).
 *
 * - `step` **thuần**: không sửa state vào, trả state mới với `frame + 1`.
 * - Xe đi trên lộ trình do `network.ts` dựng từ `LotMap.aisles` (không hard-code
 *   tên làn), động học xe đạp, vào ô tiến / ra ô lùi.
 * - Cổng một làn (U8), bám xe D7 + kẹp khoảng hở ≥ 0,8 m tuyệt đối,
 *   đặt chỗ vùng quét D8, cảnh báo va chạm/kẹt.
 */

import type { Gate, LotMap, Slot, SlotId, Vec2 } from '../contracts/lot';
import { findSlot } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import type {
  AddCarParams,
  AddCarsParams,
  LeaveParams,
  LeaveRandomParams,
  SetSpeedParams,
  SimEvent,
} from '../contracts/events';
import type {
  CarColor,
  CarModel,
  CarState,
  CarStateName,
  EventsAtFrame,
  Pose,
  Reservation,
  Route,
  SimState,
  Warning,
} from '../contracts/sim';
import {
  CAR_COLORS,
  CAR_DIMENSIONS_M,
  CAR_MODELS,
  CAR_SCALE_DEFAULT,
  CAR_SCALE_MAX,
  NARROW_SLOT_WIDTH_M,
  SLOT_EDGE_MARGIN_M,
} from '../contracts/sim';
import {
  carRect,
  findCollisionPairs,
  penetrationDepth,
  polygonsIntersect,
  rectCorners,
} from './collision';
import type { OrientedRect } from './collision';
import { advanceAlongRoute, progressOnRoute, routeCumulative } from './drive';
import { MAX_ACCEL_MPS2 } from './drive';
import { MIN_GAP_M, followSpeed } from './follow';
import { canEnterGate } from './gates';
import type { GateCar } from './gates';
import { priorityKeyOf, yieldsTo } from './priority';
import type { PriorityWorld } from './priority';
import { convexHull, pointAtDistance, round6 } from './geometry';
import {
  MANEUVER_SPEED_MPS,
  buildEntryRoute,
  buildExitRoute,
  gateTravelDirection,
  nosePoint,
  roadNetworkOf,
  signedDistanceToGate,
} from './network';
import type { RoadNetwork } from './network';
import { createRngStreams, drawInt, pickItem, shuffleItems } from './rng';
import { passClipReason,
  REAL_SIZE_MAX_SCALE,
  PARK_CLIP_ESCALATE_AFTER_FRAMES,
  PARK_CLIP_ESCALATED_MAX_M,
  PARK_CLIP_ESCALATED2_MAX_M,
  PARK_CLIP_ESCALATE2_AFTER_FRAMES,
  parkClipReason,
  parkClipWarning,
  rowUsesRealSize,
} from './parkClip';
import { COLLISION_EPS_M } from './collision';
import { reserve, reservationPriority } from './reservations';
import type { ReservationRequest } from './reservations';
import { STUCK_FRAMES, updateStuck } from './stuck';
import type { StuckTracker } from './stuck';
import { SimError } from './errors';
import {
  MERGE_CELL_RADIUS_M,
  findMergeCells,
  idmTargetSpeed,
  routeCellPasses,
  shouldBackOff,
  shouldYieldByBacking,
} from './segments';
import type { MergeCell, RouteCellPass } from './segments';

/** Tốc độ người dùng đặt, m/s (FE §2: 5–20 km/h). */
export const MIN_SPEED_MPS = 5 / 3.6;
export const MAX_SPEED_MPS = 20 / 3.6;
/** Khoảng cách tối thiểu giữa hai xe trong hàng chờ ngoài cổng, m. */
export const QUEUE_GAP_M = 1.5;
/** Bắt đầu xin giữ vùng trước mốc thao tác, m. */
export const RESERVE_AHEAD_M = 1.5;
/** Bước lấy mẫu vùng quét, m. */
const REGION_SAMPLE_M = 0.4;

function clampSpeed(kmh: number): number {
  return Math.min(MAX_SPEED_MPS, Math.max(MIN_SPEED_MPS, kmh / 3.6));
}

function carNumber(carId: string): number {
  const match = /^V(\d+)$/.exec(carId);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}

function nextCarId(cars: readonly CarState[]): string {
  let max = 0;
  for (const car of cars) {
    max = Math.max(max, carNumber(car.id));
  }
  return `V${String(max + 1).padStart(3, '0')}`;
}

function carDimensions(
  model: CarModel,
  slot: Slot,
  requestedScale: number,
): { length: number; width: number; scale: number } {
  const [length, width] = CAR_DIMENSIONS_M[model];
  const maxBySlot = (slot.width_m - SLOT_EDGE_MARGIN_M) / width;
  // ANS_4 mục 3: ô hàng 1–2 dùng kích thước THẬT (`min(scale_D4, 1.0)`) để giảm độ lấn khi
  // quay vào/ra — hai hàng này có dải trống quá hẹp (3,54 m < đường chéo xe).
  const ceiling = rowUsesRealSize(slot.row)
    ? Math.min(CAR_SCALE_DEFAULT, REAL_SIZE_MAX_SCALE)
    : CAR_SCALE_MAX;
  const scale = Math.max(0.5, Math.min(requestedScale, maxBySlot, ceiling));
  return {
    length: round6(length * scale),
    width: round6(width * scale),
    scale: round6(scale),
  };
}

function usedSlots(cars: readonly CarState[]): ReadonlySet<SlotId> {
  const used = new Set<SlotId>();
  for (const car of cars) {
    if (car.slot !== null && car.state !== 'exited') {
      used.add(car.slot);
    }
  }
  return used;
}

function slotAllowsModel(slot: Slot, model: CarModel): boolean {
  return slot.width_m >= NARROW_SLOT_WIDTH_M || model === 'hatch';
}

function makeCar(
  id: string,
  model: CarModel,
  color: CarColor,
  slot: Slot,
  requestedScale: number,
  desiredSpeedMps: number,
  state: CarStateName,
  pose: Pose,
  route: Route | null,
  parkS: number | undefined,
): CarState {
  const dimensions = carDimensions(model, slot, requestedScale);
  return {
    id,
    model,
    color,
    length: dimensions.length,
    width: dimensions.width,
    scale: dimensions.scale,
    pose,
    v: 0,
    state,
    slot: slot.id,
    desired_speed_mps: desiredSpeedMps,
    route_s: 0,
    still_frames: 0,
    ...(route === null ? {} : { route }),
    ...(parkS === undefined ? {} : { park_s: parkS }),
  };
}

/**
 * Trạng thái ban đầu từ bãi + kịch bản (FE §4.2, §5; D4).
 * Thuần, tất định theo `scenario.seed`; xe đỗ sẵn ở đúng tâm/hướng ô.
 */
export function createSimState(lot: LotMap, scenario: Scenario): SimState {
  if (scenario.lot !== lot.name) {
    throw new SimError(
      `createState: kịch bản dành cho bãi "${scenario.lot}" nhưng nhận bãi "${lot.name}"`,
    );
  }
  const desiredSpeed = clampSpeed(scenario.default_speed_kmh);
  const cars = scenario.initial.placement.map((placement) => {
    const slot = findSlot(lot, placement.slot);
    return makeCar(
      placement.car_id,
      placement.model,
      placement.color,
      slot,
      placement.scale ?? scenario.car_scale,
      desiredSpeed,
      'parked',
      {
        x: round6(slot.center[0]),
        y: round6(slot.center[1]),
        th: round6(slot.heading),
      },
      null,
      undefined,
    );
  });
  return {
    frame: 0,
    cars,
    reservations: [],
    rngState: createRngStreams(scenario.seed),
    warnings: [],
  };
}

interface EventContext {
  readonly lot: LotMap;
  readonly network: RoadNetwork;
  readonly frame: number;
  readonly rngState: SimState['rngState'];
}

function reject(frame: number, event: SimEvent, reason: string): Warning {
  return {
    frame,
    kind: 'event_rejected',
    message: `Sự kiện ${event.type} bị từ chối: ${reason}`,
  };
}

function chooseRandomSlot(
  cars: readonly CarState[],
  lot: LotMap,
  model: CarModel,
  streams: SimState['rngState'],
): { slot: Slot; streams: SimState['rngState'] } | null {
  const used = usedSlots(cars);
  const candidates = lot.slots.filter(
    (slot) => !used.has(slot.id) && slotAllowsModel(slot, model),
  );
  if (candidates.length === 0) {
    return null;
  }
  const draw = drawInt(streams, 'slot', candidates.length);
  return { slot: candidates[draw.value], streams: draw.streams };
}

interface AddCarResult {
  readonly cars: readonly CarState[];
  readonly streams: SimState['rngState'];
  readonly warning: Warning | null;
}

function addOneCar(
  cars: readonly CarState[],
  context: EventContext,
  event: SimEvent,
  slotTarget: SlotId | 'random_free',
  speedKmh: number,
  modelParam: CarModel | undefined,
  colorParam: CarColor | undefined,
  parkS: number | undefined,
  resolvedIndex: number,
): AddCarResult {
  let streams = context.rngState;
  const resolvedModel = event.resolved?.models?.[resolvedIndex];
  const resolvedColor = event.resolved?.colors?.[resolvedIndex];
  const resolvedSlot = event.resolved?.slots?.[resolvedIndex];

  let model: CarModel;
  if (modelParam !== undefined) {
    model = modelParam;
  } else if (resolvedModel !== undefined) {
    model = resolvedModel;
  } else {
    const pick = pickItem(streams, 'model', CAR_MODELS);
    streams = pick.streams;
    model = pick.value;
  }

  let color: CarColor;
  if (colorParam !== undefined) {
    color = colorParam;
  } else if (resolvedColor !== undefined) {
    color = resolvedColor;
  } else {
    const pick = pickItem(streams, 'color', CAR_COLORS);
    streams = pick.streams;
    color = pick.value;
  }

  let slot: Slot;
  if (slotTarget === 'random_free') {
    if (resolvedSlot !== undefined) {
      slot = findSlot(context.lot, resolvedSlot);
    } else {
      const chosen = chooseRandomSlot(cars, context.lot, model, streams);
      if (chosen === null) {
        return {
          cars,
          streams,
          warning: reject(context.frame, event, 'không còn ô trống phù hợp'),
        };
      }
      slot = chosen.slot;
      streams = chosen.streams;
    }
  } else {
    slot = findSlot(context.lot, slotTarget);
  }

  if (usedSlots(cars).has(slot.id)) {
    return {
      cars,
      streams,
      warning: reject(context.frame, event, `ô ${slot.id} đã có xe`),
    };
  }
  if (!slotAllowsModel(slot, model)) {
    return {
      cars,
      streams,
      warning: reject(
        context.frame,
        event,
        `ô ${slot.id} hẹp < ${NARROW_SLOT_WIDTH_M} m chỉ nhận hatchback`,
      ),
    };
  }
  const speed = clampSpeed(speedKmh);
  const route = buildEntryRoute(context.lot, context.network, slot, speed);
  if (route === null) {
    return {
      cars,
      streams,
      warning: reject(context.frame, event, `không lập được lộ trình tới ô ${slot.id}`),
    };
  }
  const direction = gateTravelDirection(context.lot.gates.in);
  const car = makeCar(
    nextCarId(cars),
    model,
    color,
    slot,
    CAR_SCALE_DEFAULT,
    speed,
    'queued',
    {
      x: round6(context.lot.gates.in.spawn[0]),
      y: round6(context.lot.gates.in.spawn[1]),
      th: round6(Math.atan2(direction[1], direction[0])),
    },
    route,
    parkS,
  );
  return { cars: [...cars, car], streams, warning: null };
}

interface EventResult {
  readonly cars: readonly CarState[];
  readonly rngState: SimState['rngState'];
  readonly warnings: readonly Warning[];
}

function applyEvent(
  cars: readonly CarState[],
  context: EventContext,
  event: SimEvent,
): EventResult {
  let currentCars = cars;
  let rngState = context.rngState;
  const warnings: Warning[] = [];
  switch (event.type) {
    case 'add_car': {
      const params = event.params as AddCarParams;
      const result = addOneCar(
        currentCars,
        { ...context, rngState },
        event,
        params.slot,
        params.speed_kmh,
        params.model,
        params.color,
        params.park_s,
        0,
      );
      currentCars = result.cars;
      rngState = result.streams;
      if (result.warning !== null) {
        warnings.push(result.warning);
      }
      return { cars: currentCars, rngState, warnings };
    }
    case 'add_cars': {
      const params = event.params as AddCarsParams;
      for (let index = 0; index < params.n; index += 1) {
        const result = addOneCar(
          currentCars,
          { ...context, rngState },
          event,
          'random_free',
          params.speed_kmh,
          undefined,
          undefined,
          undefined,
          index,
        );
        currentCars = result.cars;
        rngState = result.streams;
        if (result.warning !== null) {
          warnings.push(result.warning);
          break;
        }
      }
      return { cars: currentCars, rngState, warnings };
    }
    case 'leave': {
      const params = event.params as LeaveParams;
      const car = currentCars.find((candidate) => candidate.id === params.car_id);
      if (car === undefined) {
        warnings.push(reject(context.frame, event, `không có xe ${params.car_id}`));
        return { cars: currentCars, rngState, warnings };
      }
      if (car.state !== 'parked' || car.slot === null) {
        warnings.push(reject(context.frame, event, `${car.id} chưa đỗ (${car.state})`));
        return { cars: currentCars, rngState, warnings };
      }
      const slot = findSlot(context.lot, car.slot);
      const route = buildExitRoute(
        context.lot,
        context.network,
        slot,
        car.desired_speed_mps ?? MIN_SPEED_MPS,
      );
      if (route === null) {
        warnings.push(
          reject(context.frame, event, `không lập được lộ trình ra khỏi ô ${slot.id}`),
        );
        return { cars: currentCars, rngState, warnings };
      }
      currentCars = currentCars.map((candidate) =>
        candidate.id === car.id
          ? {
              ...candidate,
              state: 'leaving_slot',
              route,
              route_s: 0,
              v: 0,
              park_until_frame: undefined,
            }
          : candidate,
      );
      return { cars: currentCars, rngState, warnings };
    }
    case 'leave_random': {
      const params = event.params as LeaveRandomParams;
      const parked = currentCars.filter(
        (car) => car.state === 'parked' && car.slot !== null,
      );
      let chosen: readonly string[];
      if (event.resolved?.car_ids !== undefined) {
        chosen = event.resolved.car_ids;
      } else {
        const shuffled = shuffleItems(
          rngState,
          'misc',
          parked.map((car) => car.id),
        );
        rngState = shuffled.streams;
        chosen = shuffled.values;
      }
      for (const carId of chosen.slice(0, params.n)) {
        const car = currentCars.find((candidate) => candidate.id === carId);
        if (car === undefined || car.slot === null) {
          warnings.push(reject(context.frame, event, `không có xe đỗ ${carId}`));
          continue;
        }
        const slot = findSlot(context.lot, car.slot);
        const route = buildExitRoute(
          context.lot,
          context.network,
          slot,
          car.desired_speed_mps ?? MIN_SPEED_MPS,
        );
        if (route === null) {
          warnings.push(
            reject(context.frame, event, `không lập được lộ trình ra khỏi ô ${slot.id}`),
          );
          continue;
        }
        currentCars = currentCars.map((candidate) =>
          candidate.id === carId
            ? {
                ...candidate,
                state: 'leaving_slot',
                route,
                route_s: 0,
                v: 0,
                park_until_frame: undefined,
              }
            : candidate,
        );
      }
      return { cars: currentCars, rngState, warnings };
    }
    case 'set_speed': {
      const params = event.params as SetSpeedParams;
      const speed = clampSpeed(params.speed_kmh);
      let found = false;
      currentCars = currentCars.map((car) => {
        if (car.id !== params.car_id) {
          return car;
        }
        found = true;
        return {
          ...car,
          desired_speed_mps: speed,
          ...(car.route === undefined
            ? {}
            : {
                route: {
                  ...car.route,
                  points: car.route.points.map((point) => ({
                    ...point,
                    v_max:
                      point.v_max === MANEUVER_SPEED_MPS ? MANEUVER_SPEED_MPS : speed,
                  })),
                },
              }),
        };
      });
      if (!found) {
        warnings.push(reject(context.frame, event, `không có xe ${params.car_id}`));
      }
      return { cars: currentCars, rngState, warnings };
    }
    case 'env_keyframe':
    case 'noise':
      return { cars: currentCars, rngState, warnings };
    default: {
      const exhaustive: never = event.type;
      throw new SimError(`Loại sự kiện lạ: ${String(exhaustive)}`);
    }
  }
}

function alongGate(car: CarState, direction: Vec2, spawn: readonly number[]): number {
  return (
    (car.pose.x - spawn[0]) * direction[0] +
    (car.pose.y - spawn[1]) * direction[1]
  );
}

/**
 * Xếp hàng chờ ngoài cổng: xe đang vào là mốc, các xe chờ đứng sau nó (hoặc sau
 * `spawn` khi cổng trống) với khoảng hở ≥ `QUEUE_GAP_M`; không bao giờ nhảy lên
 * trước mốc gây chồng xe.
 */
function reorderQueue(lot: LotMap, cars: readonly CarState[]): readonly CarState[] {
  const queued = cars
    .filter((car) => car.state === 'queued')
    .sort((a, b) => carNumber(a.id) - carNumber(b.id));
  if (queued.length === 0) {
    return cars;
  }
  const direction = gateTravelDirection(lot.gates.in);
  const spawn = lot.gates.in.spawn;
  const entering = cars
    .filter(
      (car) =>
        car.state === 'entering' ||
        (car.state === 'driving_to_slot' &&
          alongGate(car, direction, spawn) < 10),
    )
    .sort(
      (a, b) =>
        alongGate(b, direction, spawn) - alongGate(a, direction, spawn),
    )[0];

  let aheadCoord: number | null = entering === undefined
    ? null
    : alongGate(entering, direction, spawn);
  let aheadHalf = entering === undefined ? 0 : entering.length / 2;
  const positions = new Map<string, Pose>();
  for (const car of queued) {
    const coord =
      aheadCoord === null
        ? 0
        : Math.min(0, aheadCoord - aheadHalf - QUEUE_GAP_M - car.length / 2);
    positions.set(car.id, {
      x: round6(spawn[0] + direction[0] * coord),
      y: round6(spawn[1] + direction[1] * coord),
      th: round6(Math.atan2(direction[1], direction[0])),
    });
    aheadCoord = coord;
    aheadHalf = car.length / 2;
  }
  return cars.map((car) => {
    const pose = positions.get(car.id);
    return pose === undefined ? car : { ...car, pose, v: 0 };
  });
}

/**
 * Xe đang trên đường tới cổng, kèm **quãng đường còn lại theo route** tới vạch cổng.
 *
 * P5e (B2): bản trước dùng `signedDistanceToGate` — khoảng cách **chiếu thẳng** lên pháp tuyến
 * cổng. Xe đang ở A1 (cách cổng 20 m theo đường chim bay nhưng phải vòng qua V_west/A2 hơn
 * 100 m) sẽ có `distance_m` nhỏ ⇒ bị xếp làm "head" giả và chặn xe thật sự gần cổng theo lộ
 * trình. Nay: `routeRemainingToGate` = `route.length_m − route_s` (xe ra) hoặc `route_s` (xe
 * vào), nên hàng chờ đúng thứ tự theo **đường đi thật**.
 */
function gateCarsFor(
  lot: LotMap,
  cars: readonly CarState[],
  gate: 'in' | 'out',
): readonly GateCar[] {
  const value = lot.gates[gate];
  const direction = gateTravelDirection(value);
  const approachStates: ReadonlySet<CarStateName> =
    gate === 'in'
      ? new Set<CarStateName>(['queued', 'entering', 'driving_to_slot'])
      : new Set<CarStateName>(['driving_to_exit']);
  return cars
    .filter((car) => approachStates.has(car.state))
    .map((car) => ({
      id: car.id,
      distance_m: gateDistanceAlongRoute(lot, car, gate, value, direction),
      length_m: car.length,
    }))
    .filter((car) => car.distance_m > -15 || car.id === nearestQueuedId(cars, gate));
}

/** Xe `queued` kế tiếp (chưa có route) — luôn phải có mặt trong danh sách để xét cổng vào. */
function nearestQueuedId(cars: readonly CarState[], gate: 'in' | 'out'): string | null {
  if (gate !== 'in') {
    return null;
  }
  const head = cars
    .filter((car) => car.state === 'queued')
    .sort((a, b) => carNumber(a.id) - carNumber(b.id))[0];
  return head === undefined ? null : head.id;
}

/**
 * Quãng đường trên lộ trình tại điểm **cắt vạch cổng**, m.
 *
 * P10a: bản P5e dùng `route.length_m − route_s` cho **mọi** xe có route, tức là khoảng cách tới
 * **cuối lộ trình** (ô đỗ với xe vào, `despawn` với xe ra) — không phải tới vạch cổng. Hệ quả:
 * với xe vào, `distance_m` luôn ≥ `route.length_m − route_s` > 0 ở đầu route nên **không bao giờ
 * ≤ 0**: `canEnterGate` luôn thấy "chưa tới vạch" và hàng chờ đứng yên vĩnh viễn (đo được: K2
 * V002/V003 `queued` cả 3000 frame với `route_s = 0`).
 *
 * Nay: tìm điểm lộ trình **cắt đường cổng** bằng dấu của `signedDistanceToGate` dọc polyline rồi
 * nội suy. `null` nếu lộ trình không cắt vạch (dùng đường dự phòng).
 *
 * Kết quả cache theo đối tượng `route` (route là dữ liệu bất biến, dùng lại qua các frame).
 */
const GATE_CROSSING_CACHE = new WeakMap<Route, { in?: number | null; out?: number | null }>();

function routeDistanceAtGate(
  route: Route,
  gate: 'in' | 'out',
  value: Gate,
  direction: Vec2,
): number | null {
  let cached = GATE_CROSSING_CACHE.get(route);
  if (cached === undefined) {
    cached = {};
    GATE_CROSSING_CACHE.set(route, cached);
  }
  const known = cached[gate];
  if (known !== undefined) {
    return known;
  }
  const cumulative = routeCumulative(route);
  let previousS: number | null = null;
  let previousD: number | null = null;
  let found: number | null = null;
  for (let index = 0; index < route.points.length; index += 1) {
    const pose = route.points[index].pose;
    const d = signedDistanceToGate(value, [pose.x, pose.y], direction);
    if (d <= 0) {
      if (previousD === null || previousD <= 0) {
        // Lộ trình bắt đầu đã ở phía sau vạch (xe đã qua cổng).
        found = cumulative[index];
      } else {
        const t = previousD / (previousD - d);
        found = (previousS ?? 0) + t * (cumulative[index] - (previousS ?? 0));
      }
      break;
    }
    previousS = cumulative[index];
    previousD = d;
  }
  cached[gate] = found;
  return found;
}

/**
 * Khoảng cách có dấu từ **mũi xe** tới vạch cổng, đo **dọc lộ trình**.
 *
 * > 0 = chưa tới vạch, 0 = mũi đúng vạch, < 0 = mũi đã qua vạch — đúng quy ước `GateCar`.
 *
 * Mũi xe đi trước tâm xe `length / 2` dọc chiều đi, nên mốc `routeDistanceAtGate` (đo theo
 * **tâm** xe trên polyline) được lùi lại `length / 2` để quy về mũi. Đây là xấp xỉ khi hướng xe
 * lệch hướng lộ trình tại cổng; đủ đúng cho cửa sổ chiếm cổng rộng đúng một chiều dài xe.
 */
function gateDistanceAlongRoute(
  _lot: LotMap,
  car: CarState,
  gate: 'in' | 'out',
  value: Gate,
  direction: Vec2,
): number {
  // P5f (REPORT_P10a Gốc 2): xe `queued` **chưa chạy** nên `route_s` luôn = 0; nếu dùng
  // `routeDistanceAtGate` thì `distance_m` chỉ khác nhau vài chục centimét **theo hình học lộ
  // trình tới ô đích**, không phản ánh vị trí trong hàng (đo được ở K4: 6 xe cùng `queued` có
  // `distance_m` 6,41 / 6,46 / 6,50 / 6,76 ⇒ chọn sai head, cả 6 chờ 4000 frame).
  // Với xe chưa chạy, vị trí thật là pose sau `reorderQueue` — dùng đúng pose đó.
  if (car.route !== undefined && car.state !== 'queued') {
    const gateS = routeDistanceAtGate(car.route, gate, value, direction);
    if (gateS !== null) {
      const noseS = gateS - car.length / 2;
      return noseS - (car.route_s ?? 0);
    }
  }
  return signedDistanceToGate(
    value,
    nosePoint(car.pose.x, car.pose.y, car.pose.th, car.length),
    direction,
  );
}

interface LeaderInfo {
  readonly id?: string;
  readonly gap: number;
  readonly speed: number;
}

/**
 * Chỉ **giữ chỗ** (dừng chờ) khi xe còn cách đoạn cổng ≤ ngưỡng này, m.
 *
 * Xe còn xa cổng thì cứ chạy; nếu áp `canEnterGate` ở mọi khoảng cách, xe cách cổng hơn 100 m
 * cũng đứng yên chỉ vì một xe khác đang ở trong cổng (đo được: K7 V002 dừng 2383 frame khi còn
 * 115 m).
 */
const GATE_QUEUE_HOLD_M = 12;
/**
 * Xe **phía trước trên cùng lộ trình** (dùng cho bám xe D7 và kẹp khoảng hở).
 *
 * P5f: **không bỏ qua state nào** (ANS_P10a mục 3). Xe `leaving_slot`, `driving_to_exit`,
 * `parking_in` đều là vật cản vật lý thật — trước P5f `leaderGap` bỏ qua chúng nên xe trên làn
 * chạy tới chồng lên (đo được: K4 f2030 xuyên 1,77·10⁻² m). Chỉ `exited`/`queued` mới bỏ, và
 * `parked` xử riêng bằng `clipCheck` (không để thành xe dẫn đường vĩnh viễn — lý do của P5e).
 *
 * Ai **dừng** thì do :func:`yieldsTo` quyết, không do việc bỏ/xét `leaderGap`:
 * - Nếu `car` nhường `other` ⇒ `other` là xe trước, `car` giữ khoảng hở.
 * - Nếu `car` được đi trước ⇒ bỏ qua `other` (không khoá mình vì xe phải nhường mình).
 */
function leaderGap(
  route: Route,
  routeS: number,
  car: CarState,
  cars: readonly CarState[],
  world: PriorityWorld,
): LeaderInfo | null {
  let best: LeaderInfo | null = null;
  for (const other of cars) {
    if (
      other.id === car.id ||
      other.state === 'exited' ||
      other.state === 'queued' ||
      other.state === 'parked'
    ) {
      continue;
    }
    const projection = progressOnRoute(route, [other.pose.x, other.pose.y]);
    if (projection.lateral > (car.width + other.width) / 2 + 0.4) {
      continue;
    }
    if (projection.s <= routeS) {
      continue;
    }
    // P5f: chỉ coi là "xe trước" khi mình **phải nhường** nó — dùng **cùng** tập vùng với
    // `clipCheck`, nếu không hai cơ chế bất đồng (một bên cho đi, một bên chặn) và sinh kẹt.
    // Lead (sau ANS_11): GIỮ KHOẢNG CÁCH VỚI MỌI XE ĐI TRƯỚC CÙNG CHIỀU, không phụ thuộc ưu tiên.
    // Bản P5f bỏ qua xe dẫn đường mà mình "không phải nhường" nên xe thắng không phanh và cứ
    // tiến tới chạm xe đang nằm sẵn trên lộ trình của nó (K5: V005 ra từ V_east húc vào V019 đang
    // cua ở nút giao, khoá cả hai). Ưu tiên chỉ phân xử xung đột CẮT làn (hướng khác nhau): xe
    // đi cùng chiều (±72°) luôn bám theo nhau; xe cắt ngang thì để `yieldSpeedFor`/`clipCheck`.
    if (Math.cos(car.pose.th - other.pose.th) <= 0.3) {
      continue;
    }
    void world;
    const gap = projection.s - routeS - (car.length + other.length) / 2;
    if (best === null || gap < best.gap) {
      best = { id: other.id, gap, speed: Math.abs(other.v) };
    }
  }
  return best;
}

/**
 * Biên an toàn của vùng đặt chỗ, m (P5f, ANS_coders-2_3).
 *
 * Vùng phải **lớn hơn thân xe** ngần này mỗi phía. Lý do: xe nhường dừng khi vùng của nó giao
 * vùng kia, mà vùng ôm sát thân thì điểm dừng đúng bằng 0 mm — sai số bước 0,11 m/frame làm hai
 * xe chạm nhau. Đây là **biên của vùng** (đã duyệt ở ANS_coders-2_1), **không** nới
 * `COLLISION_EPS_M`.
 */
export const ZONE_MARGIN_M = 0.2;

/**
 * Vùng quét **thật** của một thao tác trên lộ trình, từ `fromS` tới `toS` (m).
 *
 * P5f (ANS_coders-2_1 mục 1): vùng phải phủ **toàn bộ** chỗ thân/đuôi xe quét qua, **không** chỉ
 * dải hẹp dọc tim lộ trình. Bản P5b chỉ lấy hai mép `±width/2` quanh tim, nên xe trên làn đi vào
 * phần **đuôi** (dài `length`) mà vùng không phủ ⇒ `reservationBlocks` không chặn được (đo được
 * ở K2: polygon `leave_out` bbox x[-1,83; 3,11] trong khi xe dài 4 m đã tới mép từ f1860).
 *
 * ANS_coders-2_3: mỗi mẫu đóng góp hình chữ nhật thân xe **nới `ZONE_MARGIN_M` mỗi phía**, rồi
 * lấy bao lồi. Một polygon này dùng chung cho cấp đặt chỗ, `reservationBlocks`, `holdsZone` và
 * `yieldSpeedFor`.
 */
const ROUTE_POSITIONS = new WeakMap<Route, Vec2[]>();

/** Toạ độ các điểm lộ trình, nhớ theo từng `Route` (lộ trình bất biến) — tránh dựng lại mỗi lần lấy mẫu. */
function routePositions(route: Route): Vec2[] {
  let cached = ROUTE_POSITIONS.get(route);
  if (cached === undefined) {
    cached = route.points.map((point) => [point.pose.x, point.pose.y] as Vec2);
    ROUTE_POSITIONS.set(route, cached);
  }
  return cached;
}

export function maneuverPolygon(
  route: Route,
  fromS: number,
  toS: number,
  width: number,
  length = 0,
): readonly Vec2[] {
  const positions = routePositions(route);
  const halfWidth = width / 2 + ZONE_MARGIN_M;
  const halfLength = length / 2 + ZONE_MARGIN_M;
  const start = Math.min(fromS, toS);
  const end = Math.max(fromS, toS);
  const points: Vec2[] = [];
  const pushAt = (s: number): void => {
    const sample = pointAtDistance(positions, s);
    const along = [Math.cos(sample.heading) * halfLength, Math.sin(sample.heading) * halfLength];
    const across = [-Math.sin(sample.heading) * halfWidth, Math.cos(sample.heading) * halfWidth];
    // Bốn góc của thân xe (đã nới biên) tại mẫu này.
    for (const [ax, ay] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      points.push([
        sample.point[0] + along[0] * ax + across[0] * ay,
        sample.point[1] + along[1] * ax + across[1] * ay,
      ]);
    }
  };
  for (let s = start; s < end; s += REGION_SAMPLE_M) {
    pushAt(s);
  }
  pushAt(end);
  return convexHull(points);
}

/**
 * Quãng đường lộ trình mà vùng quét phải phủ thêm sau khi xe đã ra khỏi thao tác, m (P5f).
 *
 * ANS_coders-2_1 mục 1: `leave_out` phải phủ "tới khi xe đã thẳng trục làn **và đi thêm 1 chiều
 * dài xe**". Đây chính là phần **đuôi xe** còn nằm trên làn khi đầu xe đã ra — thiếu nó thì xe
 * trên làn len vào đúng chỗ đuôi sẽ quét qua.
 */
const MANEUVER_TAIL_M = 1;
/** Đoạn đầu (m) của vùng `leave_out` bị bỏ qua khi kiểm xe đang đứng trong vùng (P17g). */
const LEAVE_OCCUPANCY_SKIP_M = 1.2;

/**
 * Vùng đặt chỗ **dùng chung** cho một xe đang thao tác (P5f, ANS_coders-2_1 mục 2).
 *
 * Một polygon duy nhất được dùng ở **cả ba** chỗ: cấp đặt chỗ, `reservationBlocks` (xe không giữ
 * dừng trước mép) và `holdsZone` trong `yieldsTo`. Không nơi nào tự tính vùng riêng.
 *
 * Trả `null` nếu xe không ở trạng thái thao tác hoặc lộ trình thiếu mốc cần thiết.
 */
function maneuverZoneOf(car: CarState): readonly Vec2[] | null {
  if (car.route === undefined || car.slot === null) {
    return null;
  }
  if (car.state === 'leaving_slot' && car.route.maneuver_end_s !== undefined) {
    const toS = Math.min(
      car.route.length_m,
      car.route.maneuver_end_s + MANEUVER_TAIL_M * car.length,
    );
    return maneuverPolygon(car.route, 0, toS, car.width, car.length);
  }
  if (car.state === 'driving_to_slot' && car.route.slot_start_s !== undefined) {
    const fromS = Math.max(0, car.route.slot_start_s - MANEUVER_TAIL_M * car.length);
    return maneuverPolygon(car.route, fromS, car.route.length_m, car.width, car.length);
  }
  if (car.state === 'parking_in') {
    const fromS = car.route.slot_start_s ?? 0;
    return maneuverPolygon(car.route, fromS, car.route.length_m, car.width, car.length);
  }
  return null;
}

/**
 * P5g — **lùi nhường** (back-off) khi xe đứng kẹt vì phải nhường.
 *
 * Vì sao cần: `yieldSpeedFor` giữ xe nhường **dừng**, nhưng nếu nó đã dừng đúng ở mép vùng (sai
 * số bước 0,11 m/frame) thì hai xe ở mức xuyên dưới milimét và `clipCheck` khoá **cả hai** —
 * không ai tiến được, và cũng không ai **lùi** được vì `advanceAlongRoute` chỉ tiến. Back-off là
 * cơ chế duy nhất gỡ trạng thái đó.
 *
 * Điều kiện kích hoạt (ANS_10 mục 1): đứng yên liên tục ≥ :data:`BACKOFF_AFTER_FRAMES` frame
 * **và** có xe X trong :data:`YIELD_CLEARANCE_M` của thân mà `yieldsTo(car, X) = true`.
 *
 * Giới hạn:
 * - lùi tối đa **1 chiều dài xe** mỗi lần (mục 4);
 * - tốc độ lùi ≤ :data:`BACKOFF_SPEED_MPS`, tăng/giảm tốc theo `MAX_ACCEL_MPS2` (không giật);
 * - **không lùi qua vạch cổng** (mục 2): chặn `route_s` ở mốc cắt cổng + :data:`GATE_BACKOFF_MARGIN_M`;
 * - mỗi bước vẫn qua `clipCheck` (không lùi xuyên xe khác).
 */
function backOffTarget(
  lot: LotMap,
  car: CarState,
  route: Route,
  routeS: number,
  cars: readonly CarState[],
  world: PriorityWorld,
): { readonly routeS: number; readonly toward: CarState } | null {
  if (
    car.state !== 'entering' &&
    car.state !== 'driving_to_slot' &&
    car.state !== 'driving_to_exit'
  ) {
    return null;
  }
  if ((car.still_frames ?? 0) < BACKOFF_AFTER_FRAMES) {
    return null;
  }
  const carRectNow = carRect(car);
  let target: CarState | null = null;
  let worst = Number.POSITIVE_INFINITY;
  for (const other of cars) {
    if (other.id === car.id || other.state === 'exited' || other.state === 'queued') {
      continue;
    }
    const conflictZones = [...zonesOfCar(car, world), ...zonesOfCar(other, world)];
    if (!yieldsTo(car, other, { ...world, zones: conflictZones })) {
      continue;
    }
    let depth = penetrationDepth(inflateRect(carRectNow, YIELD_CLEARANCE_M), carRect(other));
    if (depth <= COLLISION_EPS_M) {
      // P17g: `other` là xe `leaving_slot` đang CHỜ vùng lùi ra (claim) mà thân mình đang nằm trong
      // vùng đó: vùng không bao giờ trống nếu mình không lùi — đúng ca B1 V044↔V022.
      const claims = zonesOfCar(other, world);
      if (
        other.state === 'leaving_slot' &&
        !world.reservations.some((item) => item.car_id === other.id) &&
        claims.some((zone) => overlapsPolygon(rectPolygon(carRectNow), zone))
      ) {
        depth = COLLISION_EPS_M * 2;
      } else {
        continue;
      }
    }
    if (depth < worst) {
      worst = depth;
      target = other;
    }
  }
  if (target === null) {
    return null;
  }

  // Lùi tối đa một chiều dài xe, nhưng không qua vạch cổng.
  const limit = Math.min(car.length, routeS);
  const gateKey: 'in' | 'out' = route.target.kind === 'exit' ? 'out' : 'in';
  const gateS = routeDistanceAtGate(
    route,
    gateKey,
    lot.gates[gateKey],
    gateTravelDirection(lot.gates[gateKey]),
  );
  // P17g: sàn này chỉ có nghĩa với xe ĐÃ QUA vạch cổng (không được lùi ngược lại qua vạch). Xe còn
  // TRƯỚC vạch (gateS > routeS) mà áp sàn `gateS + margin` thì targetS luôn ≥ routeS ⇒ mọi lần lùi
  // nhường của xe sắp tới cổng ra đều "không lùi được" (backoff_failed hàng trăm lần ở B/C).
  const gateFloor =
    gateS === null || routeS < gateS ? 0 : Math.max(0, gateS + GATE_BACKOFF_MARGIN_M);
  const targetS = Math.max(gateFloor, routeS - limit);
  if (targetS >= routeS - 1e-9) {
    // Không lùi được (đã sát mốc chặn) — caller sẽ báo `backoff_failed`.
    return { routeS, toward: target };
  }
  return { routeS: targetS, toward: target };
}

function stuckTrackerFrom(
  cars: readonly CarState[],
  nextFrame: number,
): StuckTracker {
  const entries: Record<string, { sinceFrame: number; warned: boolean }> = {};
  for (const car of cars) {
    const still = car.still_frames ?? 0;
    entries[car.id] = {
      sinceFrame: nextFrame - 1 - still,
      warned: still > STUCK_FRAMES,
    };
  }
  return { entries };
}

/**
 * Số frame đứng yên liên tục (6 s @ 25 fps) thì xe được vào chế độ **lách** (P17e).
 *
 * Đây là lưới an toàn cuối cùng của P17: ba luật P17d xử lý được phần lớn tải, nhưng vẫn có ca
 * khoá cứng mà không luật nào phá được (B1: `V044` đứng giữa làn ở `rs=9,49` trong khi ô của nó
 * cách 59 m, và `V008` chờ nó 9625 frame). Thay vì vá từng ca — cách đã chứng minh chỉ làm kẹt
 * **chuyển chỗ** — ta cho đúng một xe trong mỗi cụm kẹt đi xuyên qua xe đang chặn nó.
 *
 * Đây là dung sai **có chủ đích, có đếm, có cảnh báo** (`ghost_pass`), không phải lỗi lập trình.
 */
export const GHOST_AFTER_FRAMES = 150;

/** Tốc độ xe lách, m/s — chậm để người xem thấy rõ và để xe khác kịp phản ứng. */
export const GHOST_SPEED_MPS = 1.5;



/** Các trạng thái **không** bao giờ lách: chúng đứng yên là đúng ý đồ. */
const GHOST_EXEMPT_STATES: ReadonlySet<CarStateName> = new Set<CarStateName>([
  'parked',
  'queued',
  'exited',
]);

/**
 * P17e — chọn xe được **lách** trong frame này.
 *
 * Điều kiện: đang chạy/thao tác (không `parked`/`queued`/`exited`), đứng yên liên tục
 * ≥ {@link GHOST_AFTER_FRAMES}, và chưa lách.
 *
 * **Tối đa một xe lách trong mỗi cụm kẹt**, chọn theo thứ tự tất định: gom các xe đủ điều kiện thành
 * cụm theo khoảng cách (≤ {@link GHOST_CLUSTER_RADIUS_M}), trong mỗi cụm lấy xe có **số hiệu nhỏ
 * nhất**. Nhờ vậy hai xe không lách vào nhau, và kết quả không phụ thuộc thứ tự duyệt.
 */
/**
 * P17 (ANS_36): `ghost_pass` (xe xuyên qua xe khác) là cờ dev, **tắt mặc định** — anh An cấm lách.
 * Bật lại để debug: `setGhostPassEnabled(true)`. Khi tắt, xe kẹt phải được gỡ bằng điều phối
 * (`sim/segments.ts`), không bằng cách xuyên thân.
 */
/** Dev: ghi lý do mỗi xe đang bị giữ (`id → lý do`); null = tắt. Chỉ dùng chẩn đoán. */
let waitSink: Map<string, string> | null = null;

export function setWaitSink(sink: Map<string, string> | null): void {
  waitSink = sink;
}

function noteWait(carId: string, why: string): void {
  if (waitSink !== null && !waitSink.has(carId)) {
    waitSink.set(carId, why);
  }
}

/** Xe vừa chặn bước đi gần nhất của `clipCheck` (để xe bị chặn biết ai đang sát phía sau). */
let lastClipBlocker: CarState | null = null;

let ghostPassEnabled = false;

export function setGhostPassEnabled(enabled: boolean): void {
  ghostPassEnabled = enabled;
}

function computeGhostPasses(cars: readonly CarState[]): ReadonlySet<string> {
  if (!ghostPassEnabled) {
    return new Set<string>();
  }
  const eligible = cars.filter(
    (car) =>
      !GHOST_EXEMPT_STATES.has(car.state) &&
      car.route !== undefined &&
      // Dấu "đang lách" là `ghost_from_route_s`; `ghost_since_frame` chỉ là "đã từng lách" nên
      // KHÔNG dùng để chặn — nếu chặn, xe kẹt lần hai không được gỡ (đo: kẹt 0 → 52 ở C2).
      car.ghost_from_route_s === undefined &&
      (car.still_frames ?? 0) >= GHOST_AFTER_FRAMES &&
      // **Phải là deadlock thật**: có xe khác đang chắn trong tầm gần **và** bản thân xe đó cũng
      // không đi được. Một xe đứng chờ một xe đang chạy bình thường không phải deadlock — nó sẽ
      // tự đi tiếp. Lách ở ca đó biến "chờ hợp lý" thành "xuyên thân", và làm kịch bản mẫu K1–K8
      // sinh lách oan (đo: K4 sinh 83 `park_clip_escalated`).
      cars.some((other) => {
        if (other.id === car.id || other.state === 'exited') {
          return false;
        }
        const near =
          Math.hypot(car.pose.x - other.pose.x, car.pose.y - other.pose.y) <=
          GHOST_CLUSTER_RADIUS_M;
        if (!near) {
          return false;
        }
        // Chỉ coi là chắn khi xe kia **cũng** đứng yên đủ lâu (hoặc là vật cản tĩnh trong ô).
        return (
          GHOST_EXEMPT_STATES.has(other.state) ||
          Math.abs(other.v) < 1e-6
        );
      }),
  );
  if (eligible.length === 0) {
    return new Set<string>();
  }
  // Gom cụm bằng union-find trên khoảng cách, để "mỗi cụm một xe" đúng cả khi cụm dây chuyền.
  const parent = eligible.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    return root;
  };
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      const a = eligible[i];
      const b = eligible[j];
      const distance = Math.hypot(a.pose.x - b.pose.x, a.pose.y - b.pose.y);
      if (distance > GHOST_CLUSTER_RADIUS_M) {
        continue;
      }
      const rootA = find(i);
      const rootB = find(j);
      if (rootA !== rootB) {
        parent[rootB] = rootA;
      }
    }
  }
  const winnerByCluster = new Map<number, CarState>();
  for (let index = 0; index < eligible.length; index += 1) {
    const root = find(index);
    const car = eligible[index];
    const current = winnerByCluster.get(root);
    if (current === undefined || carNumber(car.id) < carNumber(current.id)) {
      winnerByCluster.set(root, car);
    }
  }
  return new Set([...winnerByCluster.values()].map((car) => car.id));
}

/** Bán kính gom cụm kẹt cho luật lách, m (rộng hơn một thân xe để bắt dây chuyền). */
const GHOST_CLUSTER_RADIUS_M = 12;

/**
 * Tiến một bước `dtS` giây — hàm thuần, không sửa state vào.
 * Áp sự kiện đúng frame này trước khi tích phân chuyển động (FE §4.1).
 */
export function advanceSimState(
  lot: LotMap,
  state: SimState,
  eventsAtFrame: EventsAtFrame,
  dtS: number,
): SimState {
  if (eventsAtFrame.frame !== state.frame) {
    throw new SimError(
      `step: sự kiện ở frame ${eventsAtFrame.frame} nhưng state ở frame ${state.frame}`,
    );
  }
  if (!(dtS > 0)) {
    throw new SimError(`step: dtS phải > 0, nhận ${String(dtS)}`);
  }
  const network = roadNetworkOf(lot);
  const nextFrame = state.frame + 1;
  const context: EventContext = { lot, network, frame: state.frame, rngState: state.rngState };

  let cars: readonly CarState[] = state.cars;
  let rngState = state.rngState;
  let warnings: Warning[] = [];
  for (const event of eventsAtFrame.events) {
    const result = applyEvent(cars, { ...context, rngState }, event);
    cars = result.cars;
    rngState = result.rngState;
    warnings = [...warnings, ...result.warnings];
  }

  let reservations: readonly Reservation[] = state.reservations;

  cars = reorderQueue(lot, cars);
  const inGateCars = gateCarsFor(lot, cars, 'in');
  const head = cars
    .filter((car) => car.state === 'queued')
    .sort((a, b) => carNumber(a.id) - carNumber(b.id))[0];
  // P17m (ANS_32 + TASK_P17d "chống đói"): **điều tiết cổng vào.** Gap-acceptance (luật 1) giữ xe
  // trong ô lâu hơn, nên nếu vẫn thả xe mới vào đều thì bãi đầy và `add_car` bị từ chối ("không còn
  // ô trống phù hợp"). Khi có xe **chờ ra** đã lâu mà chưa lùi được, giữ xe mới ở cổng (`queued`)
  // cho tới khi nó bắt đầu ra. Tất định và **không thể sinh vòng**: xe `queued` nằm ngoài bãi,
  // không chắn ai bên trong.
  if (head !== undefined && canEnterGate(inGateCars, head.id).ok) {
    const direction = gateTravelDirection(lot.gates.in);
    cars = cars.map((car) =>
      car.id === head.id
        ? {
            ...car,
            state: 'entering',
            pose: {
              x: round6(lot.gates.in.spawn[0]),
              y: round6(lot.gates.in.spawn[1]),
              th: round6(Math.atan2(direction[1], direction[0])),
            },
            route_s: 0,
            v: 0,
          }
        : car,
    );
  }

  const vips = computeVips(cars);
  // P17e: luoi an toan cuoi cung - chon toi da 1 xe lach moi cum ket.
  const ghostPasses = computeGhostPasses(cars);
  const requests: ReservationRequest[] = [];
  for (const car of cars) {
    if (car.route === undefined || car.slot === null) {
      continue;
    }
    if (reservations.some((item) => item.car_id === car.id)) {
      continue;
    }
    // P5f: một nguồn vùng duy nhất (`maneuverZoneOf`) dùng cho cả cấp đặt chỗ, `reservationBlocks`
    // và `holdsZone`. Xe chỉ xin khi đã tới gần mốc thao tác.
    const nearManeuver =
      (car.state === 'driving_to_slot' &&
        car.route.slot_start_s !== undefined &&
        (car.route_s ?? 0) >= car.route.slot_start_s - RESERVE_AHEAD_M) ||
      car.state === 'leaving_slot';
    if (!nearManeuver) {
      continue;
    }
    const zone = maneuverZoneOf(car);
    if (zone === null) {
      continue;
    }
    requests.push({
      car_id: car.id,
      slot: car.slot,
      op: car.state === 'leaving_slot' ? 'leave_out' : 'park_in',
      polygon: zone,
      frame: state.frame,
    });
  }
  requests.sort((a, b) => {
    const byPriority = reservationPriority(a.op) - reservationPriority(b.op);
    return byPriority !== 0 ? byPriority : a.car_id.localeCompare(b.car_id);
  });
  // P17m (ANS_32): **claim vùng chỉ cấp cho xe đứng đầu theo thứ tự toàn phần.** Thứ tự vùng dùng
  // `yieldsTo` (nguồn ưu tiên duy nhất), KHÔNG phải "op rồi id" như bản cũ: hai thước đo khác nhau
  // chính là nguồn vòng chờ (V044 chờ cấp vùng, mà V022 lại nhường claim của V044).
  //
  // Lead (P17m review mục 2): KHÔNG gọi `yieldsTo` trong comparator với `zones` theo từng cặp —
  // quan hệ đó có thể **không bắc cầu** (zones của cặp này khác cặp kia) nên `sort` cho thứ tự
  // không ổn định. Thay vào đó: chốt **một** `world` (zones = các vùng ĐANG giữ, giống hệt nhau cho
  // mọi lần so), tính khoá ưu tiên **một lần** cho từng xe, rồi sort theo khoá đã đóng băng.
  const frozenWorld: PriorityWorld = { reservations, zones: reservations.map((item) => item.polygon) };
  const frozenKeys = new Map<string, readonly number[]>(
    cars.map((car) => [car.id, priorityKeyOf(car, frozenWorld)]),
  );
  const compareKeys = (a: readonly number[], b: readonly number[]): number => {
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) {
        return a[index] - b[index];
      }
    }
    return 0;
  };
  requests.sort((a, b) => {
    const keyA = frozenKeys.get(a.car_id);
    const keyB = frozenKeys.get(b.car_id);
    if (keyA !== undefined && keyB !== undefined) {
      const byKey = compareKeys(keyA, keyB);
      if (byKey !== 0) {
        return byKey;
      }
    }
    const byPriority = reservationPriority(a.op) - reservationPriority(b.op);
    return byPriority !== 0 ? byPriority : a.car_id.localeCompare(b.car_id);
  });
  for (const request of requests) {
    // P5f (ANS_coders-2_1 mục 3 + ANS_coders-2_3 mục 2): **all-or-nothing** — không cấp vùng
    // đang **có xe đang di chuyển/đứng trên làn** trong đó. Nếu cấp, xe xin sẽ lùi/tiến vào chỗ
    // đã có xe và cả hai khoá nhau (đúng ca K2: V001 đã ở trong vùng V002 sắp lùi qua).
    //
    // Xe **đỗ yên ở ô** (`parked`) là ngoại lệ: nó là vật cản tĩnh đã biết, do `park_clip` xử
    // lý. Vùng mới nới `ZONE_MARGIN_M` nên biên chạm tới ô kề; nếu tính cả xe đỗ thì **mọi** ô
    // hàng 1–2 sẽ bị từ chối cấp và kẹt hàng loạt.
    const requester = cars.find((candidate) => candidate.id === request.car_id);
    // P17g: với `leave_out`, vùng dùng để kiểm "có ai đang đứng trong" bỏ qua đoạn đầu
    // (LEAVE_OCCUPANCY_SKIP_M) — xe chạy ở làn kề mép ô (aisle phía trước đầu xe) chạm biên vùng
    // CHỈ vì thân xe đỗ trong ô, trong khi xe lùi ra đi xa khỏi nó. Đo (B1): V045 ở làn nam chạm
    // biên vùng của V044 (ô S067) làm V044 không bao giờ được cấp vùng; cả cụm kẹt tới lúc lách.
    // Vùng ĐẶT CHỖ (người khác không được vào) vẫn giữ nguyên, đầy đủ.
    const occupancyPolygon =
      request.op === 'leave_out' &&
      requester?.route !== undefined &&
      requester.route.maneuver_end_s !== undefined
        ? maneuverPolygon(
            requester.route,
            LEAVE_OCCUPANCY_SKIP_M,
            Math.min(
              requester.route.length_m,
              requester.route.maneuver_end_s + MANEUVER_TAIL_M * requester.length,
            ),
            requester.width,
            requester.length,
          )
        : request.polygon;
    const occupiedByMoving = cars.some(
      (other) =>
        other.id !== request.car_id &&
        other.state !== 'exited' &&
        other.state !== 'parked' &&
        // Xe `leaving_slot` chưa nhích (route_s ≈ 0) vẫn đang NẰM TRONG ô của nó như xe đỗ:
        // không phải xe đang di chuyển. Tính nó là "đang chạy" thì xe ra ô cạnh bên và xe vào ô
        // kề chặn nhau (K5: V006 ra S041 ↔ V007 vào S043, vùng của bên này chứa thân bên kia).
        !(other.state === 'leaving_slot' && (other.route_s ?? 0) < 0.05) &&
        overlapsPolygon(rectPolygon(carRect(other)), occupancyPolygon) &&
        // Lead (sau ANS_11): xe đứng ĐẰNG SAU xe đang xin `park_in` (hàng đợi trên làn) không chặn
        // đặt chỗ — xe xin đi TIẾN vào ô, rời xa chúng; nếu chúng chặn thì đầu hàng không bao giờ
        // vào ô và cả hàng sau nó đứng chờ (đo ở 40 xe seed 123: V009 đứng cách V008 7,4 m nhưng
        // thân lọt vào đuôi vùng) ⇒ vòng chờ. `leave_out` thì KHÔNG miễn: xe lùi ra cắt làn.
        !(request.op === 'park_in' && requester !== undefined && isBehind(requester, other)),
    );
    if (occupiedByMoving && !vips.has(request.car_id)) {
      continue;
    }
    const result = reserve(reservations, request);
    if (!result.ok) {
      continue;
    }
    reservations = result.reservations;
    if (request.op === 'park_in') {
      cars = cars.map((car) =>
        car.id === request.car_id ? { ...car, state: 'parking_in' } : car,
      );
    }
  }

  reservations = reservations.filter((reservation) => {
    const car = cars.find((candidate) => candidate.id === reservation.car_id);
    if (car === undefined) {
      return false;
    }
    if (car.state !== 'parking_in' && car.state !== 'leaving_slot') {
      return false;
    }
    return true;
  });

  const outGateCars = gateCarsFor(lot, cars, 'out');
  // P5f: **một** ngữ cảnh ưu tiên dùng chung cho mọi quyết định trong frame này.
  const world: PriorityWorld = { reservations, vips, ghostPasses };
  const nextCars: CarState[] = [];
  const clipWarnings: Warning[] = [];
  for (const car of cars) {
    nextCars.push(
      advanceCar(
        lot,
        network,
        car,
        cars,
        reservations,
        outGateCars,
        world,
        nextFrame,
        dtS,
        clipWarnings,
        ghostPasses,
      ),
    );
  }
  cars = nextCars;

  // ANS_4: cặp nào thoả dung sai `park_clip` thì báo `park_clip` (không phải `collision`),
  // phần còn lại vẫn là lỗi lập trình và dừng mô phỏng như cũ.
  const clipPairs: Warning[] = [];
  const collisionWarnings: Warning[] = [];
  for (const pair of findCollisionPairs(cars.filter((car) => car.state !== 'exited'))) {
    const reasonForward = parkClipReason(lot, pair.a, pair.b, pair.depth_m);
    const reasonBackward =
      reasonForward === null ? parkClipReason(lot, pair.b, pair.a, pair.depth_m) : null;
    const reason = reasonForward ?? reasonBackward;
    if (reason !== null) {
      const mover = reasonForward !== null ? pair.a : pair.b;
      const parked = reasonForward !== null ? pair.b : pair.a;
      clipPairs.push(parkClipWarning(mover, parked, reason, pair.depth_m, nextFrame));
      continue;
    }
    // ANS_13: xuyên > trần hàng nhưng ≤ 0,35 m chỉ có thể do LEO THANG (clipCheck không cho
    // bước nào khác vượt trần) ⇒ báo `park_clip_escalated`, không phải `collision`. Cùng điều
    // kiện hình học (xe đang thao tác × xe đỗ ô kề cùng hàng); vượt 0,35 m vẫn là collision.
    const escForward = parkClipReason(lot, pair.a, pair.b, pair.depth_m, PARK_CLIP_ESCALATED2_MAX_M);
    const escBackward =
      escForward === null
        ? parkClipReason(lot, pair.b, pair.a, pair.depth_m, PARK_CLIP_ESCALATED2_MAX_M)
        : null;
    const escReason = escForward ?? escBackward;
    if (escReason !== null) {
      const mover = escForward !== null ? pair.a : pair.b;
      const parked = escForward !== null ? pair.b : pair.a;
      clipPairs.push(parkClipWarning(mover, parked, escReason, pair.depth_m, nextFrame, true));
      continue;
    }
    const passForward = passClipReason(pair.a, pair.b, pair.depth_m);
    const passBackward = passForward === null ? passClipReason(pair.b, pair.a, pair.depth_m) : null;
    const passReason = passForward ?? passBackward;
    if (passReason !== null) {
      const mover = passForward !== null ? pair.a : pair.b;
      const parked = passForward !== null ? pair.b : pair.a;
      clipPairs.push(parkClipWarning(mover, parked, passReason, pair.depth_m, nextFrame, true));
      continue;
    }
    // P17e: va chạm **trong lúc lách**, và chỉ giữa xe lách với xe nó lách qua, là `ghost_pass`
    // (dung sai có chủ đích, đã đếm), không phải lỗi lập trình.
    // Dung ghost_since_frame !== undefined (dau hieu dang lach con hieu luc), KHONG doi hoi
    // ghostPasses.has(id): khi da lach sang frame ke tiep, xe ra khoi tap duoc chon (da co
    // ghost_since_frame) nhung van dang chong len xe khac cho toi khi di het 1 than xe.
    const ghostingCar =
      pair.a.ghost_since_frame !== undefined
        ? pair.a
        : pair.b.ghost_since_frame !== undefined
          ? pair.b
          : undefined;
    if (ghostingCar !== undefined) {
      clipPairs.push({
        frame: nextFrame,
        kind: 'ghost_pass',
        message:
          `${ghostingCar.id} lách qua ${ghostingCar.id === pair.a.id ? pair.b.id : pair.a.id} ` +
          `(chồng ${round6(pair.depth_m).toFixed(3)} m)`,
        car_id: ghostingCar.id,
      });
      continue;
    }
    collisionWarnings.push({
      frame: nextFrame,
      kind: 'collision',
      message: `${pair.a.id} chồng ${pair.b.id} — lỗi lập trình, tạm dừng mô phỏng (FE §4.4.4)`,
      car_id: pair.a.id,
    });
  }
  warnings = [...warnings, ...clipWarnings, ...clipPairs, ...collisionWarnings];

  const stuck = updateStuck(stuckTrackerFrom(state.cars, nextFrame), cars, nextFrame);
  warnings = [...warnings, ...stuck.warnings];
  cars = cars.map((car) => {
    const entry = stuck.tracker.entries[car.id];
    const still = entry === undefined ? 0 : nextFrame - entry.sinceFrame;
    return still === (car.still_frames ?? 0) ? car : { ...car, still_frames: still };
  });

  cars = withChainLinks(cars);
  return { frame: nextFrame, cars, reservations, rngState, warnings };
}

/**
 * P17 (ANS_37 mục 1): gắn `leader_id`/`follower_id` cho xe chạy trên làn (xe ngay trước/sau cùng làn,
 * trong tầm {@link CHAIN_LEADER_RANGE_M}). Chỉ để debug/UI — không tham gia quyết định chuyển động.
 */
function withChainLinks(cars: readonly CarState[]): CarState[] {
  const leaderOf = new Map<string, string>();
  const followerOf = new Map<string, string>();
  const running = cars.filter((car) => CRUISE_STATES.has(car.state));
  for (const car of running) {
    let best: CarState | undefined;
    let bestAlong = Number.POSITIVE_INFINITY;
    for (const other of cars) {
      if (other.id === car.id || other.state === 'exited' || other.state === 'queued') {
        continue;
      }
      if (!isLeaderCandidate(car, other)) {
        continue;
      }
      const along =
        (other.pose.x - car.pose.x) * Math.cos(car.pose.th) +
        (other.pose.y - car.pose.y) * Math.sin(car.pose.th);
      if (along < bestAlong) {
        bestAlong = along;
        best = other;
      }
    }
    if (best !== undefined) {
      leaderOf.set(car.id, best.id);
      if (!followerOf.has(best.id)) {
        followerOf.set(best.id, car.id);
      }
    }
  }
  return cars.map((car) => {
    const leader = leaderOf.get(car.id);
    const follower = followerOf.get(car.id);
    if (leader === car.leader_id && follower === car.follower_id) {
      return car;
    }
    return { ...car, leader_id: leader, follower_id: follower };
  });
}

/** Thời gian dự phòng thêm khi xét "xe sắp tới vùng lùi ra", giây (TASK_P17d luật 1: `+ 1 s`). */
const EXIT_GAP_SLACK_S = 1;

/**
 * P17m (ANS_32 + TASK_P17d luật 1) — **chấp nhận khoảng trống** trước khi lùi ra khỏi ô.
 *
 * Chỉ cho bắt đầu `leaving_slot` khi vùng quét của **cả thao tác lùi ra** đang trống: không thân
 * xe nào (trừ xe đỗ yên trong ô — vật cản tĩnh đã biết, `park_clip` lo).
 *
 * Trước bản vá này, xe cứ lùi ra bất kể làn có xe, rồi bị `clipCheck`/`yieldSpeedFor` chặn giữa
 * đường lùi ⇒ đứng chắn làn A2 ⇒ kéo cả dòng xe, cuối cùng `ghost_pass` "xuyên" qua xe đỗ.
 * Đo ở B1 (tải gốc): **15/32 lần lách là `leaving_slot`** đứng giữa làn (x ≈ −23…−5).
 *
 * Xe không đủ khoảng trống thì **ở yên trong ô** (`parked`), frame sau thử lại. Trạng thái đó là
 * "chờ ra", đúng TASK_P17d luật 1 — **không** tính là kẹt.
 */
/**
 * Bãi đã dùng ≥ ngần này phần sức chứa ⇒ **bỏ gap-acceptance**, cứ cho xe ra.
 *
 * Vì sao cần một luật "xả": gap-acceptance (luật 1) làm xe trong ô chờ khe, nên khi bãi gần đầy thì
 * **không còn ô trống** và `add_car` bị từ chối (`không còn ô trống phù hợp`). Đo ở C1 tải gốc (60 xe
 * đỗ sẵn + 60 xe vào, đỗ 30–60 s): 2 sự kiện bị từ chối ở frame 5825/5925 — `loadSuites` đỏ.
 *
 * Ngưỡng 0,9 là **thực nghiệm**: đo được 0,9 thì `loadSuites` xanh 13/13; còn "chỉ xả khi kín 100 %"
 * thì vẫn đỏ (lúc đó đã quá muộn — `add_car` bị từ chối trước khi bãi kín), và ngưỡng rộng hơn thì
 * lách tăng.
 *
 * An toàn: khi xả, `exitGapClear` vẫn giữ điều kiện **không xuyên thân xe**; `clipCheck` là chốt cuối
 * của engine nên không thể sinh `collision` (đo 12 kịch bản: 0 va chạm).
 */
const EXIT_GAP_SKIP_OCCUPANCY_RATIO = 0.9;

function exitGapClear(
  lot: LotMap,
  car: CarState,
  exitRoute: Route,
  cars: readonly CarState[],
): boolean {
  // Bãi gần đầy ⇒ đừng chờ khe nữa (`skipLookahead`), NHƯNG **vẫn** phải kiểm "không xuyên thân
  // xe": bỏ luôn phép kiểm đó gây 51 va chạm ở C4. Chỉ nới phần DỰ BÁO, không nới phần hình học.
  const skipLookahead =
    usedSlots(cars).size >= lot.slots.length * EXIT_GAP_SKIP_OCCUPANCY_RATIO;
  const maneuverEnd = exitRoute.maneuver_end_s ?? exitRoute.length_m;
  const zone = maneuverPolygon(
    exitRoute,
    0,
    Math.min(exitRoute.length_m, maneuverEnd + MANEUVER_TAIL_M * car.length),
    car.width,
    car.length,
  );
  // Thời gian cần để lùi ra xong + dự phòng. Xe nào **sắp đi vào** vùng trong khoảng này cũng phải
  // chờ, nếu không nó sẽ ập tới đúng lúc xe đang lùi và cả hai khoá nhau (đo ở B3: `V023` bắt đầu
  // lùi khi vùng trống nhưng 150 frame sau vẫn đứng ở `rs = 0` vì xe khác vừa tới).
  const reverseSeconds = maneuverEnd / MANEUVER_SPEED_MPS + EXIT_GAP_SLACK_S;
  for (const other of cars) {
    if (other.id === car.id || other.state === 'exited') {
      continue;
    }
    // Xe ĐỖ YÊN trong ô là vật cản tĩnh đã biết (`park_clip` xử lý), không phải lý do khoá.
    if (other.state === 'parked') {
      continue;
    }
    if (overlapsPolygon(rectPolygon(carRect(other)), zone)) {
      return false;
    }
    if (skipLookahead) {
      continue;
    }
    // Luật 1 (phần "không xe nào sắp tới"): xe đang chạy mà tới vùng trong `reverseSeconds`.
    if (other.route === undefined || Math.abs(other.v) <= YIELD_CORRIDOR_MIN_SPEED_MPS) {
      continue;
    }
    const reach = Math.abs(other.v) * reverseSeconds + other.length;
    const distance = Math.hypot(other.pose.x - car.pose.x, other.pose.y - car.pose.y);
    if (distance > reach) {
      continue;
    }
    // Chỉ tính khi nó **thật sự đi qua** vùng, không phải chạy ở làn khác.
    const hitsZone = zone.some((corner) => {
      const projection = progressOnRoute(other.route as Route, corner);
      return projection.lateral <= (other.width + car.width) / 2 + 1 && projection.s > (other.route_s ?? 0);
    });
    if (hitsZone) {
      return false;
    }
  }
  return true;
}

/**
 * P17m — vì sao KHÔNG dùng điều tiết cổng vào (`starvationThrottle`).
 *
 * Tôi đã thử (TASK_P17d "chống đói"): giữ xe mới ở cổng khi có xe chờ ra quá lâu. Số lách giảm rất
 * mạnh (tổng 12 kịch bản 380 → 152) **nhưng `loadSuites.test.ts` đỏ 4/13** với
 * `abandoned queue`: xe bị giữ ở cổng quá `QUEUE_WAIT_FRAMES_LIMIT` (500 frame) trong lúc cổng vào
 * trống, đúng định nghĩa "bị bỏ quên". Cộng thêm `unfinished` tăng (xe `queued` ở cuối video).
 *
 * Theo lead review P17m mục 1: nếu xe cuối video còn `queued` thì cách xử là **kéo dài video**
 * (`gen_load_suites.py`, coders khác lo), không phải nới ghost. Vì vậy ở đây bỏ điều tiết, giữ
 * `exitGapClear` + thứ tự toàn phần.
 */

function canStartExit(lot: LotMap, network: RoadNetwork, car: CarState): Route | null {
  if (car.slot === null) {
    return null;
  }
  return buildExitRoute(
    lot,
    network,
    findSlot(lot, car.slot),
    car.desired_speed_mps ?? MIN_SPEED_MPS,
  );
}

/**
 * **Thi hành** `yieldsTo` vào tốc độ (P5f, ANS_coders-2_2).
 *
 * Trả tốc độ tối đa để xe nhường **dừng trước chỗ giao**, hoặc `null` nếu không phải nhường ai.
 *
 * "Gần" định nghĩa bằng **hình học quỹ đạo quét**, không bán kính tuỳ ý: lấy quỹ đạo quét của
 * mình trong quãng phanh + `YIELD_CLEARANCE_M`, và nếu nó giao **thân** xe kia hoặc **quỹ đạo
 * quét kế tiếp** của xe kia thì mới tính. Cùng hàm vùng với `clipCheck`/`maneuverPolygon` nên
 * hai cơ chế không bất đồng.
 *
 * Không dừng giữa đường của xe được đi trước: nếu thân mình **đã nằm trong** quỹ đạo quét của
 * xe kia thì đi tiếp để thoát; nếu bị chặn phía trước không thoát được thì ghi `yield_trapped`
 * (không im lặng).
 */
function yieldSpeedFor(
  _lot: LotMap,
  car: CarState,
  route: Route,
  routeS: number,
  cars: readonly CarState[],
  world: PriorityWorld,
  outGateCars: readonly GateCar[] = [],
): number | null {
  if (car.state === 'parked' || car.state === 'queued' || car.state === 'exited') {
    return null;
  }
  // Xe đã đứng yên vẫn phải được xét: nếu nó **phải nhường** và đang chắn đường xe khác thì
  // vẫn cần biết (và nếu đã nằm trong quỹ đạo xe kia thì phải đi tiếp để thoát).
  const speed = Math.max(Math.abs(car.v), 0.5);
  // Quãng phanh thực tế + khoảng hở an toàn.
  const brakeDistance = (speed * speed) / (2 * MAX_ACCEL_MPS2) + YIELD_CLEARANCE_M;
  if (route.length_m - routeS <= brakeDistance) {
    return null;
  }

  let limit: number | null = null;
  for (const other of cars) {
    if (
      other.id === car.id ||
      other.state === 'exited' ||
      other.state === 'queued' ||
      // Xe đỗ không bao giờ tranh đường: việc không chạm xe đỗ do tuyến đường + `clipCheck` lo.
      // Bỏ qua ở đây là tối ưu chính (bãi đầy 90 xe đỗ làm mỗi frame lấy mẫu hành lang hàng nghìn lần).
      other.state === 'parked'
    ) {
      continue;
    }
    const conflictZones = [...zonesOfCar(car, world), ...zonesOfCar(other, world)];
    if (!yieldsTo(car, other, { ...world, zones: conflictZones })) {
      continue;
    }
    // Tối ưu: xe ở xa thì bỏ qua sớm (lấy mẫu hành lang rất tốn).
    if (
      Math.hypot(car.pose.x - other.pose.x, car.pose.y - other.pose.y) >
      YIELD_LOOKAHEAD_M + 5
    ) {
      continue;
    }
    const otherRect = carRect(other);
    const otherZone = zonesOfCar(other, world);
    // Lead (ANS_11 sau P5f): quỹ đạo quét **kế tiếp của xe được đi trước** phải tính cho MỌI xe đang
    // chạy, không chỉ xe đang giữ đặt chỗ. Xe trên làn không có đặt chỗ nên trước đây xe nhường
    // chỉ thấy THÂN hiện tại của nó, dừng cách 0,2 m rồi bị chính xe kia **cua ngang qua** (đo
    // được ở K7 f944: V002 cua vào A2, V093 đã dừng cách 0,19 m nhưng đuôi V002 quét vào V093).
    // Hành lang = hình bao thân xe dọc lộ trình trong `YIELD_CORRIDOR_AHEAD_M`.
    const otherCorridor: Vec2[][] = [];
    if (
      other.route !== undefined &&
      // Chỉ xe ĐANG CHẠY trên làn. Xe `leaving_slot`/`parking_in` đã có vùng đặt chỗ (khi được cấp)
      // trong `otherZone`; xe chưa được cấp thì CHƯA đi nên không có hành lang — nếu tính thì xe
      // trên làn dừng nhường một xe chưa thể đi (vì vùng đặt chỗ của nó đang chứa chính xe trên
      // làn) ⇒ chờ vòng (đo ở K4: V004 nhường V003, V003 chờ V004 rời vùng).
      (other.state === 'entering' ||
        other.state === 'driving_to_slot' ||
        other.state === 'driving_to_exit') &&
      // P17k: xe ĐANG ĐỨNG YÊN thì KHÔNG có "quỹ đạo kế tiếp" — nó không quét thêm mét nào. Trước
      // bản vá này, hành lang 6 m phía trước của một xe đã dừng vẫn bị coi là vật cản, nên xe khác
      // phanh nhường một khoảng đường trống: đo được ở C4 (V067 đứng `rs=75,4`, pose (−30,4; 3,4),
      // cách V065 **9 m** mà V065 `v = 0`) ⇒ kẹt 150 frame rồi `ghost_pass`. Đây là "chặn ảo":
      // `yieldSpeedFor` chỉ cần xe kia đứng yên tại chỗ, thân nó đã được tính riêng ở `otherRect`.
      // Khi nó nhích lại (v > 0) hành lang tự có lại.
      Math.abs(other.v) > YIELD_CORRIDOR_MIN_SPEED_MPS &&
      // P17k (lead, ANS_31 mục 1): xe đang bị **giữ ở hàng chờ cổng ra** thì không sắp đi vào vùng
      // giao — nó đứng chờ xe trước qua cổng. Nếu tính hành lang của nó thì xe khác phanh nhường
      // một xe đang CHỜ, thành chuỗi chờ (đo ở B1: V056 nhường V045 cách 9 m trong khi V045 bị
      // `GATE_QUEUE_HOLD_M` giữ lại). Chỉ tính hành lang khi nó **thực sự sẽ đi** — đang chạy, hoặc
      // đang bị chặn bởi thứ khác chứ không phải hàng chờ cổng.
      !heldAtOutGate(other, outGateCars)
    ) {
      const otherS = other.route_s ?? 0;
      const corridorEnd = Math.min(other.route.length_m, otherS + YIELD_CORRIDOR_AHEAD_M);
      // Chia hành lang thành các đoạn NGẮN (≤ 1,5 m), mỗi đoạn một bao lồi riêng. Một bao lồi cho
      // cả 6 m lộ trình đang cua phủ cả góc trong của khúc cua (đo ở K5: hành lang V001 từ V_east
      // vào A2 phủ tới V013 cách 7,8 m ⇒ xe vào dừng nhường oan, đứng chặn ngã nhập làn của
      // chính xe ra ⇒ kẹt cả bãi).
      for (let from = otherS; from < corridorEnd; from += YIELD_CORRIDOR_CHUNK_M) {
        otherCorridor.push([
          ...maneuverPolygon(
            other.route,
            from,
            Math.min(corridorEnd, from + YIELD_CORRIDOR_CHUNK_M),
            other.width,
            other.length,
          ),
        ]);
      }
    }
    // Khoảng cách dọc lộ trình của MÌNH tới chỗ thân mình đầu tiên giao thân/hành lang xe kia
    // (lấy mẫu mỗi 0,25 m). Đây là cái thiếu của bản cũ: nó chỉ biết "có giao trong quãng phanh"
    // rồi **giữ nguyên tốc độ hiện tại**, không bao giờ phanh (đo K7: V093 target = 2,78 m/s
    // liên tục tới lúc chạm). Có `d` thì tốc độ cho phép là tốc độ dừng được trước chỗ giao.
    const shapes: Vec2[][] = [rectPolygon(otherRect), ...otherZone.map((z) => [...z]), ...otherCorridor];
    const own = rectPolygon(carRect(car));
    // Đã nằm trong quỹ đạo của xe kia ⇒ phải thoát ra, không dừng giữa đường của nó.
    // Lead (sau ANS_11): tính cả HÀNH LANG của xe kia. Xe nằm TRONG hành lang phía trước của xe
    // được đi trước là xe dẫn đường của nó trên cùng đoạn làn (K5: V013 đỗ chờ trên A2 nằm trong
    // hành lang của V001 sắp nhập A2) — xe sau phải bám theo (`leaderGap`), xe trước KHÔNG được
    // dừng nhường xe đang đứng sau nó, nếu không hai bên chờ nhau (V001 chờ V013, V013 nhường
    // V001) và cả làn A2 + hàng chờ cổng khoá cứng.
    const insideOtherPath =
      overlapsPolygon(own, rectPolygon(otherRect)) ||
      otherZone.some((zone) => overlapsPolygon(own, zone));
    // Lead (sau ANS_11): XE DẪN ĐƯỜNG. Nếu `car` đang nằm trên chính lộ trình phía trước của
    // `other` (cùng làn/đã nhập làn trước nó) thì `car` là xe dẫn đường của `other`: `other` phải
    // bám theo (`leaderGap`), `car` KHÔNG dừng nhường — nếu dừng thì xe đứng chặn đường của chính
    // xe đang chờ mình (K5: V013 đỗ trên A2 trước V001; K7: V093 đã ở trên A2 trước chỗ V002
    // nhập làn). Nhường chỉ áp cho xung đột CẮT/NHẬP làn khi `car` chưa ở phía trước trên đường đi.
    if (isOnRouteAhead(other, car)) {
      continue;
    }
    if (insideOtherPath) {
      continue;
    }
    const near =
      Math.hypot(car.pose.x - other.pose.x, car.pose.y - other.pose.y) <=
      YIELD_LOOKAHEAD_M + YIELD_CORRIDOR_AHEAD_M + 6;
    if (!near) {
      continue;
    }
    const alongLimit = Math.min(YIELD_LOOKAHEAD_M, route.length_m - routeS);
    let conflictAt: number | null = null;
    for (let d = 0.5; d <= alongLimit; d += 0.5) {
      const body = maneuverPolygon(route, routeS + d, routeS + d, car.width, car.length);
      if (shapes.some((shape) => overlapsPolygon([...body], shape))) {
        conflictAt = d;
        break;
      }
    }
    if (conflictAt === null) {
      continue;
    }
    // Còn xa thì phanh dần theo quãng còn lại; tới sát thì dừng hẳn (không tiến tới mức chạm).
    const thisLimit = Math.sqrt(2 * MAX_ACCEL_MPS2 * Math.max(0, conflictAt - YIELD_CLEARANCE_M - 0.5));
    if (thisLimit < 0.3) {
      noteWait(car.id, `yield:${other.id}`);
    }
    limit = Math.min(limit ?? Number.POSITIVE_INFINITY, thisLimit);
  }
  return limit;
}

/**
 * Kẹp va chạm: trả `null` nếu bước đi hợp lệ, một `Warning` `park_clip` nếu phải dung sai,
 * hoặc `'blocked'` nếu phải chặn hẳn.
 *
 * ANS_4: chỉ `parking_in`/`leaving_slot`, chỉ với xe **đã đỗ** ở **ô kề cùng hàng**, chỉ ô
 * hàng 1–2, và độ xuyên ≤ :data:`PARK_CLIP_MAX_DEPTH_M`. Mọi trường hợp khác chặn như cũ.
 *
 * P5f: **ai dừng do :func:`yieldsTo` quyết, và dừng TRƯỚC khi chạm.**
 *
 * Trước P5f hai xe cùng chặn nhau ở mức áp thân ⇒ khoá cứng (xem `REPORT_P10a.md` mục 5). Nay:
 * - Xe **phải nhường** bị chặn khi hình chữ nhật của nó — **nới thêm**
 *   :data:`YIELD_MARGIN_M` — đã chạm xe kia. Nhờ nới, nó dừng hẳn *trước* khi thân chạm thân.
 * - Xe **được đi trước** chỉ bị chặn khi xuyên thật (`COLLISION_EPS_M`).
 *
 * Vì xe nhường luôn dừng sớm hơn `YIELD_MARGIN_M`, xe được đi trước không bao giờ gặp nó ở mức
 * xuyên thân ⇒ không có va chạm, và cũng không có cặp nào cùng dừng.
 *
 * `park_clip` xét trước vì đó là dung sai của ANS_4, không phải tranh chấp ưu tiên.
 */
function clipCheck(
  lot: LotMap,
  car: CarState,
  state: CarStateName,
  proposed: OrientedRect,
  cars: readonly CarState[],
  world: PriorityWorld,
  frame: number,
): Warning | 'blocked' | null {
  const currentRect = carRect(car);
  let pendingEscalation: Warning | null = null;
  for (const other of cars) {
    if (other.id === car.id || other.state === 'exited') {
      continue;
    }
    const otherRect = carRect(other);
    const carDistanceNow = Math.hypot(
      car.pose.x - other.pose.x,
      car.pose.y - other.pose.y,
    );
    const carDistanceAfter = Math.hypot(
      proposed.center[0] - other.pose.x,
      proposed.center[1] - other.pose.y,
    );
    // P5f: "vùng xung đột" = **hợp vùng đặt chỗ của cả hai xe**. Dùng **cùng** tập vùng cho cả
    // hai chiều để `yieldsTo` phản xứng — nếu mỗi chiều chỉ xét vùng của xe kia thì có cặp cả
    // hai đều "đang giữ" ⇒ cả hai cùng nhường ⇒ kẹt (đo được ở K7 f960).
    // KHÔNG đưa thân xe vào tập vùng: thân xe khác nhau ở mỗi chiều nên làm hỏng phản xứng.
    const conflictZones = [...zonesOfCar(car, world), ...zonesOfCar(other, world)];
    const mustYield = yieldsTo(car, other, { ...world, zones: conflictZones });
    // Xe phải nhường giữ khoảng hở; xe được đi trước chỉ bị chặn khi xuyên thật.
    // Lead (sau ANS_13): KHÔNG nới khoảng hở 0,2 m với xe ĐỖ. Xe đỗ là vật cản tĩnh; nới 0,2 m
    // quanh nó biến mọi cú vào ô kề thành "xuyên 0,15 m" dù thân thật chưa chạm (đo: V018 vào
    // S038 báo xuyên 0,149 m nhưng khoảng hở thật còn dương) — gây kẹt vĩnh viễn ở 2/12 seed.
    const blockRect =
      mustYield && other.state !== 'parked' ? inflateRect(proposed, YIELD_CLEARANCE_M) : proposed;
    const depth = penetrationDepth(blockRect, otherRect);
    if (depth <= COLLISION_EPS_M) {
      continue;
    }
    // Lead (sau ANS_11): khoảng hở 0,2 m của xe nhường chỉ được dùng để KHÔNG tiến sát hơn, không
    // được chặn bước đi làm xe nhường XA ra. Trước đây xe phía trước đang chạm xe sau 8 mm không
    // nhúc nhích được vì hình chữ nhật nới của nó luôn "xuyên" xe sau ⇒ cả hai đứng im (đo K4).
    // Cho đi khi thân thật không xuyên quá dung sai và khoảng hở KHÔNG xấu đi so với hiện tại.
    if (mustYield && penetrationDepth(proposed, otherRect) <= COLLISION_EPS_M) {
      const clearanceNow = penetrationDepth(inflateRect(currentRect, YIELD_CLEARANCE_M), otherRect);
      if (depth <= clearanceNow + COLLISION_EPS_M) {
        continue;
      }
    }
    // P5f (ANS_coders-2_3 mục 3): **bước làm TĂNG khoảng cách** được phép khi hai xe **đã chạm**
    // (xuyên thật, dưới `TOUCH_RESOLVE_M`). Đây là sửa nhánh "bước tách ra" cũ — nó đòi
    // `depth <= currentDepth` nhưng phép đo dao động quanh epsilon nên không mở, và cặp đã chạm
    // một lần là khoá vĩnh viễn.
    //
    // Giới hạn chặt để không thành "cho đi xuyên": chỉ áp khi mức xuyên hiện tại **nhỏ**
    // (≤ 1 cm — đúng trạng thái áp thân, không phải va chạm thật), và bước đi phải làm hai tâm
    // **xa nhau hơn**. Bước làm xuyên thêm, hoặc từ trạng thái chưa chạm, vẫn bị chặn như cũ.
    const currentDepth = penetrationDepth(currentRect, otherRect);
    if (
      currentDepth > COLLISION_EPS_M &&
      currentDepth <= TOUCH_RESOLVE_M &&
      carDistanceAfter > carDistanceNow + 1e-9
    ) {
      continue;
    }
    const reason = parkClipReason(lot, { ...car, state }, other, Math.max(depth, 0));
    if (reason !== null) {
      return parkClipWarning({ ...car, state }, other, reason, depth, 0);
    }
    // ANS_13: LEO THANG có điều kiện. Xe `parking_in`/`leaving_slot` không tiến triển ≥ 4 s mà
    // chỉ bị xe ĐỖ ở ô kề cùng hàng chặn thì trần tạm nâng tới 0,35 m — tăng dần theo độ xuyên
    // thực cần (xe chỉ lấn tới chỗ đủ qua), không nhảy thẳng. Phải KHÔNG còn vật cản nào khác:
    // cứ duyệt tiếp hết các xe, chỉ trả cảnh báo leo thang khi không ai khác chặn.
    if (
      (car.still_frames ?? 0) >= PARK_CLIP_ESCALATE_AFTER_FRAMES ||
      (car.clip_escalated_until ?? -1) >= frame
    ) {
      const escalatedReason = parkClipReason(
        lot,
        { ...car, state },
        other,
        Math.max(depth, 0),
        (car.still_frames ?? 0) >= PARK_CLIP_ESCALATE2_AFTER_FRAMES ||
          (car.clip_escalated_until ?? -1) >= frame + TIER2_MARK
          ? PARK_CLIP_ESCALATED2_MAX_M
          : PARK_CLIP_ESCALATED_MAX_M,
      );
      if (escalatedReason !== null) {
        pendingEscalation = parkClipWarning(
          { ...car, state },
          other,
          escalatedReason,
          depth,
          0,
          true,
        );
        continue;
      }
    }
    // P17: xe đang chạy lách xe đỗ — chỉ sau khi đứng ≥ PARK_CLIP_ESCALATE_AFTER_FRAMES.
    if ((car.still_frames ?? 0) >= PARK_CLIP_ESCALATE_AFTER_FRAMES) {
      const passReason = passClipReason({ ...car, state }, other, Math.max(depth, 0));
      if (passReason !== null) {
        pendingEscalation = parkClipWarning({ ...car, state }, other, passReason, depth, 0, true);
        continue;
      }
    }
    noteWait(car.id, `clip:${other.id}`);
    lastClipBlocker = other;
    return 'blocked';
  }
  return pendingEscalation;
}

/** Đứng yên ≥ ngần này frame (6 s) thì xe đủ điều kiện làm VIP phá khoá (P17). */
const VIP_STALL_FRAMES = Number.POSITIVE_INFINITY; // TẮT: VIP bỏ qua ràng buộc mềm gây va chạm hàng loạt ở C2 (P17, REPORT_P17)
/** Bán kính cụm kẹt: trong cụm chỉ xe số hiệu nhỏ nhất làm VIP, m. */
const VIP_RADIUS_M = 20;
const VIP_STATES: ReadonlySet<CarStateName> = new Set<CarStateName>([
  'entering',
  'driving_to_slot',
  'driving_to_exit',
  'parking_in',
  'leaving_slot',
]);

/**
 * P17 — **bảo đảm không khoá cứng theo thiết kế**: trong mỗi cụm xe cùng đứng yên ≥ 6 s, đúng MỘT
 * xe (số hiệu nhỏ nhất, tất định) là VIP: mọi xe khác nhường nó (khoá ưu tiên số 0 trong
 * `yieldsTo`) và nó bỏ qua các ràng buộc MỀM (nhường, lùi nhường, khoảng hở dẫn đường, hàng rào
 * đặt chỗ, cấp vùng khi có xe đang chạy trong vùng). Chỉ còn ràng buộc CỨNG: thân xe không xuyên
 * nhau quá dung sai `park_clip`. Vì vòng chờ nào cũng gồm ≥ 1 xe đứng yên và mọi xe trong cụm chờ
 * một xe sẽ-là-VIP, nên luôn có ít nhất một xe tiến được; hết kẹt thì `still_frames` về 0 và VIP
 * tự mất.
 */
function computeVips(cars: readonly CarState[]): ReadonlySet<string> {
  const stalled = cars.filter(
    (car) => VIP_STATES.has(car.state) && (car.still_frames ?? 0) >= VIP_STALL_FRAMES,
  );
  const vips = new Set<string>();
  for (const car of stalled) {
    const smaller = stalled.some(
      (other) =>
        other.id !== car.id &&
        carNumber(other.id) < carNumber(car.id) &&
        Math.hypot(other.pose.x - car.pose.x, other.pose.y - car.pose.y) <= VIP_RADIUS_M,
    );
    if (!smaller) {
      vips.add(car.id);
    }
  }
  return vips;
}

/** Dấu bậc 2 của `clip_escalated_until` (cộng vào frame hết hạn). */
const TIER2_MARK = 10_000_000;

/** Mọi vùng (đặt chỗ) mà `car` đang giữ — dùng chung cho `yieldsTo`/`clipCheck`. */
function zonesOfCar(car: CarState, world: PriorityWorld): readonly (readonly Vec2[])[] {
  const held = world.reservations
    .filter((reservation) => reservation.car_id === car.id)
    .map((reservation) => reservation.polygon);
  if (held.length > 0) {
    return held;
  }
  // P17 (chống đói): xe `leaving_slot` chưa nhích và chưa được cấp vùng nhưng đã chờ ≥
  // LEAVE_CLAIM_FRAMES thì **tuyên bố** vùng lùi ra của nó. Xe khác trên làn (ưu tiên thấp hơn vì
  // `leaving` thắng `driving_to_slot`) sẽ nhường — dừng TRƯỚC vùng — nên vùng trống dần và xe
  // chờ được cấp đặt chỗ. Trước đây dòng xe vào liên tục khiến xe chờ ra bị bỏ đói (seed fuzz 35).
  if (
    car.state === 'leaving_slot' &&
    (car.still_frames ?? 0) >= LEAVE_CLAIM_FRAMES
  ) {
    const claim = maneuverZoneOf(car);
    if (claim !== null) {
      return [claim];
    }
  }
  return held;
}

/** Số frame đứng yên chờ đặt chỗ ra ô trước khi xe tuyên bố vùng của mình (P17). */
const LEAVE_CLAIM_FRAMES = 25;

/**
 * Khoảng hở xe **phải nhường** giữ với xe được đi trước, m (P5f).
 *
 * Lớn hơn một bước đi (≈ 0,11 m/frame) để xe nhường dừng hẳn **trước** khi chạm thân, không
 * "nhích tới rồi dừng" từng frame. Nhờ vậy xe được đi trước không bao giờ gặp nó ở mức xuyên.
 */
const YIELD_CLEARANCE_M = 0.2;

/**
 * `car` là XE DẪN ĐƯỜNG của `other`: nằm phía trước trên lộ trình của `other`, cùng chiều.
 *
 * Dùng CHÍNH điều kiện của `leaderGap` (cùng ngưỡng ngang `(w1+w2)/2 + 0,4`, cùng điều kiện cùng
 * chiều) — nếu hai nơi dùng ngưỡng khác nhau thì có cặp mà `other` coi `car` là xe dẫn đường
 * (đứng chờ khoảng hở) trong khi `car` lại phải nhường `other` (K5: V001 coi V014 là xe dẫn
 * đường, V014 vẫn nhường V001 vì lệch ngang 1,43 m > 1,0 m ⇒ chờ nhau).
 */
function isOnRouteAhead(other: CarState, car: CarState): boolean {
  const route = other.route;
  if (route === undefined) {
    return false;
  }
  if (Math.cos(other.pose.th - car.pose.th) <= 0.3) {
    return false;
  }
  const projection = progressOnRoute(route, [car.pose.x, car.pose.y]);
  return (
    projection.lateral <= (car.width + other.width) / 2 + 0.4 &&
    projection.s > (other.route_s ?? 0)
  );
}

/**
 * Quãng quỹ đạo phía trước của xe được đi trước mà xe nhường phải giữ khoảng cách, m.
 * Đủ dài để xe nhường (≈ 2,8 m/s) dừng hẳn trước chỗ xe kia cua ngang qua.
 */
const YIELD_CORRIDOR_AHEAD_M = 6;

/** Độ dài mỗi đoạn hành lang (bao lồi riêng từng đoạn), m. */
const YIELD_CORRIDOR_CHUNK_M = 1.5;

/** Tầm nhìn xa của xe nhường khi tìm chỗ giao với xe được đi trước, m. */
const YIELD_LOOKAHEAD_M = 10;

/**
 * Tốc độ tối thiểu để coi xe kia là "đang chạy" và tính hành lang quỹ đạo phía trước của nó, m/s
 * (P17k).
 *
 * Xe đứng yên chỉ chiếm đúng thân nó — phần đó đã được tính bằng `otherRect`, không cần cộng thêm
 * 6 m đường phía trước. Cộng thêm thì một xe **đã dừng** (ví dụ đang chờ ở làn ra) chặn oan mọi xe
 * cách nó tới 9 m, và những xe đó kẹt 150 frame rồi bị đẩy sang `ghost_pass` (đo ở C4: V067 phải
 * nhường V065 đứng yên cách 9 m). Ngưỡng nhỏ để xe nhích chậm vẫn được tính.
 */
const YIELD_CORRIDOR_MIN_SPEED_MPS = 0.05;

/**
 * Xe có đang bị **giữ ở hàng chờ cổng ra** không (P17k, theo ANS_31 mục 1 của lead).
 *
 * Điều kiện y hệt khối chặn cổng trong `advanceCar`: `driving_to_exit`, còn cách cổng ≤
 * `GATE_QUEUE_HOLD_M`, và `canEnterGate` từ chối vì **có xe khác đang trong cổng**. Khi đó xe này
 * không sắp tiến vào vùng giao nào — nó chờ xe trước qua cổng — nên hành lang 6 m phía trước của nó
 * không được dùng để bắt xe khác nhường (sẽ thành chuỗi chờ: A nhường B, B chờ cổng).
 */
function heldAtOutGate(other: CarState, outGateCars: readonly GateCar[]): boolean {
  if (other.state !== 'driving_to_exit') {
    return false;
  }
  const own = outGateCars.find((candidate) => candidate.id === other.id);
  if (own === undefined || own.distance_m <= 0 || own.distance_m > GATE_QUEUE_HOLD_M) {
    return false;
  }
  return !canEnterGate(outGateCars, other.id).ok;
}

/**
 * Mức xuyên tối đa coi là "áp thân", không phải va chạm thật, m (P5f, ANS_coders-2_3 mục 3).
 *
 * Dùng cho nhánh "bước tách ra": khi hai xe đã chạm ở mức này, cho phép bước **làm xa ra**. Một
 * bước đi thật là ~0,11 m/frame nên 1 cm **không** thể dùng để đi xuyên qua xe khác; nó chỉ đủ
 * để thoát khỏi trạng thái áp thân do sai số bước.
 */
const TOUCH_RESOLVE_M = COLLISION_EPS_M;

/** Giữ leo thang `park_clip` liên tục thêm ngần này frame sau mỗi bước leo thang (tăng dần, ANS_13). */
const PARK_CLIP_ESCALATE_HOLD_FRAMES = 50;

/** Số frame đứng yên liên tục (2 s @ 25 fps) trước khi kích hoạt back-off (ANS_10 mục 1). */
const BACKOFF_AFTER_FRAMES = 50;

/** Tốc độ lùi tối đa, m/s (ANS_10 mục 4: ≤ 1 m/s). */
const BACKOFF_SPEED_MPS = 0.8;

/** Khoảng chặn trước vạch cổng khi lùi, m (ANS_10 mục 2: không lùi qua vạch). */
const GATE_BACKOFF_MARGIN_M = 1;

/** Nới hình chữ nhật thêm `margin` mỗi phía (giữ nguyên tâm/hướng). */
function inflateRect(rect: OrientedRect, margin: number): OrientedRect {
  return {
    center: rect.center,
    heading: rect.heading,
    length: rect.length + 2 * margin,
    width: rect.width + 2 * margin,
  };
}

/**
 * Xe có bị **vùng đặt chỗ D8** của xe khác chặn không (P5f, ANS_P10a mục 2.1 + 5).
 *
 * Đây là nguồn phân xử **duy nhất** cho vùng hẹp (thao tác trong ô, góc cua, nút giao): ai giữ
 * vùng thì được đi trong vùng, ai không giữ thì **không được vào**. Nhờ vậy xe nhường dừng *xa*
 * hơn hẳn mức chạm thân, nên hai xe không bao giờ khoá nhau ở mức áp thân.
 *
 * "Tất cả hoặc không": không vào được cả vùng thì dừng **trước** biên, không lấn một phần.
 * Xe đang ở **trong** vùng của người khác (do vùng được cấp sau khi nó đã vào) vẫn được đi để
 * thoát ra — nếu không sẽ khoá chết tại chỗ.
 */
function reservationBlocks(
  car: CarState,
  proposed: OrientedRect,
  current: OrientedRect,
  world: PriorityWorld,
): boolean {
  for (const reservation of world.reservations) {
    if (reservation.car_id === car.id) {
      continue;
    }
    // P5f: xe đang ở **trong** vùng (do vùng được cấp sau, hoặc do vùng mới phủ rộng ra) vẫn
    // được đi — nhưng chỉ để **thoát ra**. Nếu bước này còn ở trong vùng thì vẫn cho đi tiếp;
    // khi đã ra khỏi vùng rồi mà cố vào lại thì mới chặn.
    const currentlyInside = overlapsPolygon(rectPolygon(current), reservation.polygon);
    const wouldBeInside = overlapsPolygon(rectPolygon(proposed), reservation.polygon);
    if (wouldBeInside && !currentlyInside) {
      return true;
    }
  }
  return false;
}

/** `other` có tâm nằm sau mép đuôi của `car` (theo hướng xe) — tức xe đang theo sau, không chắn đường tiến. */
function isBehind(car: CarState, other: CarState): boolean {
  const along =
    (other.pose.x - car.pose.x) * Math.cos(car.pose.th) +
    (other.pose.y - car.pose.y) * Math.sin(car.pose.th);
  return along < -car.length / 2;
}

/** Bốn đỉnh của hình chữ nhật có hướng, theo chiều kim đồng hồ. */
function rectPolygon(rect: OrientedRect): Vec2[] {
  return [...rectCorners(rect)];
}

/** `rect` (4 đỉnh) có giao `polygon` không. */
function overlapsPolygon(rect: readonly Vec2[], polygon: readonly Vec2[]): boolean {
  return polygonsIntersect([...rect], polygon);
}

const MERGE_CELLS = new WeakMap<RoadNetwork, readonly MergeCell[]>();
const ROUTE_CELL_PASSES = new WeakMap<Route, readonly RouteCellPass[]>();

function cellPassesOf(network: RoadNetwork, route: Route): readonly RouteCellPass[] {
  let passes = ROUTE_CELL_PASSES.get(route);
  if (passes === undefined) {
    let cells = MERGE_CELLS.get(network);
    if (cells === undefined) {
      cells = findMergeCells(network);
      MERGE_CELLS.set(network, cells);
    }
    passes = routeCellPasses(routePositions(route), cells);
    ROUTE_CELL_PASSES.set(route, passes);
  }
  return passes;
}

/** Hai hướng vào nút là cùng một dòng xe (cos > 0,9). */
function sameStream(a: Vec2, b: Vec2): boolean {
  return a[0] * b[0] + a[1] * b[1] > 0.9;
}

/**
 * P17 (ANS_36) — **hộp vàng ở nút nhập làn**. Xe chưa vào vùng nút chỉ vào khi (1) không có xe của
 * DÒNG KHÁC đang nằm trong vùng, và (2) không có xe dòng khác "tới trước" (gần mép vùng hơn, hoặc bằng
 * nhau thì id nhỏ hơn) đang chạy tới. Nhờ vậy xe đầu hàng không dừng trong vùng quét của xe đang cua
 * nhập làn (ca V037/V070: xe đầu hàng A2 đứng ngay điểm nhập, xe từ V_far_w cua vào bị thân nó chặn,
 * còn xe đầu hàng lại chờ chính xe đó ⇒ khoá). Trả giới hạn tốc độ (dừng được trước mép vùng) hoặc `null`.
 *
 * Thứ tự "tới trước" là thứ tự toàn phần ổn định (khoảng cách tới mép, rồi id) và xe nhường đứng yên
 * còn xe được đi thì giảm khoảng cách ⇒ không có vòng chờ giữa hai xe.
 */
function mergeCellLimit(
  network: RoadNetwork,
  car: CarState,
  route: Route,
  routeS: number,
  cars: readonly CarState[],
): number | null {
  if (!CRUISE_STATES.has(car.state)) {
    return null;
  }
  const passes = cellPassesOf(network, route);
  let limit: number | null = null;
  for (const pass of passes) {
    const edgeS = pass.sNode - MERGE_CELL_RADIUS_M;
    const dEdge = edgeS - (routeS + car.length / 2);
    if (dEdge < -0.2 || dEdge > 14) {
      continue;
    }
    let blocked = false;
    for (const other of cars) {
      if (other.id === car.id || !CRUISE_STATES.has(other.state) || other.route === undefined) {
        continue;
      }
      const otherPass = cellPassesOf(network, other.route).find((item) => item.cell.id === pass.cell.id);
      const distToNode = Math.hypot(
        other.pose.x - pass.cell.point[0],
        other.pose.y - pass.cell.point[1],
      );
      const sameDir =
        otherPass !== undefined
          ? sameStream(otherPass.inDir, pass.inDir)
          : Math.cos(other.pose.th - Math.atan2(pass.inDir[1], pass.inDir[0])) > 0.7;
      if (sameDir) {
        continue;
      }
      const otherEdge =
        otherPass === undefined
          ? Number.NEGATIVE_INFINITY
          : otherPass.sNode - MERGE_CELL_RADIUS_M - ((other.route_s ?? 0) + other.length / 2);
      // Đã VÀO vùng: mũi xe qua mép vùng (có lộ trình qua nút) hoặc thân nằm trong vùng (không qua nút).
      const inside =
        otherPass === undefined
          ? distToNode < MERGE_CELL_RADIUS_M + other.length / 2
          : otherEdge <= 0 && other.route_s !== undefined && (other.route_s ?? 0) - other.length / 2 < otherPass.sNode + 1;
      if (inside) {
        noteWait(car.id, `merge_occupant:${other.id}`);
        blocked = true;
        break;
      }
      if (otherPass === undefined) {
        continue;
      }
      const comingFirst =
        otherEdge > -0.2 &&
        otherEdge < 10 &&
        (Math.abs(other.v) > 0.3 || otherEdge < 2) &&
        (otherEdge < dEdge - 1e-6 || (Math.abs(otherEdge - dEdge) <= 1e-6 && other.id < car.id));
      if (comingFirst) {
        noteWait(car.id, `merge_claim:${other.id}`);
        blocked = true;
        break;
      }
    }
    if (blocked) {
      const allowed = Math.sqrt(2 * MAX_ACCEL_MPS2 * Math.max(0, dEdge - 0.4));
      limit = Math.min(limit ?? Number.POSITIVE_INFINITY, allowed);
    }
  }
  return limit;
}

/** Trạng thái chạy trên làn: các xe này mới bám xe/lùi dây chuyền. */
const CRUISE_STATES: ReadonlySet<CarStateName> = new Set<CarStateName>([
  'entering',
  'driving_to_slot',
  'driving_to_exit',
]);

/** Tốc độ lùi dây chuyền, m/s, và khoảng hở tối thiểu giữ khi lùi, m. */
const CHAIN_BACK_SPEED_MPS = 0.8;
const CHAIN_BACK_CLEARANCE_M = 0.1;
/** Xe phía trước được coi là "ngay trước" khi nằm trong cự ly này dọc hướng xe, m. */
const CHAIN_LEADER_RANGE_M = 9;

/** `other` nằm phía TRƯỚC `car` (theo hướng xe), cùng làn (lệch ngang nhỏ), trong tầm. */
function isLeaderCandidate(car: CarState, other: CarState): boolean {
  const dx = other.pose.x - car.pose.x;
  const dy = other.pose.y - car.pose.y;
  const along = dx * Math.cos(car.pose.th) + dy * Math.sin(car.pose.th);
  const across = -dx * Math.sin(car.pose.th) + dy * Math.cos(car.pose.th);
  return (
    along > 0 &&
    along <= CHAIN_LEADER_RANGE_M &&
    Math.abs(across) <= (car.width + other.width) / 2 + 0.6 &&
    Math.cos(car.pose.th - other.pose.th) > 0.3
  );
}

/**
 * P17 (ANS_37 mục 4) — **lùi dây chuyền**. Xe `car` lùi dọc lộ trình của nó khi xe ngay trước đang bị
 * chính nó chặn, hoặc khi xe ngay trước phải lùi mà không lùi được. Chỉ lùi khi phía sau đủ chỗ;
 * không đủ chỗ thì phát `back_demand` cho xe phía sau lùi trước (xe CUỐI chuỗi lùi đầu tiên).
 */
function tryChainBackOff(
  car: CarState,
  cars: readonly CarState[],
  dtS: number,
): CarState | null {
  if (!CRUISE_STATES.has(car.state) || car.route === undefined || car.ghost_from_route_s !== undefined) {
    return null;
  }
  const routeS = car.route_s ?? 0;
  // Chỉ lùi trên đoạn LÀN (đi tiến): không lùi vào đoạn lùi-ra-ô (đầu lộ trình ra) hay đoạn cung vào ô.
  const laneStart = (car.route.maneuver_end_s ?? 0) + 0.5;
  const laneEnd = (car.route.slot_start_s ?? Number.POSITIVE_INFINITY) - 1;
  if (routeS < laneStart + CHAIN_BACK_SPEED_MPS * dtS || routeS > laneEnd) {
    return null;
  }
  const active = cars.filter((other) => other.id !== car.id && other.state !== 'exited');
  let leader: CarState | undefined;
  let leaderAlong = Number.POSITIVE_INFINITY;
  for (const other of active) {
    if (other.state === 'parked' || !isLeaderCandidate(car, other)) {
      continue;
    }
    const along =
      (other.pose.x - car.pose.x) * Math.cos(car.pose.th) +
      (other.pose.y - car.pose.y) * Math.sin(car.pose.th);
    if (along < leaderAlong) {
      leaderAlong = along;
      leader = other;
    }
  }
  const toCandidate = (item: CarState) => ({
    id: item.id,
    blockedBy: item.blocked_by,
    backDemand: item.back_demand,
  });
  const blockerCar =
    car.blocked_by === undefined ? undefined : active.find((other) => other.id === car.blocked_by);
  if (
    !shouldBackOff(
      toCandidate(car),
      leader === undefined ? undefined : toCandidate(leader),
      active.map(toCandidate),
    ) &&
    !shouldYieldByBacking(
      toCandidate(car),
      blockerCar === undefined ? undefined : toCandidate(blockerCar),
    )
  ) {
    return null;
  }
  const step = Math.min(CHAIN_BACK_SPEED_MPS * dtS, routeS);
  const movedTo = routeS - step;
  const positions = routePositions(car.route);
  const sample = pointAtDistance(positions, movedTo);
  const backRect = inflateRect(
    {
      center: [sample.point[0], sample.point[1]] as Vec2,
      heading: sample.heading,
      length: car.length,
      width: car.width,
    },
    CHAIN_BACK_CLEARANCE_M,
  );
  const blocked = active.some(
    (other) => penetrationDepth(backRect, carRect(other)) > COLLISION_EPS_M,
  );
  if (blocked) {
    noteWait(car.id, 'chain_back_blocked');
    return { ...car, v: 0, back_demand: true, blocked_by: undefined };
  }
  noteWait(car.id, 'chain_backing');
  return {
    ...car,
    pose: { x: round6(sample.point[0]), y: round6(sample.point[1]), th: round6(sample.heading) },
    route_s: round6(movedTo),
    v: round6(-CHAIN_BACK_SPEED_MPS),
    back_demand: undefined,
    blocked_by: undefined,
  };
}

function advanceCar(
  lot: LotMap,
  network: RoadNetwork,
  car: CarState,
  cars: readonly CarState[],
  reservations: readonly Reservation[],
  outGateCars: readonly GateCar[],
  world: PriorityWorld,
  nextFrame: number,
  dtS: number,
  clipWarnings: Warning[],
  ghostPasses: ReadonlySet<string> = new Set<string>(),
): CarState {
  const backed = tryChainBackOff(car, cars, dtS);
  if (backed !== null) {
    return backed;
  }
  lastClipBlocker = null;
  const next = advanceCarCore(
    lot,
    network,
    car,
    cars,
    reservations,
    outGateCars,
    world,
    nextFrame,
    dtS,
    clipWarnings,
    ghostPasses,
  );
  // Xe bị chặn bởi thân xe đang nằm SAU nó (cua nhập làn quét vào đầu hàng) ⇒ ghi lại để xe sau lùi.
  const blocker = lastClipBlocker as CarState | null;
  const blockedBy =
    blocker !== null &&
    next.route_s === car.route_s &&
    CRUISE_STATES.has(car.state) &&
    CRUISE_STATES.has(blocker.state) &&
    isBehind(car, blocker)
      ? blocker.id
      : undefined;
  if (blockedBy === next.blocked_by && next.back_demand === undefined) {
    return next;
  }
  return { ...next, blocked_by: blockedBy, back_demand: undefined };
}

function advanceCarCore(
  lot: LotMap,
  network: RoadNetwork,
  car: CarState,
  cars: readonly CarState[],
  reservations: readonly Reservation[],
  outGateCars: readonly GateCar[],
  world: PriorityWorld,
  nextFrame: number,
  dtS: number,
  clipWarnings: Warning[],
  ghostPasses: ReadonlySet<string> = new Set<string>(),
): CarState {
  if (car.state === 'exited' || car.state === 'queued') {
    return car;
  }
  if (car.state === 'parked') {
    if (
      car.park_until_frame !== undefined &&
      nextFrame >= car.park_until_frame
    ) {
      const exitRoute = canStartExit(lot, network, car);
      // P17m (ANS_32 + TASK_P17d luật 1): **chấp nhận khoảng trống trước khi lùi ra.** Chỉ bắt
      // đầu `leaving_slot` khi vùng quét của thao tác lùi ra đang trống. Nếu không, xe **ở yên
      // trong ô** (vẫn `parked`) — đúng luật 1, và trạng thái đó không tính là kẹt.
      //
      if (exitRoute !== null && !exitGapClear(lot, car, exitRoute, cars)) {
        return car;
      }
      if (exitRoute !== null) {
        return {
          ...car,
          state: 'leaving_slot',
          route: exitRoute,
          route_s: 0,
          v: 0,
          park_until_frame: undefined,
        };
      }
    }
    return car;
  }
  if (car.route === undefined) {
    return car;
  }

  const route = car.route;
  const routeS = car.route_s ?? 0;
  const desired = car.desired_speed_mps ?? MIN_SPEED_MPS;
  let state: CarStateName = car.state;
  let targetSpeed = desired;
  const hasReservation = reservations.some((item) => item.car_id === car.id);

  if (state === 'entering') {
    const direction = gateTravelDirection(lot.gates.in);
    if (
      signedDistanceToGate(
        lot.gates.in,
        nosePoint(car.pose.x, car.pose.y, car.pose.th, car.length),
        direction,
      ) <= 0
    ) {
      state = 'driving_to_slot';
    }
  }

  if (state === 'driving_to_slot' && route.slot_start_s !== undefined) {
    if (!hasReservation) {
      const toManeuver = Math.max(0, route.slot_start_s - routeS);
      targetSpeed = Math.min(
        targetSpeed,
        Math.sqrt(2 * 1.5 * toManeuver),
      );
    }
  }

  if ((state === 'parking_in' || state === 'leaving_slot') && !hasReservation) {
    noteWait(car.id, 'need_zone');
    targetSpeed = 0;
  }

  // P17e — **xe lách (ghost pass)**: lưới an toàn cuối cùng, bảo đảm không xe nào kẹt mãi.
  //
  // Khi xe đứng yên đủ lâu và được chọn (tối đa 1 xe mỗi cụm, xem `computeGhostPasses`), nó đi
  // tiếp theo tuyến với tốc độ chậm, **bỏ qua** mọi ràng buộc mềm: nhường (`yieldSpeedFor`), lùi
  // nhường (`backOffTarget`), hàng rào đặt chỗ (`reservationBlocks`), bám xe (`leaderGap`) và chặn
  // va chạm với **đúng những xe đang chặn nó**. Xe khác vẫn nhường nó (đã đưa vào `priorityKey`).
  //
  // Kết thúc khi đã đi thêm ≥ 1 thân xe **và** không còn chồng lấn xe nào — lúc đó quay về luật
  // thường. Mỗi lần lách phát một cảnh báo `ghost_pass` (không phải `collision`).
  // P17e: dang (hoac da) lach thi khong duoc bao backoff_failed nua - da co co che go.
  // Chỉ lách khi **được chọn** (tối đa 1 xe/cụm, xem `computeGhostPasses`) hoặc đang lách dở.
  // KHÔNG dùng `still_frames >= GHOST_AFTER_FRAMES` làm điều kiện: làm vậy mọi xe đứng lâu đều
  // lách, kể cả kịch bản mẫu K1–K8 vốn phải **0 lần lách** (đo được: K4 sinh 82
  // `park_clip_escalated` oan).
  const ghostActive =
    ghostPasses.has(car.id) || car.ghost_from_route_s !== undefined;
  if (ghostActive) {
    const ghostFrom = car.ghost_from_route_s ?? routeS;
    const travelled = routeS - ghostFrom;
    const stillOverlapping = cars.some(
      (other) =>
        other.id !== car.id &&
        other.state !== 'exited' &&
        penetrationDepth(carRect(car), carRect(other)) > COLLISION_EPS_M,
    );
    const finished = travelled >= car.length && !stillOverlapping;
    if (finished) {
      // Xong: về luật bình thường. GIỮ `ghost_since_frame` làm dấu "đã từng lách" để va chạm về
      // sau (nếu còn) được phân loại `ghost_pass` chứ không phải `collision`; chỉ xoá dấu "đang
      // lách" để xe còn được xét lách lại khi kẹt lần nữa.
      return advanceCarCore(lot, network, {
        ...car,
        ghost_from_route_s: undefined,
      }, cars, reservations, outGateCars, world, nextFrame, dtS, clipWarnings, ghostPasses);
    }
    // Đã tới cuối tuyến mà vẫn bị chặn (thường là cổng ra bị khoá): cho xe **rời bãi** luôn thay vì
    // đứng chết ở mốc cuối. Đây là hệ quả tất yếu của "không xe nào kẹt mãi": xe đã đi hết lộ trình
    // thì việc còn lại chỉ là ra khỏi khung.
    if (routeS >= route.length_m - 1e-6) {
      // P17g (lỗi A3 V061): tuyến đích là Ô thì xe phải ĐỖ tại tâm ô, không được `exited`.
      if (route.target.kind === 'slot') {
        const slot = findSlot(lot, route.target.slot);
        return {
          ...car,
          pose: {
            x: round6(slot.center[0]),
            y: round6(slot.center[1]),
            th: round6(slot.heading),
          },
          state: 'parked',
          v: 0,
          ghost_since_frame: car.ghost_since_frame ?? nextFrame,
          ghost_from_route_s: undefined,
          ...(car.park_s === undefined
            ? {}
            : { park_until_frame: nextFrame + Math.round(car.park_s / dtS) }),
        };
      }
      return {
        ...car,
        state: 'exited',
        v: 0,
        ghost_since_frame: car.ghost_since_frame ?? nextFrame,
        ghost_from_route_s: round6(ghostFrom),
      };
    }
    // Luc lach thi bo qua gioi han toc do cua lo trinh (diem doi so / cuoi lo trinh deu co
    // `v_max = 0`, khien xe dung yen VINH VIEN ngay tai do - dung ca B1: xe dao so de lui ra
    // roi khong bao gio qua duoc moc doi so). Tu tich phan thang theo `route_s`.
    const step = Math.min(
      GHOST_SPEED_MPS * dtS,
      Math.max(0, route.length_m - routeS),
    );
    const ghostRouteS = Math.min(route.length_m, routeS + step);
    const ghostPositions = route.points.map((point) => [point.pose.x, point.pose.y] as Vec2);
    const ghostSample = pointAtDistance(ghostPositions, ghostRouteS);
    const result = {
      pose: {
        x: ghostSample.point[0],
        y: ghostSample.point[1],
        th: ghostSample.heading,
      },
      v: step > 0 ? Math.max(0, step / dtS) : 0,
      route_s: ghostRouteS,
      gear: 'forward' as const,
      finished: ghostRouteS >= route.length_m,
    };
    if (result.route_s > routeS) {
      const blockers = cars.filter(
        (other) =>
          other.id !== car.id &&
          other.state !== 'exited' &&
          penetrationDepth(
            {
              center: [result.pose.x, result.pose.y] as Vec2,
              heading: result.pose.th,
              length: car.length,
              width: car.width,
            },
            carRect(other),
          ) > COLLISION_EPS_M,
      );
      if (blockers.length > 0) {
        clipWarnings.push({
          frame: nextFrame,
          kind: 'ghost_pass',
          message:
            `${car.id} lách qua ${blockers.map((b) => b.id).join(',')} ` +
            `(từ frame ${String(car.ghost_since_frame ?? nextFrame)})`,
          car_id: car.id,
        });
      }
    }
    return {
      ...car,
      state,
      pose: {
        x: round6(result.pose.x),
        y: round6(result.pose.y),
        th: round6(result.pose.th),
      },
      route_s: round6(result.route_s),
      v: round6(result.v),
      ghost_since_frame: car.ghost_since_frame ?? nextFrame,
      ghost_from_route_s: round6(ghostFrom),
    };
  }

  // P17m (ANS_32 mục 2): **thứ tự cổng chỉ áp cho xe còn `queued` ngoài bãi.** Xe đã vào bãi
  // (`driving_to_exit`) không chờ "thứ tự cổng" nữa — nó chỉ dừng khi **thật sự có xe đang chiếm
  // đoạn cổng**. Trước đây khối này bắt xe ra phải là "đầu hàng" mới được đi, mà "đầu hàng" tính
  // theo quãng đường còn lại — thước đo đó KHÔNG đồng bộ với `yieldsTo`, nên sinh vòng chờ:
  //   V044 (leaving_slot) chờ cấp vùng ← V045 (làn nam) chờ thứ tự cổng ← V022 (đầu hàng cổng)
  //   nhường claim của V044  ⇒ không ai đi được.
  // Nay bỏ hẳn khái niệm "đầu hàng" cho xe đã vào bãi: chỉ còn ràng buộc VẬT LÝ (không có xe đang
  // nằm trong đoạn cổng), và `clipCheck`/`leaderGap` lo phần không chạm nhau.
  if (state === 'driving_to_exit') {
    const own = outGateCars.find((candidate) => candidate.id === car.id);
    if (
      own !== undefined &&
      own.distance_m > 0 &&
      own.distance_m <= GATE_QUEUE_HOLD_M
    ) {
      const decision = canEnterGate(outGateCars, car.id);
      // Chỉ chặn khi có XE ĐANG CHIẾM đoạn cổng (`occupantId`). `occupantId === null` nghĩa là cổng
      // trống và lý do từ chối chỉ là "mình chưa phải đầu hàng" — đúng thứ tự mà P17m bỏ.
      if (!decision.ok && decision.occupantId !== null) {
        noteWait(car.id, `gate_out:${decision.occupantId}`);
        targetSpeed = 0;
      }
    }
  }

  if (state === 'entering' || state === 'driving_to_slot' || state === 'driving_to_exit') {
    const leader = leaderGap(route, routeS, car, cars, world);
    if (leader !== null) {
      const decision = followSpeed({
        desiredSpeed: targetSpeed,
        leaderSpeed: leader.speed,
        gap: leader.gap,
        carLength: car.length,
      });
      if (decision.targetSpeed < 0.3 && leader.id !== undefined) {
        noteWait(car.id, `leader:${leader.id}`);
      }
      // P17 (ANS_37): bám xe kiểu IDM — giảm tốc êm từ xa, không nhanh hơn xe trước khi đã gần.
      const idmSpeed = idmTargetSpeed(Math.abs(car.v), desired, leader.gap, leader.speed, dtS);
      targetSpeed = Math.min(targetSpeed, decision.targetSpeed, idmSpeed);
    }
  }

  // P17d luật 2 — **thao tác đã bắt đầu thì không bao giờ phải nhường**.
  //
  // Xe đang lùi ra (`leaving_slot`) hoặc đang vào ô (`parking_in`) **giữ** đa giác của mình tới
  // khi xong và mọi xe khác phải dừng trước đa giác đó (do `reservationBlocks` + `clipCheck`).
  // Vì luật 1 (và luật 3 cho xe vào ô) bảo đảm lúc **bắt đầu** không có ai bên trong đa giác,
  // việc cho xe đang thao tác đi tiếp không thể tạo vòng: nó luôn tiến tới `maneuver_end_s` rồi
  // nhả vùng.
  //
  // Không có luật này thì đo được (B1): `V045` chờ vùng `park_in` của `V057` cách 11 m, mà
  // `V057` thì không xong được thao tác ⇒ khoá cứng 7311 frame.
  const isVip = world.vips?.has(car.id) === true;
  const maneuverInProgress =
    (state === 'leaving_slot' && hasReservation) ||
    (state === 'parking_in' && hasReservation);
  const yieldSpeedLimit =
    isVip || maneuverInProgress
      ? null
      : yieldSpeedFor(lot, car, route, routeS, cars, world, outGateCars);
  if (yieldSpeedLimit !== null) {
    targetSpeed = Math.min(targetSpeed, yieldSpeedLimit);
  }
  if (!isVip && !maneuverInProgress) {
    const cellLimit = mergeCellLimit(network, car, route, routeS, cars);
    if (cellLimit !== null) {
      targetSpeed = Math.min(targetSpeed, cellLimit);
    }
  }

  // P5g: lùi nhường khi đứng kẹt. Phải xét được **cả hai** kiểu: mình phải nhường ai (lùi để nó
  // qua) và ai đang phải nhường mình (thì chính nó mới là bên lùi). `backOffTarget` trả `null`
  // nếu không ai trong tầm cần mình nhường.
  // P17d luat 2: dang thao tac thi khong lui nhuong ai.
  const backOff =
    isVip || maneuverInProgress
      ? null
      : backOffTarget(lot, car, route, routeS, cars, world);
  if (backOff !== null) {
    if (backOff.routeS >= routeS - 1e-9) {
      // Đã sát mốc chặn mà vẫn phải nhường ⇒ không gỡ được, phải báo (ANS_10 mục 3).
      // P17e: xe đang/đã được gỡ bằng `ghost pass` thì KHÔNG báo `backoff_failed` nữa. Dùng
      // `ghostActive` (đang lách) hoặc đã từng lách — không dùng ngưỡng `still_frames` trần, vì
      // như vậy sẽ im lặng cả những kịch bản không hề lách (K1–K8).
      if (!ghostActive && car.ghost_since_frame === undefined) {
        clipWarnings.push({
          frame: nextFrame,
          kind: 'stuck',
          message: `${car.id} không lùi được để nhường ${backOff.toward.id} (backoff_failed)`,
          car_id: car.id,
        });
      }
    } else {
      const step = Math.min(BACKOFF_SPEED_MPS * dtS, routeS - backOff.routeS);
      const movedTo = Math.max(backOff.routeS, routeS - step);
      const positions = route.points.map((point) => [point.pose.x, point.pose.y] as Vec2);
      const sample = pointAtDistance(positions, movedTo);
      const backRect = {
        center: [sample.point[0], sample.point[1]] as Vec2,
        heading: sample.heading,
        length: car.length,
        width: car.width,
      };
      // Không được lùi xuyên xe khác, và bước lùi phải làm **xa** xe đang chắn ra — nếu không thì
      // "lùi theo route" có thể lại tiến gần về hình học (route ở đoạn cua). Đo được ở K7:
      // V093 lùi `route_s` 13,37 → 13,34 lại làm nó xuyên V002 0,585 m.
      const blocked = cars.some((other) => {
        if (other.id === car.id || other.state === 'exited') {
          return false;
        }
        const otherRect = carRect(other);
        if (penetrationDepth(backRect, otherRect) > COLLISION_EPS_M) {
          return true;
        }
        const before = Math.hypot(car.pose.x - other.pose.x, car.pose.y - other.pose.y);
        const after = Math.hypot(
          backRect.center[0] - other.pose.x,
          backRect.center[1] - other.pose.y,
        );
        // Chỉ cấm khi bước lùi làm lại **gần** một xe mình đang phải nhường.
        const conflictZones = [...zonesOfCar(car, world), ...zonesOfCar(other, world)];
        return (
          yieldsTo(car, other, { ...world, zones: conflictZones }) && after < before - 1e-9
        );
      });
      if (!blocked) {
        clipWarnings.push({
          frame: nextFrame,
          kind: 'stuck',
          message: `${car.id} lùi ${round6(routeS - movedTo).toFixed(2)} m nhường ${backOff.toward.id} (backoff)`,
          car_id: car.id,
        });
        return {
          ...car,
          pose: {
            x: round6(sample.point[0]),
            y: round6(sample.point[1]),
            th: round6(sample.heading),
          },
          route_s: round6(movedTo),
          v: round6(-Math.min(BACKOFF_SPEED_MPS, Math.abs(car.v) + MAX_ACCEL_MPS2 * dtS)),
          state,
        };
      }
    }
  }

  let escalatedUntil: number | undefined;
  const result = advanceAlongRoute(route, routeS, car.pose, car.v, targetSpeed, dtS);

  if (result.route_s > routeS) {
    const leader = leaderGap(route, result.route_s, car, cars, world);
    if (leader !== null && leader.gap < MIN_GAP_M - 1e-9) {
      return { ...car, pose: car.pose, v: 0, route_s: routeS, state };
    }
    // Kẹp tuyệt đối: không để hình chữ nhật xe chồng lên xe khác — trừ dung sai `park_clip`
    // đúng phạm vi ANS_4 (xe đã đỗ ở ô kề cùng hàng, hàng 1–2, sâu ≤ 0,5 m).
    const proposed = {
      center: [result.pose.x, result.pose.y] as Vec2,
      heading: result.pose.th,
      length: car.length,
      width: car.width,
    };
    const current = carRect(car);
    // P5f: **vùng đặt chỗ D8 là hàng rào**: không vào vùng người khác đang giữ. Đây là chỗ phân
    // xử cho vùng hẹp (thao tác trong ô, góc cua, nút giao — ANS_P10a mục 5), nên xe nhường
    // dừng **trước biên** vùng, không bao giờ tiến tới mức chạm thân.
    if (!isVip && !maneuverInProgress && reservationBlocks(car, proposed, current, world)) {
      noteWait(car.id, 'reservation');
      return { ...car, pose: car.pose, v: 0, route_s: routeS, state };
    }
    const clip = clipCheck(lot, car, state, proposed, cars, world, nextFrame);
    if (clip === 'blocked') {
      return { ...car, pose: car.pose, v: 0, route_s: routeS, state };
    }
    if (clip !== null) {
      clipWarnings.push({ ...clip, frame: nextFrame });
      if (clip.kind === 'park_clip_escalated') {
        escalatedUntil =
          nextFrame +
          PARK_CLIP_ESCALATE_HOLD_FRAMES +
          // Bậc 2 (đã lấn > trần bậc 1) được giữ bằng dấu `TIER2_MARK` để xe không bị chặn lại
          // giữa chừng khi `still_frames` về 0 lúc nhích.
          ((clip.depth_m ?? 0) > PARK_CLIP_ESCALATED_MAX_M ||
          (car.clip_escalated_until ?? -1) >= nextFrame + TIER2_MARK - PARK_CLIP_ESCALATE_HOLD_FRAMES
            ? TIER2_MARK
            : 0);
      }
    }
  }

  if (
    state === 'driving_to_slot' &&
    route.slot_start_s !== undefined &&
    !hasReservation &&
    result.route_s > route.slot_start_s
  ) {
    return { ...car, pose: car.pose, v: 0, route_s: routeS, state };
  }

  let nextCar: CarState = {
    ...car,
    pose: result.pose,
    v: result.v,
    route_s: result.route_s,
    state,
    ...(escalatedUntil === undefined ? {} : { clip_escalated_until: escalatedUntil }),
  };

  if (state === 'entering') {
    const direction = gateTravelDirection(lot.gates.in);
    if (
      signedDistanceToGate(
        lot.gates.in,
        nosePoint(result.pose.x, result.pose.y, result.pose.th, car.length),
        direction,
      ) <= 0
    ) {
      nextCar = { ...nextCar, state: 'driving_to_slot' };
    }
  }

  if (
    state === 'leaving_slot' &&
    route.maneuver_end_s !== undefined &&
    result.route_s >= route.maneuver_end_s - 0.3
  ) {
    nextCar = {
      ...nextCar,
      state: 'driving_to_exit',
      route_s: Math.max(result.route_s, route.maneuver_end_s),
    };
  }

  if (result.finished) {
    if (route.target.kind === 'slot') {
      const slot = findSlot(lot, route.target.slot);
      const parkUntil =
        car.park_s === undefined
          ? undefined
          : nextFrame + Math.round(car.park_s / dtS);
      nextCar = {
        ...nextCar,
        pose: {
          x: round6(slot.center[0]),
          y: round6(slot.center[1]),
          th: round6(slot.heading),
        },
        v: 0,
        state: 'parked',
        ...(parkUntil === undefined ? {} : { park_until_frame: parkUntil }),
      };
    } else {
      nextCar = { ...nextCar, v: 0, state: 'exited' };
    }
  }

  return nextCar;
}
