/**
 * Lõi mô phỏng (FE §4). File này chỉ là cửa ngõ import cho các lớp khác.
 *
 * R3: thư mục `src/sim/` cấm import `three`, `react`, DOM, `Math.random`, `Date.now`,
 * `performance.now` — ESLint chặn (xem `eslint.config.js`).
 *
 * P5 đã cài đặt phần thân: `contracts/sim.ts` uỷ quyền cho `engine.ts` và
 * `gtCompute.ts`; các lớp khác chỉ cần import từ file này.
 */

export {
  createState,
  step,
  gtRow,
  gtEvents,
  isHalted,
  SimError,
  notImplemented,
  DT_S,
  FPS,
  CAR_DIMENSIONS_M,
  CAR_COLORS,
  CAR_COLOR_HEX,
} from '../contracts/sim';
export {
  buildRoadNetwork,
  roadNetworkOf,
  gateAisleIds,
  lGateViolations,
  findPath,
  slotAccess,
  slotDepth,
} from './network';
export type { RoadNetwork, RoadNode, RoadEdge, SlotAccess, LGateViolation } from './network';
export type {
  CarState,
  CarModel,
  CarColor,
  CarStateName,
  Pose,
  Route,
  RoutePoint,
  Reservation,
  Warning,
  WarningKind,
  RngStreams,
  RngStreamName,
  SimState,
  SimHistory,
  EventsAtFrame,
  EnvAtFrame,
} from '../contracts/sim';