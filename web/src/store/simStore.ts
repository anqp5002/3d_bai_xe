/**
 * Store Zustand của UI P9 (FE §2, §5; D9).
 *
 * Toàn bộ logic mô phỏng nằm ở `scenarioModel.ts` (thuần dữ liệu). Store này chỉ giữ
 * trạng thái UI + gọi `sim/` — không import three/React/DOM, nên test bằng Node được.
 * Việc vẽ nằm ở `ui/SceneController`.
 */

import { create } from 'zustand';
import { GhostPassAccumulator, ParkClipLog } from '../export/runLog';
import type { LotMap, SlotId } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import { validateScenario } from '../contracts/scenario';
import { NOISE_KINDS } from '../contracts/env';
import type { EnvKeyframe, NoiseKind, NoiseToggle } from '../contracts/env';
import type { CarColor, CarModel, SimState } from '../contracts/sim';
import type { SimEvent } from '../contracts/events';
import type { CameraCount, CameraViewMode } from '../render/cameraGeometry';
import { envPreset } from '../render/env/presets';
import {
  decrementLeader,
  decideLeader,
  RECORD_LEADER_FRAMES,
} from './recordLeader';
import {
  api,
  type HealthResponse,
  type ScenarioEntry,
  type TemplateEntry,
} from '../api/client';
import {
  advanceSim,
  appendEventLog,
  addCarEvent,
  buildScenario,
  canAddEventAt,
  DEFAULT_MAP_SETTINGS,
  DEFAULT_SPAWN_COLOR,
  DEFAULT_SPAWN_MODEL,
  freeSlotIds,
  leaveEvent,
  setSpeedEvent,
  startSim,
} from './scenarioModel';
import {
  freeSlotIdsWithPending,
  type MapSettings,
} from './scenarioModel';
import { planAddCars, type AddCarsInput, type RejectedCar } from './addCarsPlan';

/** Phần dữ liệu thuần (không phải action) — tách để test reset được. */
export interface SimStoreData {
  readonly lot: LotMap | null;
  readonly scenario: Scenario | null;
  readonly state: SimState | null;
  /**
   * Đuôi lịch sử: tối đa {@link HISTORY_TAIL_MAX} state gần nhất (P17n). Trước đây giữ mọi state
   * (15 phút = 22.500 state, mỗi bước còn chép lại cả mảng ⇒ O(n²), tab tự tắt). Không ai cần
   * state cũ hơn: UI chỉ đọc state hiện tại + tóm tắt cảnh báo ở `runLog`.
   */
  readonly history: readonly SimState[];
  /**
   * Tóm tắt cảnh báo của cả lần chạy, cập nhật **tăng dần** O(cảnh báo mới) mỗi bước (P17n):
   * `ghost_pass` gộp theo xe + `park_clip`. Đối tượng đổi tại chỗ; UI theo dõi `runLogVersion`.
   */
  readonly runLog: LiveRunLog;
  /** Tăng mỗi khi `runLog` đổi (cảnh báo mới hoặc đặt lại). */
  readonly runLogVersion: number;
  readonly eventLog: readonly SimEvent[];
  readonly mapSettings: MapSettings;
  readonly spawnModel: CarModel;
  readonly spawnColor: CarColor;
  readonly selectedCarId: string | null;
  readonly selectedSlotId: SlotId | null;
  readonly viewMode: CameraViewMode;
  readonly cameraCount: CameraCount;
  /** Công tắc 3 frame trắng đánh dấu đồng bộ ở chế độ Quay (C2). Mặc định bật. */
  readonly recordSyncLeader: boolean;
  /** Số frame đánh dấu còn lại phải hiện trước khi chạy frame 0 (0 = không hiện). */
  readonly leaderFramesLeft: number;
  readonly playing: boolean;
  readonly playbackSpeed: 0.5 | 1 | 2 | 4;
  readonly scenarioName: string;
  readonly templates: readonly TemplateEntry[];
  readonly savedScenarios: readonly ScenarioEntry[];
  readonly health: HealthResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly notice: string | null;
}

/** Store đầy đủ = dữ liệu + action. */
export interface SimStore extends SimStoreData {
  readonly loadInitial: () => Promise<void>;
  readonly refreshLibrary: () => Promise<void>;
  readonly setMapSettings: (patch: Partial<MapSettings>) => void;
  readonly setSpawnModel: (model: CarModel) => void;
  readonly setSpawnColor: (color: CarColor) => void;
  readonly generateMap: () => void;
  readonly setViewMode: (mode: CameraViewMode) => void;
  readonly setCameraCount: (count: CameraCount) => void;
  /** Bật/tắt 3 frame trắng đánh dấu ở chế độ Quay (C2). */
  readonly setRecordSyncLeader: (enabled: boolean) => void;
  /** Hết một frame đánh dấu (UI gọi sau khi vẽ xong); trả số còn lại. */
  readonly consumeLeaderFrame: () => void;
  /** Bỏ chuỗi đánh dấu đang chạy (khi thoát chế độ Quay). */
  readonly clearLeader: () => void;
  /**
   * Phát tiếp **sau khi** chuỗi đánh dấu vừa hết.
   *
   * Tách khỏi `setPlaying` để không quay lại nhánh chèn frame đánh dấu (nếu dùng
   * `setPlaying(true)` ở đây thì nó thấy frame 0 + công tắc bật ⇒ chèn lại 3 frame, lặp vô hạn).
   */
  readonly resumePlayback: () => void;
  readonly setEnvPreset: (presetId: string) => void;
  readonly setEnvKeyframe: (index: number, keyframe: EnvKeyframe | null) => void;
  readonly setEnvKeyframes: (keyframes: readonly EnvKeyframe[]) => void;
  readonly setNoiseToggle: (kind: NoiseKind, toggle: NoiseToggle) => void;
  readonly setNoiseSeed: (seed: number) => void;
  readonly setPlaying: (playing: boolean) => void;
  readonly setPlaybackSpeed: (speed: 0.5 | 1 | 2 | 4) => void;
  readonly stepFrames: (count: number) => void;
  readonly resetToZero: () => void;
  readonly seekTo: (frame: number) => void;
  readonly selectCar: (carId: string | null) => void;
  readonly selectSlot: (slotId: SlotId | null) => void;
  readonly addCarAt: (slotId?: SlotId) => void;
  /**
   * Thêm N xe một lần (P14a): sinh N sự kiện `add_car` ở frame tương lai qua
   * `appendEventLog` **một lần, all-or-nothing**. Trả kết quả để UI báo xe nào bị từ chối.
   */
  readonly addCars: (request: AddCarsRequest) => AddCarsResult;
  readonly removeSelectedCar: () => void;
  /** Cho nhiều xe đang đỗ rời đi cùng một frame (một lần ghi, all-or-nothing). */
  readonly removeCars: (carIds: readonly string[]) => boolean;
  readonly setCarSpeed: (carId: string, speedKmh: number) => void;
  readonly loadTemplate: (templateId: string) => Promise<void>;
  readonly saveScenario: (name: string) => Promise<void>;
  readonly openScenario: (name: string) => Promise<void>;
  readonly setScenarioName: (name: string) => void;
  readonly setNotice: (message: string | null) => void;
  readonly setError: (message: string | null) => void;
}

/** Yêu cầu thêm nhiều xe (P14a). Bỏ trống = lấy giá trị đang có trong store. */
export interface AddCarsRequest {
  readonly count: number;
  /** Giây bắt đầu (tính từ frame 0). Mặc định = giây hiện tại. */
  readonly startSeconds?: number;
  readonly gapSeconds: number;
  readonly speedKmh: number;
  readonly mode: 'random' | 'from-list';
  readonly chosenSlots?: readonly SlotId[];
  readonly model?: CarModel | null;
  readonly color?: CarColor | null;
}

/** Kết quả thêm nhiều xe. */
export interface AddCarsResult {
  readonly ok: boolean;
  /** Số xe thêm được. */
  readonly added: number;
  readonly rejected: readonly RejectedCar[];
  /** Frame đã dùng cho từng xe (để UI hiện). */
  readonly frames: readonly number[];
  /** Thông báo ngắn cho người dùng. */
  readonly message: string;
}

const INITIAL_SCENARIO_NAME = 'scenario-1';
const SCENARIO_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Số state gần nhất giữ lại trong `history` (P17n). */
export const HISTORY_TAIL_MAX = 600;

/** Tóm tắt cảnh báo tăng dần của lần chạy hiện tại (P17n). */
export interface LiveRunLog {
  readonly ghost: GhostPassAccumulator;
  readonly parkClip: ParkClipLog;
}

export function newRunLog(): LiveRunLog {
  return { ghost: new GhostPassAccumulator(), parkClip: new ParkClipLog() };
}

/** Nối `added` vào đuôi `history`, giữ tối đa {@link HISTORY_TAIL_MAX} phần tử (không spread mảng lớn). */
export function appendHistoryTail(
  history: readonly SimState[],
  added: readonly SimState[],
): readonly SimState[] {
  if (added.length >= HISTORY_TAIL_MAX) {
    return added.slice(added.length - HISTORY_TAIL_MAX);
  }
  const keep = Math.min(history.length, HISTORY_TAIL_MAX - added.length);
  const next: SimState[] = history.slice(history.length - keep);
  for (const state of added) {
    next.push(state);
  }
  return next;
}

/** State có cảnh báo mà `runLog` quan tâm không. */
function touchesRunLog(state: SimState): boolean {
  return state.warnings.some(
    (warning) =>
      warning.kind === 'ghost_pass' ||
      warning.kind === 'park_clip' ||
      warning.kind === 'park_clip_escalated',
  );
}

/** Dữ liệu khởi tạo — test dùng lại để reset store mà giữ action. */
export function createInitialStoreData(): SimStoreData {
  return {
    lot: null,
    scenario: null,
    state: null,
    history: [],
    runLog: newRunLog(),
    runLogVersion: 0,
    eventLog: [],
    mapSettings: DEFAULT_MAP_SETTINGS,
    spawnModel: DEFAULT_SPAWN_MODEL,
    spawnColor: DEFAULT_SPAWN_COLOR,
    selectedCarId: null,
    selectedSlotId: null,
    viewMode: 'dataset',
    cameraCount: '2cam',
    recordSyncLeader: true,
    leaderFramesLeft: 0,
    playing: false,
    playbackSpeed: 1,
    scenarioName: INITIAL_SCENARIO_NAME,
    templates: [],
    savedScenarios: [],
    health: null,
    loading: false,
    error: null,
    notice: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settingsFromScenario(scenario: Scenario): MapSettings {
  return {
    seed: scenario.seed,
    carScale: scenario.car_scale,
    nParked: scenario.initial.n_parked,
    defaultSpeedKmh: scenario.default_speed_kmh,
    cameraMode: scenario.camera_mode,
  };
}

function simFields(scenario: Scenario, state: SimState) {
  return {
    scenario,
    state,
    history: [state],
    runLog: newRunLog(),
    runLogVersion: Date.now(),
    eventLog: scenario.events,
    mapSettings: settingsFromScenario(scenario),
    cameraCount: scenario.camera_mode,
    playing: false,
    selectedCarId: null,
    selectedSlotId: null,
  } as const;
}

function rejectedWarning(state: SimState | null): string | null {
  if (state === null) {
    return null;
  }
  const warning = state.warnings.find((item) => item.kind === 'event_rejected');
  return warning?.message ?? null;
}

function collisionWarning(state: SimState | null): string | null {
  if (state === null) {
    return null;
  }
  const warning = state.warnings.find((item) => item.kind === 'collision');
  return warning?.message ?? null;
}

/** Sắp xếp mốc theo `t_s` tăng dần; cùng `t_s` thì mốc mới thắng. */
function normalizeKeyframes(keyframes: readonly EnvKeyframe[]): EnvKeyframe[] {
  const sorted = [...keyframes].sort((a, b) => a.t_s - b.t_s);
  const deduped: EnvKeyframe[] = [];
  for (const entry of sorted) {
    const previous = deduped[deduped.length - 1];
    if (previous !== undefined && previous.t_s === entry.t_s) {
      deduped[deduped.length - 1] = entry;
    } else {
      deduped.push(entry);
    }
  }
  return deduped;
}

export const useSimStore = create<SimStore>()((set, get) => ({
  ...createInitialStoreData(),

  async loadInitial(): Promise<void> {
    set({ loading: true, error: null, notice: null });
    try {
      const lot = await api.lot();
      const [health, templates, savedScenarios] = await Promise.all([
        api.health().catch(() => null),
        api.templates().catch(() => [] as readonly TemplateEntry[]),
        api.scenarios().catch(() => [] as readonly ScenarioEntry[]),
      ]);
      set({ lot, health, templates, savedScenarios, loading: false });
      get().generateMap();
    } catch (error) {
      set({
        loading: false,
        error:
          `Không tải được bản đồ từ BE: ${errorMessage(error)}\n` +
          'Chạy `python -m sim3d_server --root ../data` trong sim3d/server rồi thử lại.',
      });
    }
  },

  async refreshLibrary(): Promise<void> {
    try {
      const [templates, savedScenarios] = await Promise.all([
        api.templates(),
        api.scenarios(),
      ]);
      set({ templates, savedScenarios, error: null });
    } catch (error) {
      set({ error: `Không tải được thư viện: ${errorMessage(error)}` });
    }
  },

  setMapSettings(patch: Partial<MapSettings>): void {
    const next: MapSettings = { ...get().mapSettings, ...patch };
    set({
      mapSettings: next,
      ...(patch.cameraMode === undefined ? {} : { cameraCount: patch.cameraMode }),
    });
  },

  setSpawnModel(model: CarModel): void {
    set({ spawnModel: model });
  },

  setSpawnColor(color: CarColor): void {
    set({ spawnColor: color });
  },

  generateMap(): void {
    const { lot, mapSettings, scenarioName } = get();
    if (lot === null) {
      set({ error: 'Chưa có bản đồ — bấm “Thử lại” ở thanh trạng thái.' });
      return;
    }
    try {
      const built = buildScenario(lot, mapSettings);
      const state = startSim(lot, built.scenario);
      set({
        ...simFields(built.scenario, state),
        scenarioName,
        error: null,
        notice:
          built.warnings.length > 0
            ? built.warnings.join(' ')
            : `Đã tạo map ${String(built.scenario.initial.n_parked)} xe đỗ sẵn.`,
      });
    } catch (error) {
      set({ error: `Không tạo được map: ${errorMessage(error)}` });
    }
  },

  setViewMode(mode: CameraViewMode): void {
    // Thoát chế độ Quay thì bỏ chuỗi đánh dấu còn dở — không để nó treo sang chế độ khác.
    set({
      viewMode: mode,
      ...(mode === 'record' ? {} : { leaderFramesLeft: 0 }),
    });
  },

  setRecordSyncLeader(enabled: boolean): void {
    set({ recordSyncLeader: enabled });
  },

  consumeLeaderFrame(): void {
    const remaining = get().leaderFramesLeft;
    if (remaining <= 0) {
      return;
    }
    set({ leaderFramesLeft: decrementLeader(remaining) });
  },

  clearLeader(): void {
    set({ leaderFramesLeft: 0 });
  },

  resumePlayback(): void {
    const { scenario, state, leaderFramesLeft } = get();
    if (leaderFramesLeft > 0 || scenario === null || state === null) {
      return;
    }
    // Không đi qua nhánh chèn frame đánh dấu: đây là "phát tiếp sau khi chuỗi vừa hết".
    set({ playing: true });
  },

  setCameraCount(count: CameraCount): void {
    const { scenario } = get();
    set({
      cameraCount: count,
      mapSettings: { ...get().mapSettings, cameraMode: count },
      ...(scenario === null
        ? {}
        : { scenario: { ...scenario, camera_mode: count } }),
    });
  },

  setEnvPreset(presetId: string): void {
    const { scenario } = get();
    if (scenario === null) {
      set({ error: 'Chưa có kịch bản để đổi môi trường.' });
      return;
    }
    let preset: ReturnType<typeof envPreset>;
    try {
      preset = envPreset(presetId);
    } catch (error) {
      set({ error: errorMessage(error) });
      return;
    }
    try {
      const validated = validateScenario({
        ...scenario,
        env: { preset: preset.id, keyframes: preset.keyframes },
      });
      // Chỉ đổi env; state/history/eventLog giữ nguyên (env không ảnh hưởng GT).
      set({ scenario: { ...scenario, env: validated.env }, error: null });
    } catch (error) {
      set({ error: `Môi trường không hợp lệ: ${errorMessage(error)}` });
    }
  },

  setEnvKeyframe(index: number, keyframe: EnvKeyframe | null): void {
    const { scenario } = get();
    if (scenario === null) {
      set({ error: 'Chưa có kịch bản để sửa mốc môi trường.' });
      return;
    }
    const keyframes = [...scenario.env.keyframes];
    if (index === -1) {
      if (keyframe === null) {
        set({ error: 'Thêm mốc cần keyframe (index = -1, keyframe = null là vô nghĩa).' });
        return;
      }
      keyframes.push(keyframe);
    } else {
      if (!Number.isInteger(index) || index < 0 || index >= keyframes.length) {
        set({ error: `Chỉ số mốc ${String(index)} ngoài [0, ${String(keyframes.length - 1)}].` });
        return;
      }
      if (keyframe === null) {
        if (keyframes.length <= 1) {
          set({ error: 'Kịch bản phải còn ít nhất một mốc môi trường.' });
          return;
        }
        keyframes.splice(index, 1);
      } else {
        keyframes[index] = keyframe;
      }
    }
    const deduped = normalizeKeyframes(keyframes);
    if (deduped.length === 0) {
      set({ error: 'Kịch bản phải còn ít nhất một mốc môi trường.' });
      return;
    }
    try {
      const validated = validateScenario({
        ...scenario,
        env: { preset: null, keyframes: deduped },
      });
      set({ scenario: { ...scenario, env: validated.env }, error: null });
    } catch (error) {
      set({ error: `Mốc môi trường không hợp lệ: ${errorMessage(error)}` });
    }
  },

  setEnvKeyframes(keyframes: readonly EnvKeyframe[]): void {
    const { scenario } = get();
    if (scenario === null) {
      set({ error: 'Chưa có kịch bản để sửa mốc môi trường.' });
      return;
    }
    const deduped = normalizeKeyframes(keyframes);
    if (deduped.length === 0) {
      set({ error: 'Kịch bản phải còn ít nhất một mốc môi trường.' });
      return;
    }
    try {
      const validated = validateScenario({
        ...scenario,
        env: { preset: null, keyframes: deduped },
      });
      set({ scenario: { ...scenario, env: validated.env }, error: null });
    } catch (error) {
      set({ error: `Mốc môi trường không hợp lệ: ${errorMessage(error)}` });
    }
  },

  setNoiseToggle(kind: NoiseKind, toggle: NoiseToggle): void {
    const { scenario } = get();
    if (scenario === null) {
      set({ error: 'Chưa có kịch bản để đổi nhiễu.' });
      return;
    }
    if (!(NOISE_KINDS as readonly string[]).includes(kind)) {
      set({ error: `Loại nhiễu lạ: ${String(kind)}` });
      return;
    }
    try {
      const validated = validateScenario({
        ...scenario,
        noise: { ...scenario.noise, [kind]: toggle },
      });
      set({ scenario: { ...scenario, noise: validated.noise }, error: null });
    } catch (error) {
      set({ error: `Nhiễu không hợp lệ: ${errorMessage(error)}` });
    }
  },

  setNoiseSeed(seed: number): void {
    const { scenario } = get();
    if (scenario === null) {
      set({ error: 'Chưa có kịch bản để đổi seed nhiễu.' });
      return;
    }
    try {
      const validated = validateScenario({
        ...scenario,
        noise: { ...scenario.noise, seed },
      });
      set({ scenario: { ...scenario, noise: validated.noise }, error: null });
    } catch (error) {
      set({ error: `Seed nhiễu không hợp lệ: ${errorMessage(error)}` });
    }
  },

  setPlaying(playing: boolean): void {
    const { scenario, state, viewMode, recordSyncLeader, leaderFramesLeft } = get();
    if (playing && (scenario === null || state === null)) {
      return;
    }
    if (playing && state !== null && scenario !== null && state.frame >= scenario.duration_frames) {
      set({ notice: 'Đã hết thời lượng kịch bản — bấm “Về 0” để chạy lại.' });
      return;
    }
    if (playing) {
      // C2: bấm Play ở chế độ Quay ⇒ 3 frame trắng in số frame, RỒI mới chạy từ frame 0.
      // Frame đánh dấu chỉ ở đường phát hình: không vào video xuất, không đổi sim/GT.
      const decision = decideLeader({
        enabled: recordSyncLeader,
        viewMode,
        frame: state?.frame ?? 0,
        alreadyActive: leaderFramesLeft > 0,
      });
      if (decision.begin) {
        set({ leaderFramesLeft: RECORD_LEADER_FRAMES, playing: false });
        return;
      }
      if (decision.reason !== null && viewMode === 'record') {
        // Chỉ báo khi ở chế độ Quay; ở chế độ khác "không chèn" là bình thường.
        set({ notice: `Không chèn frame đồng bộ: ${decision.reason}.` });
      }
    }
    set({ playing });
  },

  setPlaybackSpeed(speed: 0.5 | 1 | 2 | 4): void {
    set({ playbackSpeed: speed });
  },

  stepFrames(count: number): void {
    const { lot, scenario, state, history, eventLog, playing, leaderFramesLeft, runLog, runLogVersion } = get();
    if (lot === null || scenario === null || state === null) {
      return;
    }
    if (leaderFramesLeft > 0) {
      // Đang hiện frame đánh dấu: sim KHÔNG được tiến, nếu không GT lệch với video quay.
      return;
    }
    const steps = Math.max(0, Math.floor(count));
    if (steps === 0) {
      return;
    }
    try {
      const result = advanceSim(
        lot,
        state,
        eventLog,
        steps,
        scenario.duration_frames,
      );
      if (result.history.length === 0) {
        set({ playing: false });
        return;
      }
      const nextState = result.state;
      const collision = collisionWarning(nextState);
      const done = nextState.frame >= scenario.duration_frames;
      // P17n: cập nhật tóm tắt cảnh báo tăng dần; không giữ lại state cũ.
      let runLogChanged = false;
      for (const added of result.history) {
        runLog.ghost.push(added);
        runLog.parkClip.push(added);
        if (!runLogChanged && touchesRunLog(added)) {
          runLogChanged = true;
        }
      }
      set({
        state: nextState,
        history: appendHistoryTail(history, result.history),
        ...(runLogChanged ? { runLogVersion: runLogVersion + 1 } : {}),
        playing: collision === null && !done ? playing : false,
        ...(collision === null ? {} : { notice: collision }),
      });
    } catch (error) {
      set({ error: `Lỗi bước mô phỏng: ${errorMessage(error)}`, playing: false });
    }
  },

  resetToZero(): void {
    const { lot, scenario } = get();
    if (lot === null || scenario === null) {
      return;
    }
    try {
      const state = startSim(lot, scenario);
      set({
        state,
        history: [state],
        runLog: newRunLog(),
        runLogVersion: get().runLogVersion + 1,
        playing: false,
        selectedCarId: null,
        selectedSlotId: null,
        error: null,
        notice: 'Về frame 0 — nhật ký sự kiện giữ nguyên (D9).',
      });
    } catch (error) {
      set({ error: `Không tạo lại được frame 0: ${errorMessage(error)}` });
    }
  },

  seekTo(frame: number): void {
    const { state, scenario } = get();
    if (state === null || scenario === null) {
      return;
    }
    const target = Math.max(
      0,
      Math.min(Math.floor(frame), scenario.duration_frames),
    );
    if (target < state.frame) {
      set({ error: 'D9 cấm tua lùi — dùng “Về 0” rồi chạy lại.' });
      return;
    }
    if (target === state.frame) {
      return;
    }
    set({ error: null, notice: `Tua tới frame ${String(target)}…` });
    get().stepFrames(target - state.frame);
  },

  selectCar(carId: string | null): void {
    if (carId === null) {
      set({ selectedCarId: null, selectedSlotId: null });
      return;
    }
    const car = get().state?.cars.find((candidate) => candidate.id === carId);
    if (car === undefined) {
      set({ error: `Không có xe ${carId}.` });
      return;
    }
    set({ selectedCarId: car.id, selectedSlotId: car.slot });
  },

  selectSlot(slotId: SlotId | null): void {
    if (slotId === null) {
      set({ selectedSlotId: null, selectedCarId: null });
      return;
    }
    const car = get().state?.cars.find(
      (candidate) => candidate.slot === slotId && candidate.state !== 'exited',
    );
    if (car !== undefined) {
      set({ selectedCarId: car.id, selectedSlotId: slotId });
      return;
    }
    set({ selectedSlotId: slotId, selectedCarId: null });
  },

  addCarAt(slotId?: SlotId): void {
    const { lot, scenario, state, eventLog, mapSettings, spawnModel, spawnColor } = get();
    if (lot === null || scenario === null || state === null) {
      return;
    }
    if (state.frame >= scenario.duration_frames) {
      set({ error: 'Đã hết thời lượng kịch bản — không thêm xe được.' });
      return;
    }
    if (!canAddEventAt(eventLog, state.frame)) {
      const last = eventLog[eventLog.length - 1];
      set({
        error:
          `D9: chỉ thêm sự kiện khi frame hiện tại ≥ frame sự kiện cuối` +
          (last === undefined ? '' : ` (${String(last.frame)})`) +
          '.',
      });
      return;
    }
    const free = freeSlotIds(lot, state);
    const requested = slotId ?? get().selectedSlotId ?? undefined;
    const target = requested ?? free[0];
    if (target === undefined) {
      set({ error: 'Không còn ô trống để thêm xe.' });
      return;
    }
    if (!free.includes(target)) {
      set({ error: `Ô ${target} đã có xe hoặc không dùng được.` });
      return;
    }

    const before = { state, history: get().history, scenario, eventLog };
    let nextLog: readonly SimEvent[];
    try {
      nextLog = appendEventLog(
        eventLog,
        addCarEvent(
          state.frame,
          target,
          mapSettings.defaultSpeedKmh,
          spawnModel,
          spawnColor,
        ),
      );
    } catch (error) {
      set({ error: errorMessage(error) });
      return;
    }
    const nextScenario: Scenario = { ...scenario, events: nextLog };
    set({
      eventLog: nextLog,
      scenario: nextScenario,
      selectedSlotId: target,
      notice: `Thêm xe vào ${target} ở frame ${String(state.frame)}.`,
      error: null,
    });
    get().stepFrames(1);
    const rejected = rejectedWarning(get().state);
    if (rejected !== null) {
      set({ ...before, error: rejected, notice: null });
    }
  },

  addCars(request: AddCarsRequest): AddCarsResult {
    const { lot, scenario, state, eventLog, spawnModel, spawnColor } = get();
    const fail = (message: string): AddCarsResult => {
      set({ error: message });
      return { ok: false, added: 0, rejected: [], frames: [], message };
    };
    if (lot === null || scenario === null || state === null) {
      return fail('Chưa có bản đồ — tạo map trước.');
    }

    // Ô trống phải trừ cả sự kiện `add_car` CHƯA CHẠY (lỗi 4: "thêm 2 xe là hết").
    // `>=` vì sự kiện ở đúng frame hiện tại vẫn chưa được engine xử lý khi sim đang dừng.
    const pending = eventLog.filter((event) => event.frame >= state.frame);
    const freeSlots = freeSlotIdsWithPending(lot, state, pending);

    // Giây bắt đầu: mặc định = giây hiện tại; không nhỏ hơn sự kiện cuối (D9).
    // Nếu giây hiện tại đã nằm sau sự kiện cuối thì dùng nó; ngược lại lấy sự kiện cuối.
    const lastEventFrame = eventLog.length === 0 ? -1 : eventLog[eventLog.length - 1].frame;
    const requestedFrame =
      request.startSeconds === undefined
        ? Math.max(state.frame, lastEventFrame)
        : Math.round(request.startSeconds * 25);
    const startFrame = Math.max(requestedFrame, lastEventFrame);
    if (requestedFrame < lastEventFrame) {
      return fail(
        `D9: không chèn trước sự kiện cuối (frame ${String(lastEventFrame)}) — ` +
          `giây bắt đầu phải ≥ ${String(Math.ceil(lastEventFrame / 25))} s.`,
      );
    }

    const plan = planAddCars({
      count: request.count,
      startFrame,
      gapSeconds: request.gapSeconds,
      speedKmh: request.speedKmh,
      mode: request.mode,
      chosenSlots: request.chosenSlots ?? [],
      freeSlots,
      durationFrames: scenario.duration_frames,
      model: request.model ?? spawnModel,
      color: request.color ?? spawnColor,
      // Seed phải đổi theo **số sự kiện đã có**, không chỉ theo frame: bấm "Thêm" nhiều lần
      // khi sim đang dừng thì frame không đổi ⇒ nếu chỉ dùng frame thì lần nào cũng bốc cùng
      // ô đầu ⇒ đó chính là lỗi 4 "thêm 2 xe là hết".
      seed: (scenario.seed ^ ((state.frame + eventLog.length + 1) * 0x9e3779b1)) >>> 0,
    } satisfies AddCarsInput);

    if (plan.events.length === 0) {
      const detail = plan.rejected.map((item) => item.reason).join('; ');
      return fail(`Không thêm được xe nào: ${detail === '' ? 'không có ô trống' : detail}`);
    }

    // All-or-nothing: dựng log mới rồi mới set; lỗi giữa đường thì không đổi gì.
    let nextLog: readonly SimEvent[] = eventLog;
    try {
      for (const event of plan.events) {
        nextLog = appendEventLog(nextLog, event);
      }
    } catch (error) {
      return fail(`Không ghi được nhật ký sự kiện: ${errorMessage(error)}`);
    }

    const rejectedText =
      plan.rejected.length === 0
        ? ''
        : ` Bị từ chối ${String(plan.rejected.length)}: ` +
          plan.rejected.map((item) => item.reason).join('; ');
    const frames = plan.acceptedFrames;
    set({
      eventLog: nextLog,
      scenario: { ...scenario, events: nextLog },
      // Lỗi 4: bỏ chọn ô sau khi thêm, để lần bấm sau không dùng lại ô vừa chiếm.
      selectedSlotId: null,
      notice:
        `Đã thêm ${String(plan.events.length)} xe ở frame ` +
        `${frames.map((frame) => String(frame)).join(', ')}.${rejectedText}`,
      error: null,
    });
    return {
      ok: plan.rejected.length === 0,
      added: plan.events.length,
      rejected: plan.rejected,
      frames,
      message: rejectedText.trim(),
    };
  },

  removeSelectedCar(): void {
    const { scenario, state, eventLog } = get();
    const carId = get().selectedCarId;
    if (scenario === null || state === null) {
      return;
    }
    if (carId === null) {
      set({ error: 'Chọn một xe trong danh sách hoặc trên khung xem trước.' });
      return;
    }
    if (state.frame >= scenario.duration_frames) {
      set({ error: 'Đã hết thời lượng kịch bản.' });
      return;
    }
    if (!canAddEventAt(eventLog, state.frame)) {
      set({ error: 'D9: frame hiện tại đang trước sự kiện cuối — không thêm được.' });
      return;
    }
    const before = { state, history: get().history, scenario, eventLog };
    let nextLog: readonly SimEvent[];
    try {
      nextLog = appendEventLog(eventLog, leaveEvent(state.frame, carId));
    } catch (error) {
      set({ error: errorMessage(error) });
      return;
    }
    const nextScenario: Scenario = { ...scenario, events: nextLog };
    set({
      eventLog: nextLog,
      scenario: nextScenario,
      notice: `Xe ${carId} rời đi ở frame ${String(state.frame)}.`,
      error: null,
    });
    get().stepFrames(1);
    const rejected = rejectedWarning(get().state);
    if (rejected !== null) {
      set({ ...before, error: rejected, notice: null });
    }
  },

  removeCars(carIds: readonly string[]): boolean {
    const { scenario, state, eventLog } = get();
    if (scenario === null || state === null) {
      return false;
    }
    const ids = [...new Set(carIds)];
    if (ids.length === 0) {
      set({ error: 'Chưa chọn xe nào để cho rời đi.' });
      return false;
    }
    const notParked = ids.filter(
      (id) => state.cars.find((car) => car.id === id)?.state !== 'parked',
    );
    if (notParked.length > 0) {
      set({ error: `Chỉ xe đang đỗ mới rời được: ${notParked.join(', ')} không ở trạng thái đỗ.` });
      return false;
    }
    if (state.frame >= scenario.duration_frames) {
      set({ error: 'Đã hết thời lượng kịch bản.' });
      return false;
    }
    if (!canAddEventAt(eventLog, state.frame)) {
      set({ error: 'D9: frame hiện tại đang trước sự kiện cuối — không thêm được.' });
      return false;
    }
    const before = { state, history: get().history, scenario, eventLog };
    let nextLog: readonly SimEvent[] = eventLog;
    try {
      for (const id of ids) {
        nextLog = appendEventLog(nextLog, leaveEvent(state.frame, id));
      }
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    }
    set({
      eventLog: nextLog,
      scenario: { ...scenario, events: nextLog },
      selectedCarId: null,
      notice: `${String(ids.length)} xe rời đi cùng lúc ở frame ${String(state.frame)}: ${ids.join(', ')}.`,
      error: null,
    });
    get().stepFrames(1);
    const rejected = rejectedWarning(get().state);
    if (rejected !== null) {
      set({ ...before, error: rejected, notice: null });
      return false;
    }
    return true;
  },

  setCarSpeed(carId: string, speedKmh: number): void {
    const { scenario, state, eventLog } = get();
    if (scenario === null || state === null) {
      return;
    }
    if (!Number.isFinite(speedKmh) || speedKmh < 5 || speedKmh > 20) {
      set({ error: 'Tốc độ phải trong 5–20 km/h.' });
      return;
    }
    if (!canAddEventAt(eventLog, state.frame)) {
      set({ error: 'D9: chưa thể thêm sự kiện ở frame này.' });
      return;
    }
    const before = { state, history: get().history, scenario, eventLog };
    let nextLog: readonly SimEvent[];
    try {
      nextLog = appendEventLog(eventLog, setSpeedEvent(state.frame, carId, speedKmh));
    } catch (error) {
      set({ error: errorMessage(error) });
      return;
    }
    const nextScenario: Scenario = { ...scenario, events: nextLog };
    set({
      eventLog: nextLog,
      scenario: nextScenario,
      notice: `Đặt ${String(speedKmh)} km/h cho ${carId}.`,
      error: null,
    });
    get().stepFrames(1);
    const rejected = rejectedWarning(get().state);
    if (rejected !== null) {
      set({ ...before, error: rejected, notice: null });
    }
  },

  async loadTemplate(templateId: string): Promise<void> {
    const { lot } = get();
    if (lot === null) {
      set({ error: 'Chưa có bản đồ.' });
      return;
    }
    set({ loading: true, error: null });
    try {
      const scenario = await api.template(templateId);
      const state = startSim(lot, scenario);
      set({
        ...simFields(scenario, state),
        scenarioName: templateId,
        loading: false,
        error: null,
        notice: `Đã nạp kịch bản mẫu ${templateId}.`,
      });
    } catch (error) {
      set({
        loading: false,
        error: `Không nạp được mẫu ${templateId}: ${errorMessage(error)}`,
      });
    }
  },

  async saveScenario(name: string): Promise<void> {
    const { scenario } = get();
    if (scenario === null) {
      set({ error: 'Chưa có kịch bản để lưu.' });
      return;
    }
    if (!SCENARIO_NAME_RE.test(name)) {
      set({ error: 'Tên kịch bản chỉ gồm A-Z a-z 0-9 _ - (không dấu cách).' });
      return;
    }
    set({ loading: true, error: null });
    try {
      await api.saveScenario(name, scenario);
      const savedScenarios = await api.scenarios();
      set({
        loading: false,
        scenarioName: name,
        savedScenarios,
        notice: `Đã lưu kịch bản “${name}”.`,
      });
    } catch (error) {
      set({ loading: false, error: `Lưu thất bại: ${errorMessage(error)}` });
    }
  },

  async openScenario(name: string): Promise<void> {
    const { lot } = get();
    if (lot === null) {
      set({ error: 'Chưa có bản đồ.' });
      return;
    }
    set({ loading: true, error: null });
    try {
      const scenario = await api.scenario(name);
      const state = startSim(lot, scenario);
      set({
        ...simFields(scenario, state),
        scenarioName: name,
        loading: false,
        error: null,
        notice: `Đã mở kịch bản “${name}”.`,
      });
    } catch (error) {
      set({ loading: false, error: `Mở thất bại: ${errorMessage(error)}` });
    }
  },

  setScenarioName(name: string): void {
    set({ scenarioName: name });
  },

  setNotice(message: string | null): void {
    set({ notice: message });
  },

  setError(message: string | null): void {
    set({ error: message });
  },
}));
