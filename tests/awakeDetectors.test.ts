import {
  AverageActivityOverThresholdDetector,
  HighActivityFrequencyDetector,
  PhoneUsageDetector,
  LightsOnDetector,
  EnsembleAwakeDetector,
  AwakeDetector,
} from '../src/awakeDetectors';

describe('AverageActivityOverThresholdDetector（§3 高活動量検知）', () => {
  test('30サンプル未満は覚醒と判定しない（§3 表・評価開始条件）', () => {
    const d = new AverageActivityOverThresholdDetector(1.5);
    for (let i = 0; i < 29; i++) d.update(10.0);
    expect(d.isAwake()).toBe(false);
  });

  test('移動平均がしきい値1.5超で覚醒（30サンプル以上）', () => {
    const d = new AverageActivityOverThresholdDetector(1.5);
    for (let i = 0; i < 30; i++) d.update(10.0); // 平均10 > 1.5
    expect(d.isAwake()).toBe(true);
  });

  test('活動値>150でmilli-G単位とみなししきい値を×100（§3 表）', () => {
    const d = new AverageActivityOverThresholdDetector(1.5);
    d.update(200.0); // 1サンプルでmilli-Gフラグ立つ（しきい値→150）
    for (let i = 0; i < 29; i++) d.update(100.0);
    // callCount=30・avg=(200+2900)/30≈103.3 < 150 → 覚醒しない
    expect(d.isAwake()).toBe(false);
    for (let i = 0; i < 30; i++) d.update(200.0);
    // callCount=60・avg=(3100+6000)/60≈151.7 > 150 → 覚醒
    expect(d.isAwake()).toBe(true);
  });
});

describe('HighActivityFrequencyDetector（§3 高活動頻度検知）', () => {
  test('平均+3σを超えるサンプルの直近window比率がしきい値以上で覚醒', () => {
    const history: number[] = [];
    // 100サンプルの平静（平均≈100・σ≈2）
    for (let i = 0; i < 100; i++) history.push(100 + (i % 5) - 2);
    // 直近window=10のうち7個が平均+3σ超（=106超）
    for (let i = 0; i < 7; i++) history.push(200);
    // 残り3個は平静
    for (let i = 0; i < 3; i++) history.push(100);
    const d = new HighActivityFrequencyDetector({ windowSize: 10, threshold: 0.5 });
    expect(d.isAwake(history)).toBe(true); // 7/10=0.7 >= 0.5
  });

  test('高活動フラグが少なければ覚醒しない', () => {
    const history: number[] = [];
    for (let i = 0; i < 100; i++) history.push(100 + (i % 5) - 2);
    for (let i = 0; i < 2; i++) history.push(200);
    for (let i = 0; i < 8; i++) history.push(100);
    const d = new HighActivityFrequencyDetector({ windowSize: 10, threshold: 0.5 });
    expect(d.isAwake(history)).toBe(false); // 2/10=0.2 < 0.5
  });

  test('履歴がwindow未満では覚醒しない（§3・サンプル不足）', () => {
    const d = new HighActivityFrequencyDetector({ windowSize: 10, threshold: 0.5 });
    expect(d.isAwake([500, 500, 500])).toBe(false);
  });
});

describe('PhoneUsageDetector（§3 スマホ使用検知）', () => {
  const MIN_ON_MS = PhoneUsageDetector.SCREEN_ON_MIN_TIME_MS;
  test('画面ONが最小継続時間に達したら覚醒', () => {
    const d = new PhoneUsageDetector();
    d.onScreenOn(0);
    expect(d.isAwake(MIN_ON_MS - 1)).toBe(false);
    expect(d.isAwake(MIN_ON_MS)).toBe(true);
  });

  test('画面OFFで覚醒状態は解除される', () => {
    const d = new PhoneUsageDetector();
    d.onScreenOn(0);
    d.onScreenOff(MIN_ON_MS + 1000);
    expect(d.isAwake(MIN_ON_MS + 2000)).toBe(false);
  });

  test('スクリーンセーバー時は別閾値（より長い最小継続時間）で覚醒', () => {
    const d = new PhoneUsageDetector();
    d.onScreenOn(0);
    d.setScreenSaver(true);
    expect(d.isAwake(PhoneUsageDetector.SCREEN_ON_MIN_TIME_SCREENSAVER_MS - 1)).toBe(false);
    expect(d.isAwake(PhoneUsageDetector.SCREEN_ON_MIN_TIME_SCREENSAVER_MS)).toBe(true);
  });
});

describe('LightsOnDetector（§3 照度検知）', () => {
  test('夜間（日の出前）に照度がしきい値超 → 覚醒', () => {
    const d = new LightsOnDetector({ sensitivity: 2 });
    // しきい値テーブル（感度2 → 10 lux）
    // 夜間: 日の出06:00・日の入り18:00 として 03:00 は夜間
    const now = Date.UTC(2026, 9, 24, 18, 0, 0); // UTC 18:00（日付境界で夜間扱いにする）
    d.updateLux(100); // 感度2のしきい値50を超える
    expect(
      d.isAwake(now, { sunriseMs: Date.UTC(2026, 9, 25, 0, 0, 0), sunsetMs: Date.UTC(2026, 9, 24, 12, 0, 0) })
    ).toBe(true);
  });

  test('照度がしきい値以下 → 覚醒しない', () => {
    const d = new LightsOnDetector({ sensitivity: 2 });
    const now = Date.UTC(2026, 9, 24, 18, 0, 0);
    d.updateLux(5); // しきい値10未満
    expect(
      d.isAwake(now, { sunriseMs: Date.UTC(2026, 9, 25, 0, 0, 0), sunsetMs: Date.UTC(2026, 9, 24, 12, 0, 0) })
    ).toBe(false);
  });

  test('日中（日の出後〜日の入り前）は照覚醒を無効化（日の出状態の考慮・§3 表）', () => {
    const d = new LightsOnDetector({ sensitivity: 2 });
    d.updateLux(10000); // 昼の明るさ
    // 日の日出 00:00・日の入り 12:00 → 06:00 は日中
    const now = Date.UTC(2026, 9, 24, 6, 0, 0);
    expect(
      d.isAwake(now, { sunriseMs: Date.UTC(2026, 9, 24, 0, 0, 0), sunsetMs: Date.UTC(2026, 9, 24, 12, 0, 0) })
    ).toBe(false);
  });
});

describe('EnsembleAwakeDetector（§3 OR合成）', () => {
  class StubDetector implements AwakeDetector {
    constructor(private value: boolean) {}
    isAwake(): boolean {
      return this.value;
    }
    stop(): void {}
  }

  test('どれか1つでも覚醒なら覚醒（OR合成）', () => {
    const e = new EnsembleAwakeDetector();
    e.add(new StubDetector(false));
    e.add(new StubDetector(true));
    e.add(new StubDetector(false));
    expect(e.isAwake()).toBe(true);
  });

  test('全員が非覚醒なら非覚醒', () => {
    const e = new EnsembleAwakeDetector();
    e.add(new StubDetector(false));
    e.add(new StubDetector(false));
    expect(e.isAwake()).toBe(false);
  });

  test('forceAwakeNow/forceNotAwake で強制上書き', () => {
    const e = new EnsembleAwakeDetector();
    e.add(new StubDetector(false));
    e.forceAwakeNow();
    expect(e.isAwake()).toBe(true);
    e.forceNotAwake();
    expect(e.isAwake()).toBe(false);
  });
});
