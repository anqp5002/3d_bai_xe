/**
 * Mạng đường đi trừu tượng dựng từ `LotMap.aisles` (FE §4.3, D6).
 *
 * Không hard-code tên làn: đỉnh polyline trùng nhau (sai ≤ 1 mm) được coi là cùng
 * một nút; mỗi aisle là **một chiều** nên cạnh có hướng. Nhờ vậy khi P2b sinh lại
 * `lot_pucpr.json` chỉ cần đổi dữ liệu, không sửa module này.
 *
 * Lộ trình vào/ra một ô được dựng từ hình học:
 * - xe vào ô **tiến** theo cung 1/4 đường tròn bán kính = khoảng cách vuông góc
 *   từ tâm ô tới tim làn (cung bắt đầu trước tâm ô đúng bán kính để tiếp tuyến
 *   trùng chiều làn);
 * - xe ra ô **lùi** đúng cung đó (ngược lại), tới tim làn thì quay đầu theo làn.
 * Đây là "interface đường đi" mà `engine.ts` dùng — không biết tên làn cụ thể.
 */

import type { Aisle, Gate, LotMap, Slot, Vec2 } from '../contracts/lot';
import type { Route, RoutePoint } from '../contracts/sim';
import { segmentsIntersect } from './collision';
import {
  arcPoints,
  clonePoint,
  distance,
  nearestPointOnSegment,
  normalizeAngle,
  polylineLength,
  round6,
  segmentSegmentDistance,
} from './geometry';

/** Bán kính quay tối thiểu theo FE §4.3 (mô hình xe đạp, góc lái 35°). */
export const MIN_TURN_RADIUS_M = 4;
/** Tốc độ tối đa khi thao tác trong ô, m/s (≤ 5 km/h theo FE §4.3). */
export const MANEUVER_SPEED_MPS = 5 / 3.6;
/** Số đoạn chia cung 1/4 vòng khi vào/ra ô. */
export const ARC_SEGMENTS = 16;
/** Bán kính cung lớn nhất dùng cho thao tác vào/ra ô, m (giữ cung trong dải làn). */
export const MAX_ARC_RADIUS_M = 6;
/**
 * Bước tối đa giữa hai điểm liền tiếp của lộ trình, m (P5e).
 *
 * Bộ bám đường nhìn xa 1,8 m; để điểm nhìn không rơi vào "hố" giữa hai điểm xa nhau, mọi đoạn
 * phải ≤ giá trị này. Chia nhỏ **không đổi hình học** đường đi, chỉ thêm điểm trên cùng đoạn.
 */
export const MAX_ROUTE_STEP_M = 0.9;
/** Bán kính cung nhỏ nhất dùng cho thao tác vào/ra ô, m. */
export const MIN_ARC_RADIUS_M = 0.5;
/**
 * Khoảng hở (m) giữa điểm cuối cung và miệng ô, để thân xe (dài ~5 m) không quét vào ô
 * hàng xóm khi đang quay. Đây là chỗ P2b sai: cung kết thúc **tại tâm ô** nên xe quay ngay
 * trong dải ô, quét sang hai bên.
 */
export const APPROACH_CLEARANCE_M = 1.2;

export interface RoadNode {
  readonly id: string;
  readonly point: Vec2;
}

/** Cạnh có hướng giữa hai đỉnh polyline liên tiếp của một aisle. */
export interface RoadEdge {
  readonly id: string;
  readonly aisle_id: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly [Vec2, Vec2];
  readonly length_m: number;
}

export interface RoadNetwork {
  readonly nodes: readonly RoadNode[];
  readonly nodeById: ReadonlyMap<string, RoadNode>;
  readonly edges: readonly RoadEdge[];
  readonly outgoing: ReadonlyMap<string, readonly RoadEdge[]>;
}

const NODE_TOLERANCE_DIGITS = 3;

function nodeKey(point: Vec2): string {
  return `${point[0].toFixed(NODE_TOLERANCE_DIGITS)},${point[1].toFixed(NODE_TOLERANCE_DIGITS)}`;
}

function addNode(
  nodes: RoadNode[],
  nodeById: Map<string, RoadNode>,
  point: Vec2,
): RoadNode {
  const key = nodeKey(point);
  const existing = nodeById.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const node: RoadNode = { id: key, point: [round6(point[0]), round6(point[1])] };
  nodes.push(node);
  nodeById.set(key, node);
  return node;
}

/** Dựng mạng có hướng từ danh sách aisle (thuần dữ liệu, tất định). */
export function buildRoadNetwork(lot: LotMap): RoadNetwork {
  const nodes: RoadNode[] = [];
  const nodeById = new Map<string, RoadNode>();
  const edges: RoadEdge[] = [];
  for (const aisle of lot.aisles) {
    for (let index = 1; index < aisle.polyline.length; index += 1) {
      const a = addNode(nodes, nodeById, aisle.polyline[index - 1]);
      const b = addNode(nodes, nodeById, aisle.polyline[index]);
      const length = distance(a.point, b.point);
      if (length <= 1e-9 || a.id === b.id) {
        continue;
      }
      edges.push({
        id: `${aisle.id}#${index - 1}`,
        aisle_id: aisle.id,
        from: a.id,
        to: b.id,
        points: [a.point, b.point],
        length_m: length,
      });
    }
  }
  const outgoing = new Map<string, RoadEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from);
    if (list === undefined) {
      outgoing.set(edge.from, [edge]);
    } else {
      list.push(edge);
    }
  }
  return { nodes, nodeById, edges, outgoing };
}

const NETWORK_CACHE = new WeakMap<LotMap, RoadNetwork>();

/** Bản mạng dùng lại cho cùng một object `lot` (không quan sát được từ ngoài). */
export function roadNetworkOf(lot: LotMap): RoadNetwork {
  const cached = NETWORK_CACHE.get(lot);
  if (cached !== undefined) {
    return cached;
  }
  const network = buildRoadNetwork(lot);
  NETWORK_CACHE.set(lot, network);
  return network;
}

/** Nút gần một điểm nhất (tie-break theo id để tất định). */
export function nearestNode(network: RoadNetwork, point: Vec2): RoadNode {
  if (network.nodes.length === 0) {
    throw new Error('nearestNode: mạng rỗng — lot chưa có aisle');
  }
  let best = network.nodes[0];
  let bestDistance = distance(best.point, point);
  for (const node of network.nodes) {
    const candidate = distance(node.point, point);
    if (candidate < bestDistance || (candidate === bestDistance && node.id < best.id)) {
      best = node;
      bestDistance = candidate;
    }
  }
  return best;
}

export interface RoadPath {
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
  readonly length_m: number;
}

/**
 * Đường đi ngắn nhất trên đồ thị có hướng (Dijkstra, tie-break theo id nút).
 * Trả `null` nếu không tới được — không im lặng trả đường giả (R2).
 */
export function findPath(
  network: RoadNetwork,
  fromId: string,
  toId: string,
): RoadPath | null {
  if (!network.nodeById.has(fromId) || !network.nodeById.has(toId)) {
    return null;
  }
  if (fromId === toId) {
    return { nodes: [network.nodeById.get(fromId)!], edges: [], length_m: 0 };
  }
  const distances = new Map<string, number>();
  const previous = new Map<string, { node: string; edge: RoadEdge }>();
  const visited = new Set<string>();
  distances.set(fromId, 0);
  for (;;) {
    let current: string | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const [nodeId, value] of distances) {
      if (visited.has(nodeId)) {
        continue;
      }
      if (value < currentDistance || (value === currentDistance && current !== null && nodeId < current)) {
        current = nodeId;
        currentDistance = value;
      }
    }
    if (current === null) {
      break;
    }
    visited.add(current);
    if (current === toId) {
      break;
    }
    for (const edge of network.outgoing.get(current) ?? []) {
      const candidate = currentDistance + edge.length_m;
      const existing = distances.get(edge.to);
      if (existing === undefined || candidate < existing) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, { node: current, edge });
      }
    }
  }
  if (!distances.has(toId) || !visited.has(toId)) {
    return null;
  }
  const nodeIds: string[] = [toId];
  const edges: RoadEdge[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = previous.get(cursor);
    if (step === undefined) {
      return null;
    }
    edges.push(step.edge);
    nodeIds.push(step.node);
    cursor = step.node;
  }
  nodeIds.reverse();
  edges.reverse();
  return {
    nodes: nodeIds.map((id) => network.nodeById.get(id)!),
    edges,
    length_m: edges.reduce((total, edge) => total + edge.length_m, 0),
  };
}

/** Nút gần tim đoạn cổng nhất — điểm nối mạng đường với cổng. */
export function gateNode(network: RoadNetwork, gate: Gate): RoadNode {
  const midpoint: Vec2 = [(gate.p1[0] + gate.p2[0]) / 2, (gate.p1[1] + gate.p2[1]) / 2];
  return nearestNode(network, midpoint);
}

/** Trung điểm đoạn cổng. */
export function gateMidpoint(gate: Gate): Vec2 {
  return [(gate.p1[0] + gate.p2[0]) / 2, (gate.p1[1] + gate.p2[1]) / 2];
}

/** Hướng đi qua cổng (từ `spawn` vào bãi), dùng để tính khoảng cách có dấu. */
export function gateTravelDirection(gate: Gate): Vec2 {
  const dx = gate.despawn[0] - gate.spawn[0];
  const dy = gate.despawn[1] - gate.spawn[1];
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) {
    throw new Error('gateTravelDirection: spawn và despawn trùng nhau');
  }
  return [dx / length, dy / length];
}

/** Một điểm trên cung vào/ra kèm hướng mũi xe (tiếp tuyến chiều tiến của cung). */
export interface ArcSample {
  readonly point: Vec2;
  readonly heading: number;
}

/** Phần hình học của thao tác vào/ra một ô. */
export interface SlotAccess {
  readonly slot: Slot;
  readonly edge: RoadEdge;
  readonly aisle_id: string;
  /** Hình chiếu tâm ô lên tim làn. */
  readonly attach: Vec2;
  /** Tiếp tuyến làn tại `attach` (chiều đi của làn). */
  readonly tangent: Vec2;
  /** Pháp tuyến từ tim làn tới tâm ô. */
  readonly normal: Vec2;
  /** Bán kính cung thực dùng (≤ khoảng cách tới tâm ô). */
  readonly radius_m: number;
  /** Cung S → tâm ô (rỗng nếu phải đi thẳng). */
  readonly arc: readonly ArcSample[];
}

/** Số đoạn chia đoạn thẳng nối cung với tâm ô. */
export const APPROACH_SEGMENTS = 12;

/**
 * Độ sâu ô (m) — cạnh dài của hình chữ nhật.
 *
 * Dùng để biết mép ô (miệng ô) nằm ở đâu: tâm ô lùi vào trong `depth/2` tính từ miệng.
 */
function slotDepthM(slot: Slot): number {
  let depth = 0;
  for (let index = 0; index < slot.polygon.length; index += 1) {
    const a = slot.polygon[index];
    const b = slot.polygon[(index + 1) % slot.polygon.length];
    depth = Math.max(depth, distance(a, b));
  }
  return depth;
}

/** Độ sâu ô (cạnh dài của hình chữ nhật), m. */
export function slotDepth(slot: Slot): number {
  return slotDepthM(slot);
}

/** Cạnh có hướng gần tâm ô nhất, kèm hình chiếu lên cạnh. */
function nearestEdgeToSlot(
  network: RoadNetwork,
  slot: Slot,
): { edge: RoadEdge; attach: Vec2 } {
  let bestEdge: RoadEdge | null = null;
  let bestAttach: Vec2 = [0, 0];
  let bestDistance = Number.POSITIVE_INFINITY;
  // Lead (sau ANS_11): ô cuối hàng nằm sát làn dọc (S088 cạnh V_east_s) bị chọn nhầm làn dọc đó
  // vì nó GẦN tâm ô hơn làn ở phía miệng ô; xe vào ô từ bên hông rồi đảo chiều (cusp 2 rad trong
  // 1,6 m), cung không bao giờ thẳng trục ô và xe kẹt `parking_in` ở mọi seed. Làn dùng để vào ô
  // phải (1) vuông góc với trục ô và (2) nằm ở phía MIỆNG ô.
  const axis: Vec2 = [Math.cos(slot.heading), Math.sin(slot.heading)];
  const facing = network.edges.filter((edge) => {
    const dx = edge.points[1][0] - edge.points[0][0];
    const dy = edge.points[1][1] - edge.points[0][1];
    const length = Math.hypot(dx, dy);
    if (length <= 1e-9) {
      return false;
    }
    if (Math.abs((dx * axis[0] + dy * axis[1]) / length) > 0.5) {
      return false;
    }
    const attach = nearestPointOnSegment(edge.points[0], edge.points[1], slot.center);
    return (attach[0] - slot.center[0]) * axis[0] + (attach[1] - slot.center[1]) * axis[1] < 0;
  });
  const candidates = facing.length > 0 ? facing : network.edges;
  for (const edge of candidates) {
    const attach = nearestPointOnSegment(edge.points[0], edge.points[1], slot.center);
    const candidate = distance(attach, slot.center);
    if (
      candidate < bestDistance ||
      (candidate === bestDistance &&
        (bestEdge === null || edge.id < bestEdge.id))
    ) {
      bestDistance = candidate;
      bestEdge = edge;
      bestAttach = attach;
    }
  }
  if (bestEdge === null) {
    throw new Error(`slotAccess: bãi "${slot.id}" chưa có aisle nào`);
  }
  return { edge: bestEdge, attach: bestAttach };
}

/**
 * Hình học thao tác vào/ra ô trên **làn gần nhất** (P5c: viết lại).
 *
 * Vấn đề của bản P2b: cung 1/4 vòng bán kính ~5,4 m nên **thân xe quay ngay bên trong ô**,
 * quét sang ô hàng xóm. Bãi này có bước ô 2,19–2,85 m trong khi chiều dài xe 4,7–5,2 m:
 * một vật cứng quay 90° cần **bề rộng ≥ đường chéo xe** (5,0–5,6 m), nên **không thể** quay
 * trong dải ô. Vì vậy cung phải nằm **hoàn toàn phía làn** (trước miệng ô), và đoạn cuối đi
 * **thẳng theo trục ô** — đúng cách lái thật: tiến/lùi thẳng vào ô, không bẻ lái trong ô.
 *
 * Hình học:
 * 1. Cung 1/4 vòng bán kính `R` kết thúc **tại miệng ô** (mép ngoài đa giác), phương của xe
 *    lúc đó trùng trục ô.
 * 2. Đoạn thẳng dài `depth/2` từ miệng ô vào tâm ô.
 *
 * `R` lấy lớn nhất có thể nhưng vẫn để cung nằm trong dải làn: `R = min(D − depth/2, MAX)` với
 * `D` = khoảng cách tâm ô → tim làn. Cung không bao giờ lấn vào dải ô (nơi có xe đỗ).
 */
export function slotAccess(network: RoadNetwork, slot: Slot): SlotAccess {
  const { edge, attach } = nearestEdgeToSlot(network, slot);
  const tangentRaw: Vec2 = [
    edge.points[1][0] - edge.points[0][0],
    edge.points[1][1] - edge.points[0][1],
  ];
  const edgeLength = Math.hypot(tangentRaw[0], tangentRaw[1]);
  if (edgeLength <= 1e-9) {
    throw new Error(`slotAccess: cạnh ${edge.id} dài 0`);
  }
  const tangent: Vec2 = [tangentRaw[0] / edgeLength, tangentRaw[1] / edgeLength];
  const toCenter: Vec2 = [slot.center[0] - attach[0], slot.center[1] - attach[1]];
  const centerDistance = Math.hypot(toCenter[0], toCenter[1]);
  if (centerDistance <= 1e-9) {
    throw new Error(`slotAccess: tâm ô ${slot.id} nằm đúng trên tim làn`);
  }
  const normal: Vec2 = [toCenter[0] / centerDistance, toCenter[1] / centerDistance];
  const depth = slotDepthM(slot);
  // Bán kính cung có **hai** ràng buộc đối nghịch:
  // 1. **≥ MIN_TURN_RADIUS_M** (3,856 m) — nếu nhỏ hơn, xe đạp 35° không bám được cung. Đây là
  //    lỗi gốc P5d: cung 0,953 m làm xe trượt 2,075 m rồi lấn 0,79 m.
  // 2. **≤ dải trống phía làn** — nếu lớn hơn, cung quét sang dải ô của hàng đối diện
  //    (đo được: bán kính 4 m ở hàng 1 ⇒ 21/22 cung va xe hàng 2).
  //
  // Hàng 1–2 có dải trống 3,54 m < 3,856 m ⇒ **hai ràng buộc không thể đồng thời thoả**. Đó là
  // bất khả thi hình học thật (đã chứng minh ở `ASK_coders-2_2.md`), nên ở đây chọn **ưu tiên
  // (1)**: cung khả thi để xe bám được, phần lấn sang ô kề do `park_clip` hứng với ngưỡng 0,5 m
  // của ANS_5. Hàng 3–5 dải rộng nên cả hai ràng buộc đều thoả.
  const mouthDistance = Math.max(centerDistance - depth / 2, 0.5);
  // Điểm cuối của cung = miệng ô, KHÔNG phải tâm ô. Dùng **trục ô** (`slot.heading`).
  const axis: Vec2 = [Math.cos(slot.heading), Math.sin(slot.heading)];
  const mouth: Vec2 = [
    slot.center[0] - axis[0] * (depth / 2),
    slot.center[1] - axis[1] * (depth / 2),
  ];
  // P5e (a) — bán kính phải **≥ MIN_TURN_RADIUS_M** để xe đạp 35° bám được cung. Dùng đúng
  // `MIN_TURN_RADIUS_M` cho mọi ô (đo được đây là phương án ổn định nhất qua 5 seed); phần chênh
  // so với `mouthDistance` được xử lý bằng **chèn điểm nối ≤ 0,9 m** ở dưới nên không có bước
  // nhảy, và hướng xe vẫn tới được trục ô.
  const radius = Math.max(
    Math.min(Math.max(mouthDistance, MIN_TURN_RADIUS_M), MAX_ARC_RADIUS_M),
    MIN_ARC_RADIUS_M,
  );
  const start: Vec2 = [
    attach[0] - tangent[0] * radius,
    attach[1] - tangent[1] * radius,
  ];
  const circleCenter: Vec2 = [
    start[0] + normal[0] * radius,
    start[1] + normal[1] * radius,
  ];

  const cross = tangent[0] * normal[1] - tangent[1] * normal[0];
  const arc: ArcSample[] = [];
  if (Math.abs(cross) > 1e-9) {
    const startAngle = Math.atan2(start[1] - circleCenter[1], start[0] - circleCenter[0]);
    const sweep = cross > 0 ? Math.PI / 2 : -Math.PI / 2;
    const points = arcPoints(circleCenter, radius, startAngle, sweep, ARC_SEGMENTS);
    const forward = cross > 0 ? 1 : -1;
    for (let index = 0; index < points.length; index += 1) {
      const angle = startAngle + (sweep * index) / ARC_SEGMENTS;
      arc.push({
        point: points[index],
        heading: normalizeAngle(angle + (forward > 0 ? Math.PI / 2 : -Math.PI / 2)),
      });
    }
    // Bỏ mẫu cuối của cung nếu nó đã lấn vào ô.
    while (arc.length > 1) {
      const tail = arc[arc.length - 1];
      const tailDistance = Math.hypot(
        tail.point[0] - slot.center[0],
        tail.point[1] - slot.center[1],
      );
      if (tailDistance >= depth / 2 - 1e-9) {
        break;
      }
      arc.pop();
    }
    // P5e (3): **không được để bước nhảy** giữa điểm cuối cung và miệng ô. Với ô mà làn nằm
    // rất sát miệng ô (S090: radius 1,93 m, `attach` gần như trùng miệng), cung bị cắt còn
    // 1–2 điểm nên đoạn nối dài ~5,5 m ⇒ `advanceAlongRoute` nhìn xa 1,8 m rơi vào giữa đoạn
    // nhảy và xe đứng yên. Chèn điểm trung gian sao cho **mỗi đoạn ≤ 0,9 m**.
    const tail = arc[arc.length - 1];
    const jump = Math.hypot(tail.point[0] - mouth[0], tail.point[1] - mouth[1]);
    const MAX_STEP_M = 0.9;
    const pieces = Math.max(1, Math.ceil(jump / MAX_STEP_M));
    for (let k = 1; k < pieces; k += 1) {
      const t = k / pieces;
      arc.push({
        point: [
          tail.point[0] + (mouth[0] - tail.point[0]) * t,
          tail.point[1] + (mouth[1] - tail.point[1]) * t,
        ] as Vec2,
        heading: slot.heading,
      });
    }
    arc.push({ point: mouth, heading: slot.heading });
  } else {
    arc.push(
      { point: start, heading: slot.heading },
      { point: mouth, heading: slot.heading },
    );
  }
  return {
    slot,
    edge,
    aisle_id: edge.aisle_id,
    attach,
    tangent,
    normal,
    radius_m: radius,
    arc,
  };
}

function cumulativeAt(points: readonly Vec2[], index: number): number {
  let total = 0;
  for (let cursor = 1; cursor <= index && cursor < points.length; cursor += 1) {
    total += distance(points[cursor - 1], points[cursor]);
  }
  return total;
}

function pushUnique(points: Vec2[], point: Vec2): void {
  const last = points[points.length - 1];
  if (last !== undefined && distance(last, point) <= 1e-9) {
    return;
  }
  points.push(clonePoint(point));
}

/** Dựng `RoutePoint[]` cho một dãy vị trí đã biết (heading lấy theo hướng đi). */
function toForwardRoutePoints(
  positions: readonly Vec2[],
  desiredSpeed: number,
  maneuverFromIndex: number,
  finalHeading: number,
): RoutePoint[] {
  return positions.map((position, index) => {
    const next = positions[index + 1];
    const previous = positions[index - 1];
    const heading =
      next !== undefined
        ? Math.atan2(next[1] - position[1], next[0] - position[0])
        : previous !== undefined
          ? Math.atan2(position[1] - previous[1], position[0] - previous[0])
          : finalHeading;
    const vMax = index >= maneuverFromIndex ? MANEUVER_SPEED_MPS : desiredSpeed;
    return {
      pose: { x: position[0], y: position[1], th: round6(heading) },
      gear: 'forward' as const,
      v_max: vMax,
    };
  });
}

/**
 * Chia mọi đoạn dài của lộ trình thành bước ≤ `MAX_ROUTE_STEP_M`.
 *
 * P5e: bộ bám đường dùng **pure pursuit nhìn xa 1,8 m**. Nếu hai điểm liền tiếp cách nhau 8–47 m
 * (đo được trên route S092), điểm nhìn rơi vào **giữa đoạn thẳng** nên góc lái bị tính sai và xe
 * có thể đứng yên/trôi. Chia nhỏ chỉ **thêm điểm trên cùng đoạn thẳng** — hình học đường đi không
 * đổi, chỉ giúp bộ điều khiển bám được.
 */
function subdividePositions(positions: readonly Vec2[]): Vec2[] {
  if (positions.length < 2) {
    return [...positions];
  }
  const out: Vec2[] = [positions[0]];
  for (let index = 1; index < positions.length; index += 1) {
    const a = positions[index - 1];
    const b = positions[index];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length <= 1e-9) {
      // Bỏ điểm trùng (cung và đoạn nối có thể trùng nhau ⇒ mẫu bước 0 làm gãy hướng).
      continue;
    }
    const pieces = Math.max(1, Math.ceil(length / MAX_ROUTE_STEP_M));
    for (let k = 1; k <= pieces; k += 1) {
      const t = k / pieces;
      const point: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const last = out[out.length - 1];
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) > 1e-6) {
        out.push(point);
      }
    }
  }
  return out;
}

/**
 * Lộ trình vào ô: cổng vào → làn → cung tiến vào tâm ô.
 * Trả `null` nếu mạng không nối tới làn của ô (không im lặng).
 */
export function buildEntryRoute(
  lot: LotMap,
  network: RoadNetwork,
  slot: Slot,
  desiredSpeed: number,
): Route | null {
  const access = slotAccess(network, slot);
  const entryNode = gateNode(network, lot.gates.in);
  const path = findPath(network, entryNode.id, access.edge.from);
  if (path === null) {
    return null;
  }
  const positions: Vec2[] = [];
  pushUnique(positions, [lot.gates.in.spawn[0], lot.gates.in.spawn[1]]);
  for (const node of path.nodes) {
    pushUnique(positions, node.point);
  }
  const arcStart = access.arc[0];
  if (arcStart !== undefined) {
    pushUnique(positions, arcStart.point);
  }
  const arcStartIndex = positions.length - 1;
  for (const sample of access.arc.slice(1)) {
    pushUnique(positions, sample.point);
  }
  pushUnique(positions, access.slot.center);
  // P5e: chia nhỏ để bộ bám đường (nhìn xa 1,8 m) không bị "nhảy" giữa hai điểm xa nhau.
  const finePositions = subdividePositions(positions);
  const arcStartFine = (() => {
    const startPoint = positions[arcStartIndex];
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let index = 0; index < finePositions.length; index += 1) {
      const d = Math.hypot(
        finePositions[index][0] - startPoint[0],
        finePositions[index][1] - startPoint[1],
      );
      if (d < bestD) {
        bestD = d;
        best = index;
      }
    }
    return best;
  })();
  const points = toForwardRoutePoints(
    finePositions,
    desiredSpeed,
    arcStartFine,
    access.slot.heading,
  );
  points[points.length - 1] = {
    pose: {
      x: round6(access.slot.center[0]),
      y: round6(access.slot.center[1]),
      th: round6(access.slot.heading),
    },
    gear: 'forward',
    v_max: MANEUVER_SPEED_MPS,
  };
  const aisleIds = [...new Set(path.edges.map((edge) => edge.aisle_id))];
  if (!aisleIds.includes(access.aisle_id)) {
    aisleIds.push(access.aisle_id);
  }
  return {
    aisles: aisleIds,
    points,
    length_m: polylineLength(positions),
    target: { kind: 'slot', slot: access.slot.id },
    slot_start_s: cumulativeAt(positions, arcStartIndex),
  };
}

/**
 * Lộ trình ra ô: cung lùi tới tim làn → làn → cổng ra.
 * Trả `null` nếu mạng không nối tới cổng ra.
 */
export function buildExitRoute(
  lot: LotMap,
  network: RoadNetwork,
  slot: Slot,
  desiredSpeed: number,
): Route | null {
  const access = slotAccess(network, slot);
  const exitNode = gateNode(network, lot.gates.out);
  const path = findPath(network, access.edge.to, exitNode.id);
  if (path === null) {
    return null;
  }
  const arc = access.arc;
  const reverse: RoutePoint[] = [];
  // P5c: xe đang đỗ ở **tâm ô**, còn `access.arc` kết thúc ở **miệng ô**. Nên lộ trình lùi
  // phải bắt đầu bằng việc **lùi thẳng từ tâm ô ra miệng ô** (dọc trục ô), rồi mới lùi theo
  // **cung** ra tim làn. Thiếu đoạn đầu này thì frame 0 của lộ trình đặt xe ở miệng ô (nhảy
  // ~2,4 m trong 1 frame) và đè lên xe đỗ bên cạnh — đó là lỗi va chạm hàng loạt ở K4.
  reverse.push({
    pose: {
      x: round6(slot.center[0]),
      y: round6(slot.center[1]),
      th: round6(slot.heading),
    },
    gear: 'reverse',
    v_max: MANEUVER_SPEED_MPS,
  });
  for (let index = arc.length - 1; index > 0; index -= 1) {
    const sample = arc[index];
    reverse.push({
      pose: { x: round6(sample.point[0]), y: round6(sample.point[1]), th: round6(sample.heading) },
      gear: 'reverse',
      v_max: MANEUVER_SPEED_MPS,
    });
  }
  const junction = arc[0];
  const positions: Vec2[] = [junction.point];
  pushUnique(positions, access.edge.points[1]);
  for (const node of path.nodes) {
    pushUnique(positions, node.point);
  }
  pushUnique(positions, lot.gates.out.despawn);
  // P5e (3): chia nhỏ **đoạn chạy ra** giống route vào — bước 62 m làm pure pursuit (nhìn xa
  // 1,8 m) không bám được, xe đứng yên dù đường trống (đo được: V002 K7 rs=11,1/126,4).
  const fineForward = subdividePositions(positions);
  const forward = toForwardRoutePoints(
    fineForward,
    desiredSpeed,
    fineForward.length,
    0,
  );
  const combined = [...reverse, ...forward];
  const points = combined;
  const aisleIds = [...new Set(path.edges.map((edge) => edge.aisle_id))];
  if (!aisleIds.includes(access.aisle_id)) {
    aisleIds.push(access.aisle_id);
  }
  return {
    aisles: aisleIds,
    points,
    length_m: polylineLength(points.map((point) => [point.pose.x, point.pose.y] as Vec2)),
    target: { kind: 'exit' },
    maneuver_end_s: cumulativeAt(
      points.map((point) => [point.pose.x, point.pose.y] as Vec2),
      reverse.length,
    ),
  };
}

/** Một làn vi phạm luật L-GATE (ANS_1 mục B2). */
export interface LGateViolation {
  readonly gate: 'in' | 'out';
  readonly aisle_id: string;
  /** Khoảng hở mép làn → đoạn cổng, m (âm = làn đè lên cổng). */
  readonly clearance_m: number;
  readonly required_m: number;
}

function polylineGateDistance(aisle: Aisle, gate: Gate): number {
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < aisle.polyline.length; index += 1) {
    shortest = Math.min(
      shortest,
      segmentSegmentDistance(
        aisle.polyline[index - 1],
        aisle.polyline[index],
        gate.p1,
        gate.p2,
      ),
    );
  }
  return shortest;
}

/** Dung sai coi là "cắt/chạm" cổng, m (dữ liệu lot làm tròn 4 chữ số). */
const GATE_TOUCH_EPS_M = 1e-3;

function aisleCrossesGate(aisle: Aisle, gate: Gate): boolean {
  for (let index = 1; index < aisle.polyline.length; index += 1) {
    const a = aisle.polyline[index - 1];
    const b = aisle.polyline[index];
    if (
      segmentsIntersect(a, b, gate.p1, gate.p2) ||
      segmentSegmentDistance(a, b, gate.p1, gate.p2) <= GATE_TOUCH_EPS_M
    ) {
      return true;
    }
  }
  return false;
}

/** Id các làn được phép cắt đoạn cổng (làn chứa cổng vào/ra). */
export function gateAisleIds(lot: LotMap): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const aisle of lot.aisles) {
    if (aisleCrossesGate(aisle, lot.gates.in) || aisleCrossesGate(aisle, lot.gates.out)) {
      ids.add(aisle.id);
    }
  }
  return ids;
}

/**
 * Kiểm L-GATE: mọi làn **không** phải làn cổng phải cách đoạn cổng ≥ `requiredM`
 * tính cả nửa bề rộng làn. Trả danh sách vi phạm (rỗng = đạt).
 */
export function lGateViolations(lot: LotMap, requiredM = 2): readonly LGateViolation[] {
  const allowed = gateAisleIds(lot);
  const violations: LGateViolation[] = [];
  const gates: readonly { gate: 'in' | 'out'; value: Gate }[] = [
    { gate: 'in', value: lot.gates.in },
    { gate: 'out', value: lot.gates.out },
  ];
  for (const { gate, value } of gates) {
    for (const aisle of lot.aisles) {
      if (allowed.has(aisle.id)) {
        continue;
      }
      const clearance = polylineGateDistance(aisle, value) - aisle.width_m / 2;
      if (clearance < requiredM) {
        violations.push({
          gate,
          aisle_id: aisle.id,
          clearance_m: round6(clearance),
          required_m: requiredM,
        });
      }
    }
  }
  return violations.sort((a, b) =>
    a.gate === b.gate
      ? a.aisle_id.localeCompare(b.aisle_id)
      : a.gate.localeCompare(b.gate),
  );
}

/** Khoảng cách có dấu từ mũi xe tới đoạn cổng, theo chiều đi qua cổng. */
export function signedDistanceToGate(
  gate: Gate,
  nose: Vec2,
  direction: Vec2,
): number {
  const midpoint = gateMidpoint(gate);
  return (
    (midpoint[0] - nose[0]) * direction[0] +
    (midpoint[1] - nose[1]) * direction[1]
  );
}

/** Điểm mũi xe từ pose tâm xe. */
export function nosePoint(x: number, y: number, heading: number, length: number): Vec2 {
  return [x + (Math.cos(heading) * length) / 2, y + (Math.sin(heading) * length) / 2];
}
