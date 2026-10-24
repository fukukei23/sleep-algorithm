import {
  SleepPhaseDetector,
  RemIntervalRecorder,
  smartWakeupChecks,
} from '../src/sleepPhaseDetector';
import { ActivityFlags, SleepPhase } from '../src/types';

const SOME: ActivityFlags = { isSomeActivity: true, isHighActivity: false };
const HIGH: ActivityFlags = { isSomeActivity: true, isHighActivity: true };
const NONE: ActivityFlags = { isSomeActivity: false, isHighActivity: false };

function feed(d: SleepPhaseDetector, n: number, flags: ActivityFlags | null): SleepPhase {
  let phase: SleepPhase = 'UNKNOWN';
  for (let i = 0; i < n; i++) phase = d.update(flags);
  return phase;
}

describe('SleepPhaseDetector（仕様メモ §2 睡眠段階判定）', () => {
  test('12サンプル未満はUNKNOWN（§2.3）', () => {
    const d = new SleepPhaseDetector();
    const phase = feed(d, 11, HIGH);
    expect(phase).toBe('UNKNOWN');
  });

  test('12サンプル目で初めて判定される（全て高活動 → LIGHT）', () => {
    const d = new SleepPhaseDetector();
    const phase = feed(d, 12, HIGH);
    expect(phase).toBe('LIGHT_SLEEP');
  });

  test('OR条件の左: 短窓高活動合計=0 → 長窓活動量に関係なくDEEP（§2.3のOR）', () => {
    const d = new SleepPhaseDetector();
    // 30サンプル: 微活動のみ・高活動ゼロ
    feed(d, 30, SOME);
    // 短窓6（直近6サンプル）の高活動合計=0 → DEEP
    expect(d.update(SOME)).toBe('DEEP_SLEEP');
  });

  test('OR条件の右: 長窓微活動合計がchecks未満 → 短窓高活動があってもDEEP', () => {
    // 高活動のみ・微活動フラグなしの独立フラグ（判定は独立した2フラグで構成される）
    const HIGH_ONLY: ActivityFlags = { isSomeActivity: false, isHighActivity: true };
    const d = new SleepPhaseDetector();
    feed(d, 11, NONE); // 1-11 完全静止
    d.update(HIGH_ONLY); // 12（評価開始）: 直近6高活動=1で左不成立・直近30微活動=0で右成立
    expect(d.update(NONE) as SleepPhase).toBe('DEEP_SLEEP'); // 13
    feed(d, 11, NONE); // 14-24
    feed(d, 6, HIGH_ONLY); // 25-30: 直近6高活動=6で左不成立・微活動=0で右成立
    const phase = d.update(HIGH_ONLY); // 31
    expect(phase).toBe('DEEP_SLEEP');
  });

  test('両条件とも成立 → LIGHT: 短窓高活動あり且つ長窓微活動がchecks以上', () => {
    const d = new SleepPhaseDetector();
    // 9個NONE・2個SOME（微活動2）・1個HIGH（12サンプル目で評価開始）
    feed(d, 9, NONE);
    feed(d, 2, SOME);
    d.update(HIGH);
    // 直近6高活動=1>=1成立・直近30微活動=3>=3成立 → LIGHT
    const phase = d.update(HIGH);
    expect(phase).toBe('LIGHT_SLEEP');
  });

  test('LIGHT継続: 高活動が短窓内にあり・微活動が長窓でchecks以上', () => {
    const d = new SleepPhaseDetector();
    // 12サンプル: 全て高活動（微活動もON）
    feed(d, 12, HIGH);
    // 直近6の高活動=6>=1・直近30の微活動=12>=3 → LIGHT
    expect(d.update(HIGH)).toBe('LIGHT_SLEEP');
  });

  test('欠損1サンプルはスキップ（前状態維持・§2.2）', () => {
    const d = new SleepPhaseDetector();
    feed(d, 12, HIGH); // LIGHT
    expect(d.update(null)).toBe('LIGHT_SLEEP'); // 欠損でも前状態を返す
  });

  test('欠損が直近5窓の90%超 → リセットしてUNKNOWN（§2.2）', () => {
    const d = new SleepPhaseDetector();
    feed(d, 12, HIGH); // LIGHT
    feed(d, 5, null); // 5連続欠損（欠損率1.0>0.9）
    expect(d.update(HIGH)).toBe('UNKNOWN'); // リセット後は12サンプル再カウント
  });

  test('感度→checksマップ（§2.3）: 1→1・2→3・3→6・4→10・未指定→3', () => {
    expect(smartWakeupChecks(1)).toBe(1);
    expect(smartWakeupChecks(2)).toBe(3);
    expect(smartWakeupChecks(3)).toBe(6);
    expect(smartWakeupChecks(4)).toBe(10);
    expect(smartWakeupChecks(undefined)).toBe(3);
  });

  test('スマートウォッチモード: 短窓12（§2.3表）', () => {
    const d = new SleepPhaseDetector({ shortWindow: 12 });
    // 12サンプル目で判定開始・直近12の高活動で評価
    feed(d, 12, HIGH);
    expect(d.update(HIGH)).toBe('LIGHT_SLEEP');
    // 高活動をやめて直近12に高活動ゼロ → DEEP
    const d2 = new SleepPhaseDetector({ shortWindow: 12 });
    feed(d2, 12, HIGH);
    feed(d2, 12, SOME); // 直近12が高活動ゼロ
    expect(d2.update(SOME)).toBe('DEEP_SLEEP');
  });
});

describe('RemIntervalRecorder（仕様メモ §2.4 区間記録）', () => {
  test('DEEP遷移で5分遡った区間開始・継続で延伸', () => {
    const r = new RemIntervalRecorder();
    r.onPhase('LIGHT_SLEEP', 0);
    r.onPhase('DEEP_SLEEP', 10 * 60 * 1000); // 10分にDEEP遷移
    r.onPhase('DEEP_SLEEP', 12 * 60 * 1000); // 12分まで継続
    const { deep } = r.getIntervals();
    expect(deep).toHaveLength(1);
    expect(deep[0]).toEqual({ start: 5 * 60 * 1000, end: 12 * 60 * 1000 }); // 5分遡り
  });

  test('LIGHT遷移で10秒遡った区間開始', () => {
    const r = new RemIntervalRecorder();
    r.onPhase('DEEP_SLEEP', 0);
    r.onPhase('LIGHT_SLEEP', 60 * 1000); // 60秒にLIGHT遷移
    const { light } = r.getIntervals();
    expect(light).toHaveLength(1);
    expect(light[0]).toEqual({ start: 60 * 1000 - 10 * 1000, end: 60 * 1000 });
  });

  test('UNKNOWNは区間を作らない', () => {
    const r = new RemIntervalRecorder();
    r.onPhase('UNKNOWN', 0);
    expect(r.getIntervals().deep).toHaveLength(0);
    expect(r.getIntervals().light).toHaveLength(0);
  });
});
