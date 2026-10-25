import { detectAwakeIntervals } from '../src/awakeDetectors';
import { computeHypnogram } from '../src/hypnogramGeneration';

/** 10秒粒度の系列ヘルパー（実データと同粒度） */
const STEP = 10_000;
const BASE_MS = Date.UTC(2026, 9, 25, 23, 0, 0);

function series(amplitudes: number[]): { ts: number; amp: number }[] {
  return amplitudes.map((amp, i) => ({ ts: BASE_MS + i * STEP, amp }));
}

/** 睡眠開始+50分のREM禁止帯を回避するため DEEP(20分)+LIGHT(20分) ペアを4回繰り返す（約73分） */
function hypnogramSeries(): { history: number[]; samples: { ts: number; amp: number }[] } {
  const history: number[] = [];
  for (let p = 0; p < 4; p++) {
    history.push(...Array(120).fill(2.0)); // DEEP（しきい値3.1未満・最小深眠長15分超で格下げされない）
    history.push(...Array(120).fill(4.0)); // LIGHT（しきい値以上・高活動頻度なし）
  }
  const samples = history.map((_, i) => ({ ts: BASE_MS + i * STEP, amp: 0.5 }));
  return { history, samples };
}

/**
 * 移動平均窓30の発火点検算（40静穏0.3+40高活動10.0+40静穏0.3）:
 * 窓内高活動 k 個で avg=(0.3(30-k)+10k)/30>1.5 → k>=4 → 最初の覚醒は idx=43・
 * 高活動ブロック終了後は avg>1.5 が idx=105 まで続く（最終覚醒 idx=105）。
 */
describe('detectAwakeIntervals（§3 バッチ覚醒区間列挙）', () => {
  test('静穏系列は空配列（覚醒ゼロ入力=変化なしで正）', () => {
    const samples = series(Array.from({ length: 60 }, () => 0.3));
    expect(detectAwakeIntervals(samples)).toEqual([]);
  });

  test('30サンプル以上の高活動で覚醒区間が1つ列挙される', () => {
    const amps = [...Array(40).fill(0.3), ...Array(40).fill(10.0), ...Array(40).fill(0.3)];
    const result = detectAwakeIntervals(series(amps), { enableFrequency: false });
    expect(result.length).toBe(1);
    const aw = result[0]!;
    expect(aw.start).toBe(BASE_MS + 42 * STEP); // idx=43 覚醒開始・1ループ前
    expect(aw.end).toBe(BASE_MS + 106 * STEP); // idx=105 最終覚醒・end=idx=106 の ts
  });

  test('覚醒開始の1ループ前拡張が効く（30サンプル評価開始条件で初回覚醒は idx=29）', () => {
    const amps = [...Array(40).fill(10.0), ...Array(40).fill(0.3)];
    const result = detectAwakeIntervals(series(amps), { enableFrequency: false });
    expect(result.length).toBe(1);
    const aw = result[0]!;
    expect(aw.start).toBe(BASE_MS + 28 * STEP); // 初回覚醒 idx=29（callCount>=30）・start=1ループ前
    // 高活動は idx=0..39・窓内高活動が4個以下に落ちる idx=66 で非覚醒化 → 最終覚醒 idx=65
    expect(aw.end).toBe(BASE_MS + 66 * STEP);
  });

  test('分離した高活動ブロックは2区間に列挙される', () => {
    const amps = [
      ...Array(40).fill(0.3),
      ...Array(40).fill(10.0),
      ...Array(40).fill(0.3),
      ...Array(40).fill(10.0),
      ...Array(40).fill(0.3),
    ];
    const result = detectAwakeIntervals(series(amps), { enableFrequency: false });
    expect(result.length).toBe(2);
    const first = result[0]!;
    const second = result[1]!;
    expect(first.end).toBe(BASE_MS + 106 * STEP);
    // 第2ブロック（idx=120..159）の窓内高活動が4個に達する idx=123 で覚醒再開・start=1ループ前
    expect(second.start).toBe(BASE_MS + 122 * STEP);
    expect(first.end).toBeLessThan(second.start);
  });

  test('高活動頻度検知: 移動平均しきい値未満のスパイク群をフラグ比率で覚醒', () => {
    // 静穏0.5（385サンプル）にスパイク1.2（19個=履歴の4.7%）: avg は最大≈0.94<1.5 で非覚醒・
    // freq は「mean+3σ≈1.13超」フラグが直近窓30に19個集中 → ratio≈0.63>=0.5 で覚醒
    const amps = [...Array(385).fill(0.5), ...Array(19).fill(1.2)];
    const result = detectAwakeIntervals(series(amps));
    expect(result.length).toBe(1);
  });

  test('1サンプルの高活動は移動平均・頻度検知どちらも覚醒にならない', () => {
    const amps = [...Array(40).fill(0.3), 10.0, ...Array(40).fill(0.3)];
    const result = detectAwakeIntervals(series(amps));
    expect(result).toEqual([]);
  });

  test('milli-G単位系列（>150）でしきい値が×100され覚醒区間が分断される（§3 表）', () => {
    // idx=29 から threshold1.5 で avg=100>1.5 覚醒・idx=40 の200で milli-G フラグ立ち
    // → しきい値150に切り替わり avg<150 で覚醒中断・idx=55（窓内200が16個）から再開
    const amps = [...Array(40).fill(100.0), ...Array(40).fill(200.0), ...Array(40).fill(100.0)];
    const result = detectAwakeIntervals(series(amps), { enableFrequency: false });
    expect(result.length).toBe(2);
    const first = result[0]!;
    const second = result[1]!;
    expect(first.start).toBe(BASE_MS + 28 * STEP); // idx=29 覚醒・1ループ前
    expect(first.end).toBe(BASE_MS + 40 * STEP);
    expect(second.start).toBe(BASE_MS + 54 * STEP); // idx=55 再開・1ループ前
    expect(second.end).toBe(BASE_MS + 94 * STEP); // idx=93 最終覚醒（窓内200が15個で avg=150 と同値→非覚醒化）・end=idx=94 の ts
  });

  test('samples が空なら空配列', () => {
    expect(detectAwakeIntervals([])).toEqual([]);
  });

  test('欠損ギャップ（直前間隔の2倍超）で覚醒区間が分断される', () => {
    // 40静穏+40高活動（ts連続）→ idx80..119 相当を欠損（サンプル無し）→ ts=120..159 に40高活動
    const samples: { ts: number; amp: number }[] = [];
    for (let i = 0; i < 40; i++) samples.push({ ts: BASE_MS + i * STEP, amp: 0.3 });
    for (let i = 40; i < 80; i++) samples.push({ ts: BASE_MS + i * STEP, amp: 10.0 });
    for (let i = 120; i < 160; i++) samples.push({ ts: BASE_MS + i * STEP, amp: 10.0 });
    const result = detectAwakeIntervals(samples, { enableFrequency: false });
    expect(result.length).toBe(2);
    const first = result[0]!;
    const second = result[1]!;
    // 第1区間はギャップ直前で閉じる（最終覚醒 samples[79]・end=ts+直前差分）
    expect(first.end).toBe(BASE_MS + 80 * STEP);
    // 第2区間はギャップ後から末尾まで（end=last.ts+直前差分=160×STEP）
    expect(second.end).toBe(BASE_MS + 160 * STEP);
    // 注記: 開始1ループ前拡張はギャップ直前のサンプルtsを指すため・区間境界の重なりは許容
    expect(second.end).toBeGreaterThan(first.end);
  });

  test('系列末尾まで覚醒が続くと end は最終覚醒サンプル+直前差分で閉じる（末尾外挿ブランチ）', () => {
    const amps = [...Array(40).fill(0.3), ...Array(40).fill(10.0)]; // 系列末尾まで高活動
    const result = detectAwakeIntervals(series(amps), { enableFrequency: false });
    expect(result.length).toBe(1);
    const aw = result[0]!;
    expect(aw.start).toBe(BASE_MS + 42 * STEP); // idx=43 覚醒開始・1ループ前
    expect(aw.end).toBe(BASE_MS + amps.length * STEP); // last.ts + 直前差分(=STEP)
  });

  test('複合: 両検知器有効でも移動平均経路の覚醒は検出される（freq との OR 動作）', () => {
    const amps = [...Array(40).fill(0.3), ...Array(40).fill(10.0), ...Array(40).fill(0.3)];
    const result = detectAwakeIntervals(series(amps)); // enableFrequency 既定 true
    expect(result.length).toBe(1);
    const aw = result[0]!;
    expect(aw.start).toBe(BASE_MS + 42 * STEP);
    expect(aw.end).toBe(BASE_MS + 106 * STEP);
  });

  test('enableFrequency:false で高活動頻度検知が無効化される', () => {
    const amps = [...Array(385).fill(0.5), ...Array(19).fill(1.2)];
    const result = detectAwakeIntervals(series(amps), { enableFrequency: false });
    expect(result).toEqual([]); // avg も発火しない（スパイク1.2<1.5）
  });

  test('統合: 覚醒区間をcomputeHypnogramに渡すとREM区間が変化する（fail条件検証）', () => {
    const { history, samples } = hypnogramSeries();
    // REM はペア2/3/4で生成（[idx=420,450・660,690・900,930]分相当）・
    // 第4REM（idx=900..929 相当）に重なる高活動を idx=910..949 に置く
    // 覚醒区間は REM4 の前半2分のみを残し・5分未満断片として REM4 を消滅させる
    for (let i = 910; i <= 949; i++) samples[i]!.amp = 10.0;
    const awakes = detectAwakeIntervals(samples, { enableFrequency: false });
    expect(awakes.length).toBe(1);

    const common = {
      history,
      flags: history.map(() => 0),
      fromMillis: BASE_MS,
      toMillis: BASE_MS + history.length * STEP,
    };
    const withoutAwake = computeHypnogram(common);
    const withAwake = computeHypnogram({ ...common, awakes });
    const remOf = (out: { label: string }[]) => out.filter((i) => i.label === 'REM');
    expect(remOf(withoutAwake).length).toBe(3);
    // REM 生成後に覚醒で削断され・REM が変化する（覚醒ゼロ入力時は変化なし=正）
    expect(remOf(withAwake).length).toBe(2);
  });

  test('統合: 覚醒がREMに重ならない系列ではREM区間は変化しない（覚醒ゼロと等価で正）', () => {
    const { history, samples } = hypnogramSeries();
    // 高活動をペア1のLIGHT（idx=120..239 相当・REM禁止帯内でREM生成対象外）に置く
    for (let i = 130; i <= 170; i++) samples[i]!.amp = 10.0;
    const awakes = detectAwakeIntervals(samples, { enableFrequency: false });
    expect(awakes.length).toBe(1);

    const common = {
      history,
      flags: history.map(() => 0),
      fromMillis: BASE_MS,
      toMillis: BASE_MS + history.length * STEP,
    };
    const withoutAwake = computeHypnogram(common);
    const withAwake = computeHypnogram({ ...common, awakes });
    const remOf = (out: { label: string }[]) => out.filter((i) => i.label === 'REM');
    expect(remOf(withAwake)).toEqual(remOf(withoutAwake));
  });
});
