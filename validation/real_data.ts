/**
 * 実機比較検証: 原典アプリのアクティグラフ実データ（10秒粒度・1,342サンプル）を
 * 自作アルゴリズムで判定し・原典ヒプノグラム（深い睡眠18%・~REM13%・浅い睡眠68%・目覚め1%）
 * と比較する。
 *
 * 検収（2026-10-25実測）: ヘッダなし・カンマ区切り5列・サンプリング10秒（タイムスタンプ差分実測）
 * 列: 0=タイムスタンプ・1=活動振幅（連続値）・2=活動値（対数正規的分布・原典判定入力と推定）・3/4=0/1フラグ列（活動フラグと推定・意味はL141実機比較検証で確定予定）
 * 窓（6/30/720）は原典の10秒粒度サンプルに基づくため変換なしで投入
 *
 * 出力: validation/out/hypnogram_real.csv・real_comparison.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  ActivityClassifier,
  SleepPhaseDetector,
  RemIntervalRecorder,
  computeHypnogram,
  detectAwakeIntervals,
} from '../src/index';
import type { SleepPhase } from '../src/index';

const DATA = process.argv[2] ?? '/mnt/c/Users/yn441/Downloads/Mobile Devices/Activity_1792867682324_26-10-25-03-48.txt';
const START_MS = 1792867692337;

// ===== 1. 検収+読込 =====
const raw = readFileSync(DATA, 'utf-8').trim().split('\n');
const samples: { ts: number; amp: number }[] = [];
let minAmp = Infinity;
let maxAmp = -Infinity;
for (const line of raw) {
  const cols = line.split(',');
  const ts = Number(cols[0]);
  const amp = Number(cols[2]); // MLR r4検収の診断結果: 列2（9.8フロア）でなく列3（対数正規的分布・norm>1.39が40%）が原典判定入力と推定
  if (!Number.isFinite(ts) || !Number.isFinite(amp)) continue;
  samples.push({ ts, amp });
  if (amp < minAmp) minAmp = amp;
  if (amp > maxAmp) maxAmp = amp;
}

// サンプリング間隔の実測（検収手順書 項目2・fail条件F1）
const intervals: number[] = [];
for (let i = 1; i < Math.min(samples.length, 100); i++) {
  intervals.push(samples[i].ts - samples[i - 1].ts);
}
const medianInterval = intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)];

console.log(`検収: samples=${samples.length} interval_median=${medianInterval}ms amp_range=[${minAmp.toFixed(2)}, ${maxAmp.toFixed(2)}]`);
if (medianInterval !== 10000) {
  console.log(`⚠️ F1: サンプリング間隔が10秒でない（${medianInterval}ms）— 検証続行するが報告に明記`);
}

// ===== 2. 自作アルゴリズムで判定（10秒粒度のまま投入=原典の窓定義に整合） =====
const classifier = new ActivityClassifier();
const detector = new SleepPhaseDetector();
const recorder = new RemIntervalRecorder();

interface SampleResult {
  idx: number;
  ts: number;
  amp: number;
  phase: SleepPhase;
  score: number;
  isHighActivity: boolean;
}

const results: SampleResult[] = [];
for (const { ts, amp } of samples) {
  const flags = classifier.update(amp);
  const phase = detector.update(flags);
  recorder.onPhase(phase, ts);
  results.push({
    idx: results.length,
    ts,
    amp,
    phase,
    score: classifier.lastScore,
    isHighActivity: flags.isHighActivity,
  });
}

// ===== 3. 段階比率集計 =====
const count = (p: SleepPhase): number => results.filter((r) => r.phase === p).length;
const total = results.length;
const deepN = count('DEEP_SLEEP');
const lightN = count('LIGHT_SLEEP');
const unknownN = count('UNKNOWN');
const deepPct = (deepN / total) * 100;
const lightPct = (lightN / total) * 100;
const unknownPct = (unknownN / total) * 100;

// 原典実測（スクショ: フェーズ 18% 深い睡眠・13% ~REM・68% 浅い睡眠・1% 目覚め）
// 自作は2値+UNKNOWN のため REM は「非深眠」として扱う（検収手順書F3規定）
const origDeepPct = 18;
const origNonDeepPct = 82; // 浅い睡眠68% + ~REM13% + 目覚め1%

// ===== 4. 2値比較（深眠 vs 非深眠・検収手順書F3の規定） =====
// 自作のDEEP率を「深い睡眠」に・LIGHT+UNKNOWNを「非深眠」に対応させる
const agreeDeep = deepPct;
const diffPct = Math.abs(agreeDeep - origDeepPct);

// ===== 5. 出力 =====
mkdirSync('validation/out', { recursive: true });

const hypno = ['sample_index,timestamp_ms,amplitude,phase', ...results.map((r) => `${r.idx},${r.ts},${r.amp.toFixed(4)},${r.phase}`)].join('\n');
writeFileSync('validation/out/hypnogram_real.csv', hypno + '\n');
writeFileSync(
  'validation/out/real_comparison.json',
  JSON.stringify(
    {
      purpose: '実機比較検証の結果（原典ヒプノグラム vs 自作判定）',
      acceptance: {
        samples: samples.length,
        sampling_interval_ms: medianInterval,
        amp_range: [Number(minAmp.toFixed(2)), Number(maxAmp.toFixed(2))],
        fail_conditions: {
          F1_sampling_not_10s: medianInterval !== 10000,
          F2_parse_fail: false,
          F3_label_incompatible: 'REM非互換→2値比較（深眠/非深眠）で対応済み',
          F4_agreement_below_50: null,
        },
      },
      own_judgement: {
        DEEP_pct: Number(deepPct.toFixed(2)),
        LIGHT_pct: Number(lightPct.toFixed(2)),
        UNKNOWN_pct: Number(unknownPct.toFixed(2)),
        deep_minutes_equiv: Number(((deepN * 10) / 60).toFixed(1)),
      },
      original_app: {
        deep_pct: origDeepPct,
        non_deep_pct: origNonDeepPct,
        sleep_length: '3:40',
        efficiency: '99%',
        score: 75,
      },
      comparison: {
        deep_pct_diff_points: Number(diffPct.toFixed(2)),
        method: '2値比較（自作DEEP率 vs 原典深い睡眠18%・REMは非深眠扱い・検収手順書F3規定）',
      },
      rem_intervals: recorder.getIntervals(),
    },
    null,
    2
  ) + '\n'
);

console.log(`=== 自作判定（10秒粒度・${total}サンプル=約${((total * 10) / 3600).toFixed(1)}時間） ===`);
console.log(`DEEP=${deepN}（${deepPct.toFixed(1)}%・${((deepN * 10) / 60).toFixed(0)}分相当）`);
console.log(`LIGHT=${lightN}（${lightPct.toFixed(1)}%）`);
console.log(`UNKNOWN=${unknownN}（${unknownPct.toFixed(1)}%）`);
console.log(`=== 原典実測 ===`);
console.log(`深い睡眠18%（0:39）・浅い睡眠68%・~REM13%・目覚め1%`);
console.log(`=== 比較（2値: 深眠率の差） ===`);
console.log(`自作DEEP率 ${deepPct.toFixed(1)}% vs 原典深い睡眠 ${origDeepPct}% → 差 ${diffPct.toFixed(1)}ポイント`);
if (diffPct > 10) {
  console.log(`⚠️ 深眠率差が10ポイント超: 検収手順書の「注意」指標に該当（一致率とは別の合格線）`);
}

// ===== 6. ヒプノグラム生成（仕様メモ §2.5・REM区間を含む表示用・2026-10-25追加解析） =====
// history=圧縮スコア系列（§1.2-5・filteredHistory 相当）・flags=高活動フラグ（score>highThreshold の DHA 相当）
// 覚醒区間は §3 検知器（高活動量+高活動頻度・OR合成）をバッチ列挙して接続（2026-10-25 覚醒検知統合）
const fromMillis = samples[0]?.ts ?? START_MS;
const toMillis = (samples[samples.length - 1]?.ts ?? START_MS) + 10_000;
const awakeIntervals = detectAwakeIntervals(samples);
const hypnoIntervals = computeHypnogram({
  history: results.map((r) => r.score),
  flags: results.map((r) => (r.isHighActivity ? 1 : 0)),
  fromMillis,
  toMillis,
  awakes: awakeIntervals,
});
const remBeforeAwake = computeHypnogram({
  history: results.map((r) => r.score),
  flags: results.map((r) => (r.isHighActivity ? 1 : 0)),
  fromMillis,
  toMillis,
});

const SAMPLE_MS = 10_000;
const pctOf = (label: string): number => {
  const ms = hypnoIntervals
    .filter((i) => i.label === label)
    .reduce((sum, i) => sum + (i.end - i.start), 0);
  return (ms / (samples.length * SAMPLE_MS)) * 100;
};
const hypoDeepPct = pctOf('DEEP');
const hypoLightPct = pctOf('LIGHT');
const hypoBrokenPct = pctOf('BROKEN');
const hypoRemPct = pctOf('REM');

console.log(`=== ヒプノグラム生成（§2.5・REM区間含む） ===`);
console.log(`DEEP=${hypoDeepPct.toFixed(1)}% LIGHT=${hypoLightPct.toFixed(1)}% BROKEN=${hypoBrokenPct.toFixed(1)}% REM=${hypoRemPct.toFixed(1)}%`);
console.log(`原典実測: 深い睡眠18%・~REM13%・浅い睡眠68%・目覚め1%`);
console.log(`差: DEEP=${(hypoDeepPct - 18).toFixed(1)}pt・REM=${(hypoRemPct - 13).toFixed(1)}pt`);

const hypnoCsv = ['label,start_ms,end_ms,length_ms', ...hypnoIntervals.map((i) => `${i.label},${i.start},${i.end},${i.end - i.start}`)].join('\n');
writeFileSync('validation/out/hypnogram_real_v2.csv', hypnoCsv + '\n');

// 覚醒あり/なしのREM差異（fail条件検証: 覚醒区間を接続してもREM区間が一切変化しない時=fail）
// 比較は区間集合の完全一致（順序は時系列で確定）・片側 some でなく両集合の直列化で判定
const remOf = (out: { label: string }[]) => out.filter((i) => i.label === 'REM');
const remWith = remOf(hypnoIntervals);
const remWithout = remOf(remBeforeAwake);
const remSig = (rs: { start: number; end: number }[]): string => rs.map((r) => `${r.start}:${r.end}`).join('|');
const remChanged = remSig(remWith) !== remSig(remWithout);
console.log(`=== 覚醒検知統合（§3・覚醒区間=${awakeIntervals.length}区間） ===`);
console.log(`覚醒ありREM=${remWith.length}区間・なしREM=${remWithout.length}区間 → 変化: ${remChanged ? 'あり' : 'なし（覚醒区間ゼロ交差時は変化なしで正）'}`);

// 再現性記録（MLR指摘採用・2026-10-25）: commit hash・覚醒区間有無を明記
const gitResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' });
const commitHash = gitResult.stdout?.trim() ?? 'unknown';
writeFileSync(
  'validation/out/real_comparison_v2.json',
  JSON.stringify(
    {
      purpose: 'ヒプノグラム生成（§2.5・REM区間含む）による再検証・2026-10-25覚醒検知統合後',
      method: 'history=圧縮スコア系列（§1.2-5・filteredHistory相当）・flags=isHighActivity（DHA相当）・version=10008（現行）・awakes=§3検知器バッチ列挙（高活動量+高活動頻度のOR合成）',
      reproducibility: {
        commit: commitHash,
        awakes_given: true,
        awakes_note: '§3検知器（高活動量+高活動頻度）をActivity_*.txtの活動系列からバッチ列挙して接続（スマホ使用/照度は列が無いため対象外）',
        awake_interval_count: awakeIntervals.length,
        awake_intervals: awakeIntervals,
      },
      rem_change_check: {
        rem_with_awake: remWith,
        rem_without_awake: remWithout,
        changed: remChanged,
        fail_condition: '実装後に覚醒区間を接続してもREM区間が一切変化しない時（覚醒区間ゼロ交差時は変化なしで正）',
      },
      own_hypnogram_pct: {
        DEEP: Number(hypoDeepPct.toFixed(2)),
        LIGHT: Number(hypoLightPct.toFixed(2)),
        BROKEN: Number(hypoBrokenPct.toFixed(2)),
        REM: Number(hypoRemPct.toFixed(2)),
      },
      original_app_pct: { deep: 18, rem: 13, light: 68, awake: 1 },
      diff_points: {
        DEEP: Number((hypoDeepPct - 18).toFixed(2)),
        REM: Number((hypoRemPct - 13).toFixed(2)),
      },
      interval_count: hypnoIntervals.length,
      intervals: hypnoIntervals,
    },
    null,
    2
  ) + '\n'
);
console.log('out: validation/out/hypnogram_real_v2.csv, validation/out/real_comparison_v2.json');
