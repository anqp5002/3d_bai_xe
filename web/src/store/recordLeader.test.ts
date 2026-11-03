/**
 * Chế độ Quay + 3 frame đánh dấu đồng bộ (C2) — test logic thuần, không cần trình duyệt.
 *
 * Chạy: `cd sim3d/web && npx vitest run src/store`
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import { createInitialStoreData, useSimStore } from './simStore';
import {
  decrementLeader,
  decideLeader,
  gtFrameForRecordedFrame,
  isLeaderShowing,
  leaderLabel,
  RECORD_LEADER_FRAMES,
} from './recordLeader';
import { makeTestLot } from './testLot';

/** Bằng `SYNC_LEADER_FRAMES` ở `export/index.ts:13` — lệch là phải biết ngay. */
const EXPORT_SYNC_LEADER_FRAMES = 3;

function setup(nParked = 1): LotMap {
  const lot = makeTestLot();
  useSimStore.setState({
    ...createInitialStoreData(),
    lot,
    mapSettings: {
      seed: 3,
      carScale: 1.1,
      nParked,
      defaultSpeedKmh: 10,
      cameraMode: '2cam',
    },
    scenarioName: 'test',
  });
  useSimStore.getState().generateMap();
  return lot;
}

beforeEach(() => {
  useSimStore.setState(createInitialStoreData());
});

describe('recordLeader — hằng số và quyết định', () => {
  it('RECORD_LEADER_FRAMES khớp SYNC_LEADER_FRAMES của export', () => {
    expect(RECORD_LEADER_FRAMES).toBe(EXPORT_SYNC_LEADER_FRAMES);
  });

  it('bật + ở chế độ Quay + frame 0 ⇒ bắt đầu', () => {
    expect(
      decideLeader({ enabled: true, viewMode: 'record', frame: 0, alreadyActive: false }),
    ).toEqual({ begin: true, reason: null });
  });

  it('tắt công tắc ⇒ không bắt đầu, có lý do', () => {
    const decision = decideLeader({
      enabled: false,
      viewMode: 'record',
      frame: 0,
      alreadyActive: false,
    });
    expect(decision.begin).toBe(false);
    expect(decision.reason).toContain('tắt');
  });

  it('không ở chế độ Quay ⇒ không bắt đầu', () => {
    for (const viewMode of ['dataset', 'free'] as const) {
      const decision = decideLeader({
        enabled: true,
        viewMode,
        frame: 0,
        alreadyActive: false,
      });
      expect(decision.begin).toBe(false);
      expect(decision.reason).toContain('Quay');
    }
  });

  it('đang chạy chuỗi đánh dấu ⇒ không bắt đầu lại', () => {
    const decision = decideLeader({
      enabled: true,
      viewMode: 'record',
      frame: 0,
      alreadyActive: true,
    });
    expect(decision.begin).toBe(false);
    expect(decision.reason).toContain('đang chạy');
  });

  it('không ở frame 0 ⇒ không chèn (C2: rồi mới chạy từ frame 0)', () => {
    const decision = decideLeader({
      enabled: true,
      viewMode: 'record',
      frame: 40,
      alreadyActive: false,
    });
    expect(decision.begin).toBe(false);
    expect(decision.reason).toContain('frame 40');
  });
});

describe('recordLeader — đếm và nhãn', () => {
  it('decrementLeader giảm 1 và không âm', () => {
    expect(decrementLeader(3)).toBe(2);
    expect(decrementLeader(1)).toBe(0);
    expect(decrementLeader(0)).toBe(0);
    expect(decrementLeader(-5)).toBe(0);
    expect(decrementLeader(Number.NaN)).toBe(0);
  });

  it('isLeaderShowing chỉ đúng khi > 0', () => {
    expect(isLeaderShowing(3)).toBe(true);
    expect(isLeaderShowing(1)).toBe(true);
    expect(isLeaderShowing(0)).toBe(false);
    expect(isLeaderShowing(-1)).toBe(false);
    expect(isLeaderShowing(Number.NaN)).toBe(false);
  });

  it('leaderLabel in 1, 2, 3 theo thứ tự', () => {
    expect(leaderLabel(3)).toBe('1');
    expect(leaderLabel(2)).toBe('2');
    expect(leaderLabel(1)).toBe('3');
  });

  it('leaderLabel ném lỗi khi không còn frame nào (R2: không in số giả)', () => {
    expect(() => leaderLabel(0)).toThrow(/không còn frame đánh dấu/);
  });

  it('gtFrameForRecordedFrame trừ đúng số frame đánh dấu', () => {
    expect(gtFrameForRecordedFrame(0, true)).toBeNull();
    expect(gtFrameForRecordedFrame(2, true)).toBeNull();
    expect(gtFrameForRecordedFrame(3, true)).toBe(0);
    expect(gtFrameForRecordedFrame(4, true)).toBe(1);
    // Tắt công tắc ⇒ không lệch.
    expect(gtFrameForRecordedFrame(0, false)).toBe(0);
    expect(gtFrameForRecordedFrame(4, false)).toBe(4);
  });
});

describe('simStore — frame đánh dấu không đổi sim/GT', () => {
  it('setPlaying ở chế độ Quay frame 0 ⇒ hiện 3 frame đánh dấu và CHƯA phát', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', recordSyncLeader: true });
    useSimStore.getState().setPlaying(true);

    const store = useSimStore.getState();
    expect(store.leaderFramesLeft).toBe(RECORD_LEADER_FRAMES);
    expect(store.playing).toBe(false);
    expect(store.state?.frame).toBe(0);
  });

  it('stepFrames bị chặn khi còn frame đánh dấu ⇒ GT không tiến', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', leaderFramesLeft: 2, playing: true });
    const before = useSimStore.getState().state;
    useSimStore.getState().stepFrames(5);
    const after = useSimStore.getState();
    expect(after.state).toBe(before);
    expect(after.history).toHaveLength(1);
    expect(after.state?.frame).toBe(0);
  });

  it('consumeLeaderFrame giảm dần tới 0 rồi stepFrames chạy lại bình thường', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', leaderFramesLeft: RECORD_LEADER_FRAMES });
    useSimStore.getState().consumeLeaderFrame();
    useSimStore.getState().consumeLeaderFrame();
    expect(useSimStore.getState().leaderFramesLeft).toBe(1);
    useSimStore.getState().consumeLeaderFrame();
    expect(useSimStore.getState().leaderFramesLeft).toBe(0);
    // Gọi thêm không xuống âm.
    useSimStore.getState().consumeLeaderFrame();
    expect(useSimStore.getState().leaderFramesLeft).toBe(0);

    useSimStore.getState().stepFrames(2);
    expect(useSimStore.getState().state?.frame).toBe(2);
  });

  it('tắt công tắc ⇒ bấm Play phát luôn, không có frame đánh dấu', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', recordSyncLeader: false });
    useSimStore.getState().setPlaying(true);
    const store = useSimStore.getState();
    expect(store.leaderFramesLeft).toBe(0);
    expect(store.playing).toBe(true);
  });

  it('ở chế độ dataset ⇒ không chèn frame đánh dấu dù công tắc bật', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'dataset', recordSyncLeader: true });
    useSimStore.getState().setPlaying(true);
    const store = useSimStore.getState();
    expect(store.leaderFramesLeft).toBe(0);
    expect(store.playing).toBe(true);
  });

  it('bấm Play khi đang ở frame > 0 ⇒ phát luôn (không chèn giữa lúc chạy)', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', recordSyncLeader: true });
    useSimStore.getState().stepFrames(30);
    expect(useSimStore.getState().state?.frame).toBe(30);

    useSimStore.getState().setPlaying(true);
    const store = useSimStore.getState();
    expect(store.leaderFramesLeft).toBe(0);
    expect(store.playing).toBe(true);
    expect(store.notice).toContain('Không chèn frame đồng bộ');
  });

  it('thoát chế độ Quay thì xoá chuỗi đánh dấu còn dở', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', leaderFramesLeft: 2 });
    useSimStore.getState().setViewMode('dataset');
    expect(useSimStore.getState().leaderFramesLeft).toBe(0);
  });

  it('resumePlayback phát tiếp mà KHÔNG chèn lại frame đánh dấu (chống lặp vô hạn)', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', recordSyncLeader: true });
    // Chuỗi vừa hết.
    useSimStore.setState({ leaderFramesLeft: 0 });
    useSimStore.getState().resumePlayback();
    const store = useSimStore.getState();
    expect(store.playing).toBe(true);
    expect(store.leaderFramesLeft).toBe(0);
    // Qua vài bước: vẫn không được quay lại chuỗi 3 frame.
    useSimStore.getState().stepFrames(5);
    expect(useSimStore.getState().leaderFramesLeft).toBe(0);
    expect(useSimStore.getState().state?.frame).toBe(5);
  });

  it('resumePlayback không làm gì khi còn frame đánh dấu', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', leaderFramesLeft: 2 });
    useSimStore.getState().resumePlayback();
    expect(useSimStore.getState().playing).toBe(false);
    expect(useSimStore.getState().leaderFramesLeft).toBe(2);
  });

  it('clearLeader xoá sạch (dùng khi Esc)', () => {
    setup(1);
    useSimStore.setState({ viewMode: 'record', leaderFramesLeft: 3 });
    useSimStore.getState().clearLeader();
    expect(useSimStore.getState().leaderFramesLeft).toBe(0);
  });

  it('frame đánh dấu KHÔNG vào history ⇒ GT sinh ra không đổi', () => {
    setup(2);
    const before = useSimStore.getState().state;
    useSimStore.setState({ viewMode: 'record', leaderFramesLeft: 3 });
    // Trong lúc còn frame đánh dấu, mọi bước sim đều bị chặn.
    for (let index = 0; index < 3; index += 1) {
      expect(useSimStore.getState().leaderFramesLeft).toBeGreaterThan(0);
      useSimStore.getState().stepFrames(1);
      expect(useSimStore.getState().state).toBe(before);
      useSimStore.getState().consumeLeaderFrame();
    }
    const after = useSimStore.getState();
    expect(after.leaderFramesLeft).toBe(0);
    expect(after.state).toBe(before);
    expect(after.history).toHaveLength(1);
  });
});
