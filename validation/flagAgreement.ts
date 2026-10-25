/**
 * フラグ粒度の実機一致率検証（L141残部・2026-10-26）:
 * 原典アクティグラフの列3=isSomeActivity・列4=isHighActivity（AccelSleepRecorder.appendActivity
 * のデコンパイルで確定: 行フォーマット=rawActivity,actigraph,isSomeActivity,isHighActivity）
 * と自作 ActivityClassifier の同名2フラグを10秒粒度で突合する。
 *
 * 指標は validation/検証手順.md の事前固定に準拠（一致率+混同行列・境界遅延感度・F4判定）。
 *
 * 出力: validation/out/flag_agreement.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ActivityClassifier } from '../src/index';

const DATA = process.argv[2] ?? '/mnt/c/Users/yn441/Downloads/Mobile Devices/Activity_1792867682324_26-10-25-03-48.txt';

interface Row {
  actigraph: number;
  origSome: number;
  origHigh: number;
}

const rows: Row[] = [];
for (const line of readFileSync(DATA, 'utf-8').trim().split('\n')) {
  const cols = line.split(',');
  const actigraph = Number(cols[2]);
  const origSome = Number(cols[3]);
  const origHigh = Number(cols[4]);
  if (!Number.isFinite(actigraph) || !Number.isFinite(origSome) || !Number.isFinite(origHigh)) continue;
  rows.push({ actigraph, origSome, origHigh });
}

if (rows.length === 0) {
  console.error('F2: 解析可能な行がゼロ（形式解析失敗）');
  process.exit(2);
}

// 自作判定（real_data.ts と同一経路: cols[2]=actigraph を振幅として投入・デフォルト感度）
const classifier = new ActivityClassifier();
const own = rows.map((r) => classifier.update(r.actigraph));

const n = rows.length;
const agree = (a: boolean[], b: number[]): number => {
  let ok = 0;
  for (let i = 0; i < n; i++) if (a[i] === (b[i] === 1)) ok++;
  return ok / n;
};

const ownSome = own.map((f) => f.isSomeActivity);
const ownHigh = own.map((f) => f.isHighActivity);

// 遅延感度（自作判定をdサンプル遅らせた一致率・境界オフセットの影響確認）
const agreeWithDelay = (a: boolean[], b: number[], d: number): number => {
  let ok = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const j = i - d;
    if (j < 0 || j >= n) continue;
    ok += a[j] === (b[i] === 1) ? 1 : 0;
    cnt++;
  }
  return ok / cnt;
};

interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  recallOfOnes: number;
  precisionOfOnes: number;
}

const confusion = (a: boolean[], b: number[]): Confusion => {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < n; i++) {
    const truth = b[i] === 1;
    if (a[i] && truth) tp++;
    else if (a[i] && !truth) fp++;
    else if (!a[i] && truth) fn++;
    else tn++;
  }
  return {
    tp, fp, fn, tn,
    recallOfOnes: tp + fn > 0 ? tp / (tp + fn) : 0,
    precisionOfOnes: tp + fp > 0 ? tp / (tp + fp) : 0,
  };
};

const someAgree = agree(ownSome, rows.map((r) => r.origSome));
const highAgree = agree(ownHigh, rows.map((r) => r.origHigh));
const bothAgree = own.filter((f, i) =>
  f.isSomeActivity === (rows[i].origSome === 1) && f.isHighActivity === (rows[i].origHigh === 1)
).length / n;

const someCm = confusion(ownSome, rows.map((r) => r.origSome));
const highCm = confusion(ownHigh, rows.map((r) => r.origHigh));

const delays = [0, 1, 2, 3, -1, -2];
const someDelay = delays.map((d) => ({ delay: d, agreement: Number((agreeWithDelay(ownSome, rows.map((r) => r.origSome), d) * 100).toFixed(2)) }));
const highDelay = delays.map((d) => ({ delay: d, agreement: Number((agreeWithDelay(ownHigh, rows.map((r) => r.origHigh), d) * 100).toFixed(2)) }));

// F4（検証手順.md 事前固定・<50%=fail）
const f4Fail = bothAgree < 0.5;

console.log(`サンプル数=${n}（10秒粒度=${((n * 10) / 60).toFixed(0)}分）`);
console.log(`=== フラグ粒度一致率（10秒サンプル単位） ===`);
console.log(`isSomeActivity 一致率: ${(someAgree * 100).toFixed(1)}%`);
console.log(`isHighActivity 一致率: ${(highAgree * 100).toFixed(1)}%`);
console.log(`両フラグ同時一致率: ${(bothAgree * 100).toFixed(1)}%`);
console.log(`=== 混同行列（自作vs原典・1=活動あり） ===`);
console.log(`isSomeActivity: TP=${someCm.tp} FP=${someCm.fp} FN=${someCm.fn} TN=${someCm.tn}・recall=${(someCm.recallOfOnes * 100).toFixed(1)}% precision=${(someCm.precisionOfOnes * 100).toFixed(1)}%`);
console.log(`isHighActivity: TP=${highCm.tp} FP=${highCm.fp} FN=${highCm.fn} TN=${highCm.tn}・recall=${(highCm.recallOfOnes * 100).toFixed(1)}% precision=${(highCm.precisionOfOnes * 100).toFixed(1)}%`);
console.log(`=== 遅延感度（自作判定をdサンプル遅らせた一致率・境界影響確認） ===`);
console.log(`isSomeActivity: ${someDelay.map((x) => `d=${x.delay}:${x.agreement}%`).join(' ')}`);
console.log(`isHighActivity: ${highDelay.map((x) => `d=${x.delay}:${x.agreement}%`).join(' ')}`);
console.log(`F4判定（両フラグ同時一致率<50%=fail）: ${f4Fail ? 'FAIL（検証中止・実装見直しタスク化）' : 'PASS'}`);

mkdirSync('validation/out', { recursive: true });
writeFileSync(
  'validation/out/flag_agreement.json',
  JSON.stringify(
    {
      purpose: 'フラグ粒度の実機一致率（L141残部・列3/4列定義確定後）',
      column_definition_confirmed: {
        source: 'com.urbandroid.sleep.domain.AccelSleepRecorder.appendActivity（rea decompile・2026-10-26）',
        row_format: 'timestamp, rawActivity, actigraph, isSomeActivity(0/1), isHighActivity(0/1)',
        isSomeActivity: '何らかの活動ありフラグ（列3）',
        isHighActivity: '高活動フラグ（列4）',
        containment: 'isHighActivity=1 ⇒ isSomeActivity=1（appendActivity実装から論理必然・実データ1342サンプルでもc3=0,c4=1は0件と一致）',
        dynamic_threshold_note: '単一閾値フィットは最大95.6%（isHigh）で完全分離せず・フラグは動的閾値（正規化スコア比較）で決まる',
      },
      samples: n,
      agreement_pct: {
        isSomeActivity: Number((someAgree * 100).toFixed(2)),
        isHighActivity: Number((highAgree * 100).toFixed(2)),
        both_flags_simultaneous: Number((bothAgree * 100).toFixed(2)),
      },
      confusion: {
        isSomeActivity: {
          tp: someCm.tp, fp: someCm.fp, fn: someCm.fn, tn: someCm.tn,
          recall_of_ones: Number((someCm.recallOfOnes * 100).toFixed(2)),
          precision_of_ones: Number((someCm.precisionOfOnes * 100).toFixed(2)),
        },
        isHighActivity: {
          tp: highCm.tp, fp: highCm.fp, fn: highCm.fn, tn: highCm.tn,
          recall_of_ones: Number((highCm.recallOfOnes * 100).toFixed(2)),
          precision_of_ones: Number((highCm.precisionOfOnes * 100).toFixed(2)),
        },
      },
      delay_sensitivity: { isSomeActivity: someDelay, isHighActivity: highDelay },
      fail_conditions: {
        F4_agreement_below_50: f4Fail,
        note: '検証手順.md 事前固定・10秒粒度フラグ突合（原典の中間判定フラグが列3/4として記録されているため・原典定義の一致率を直接測定）',
      },
    },
    null,
    2
  ) + '\n'
);
console.log('out: validation/out/flag_agreement.json');
