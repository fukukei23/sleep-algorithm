/**
 * 合成データによる実機検証の準備（原典ヒプノグラムとの突き合わせ用）。
 * 1晩分（8時間=480分・1サンプル=1分）の加速度振幅系列を合成し・
 * 自作アルゴリズム（ActivityClassifier→SleepPhaseDetector→SleepScore）で
 * 判定して hypnogram.csv と score.json を出力する。
 *
 * 出力: validation/out/hypnogram.csv・validation/out/score.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  ActivityClassifier,
  SleepPhaseDetector,
  SleepScoreCalculator,
  RemIntervalRecorder,
  NO_ACTIVITY,
} from '../src/index';
import type { ActivityFlags, SleepPhase } from '../src/index';

const SAMPLES = 480; // 1晩=8時間・1サンプル=1分
const START_MS = Date.UTC(2026, 9, 25, 23, 0, 0); // 23:00 就床
const MIN_MS = 60 * 1000;

/** 決定論的な疑似乱数（再現性のため・mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 現実的な1晩の構成（分）: 就床覚醒→浅眠→深眠→浅眠→深眠→浅眠→浅眠→起床前覚醒 */
const PHASE_PLAN: { phase: 'wake' | 'light' | 'deep' | 'rem'; minutes: number }[] = [
  { phase: 'wake', minutes: 30 },
  { phase: 'light', minutes: 40 },
  { phase: 'deep', minutes: 80 },
  { phase: 'rem', minutes: 30 },
  { phase: 'light', minutes: 40 },
  { phase: 'deep', minutes: 50 },
  { phase: 'rem', minutes: 40 },
  { phase: 'light', minutes: 80 },
  { phase: 'rem', minutes: 60 },
  { phase: 'light', minutes: 20 },
  { phase: 'wake', minutes: 10 },
];

/**
 * 各段階の振幅レンジ。原典 actigraphy の実例レンジ（0.25〜1.7・parser実測）を基準に・
 * 段階間の相対的な変調を加えた合成値。truth ラベルは参考（本来の指標は
 * 「原典判定 vs 自作判定の一致率」）。
 * 実測学習: 中央値正規化+起動補正(sqrt圧縮)の仕様により・norm比が大きくないと
 * 高活動フラグは立たない=DEEP多めの判定は仕様通りの挙動（原典と同じ性質）。
 */
const AMPLITUDE_RANGE: Record<string, [number, number]> = {
  wake: [1.2, 1.7], // 覚醒: 実例レンジの上限側
  light: [0.45, 0.85], // 浅眠: 中央値よりやや上
  deep: [0.25, 0.4], // 深眠: 実例レンジの下限側
  rem: [0.35, 0.6], // レム: 深眠と浅眠の間
};

function genAmplitude(phase: string, rand: () => number): number {
  const [lo, hi] = AMPLITUDE_RANGE[phase] ?? AMPLITUDE_RANGE.light;
  return lo + rand() * (hi - lo);
}

// ===== 1. 合成データ生成 =====
const rand = mulberry32(20261025);
const amplitudes: number[] = [];
const truth: string[] = [];
for (const { phase, minutes } of PHASE_PLAN) {
  for (let i = 0; i < minutes; i++) {
    amplitudes.push(genAmplitude(phase, rand));
    truth.push(phase);
  }
}
// ランダムな寝返り（高振幅スパイク・1.5%）を浅眠/レム中に挿入（MLR r4修正: 深眠にも挿入されていたコメント不一致）
for (let i = 0; i < SAMPLES; i++) {
  if ((truth[i] === 'light' || truth[i] === 'rem') && rand() < 0.015) {
    amplitudes[i] = 0.9 + rand() * 2.1;
  }
}
if (amplitudes.length !== SAMPLES) {
  throw new Error(`合成系列が${SAMPLES}サンプルでない: ${amplitudes.length}`);
}

// ===== 2. 自作アルゴリズムでの判定 =====
const classifier = new ActivityClassifier();
const detector = new SleepPhaseDetector();
const recorder = new RemIntervalRecorder();
const score = new SleepScoreCalculator({ idealSleepMinutes: 480 });
score.setAge(45); // 26-64歳区分（初期値しきい値）

interface SampleResult {
  idx: number;
  ts: number;
  amplitude: number;
  truth: string;
  flags: ActivityFlags;
  phase: SleepPhase;
}

const results: SampleResult[] = [];
for (let i = 0; i < SAMPLES; i++) {
  const flags = classifier.update(amplitudes[i]);
  const phase = detector.update(flags);
  recorder.onPhase(phase, START_MS + i * MIN_MS);
  results.push({ idx: i, ts: START_MS + i * MIN_MS, amplitude: amplitudes[i], truth: truth[i], flags, phase });
}

/** truth×判定の混同行列（MLR r4修正: 合成側妥当性検査の内部指標として残置） */
function confusionMatrix(): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const r of results) {
    m[r.truth] ??= {};
    m[r.truth][r.phase] = (m[r.truth][r.phase] ?? 0) + 1;
  }
  return m;
}

// ===== 3. スコア計算（合成記録から実測値を算出） =====
const deepSamples = results.filter((r) => r.phase === 'DEEP_SLEEP').length;
const judged = results.filter((r) => r.phase !== 'UNKNOWN').length;
const deepRatio = judged > 0 ? deepSamples / judged : 0;

// 純睡眠時間 = UNKNOWN以外の長さ（合成では覚醒区間も含むが・簡易に全サンプルを睡眠とみなす）
const sleepLengthMinutes = SAMPLES;
score.updateMeasure('DURATION', sleepLengthMinutes);
score.updateMeasure('DEEP_SLEEP', deepRatio);
// 効率: 覚醒（truth=wake）を覚醒区間として純睡眠/全体
const wakeSamples = results.filter((r) => r.truth === 'wake').length;
const efficiency = (SAMPLES - wakeSamples) / SAMPLES;
score.updateMeasure('EFFICIENCY', efficiency);
// RATING: 合成では自動4.0（手動評価の代わり）を投入
score.updateMeasure('RATING', 4.0);
// HR/HRV/RDI/SNORE/IRREGULARITY: センサー入力なし → 評価対象外とする（集計から除外・原典の欠測時の扱いに相当）
const scorePct = score.getScorePercentage();

// ===== 4. 出力 =====
mkdirSync('validation/out', { recursive: true });

const hypno = ['sample_index,timestamp_ms,amplitude,truth_phase,phase,flag_some,flag_high', ...results.map((r) => `${r.idx},${r.ts},${r.amplitude.toFixed(4)},${r.truth},${r.phase},${r.flags.isSomeActivity},${r.flags.isHighActivity}`)].join('\n');
writeFileSync('validation/out/hypnogram.csv', hypno + '\n');
writeFileSync(
  'validation/out/score.json',
  JSON.stringify(
    {
      purpose: 'synthetic-debug-only, NOT for cross-app score comparison（原典スコアとの比較には使わない）',
      truth_vs_judgement_confusion: confusionMatrix(),
      meta: { samples: SAMPLES, start_ms: START_MS, generator_seed: 20261025 },
      phase_counts: {
        DEEP_SLEEP: deepSamples,
        LIGHT_SLEEP: results.filter((r) => r.phase === 'LIGHT_SLEEP').length,
        UNKNOWN: results.filter((r) => r.phase === 'UNKNOWN').length,
      },
      deep_ratio: Number(deepRatio.toFixed(4)),
      efficiency_synthetic: Number(efficiency.toFixed(4)),
      score_percentage: scorePct,
      score_used_measures: score.getScoreMax(),
      rem_intervals: recorder.getIntervals(),
    },
    null,
    2
  ) + '\n'
);

// ===== 5. サマリ表示 =====
console.log(`samples=${SAMPLES}`);
console.log(`phase: DEEP=${deepSamples} LIGHT=${results.filter((r) => r.phase === 'LIGHT_SLEEP').length} UNKNOWN=${results.filter((r) => r.phase === 'UNKNOWN').length}`);
console.log(`deep_ratio=${deepRatio.toFixed(4)} efficiency=${efficiency.toFixed(4)} score=${scorePct}%`);
console.log('out: validation/out/hypnogram.csv, validation/out/score.json');
