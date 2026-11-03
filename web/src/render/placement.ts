/**
 * Chặn tỉ lệ xe theo ô (D4) + xếp xe đỗ sẵn theo seed (U4, FE §2).
 *
 * Phần này **thuần dữ liệu** (không three, không DOM) nên test bằng Node được, và P5
 * dùng chung đúng công thức này để biết xe có vừa ô không.
 *
 * Công thức D4 (nguyên văn quyết định director):
 *
 *     hệ số thực = min(hệ số người chọn, (w_ô - 0,35 m) / w_xe)
 *     ô có w_ô < 2,1 m chỉ nhận hatchback
 *
 * "Không ô nào bị bỏ vì xe to": nếu hệ số bị kẹp xuống dưới `CAR_SCALE_MIN` thì chọn
 * model nhỏ hơn (suv → hatch) trước khi bỏ; chỉ bỏ khi hatch cũng không vừa.
 */

import type { CarColor, CarModel, RngStreams } from '../contracts/sim';
import {
  CAR_COLORS,
  CAR_DIMENSIONS_M,
  CAR_MODELS,
  CAR_SCALE_MAX,
  CAR_SCALE_MIN,
  NARROW_SLOT_WIDTH_M,
  SLOT_EDGE_MARGIN_M,
} from '../contracts/sim';
import type { Slot, SlotId } from '../contracts/lot';
import { createRngStreams, drawInt, pickItem } from '../sim/rng';

/** Kết quả chặn tỉ lệ cho một cặp (ô, model, hệ số người chọn). */
export interface ScaleFit {
  /** Hệ số thực dùng khi đỗ. */
  readonly scale: number;
  /** Model thực dùng (có thể nhỏ hơn model yêu cầu nếu ô hẹp). */
  readonly model: CarModel;
  /** `true` nếu phải hạ model xuống cho vừa ô. */
  readonly downgraded: boolean;
  /** `true` nếu kể cả hatch cũng không vừa ô (ô hẹp bất thường). */
  readonly fits: boolean;
}

/** Bề rộng xe theo model ở hệ số 1,00 (m) - cạnh ngắn của C4. */
export function modelWidthM(model: CarModel): number {
  return CAR_DIMENSIONS_M[model][1];
}

/** Bề rộng tối đa cho phép của xe trong ô rộng `widthM`. */
export function maxCarWidthInSlot(widthM: number): number {
  return widthM - SLOT_EDGE_MARGIN_M;
}

/** Thứ tự thử model: giữ model yêu cầu trước, rồi nhỏ dần. */
function modelOrder(model: CarModel): readonly CarModel[] {
  switch (model) {
    case 'suv':
      return ['suv', 'hatch'];
    case 'sedan':
      return ['sedan', 'hatch'];
    case 'hatch':
      return ['hatch'];
    default: {
      const exhaustive: never = model;
      throw new Error(`modelOrder: model lạ ${String(exhaustive)}`);
    }
  }
}

/** Làm tròn hệ số 4 chữ số để JSON ổn định và GT không trôi số (D11). */
function roundScale(scale: number): number {
  return Math.round(scale * 1e4) / 1e4;
}

/**
 * Chặn tỉ lệ xe theo ô (D4).
 *
 * @param slotWidthM bề rộng ô (m) = `Slot.width_m` của contract.
 * @param model model người dùng/kịch bản chọn.
 * @param desiredScale hệ số người dùng chọn (1,00-1,30), mặc định 1,10.
 */
export function fitCarToSlot(
  slotWidthM: number,
  model: CarModel,
  desiredScale: number,
): ScaleFit {
  if (!(slotWidthM > 0)) {
    throw new Error(`fitCarToSlot: bề rộng ô phải > 0, nhận ${String(slotWidthM)}`);
  }
  const clampedDesired = Math.min(Math.max(desiredScale, CAR_SCALE_MIN), CAR_SCALE_MAX);
  const allowedWidth = maxCarWidthInSlot(slotWidthM);

  // Ô hẹp (D4): chỉ nhận hatchback, dù người dùng chọn xe to.
  const order: readonly CarModel[] =
    slotWidthM < NARROW_SLOT_WIDTH_M ? ['hatch'] : modelOrder(model);

  for (const candidate of order) {
    const width = modelWidthM(candidate);
    if (width > allowedWidth) {
      continue;
    }
    const scale = Math.min(clampedDesired, allowedWidth / width);
    if (scale < CAR_SCALE_MIN) {
      // Vừa nhưng phải thu nhỏ dưới mức cho phép -> thử model nhỏ hơn.
      continue;
    }
    return {
      scale: roundScale(scale),
      model: candidate,
      downgraded: candidate !== model,
      fits: true,
    };
  }

  // Không model nào vừa: trả hệ số nhỏ nhất và báo `fits: false` để UI hiện cảnh báo.
  const smallest: CarModel = 'hatch';
  return {
    scale: CAR_SCALE_MIN,
    model: smallest,
    downgraded: model !== smallest,
    fits: false,
  };
}

/** Một xe đỗ sẵn đã bốc xong. */
export interface ParkedCar {
  readonly car_id: string;
  readonly slot: SlotId;
  readonly model: CarModel;
  readonly color: CarColor;
  readonly scale: number;
  /** Tâm ô (m) - dùng làm pose. */
  readonly center: readonly [x: number, y: number];
  /** Hướng mũi xe (rad) - lấy từ `slot.heading`. */
  readonly heading: number;
}

/** Lỗi khi số xe yêu cầu vượt số ô dùng được (R2: không im lặng bớt xe). */
export class PlacementError extends Error {
  override readonly name = 'PlacementError';
}

/**
 * Bốc `nParked` xe đỗ sẵn ngẫu nhiên theo seed (U4, FE §2).
 *
 * Dùng đúng luồng RNG của `sim/rng.ts` (`placement`/`model`/`color`) để cùng seed cho
 * cùng kết quả và để thêm một sự kiện không xáo các lần bốc khác (FE §4.1).
 *
 * @param slots danh sách ô của `lot` - chỉ dùng ô `reachable`.
 * @param nParked số xe đỗ sẵn, 0...số ô dùng được.
 * @param seed seed kịch bản.
 * @param desiredScale hệ số người dùng chọn (D4 sẽ chặn tiếp theo từng ô).
 */
export function placeParkedCars(
  slots: readonly Slot[],
  nParked: number,
  seed: number,
  desiredScale: number,
): readonly ParkedCar[] {
  const usable = slots.filter((slot) => slot.reachable);
  if (!Number.isInteger(nParked) || nParked < 0) {
    throw new PlacementError(`nParked phải là số nguyên >= 0, nhận ${String(nParked)}`);
  }
  if (nParked > usable.length) {
    throw new PlacementError(
      `nParked=${String(nParked)} vượt số ô dùng được (${String(usable.length)})`,
    );
  }

  let streams: RngStreams = createRngStreams(seed);
  const cars: ParkedCar[] = [];
  const taken = new Set<string>();

  for (let index = 0; index < nParked; index += 1) {
    // Bốc ô: chọn chỉ số trong danh sách chưa dùng, để không bao giờ trùng ô.
    const free = usable.filter((slot) => !taken.has(slot.id));
    const slotDraw = drawInt(streams, 'placement', free.length);
    streams = slotDraw.streams;
    const slot = free[slotDraw.value];
    taken.add(slot.id);

    const modelDraw = pickItem(streams, 'model', CAR_MODELS);
    streams = modelDraw.streams;
    const fit = fitCarToSlot(slot.width_m, modelDraw.value, desiredScale);

    const colorDraw = pickItem(streams, 'color', CAR_COLORS);
    streams = colorDraw.streams;

    cars.push({
      car_id: `V${String(index + 1).padStart(3, '0')}`,
      slot: slot.id,
      model: fit.model,
      color: colorDraw.value,
      scale: fit.scale,
      center: slot.center,
      heading: slot.heading,
    });
  }
  return cars;
}

/** Vị trí xe đỗ sẵn trong world -> pose của contract C-A (`pose.x/y/th`). */
export function parkedCarPose(car: ParkedCar): { x: number; y: number; th: number } {
  return { x: car.center[0], y: car.center[1], th: car.heading };
}
