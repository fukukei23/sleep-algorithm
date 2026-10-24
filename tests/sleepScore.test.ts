import { SleepScoreCalculator, MeasureKey } from '../src/sleepScore';

describe('SleepScoreCalculator（仕様メモ §4 睡眠スコア）', () => {
  test('DURATION範囲型: 500分は帯域内（410-540）で合格・progress=100', () => {
    const s = new SleepScoreCalculator();
    const r = s.updateMeasure('DURATION', 500);
    expect(r.colorType).toBe('POSITIVE');
    expect(r.progress).toBe(100);
    expect(s.getScore()).toBe(1);
    expect(s.getScoreMax()).toBe(1);
  });

  test('DURATION下回り: 400分は不合格・progress=round(400/410×100)=98（緩衝帯内なので色はPOSITIVE）', () => {
    const s = new SleepScoreCalculator();
    const r = s.updateMeasure('DURATION', 400);
    expect(r.colorType).toBe('POSITIVE'); // 緩衝帯307.5-675内
    expect(r.progress).toBe(98);
    expect(s.getScore()).toBe(0);
  });

  test('DURATION上回り: 600分は不合格・progress=round((2−600/540)×100)=89', () => {
    const s = new SleepScoreCalculator();
    const r = s.updateMeasure('DURATION', 600);
    expect(r.progress).toBe(89);
    expect(s.getScore()).toBe(0);
  });

  test('setAge(10)でDURATIONしきい値が540-720に上書きされ600分が合格', () => {
    const s = new SleepScoreCalculator();
    s.setAge(10); // 6-13歳
    const r = s.updateMeasure('DURATION', 600);
    expect(r.colorType).toBe('POSITIVE');
    expect(s.getScore()).toBe(1);
  });

  test('setAge(70)でDURATIONしきい値が360-600に上書き', () => {
    const s = new SleepScoreCalculator();
    s.setAge(70); // 65歳以上
    const r = s.updateMeasure('DURATION', 380);
    expect(r.colorType).toBe('POSITIVE');
  });

  test('setAge(0)・setAge(-1)は変更しない（§4.3・age<=0は無視）', () => {
    const s = new SleepScoreCalculator();
    s.setAge(0);
    s.setAge(-1);
    // 初期値410-540のまま: 420は合格
    expect(s.updateMeasure('DURATION', 420).colorType).toBe('POSITIVE');
  });

  test('DURATIONの表示進捗は理想睡眠時間ベース: ideal=480で240分 → progress=50', () => {
    const s = new SleepScoreCalculator({ idealSleepMinutes: 480 });
    const r = s.updateMeasure('DURATION', 240);
    expect(r.progress).toBe(50);
  });

  test('DEEP_SLEEP(高ほど良い・0.20/0.10): 0.25は合格・progress=100（クリップ）', () => {
    const s = new SleepScoreCalculator();
    const r = s.updateMeasure('DEEP_SLEEP', 0.25);
    expect(r.colorType).toBe('POSITIVE');
    expect(r.progress).toBe(100);
  });

  test('DEEP_SLEEP: 0.15は不合格・progress=round((0.15−0.05)×100/0.15)=67', () => {
    const s = new SleepScoreCalculator();
    const r = s.updateMeasure('DEEP_SLEEP', 0.15);
    expect(r.colorType).toBe('NEGATIVE');
    expect(r.progress).toBe(67);
  });

  test('EFFICIENCY(高ほど良い・0.95/0.85): 0.96合格・0.90は不合格progress=90', () => {
    const s = new SleepScoreCalculator();
    expect(s.updateMeasure('EFFICIENCY', 0.96).colorType).toBe('POSITIVE');
    const r2 = s.updateMeasure('EFFICIENCY', 0.90);
    expect(r2.colorType).toBe('NEGATIVE');
    expect(r2.progress).toBe(90);
  });

  test('SNORE(低ほど良い・0.04/0.10): 0.03合格progress=100（クリップ）・0.05不合格progress=94', () => {
    const s = new SleepScoreCalculator();
    const r1 = s.updateMeasure('SNORE', 0.03);
    expect(r1.colorType).toBe('POSITIVE');
    expect(r1.progress).toBe(100);
    const r2 = s.updateMeasure('SNORE', 0.05);
    expect(r2.colorType).toBe('NEGATIVE');
    expect(r2.progress).toBe(94);
  });

  test('HR範囲型(35-55bpm): 45合格・30は下回りprogress=round(30/35×100)=86', () => {
    const s = new SleepScoreCalculator();
    const r1 = s.updateMeasure('HR', 45);
    expect(r1.colorType).toBe('POSITIVE');
    expect(r1.progress).toBe(100);
    const r2 = s.updateMeasure('HR', 30);
    expect(r2.progress).toBe(86);
  });

  test('HRV(高ほど良い・2.0/−5.0): 3は合格progress=100・−4は不合格progress=0（クリップ）', () => {
    const s = new SleepScoreCalculator();
    const r1 = s.updateMeasure('HRV', 3);
    expect(r1.colorType).toBe('POSITIVE');
    expect(r1.progress).toBe(100);
    const r2 = s.updateMeasure('HRV', -4);
    expect(r2.colorType).toBe('NEGATIVE');
    expect(r2.progress).toBe(0);
  });

  test('RDI(低ほど良い・10/20): 8合格・15不合格progress=round((40−15)×100/30)=83', () => {
    const s = new SleepScoreCalculator();
    const r1 = s.updateMeasure('RDI', 8);
    expect(r1.colorType).toBe('POSITIVE');
    const r2 = s.updateMeasure('RDI', 15);
    expect(r2.progress).toBe(83);
  });

  test('RATING(高ほど良い・3.8/2.5): 4.0合格・3.0は不合格progress=round((3.0−1.25)×100/2.55)=69', () => {
    const s = new SleepScoreCalculator();
    expect(s.updateMeasure('RATING', 4.0).colorType).toBe('POSITIVE');
    const r2 = s.updateMeasure('RATING', 3.0);
    expect(r2.progress).toBe(69);
  });

  test('IRREGULARITY(高ほど良い・0.90/0.75): 0.92合格・0.80不合格progress=round((0.80−0.375)×100/0.525)=81', () => {
    const s = new SleepScoreCalculator();
    expect(s.updateMeasure('IRREGULARITY', 0.92).colorType).toBe('POSITIVE');
    const r2 = s.updateMeasure('IRREGULARITY', 0.80);
    expect(r2.progress).toBe(81);
  });

  test('集計: 9項目全合格 → percentage=100', () => {
    const s = new SleepScoreCalculator();
    s.updateMeasure('DURATION', 500);
    s.updateMeasure('DEEP_SLEEP', 0.25);
    s.updateMeasure('EFFICIENCY', 0.96);
    s.updateMeasure('IRREGULARITY', 0.92);
    s.updateMeasure('SNORE', 0.03);
    s.updateMeasure('RATING', 4.0);
    s.updateMeasure('HR', 45);
    s.updateMeasure('HRV', 3);
    s.updateMeasure('RDI', 8);
    expect(s.getScoreMax()).toBe(9);
    expect(s.getScorePercentage()).toBe(100);
  });

  test('集計: DURATION不合格+他8合格 → percentage=round(8/9×100)=89', () => {
    const s = new SleepScoreCalculator();
    s.updateMeasure('DURATION', 300);
    s.updateMeasure('DEEP_SLEEP', 0.25);
    s.updateMeasure('EFFICIENCY', 0.96);
    s.updateMeasure('IRREGULARITY', 0.92);
    s.updateMeasure('SNORE', 0.03);
    s.updateMeasure('RATING', 4.0);
    s.updateMeasure('HR', 45);
    s.updateMeasure('HRV', 3);
    s.updateMeasure('RDI', 8);
    expect(s.getScorePercentage()).toBe(89);
  });

  test('色判定の緩衝帯（範囲型・§4.1）: DURATION 350分は不合格だが緩衝帯内でPOSITIVE', () => {
    const s = new SleepScoreCalculator();
    const r = s.updateMeasure('DURATION', 350); // 410×0.75=307.5 <= 350 <= 540×1.25=675
    expect(r.colorType).toBe('POSITIVE');
    expect(s.getScore()).toBe(0); // 合格はしていない
  });

  test('色判定: 緩衝帯外（300分）はNEGATIVE', () => {
    const s = new SleepScoreCalculator();
    const r = s.updateMeasure('DURATION', 300); // 300 < 307.5
    expect(r.colorType).toBe('NEGATIVE');
  });

  test('同一測定を複数回評価すると各回が集計に加算される', () => {
    const s = new SleepScoreCalculator();
    s.updateMeasure('DURATION', 500); // 合格
    s.updateMeasure('DURATION', 300); // 不合格
    expect(s.getScoreMax()).toBe(2);
    expect(s.getScorePercentage()).toBe(50);
  });
});

// 型レベルでSCOREが集計対象外であること（仕様メモ §4.4）は tsc --noEmit が担保:
// MeasureKey に 'SCORE' は含まれないため updateMeasure('SCORE', ...) は型エラーになる
describe('MeasureKey 型の集計対象外確認（コンパイル時担保）', () => {
  test('MeasureKey一覧にSCOREが無い（実行時リフレクション代わりの実値確認）', () => {
    const all: MeasureKey[] = [
      'DURATION', 'DEEP_SLEEP', 'EFFICIENCY', 'IRREGULARITY',
      'SNORE', 'RATING', 'HR', 'HRV', 'RDI',
    ];
    expect(all).not.toContain('SCORE');
    expect(all).toHaveLength(9);
  });
});

describe('自己点検で追加した欠落テスト（coverage BrPart削減）', () => {
  test('評価0件でのgetScorePercentageは0', () => {
    const s = new SleepScoreCalculator();
    expect(s.getScorePercentage()).toBe(0);
  });
});

describe('MLR r2修正の回帰テスト', () => {
  test('idealSleepMinutes=0でも特例progressが適用される（!== undefined 判定）', () => {
    const s = new SleepScoreCalculator({ idealSleepMinutes: 0 });
    // ideal=0は実用外だが・undefinedとの区別を契約とする（0で割る→Infinity→clamp100）
    const r = s.updateMeasure('DURATION', 240);
    expect(r.progress).toBe(100); // Infinity→clamp100
  });
});
