/** ヒプノグラム生成（仕様メモ §2.5のクリーンルール実装） */
import type { Interval } from './types';

/**
 * ヒプノグラム 1 点あたりのミリ秒（仕様メモ §2.5）。
 * version>=10005 は (to-from)/size を粗さで量子化する。
 */
export function getMillisPerPoint(
  version: number,
  fromMillis: number,
  toMillis: number,
  historySize: number,
): number {
  const coarse = Math.trunc((toMillis - fromMillis) / historySize);
  if (version < 10005) {
    return coarse;
  }
  if (coarse <= 25000) return 10000;
  if (coarse <= 50000) return 30000;
  if (coarse <= 100000) return 60000;
  return 300000;
}

/**
 * 深眠しきい値（仕様メモ §2.5・version 分岐）。
 * 現行（version>=10008）は固定 3.1。
 */
export function getDeepSleepThreshold(version: number, history: number[]): number {
  if (version >= 10008) return 3.1;
  if (version >= 10005) return 3.3;
  if (version > 10001) return percentile(history, 65);
  return averageOfNonNegative(history);
}

/** 1-indexed の p パーセンタイル（rank = ceil(p * n) 番目） */
function percentile(sortedValues: number[], p: number): number {
  const sorted = [...sortedValues].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const value = sorted[rank - 1];
  return value ?? sorted[sorted.length - 1] ?? 0;
}

function averageOfNonNegative(values: number[]): number {
  const nonNeg = values.filter((v) => v >= 0);
  if (nonNeg.length === 0) return 0;
  return nonNeg.reduce((a, b) => a + b, 0) / nonNeg.length;
}

/**
 * 後処理の最小深眠長（ミリ秒・仕様メモ §2.5）。現行（version>=10008）は 900000（15 分）。
 * version 10005-10007 は WATCH/SONAR/PHASER タグで 600000（10 分）に短縮。
 */
export function getMinDeepSleepLength(version: number, deviceTags: string): number {
  switch (version) {
    case 10000:
    case 10001:
    case 10002:
      return hasTag(deviceTags, 'WATCH') ? 960_000 : 1_190_000;
    case 10003:
    case 10004:
      return 960_000;
    case 10005:
    case 10006:
    case 10007:
      return hasTag(deviceTags, 'WATCH') ||
        hasTag(deviceTags, 'SONAR') ||
        hasTag(deviceTags, 'PHASER')
        ? 600_000
        : 900_000;
    case 10008:
      return 900_000;
    default:
      return hasTag(deviceTags, 'WATCH') ? 960_000 : 1_190_000;
  }
}

function hasTag(tags: string, tag: string): boolean {
  return tags.split(',').includes(tag);
}

/**
 * 高活動頻度配列（仕様メモ §2.5入力）。
 * 0/1 フラグ系列 → 先頭窓移動平均（窓=aggregation）→ aggregation 点ごとに間引き。
 * 出力長 = targetSize（history と同長）。
 */
export function getHighActivityFrequency(
  flags: number[],
  targetSize: number,
  aggregation: number,
): number[] {
  const target = targetSize * aggregation;
  const arr = new Array<number>(target).fill(0);
  const limit = Math.min(flags.length, target);
  for (let i = 0; i < limit; i++) {
    if (flags[i]) {
      arr[i] = 1;
    }
  }
  return decimate(movingAverage(arr, aggregation), aggregation);
}

/** 先頭窓移動平均: arr[i] = avg(arr[i .. min(i+window, len))） */
function movingAverage(arr: number[], window: number): number[] {
  return arr.map((_, i) => {
    const end = Math.min(i + window, arr.length);
    let sum = 0;
    for (let j = i; j < end; j++) sum += arr[j] ?? 0;
    return sum / (end - i);
  });
}

/** aggregation 点ごとに先頭点を採用して間引き（出力長 = floor(len/step)） */
function decimate(arr: number[], step: number): number[] {
  if (step === 1) return arr;
  const length = Math.floor(arr.length / step);
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    out[i] = arr[i * step] ?? 0;
  }
  return out;
}

/**
 * ヒプノグラム 1 フレームのミリ秒。実測サンプリング 10 秒粒度と整合
 * （仕様メモ §2.5 補足・aggregation<=10 の範囲で fMin=0.1 に丸められ挙動不変）。
 */
export const FRAMERATE_MS = 10_000;

export type HypnogramLabel = 'DEEP' | 'LIGHT' | 'BROKEN';

export interface HypnogramEventInterval {
  label: HypnogramLabel;
  start: number;
  end: number;
}

/**
 * サンプル分類（仕様メモ §2.5）:
 * 負値→BROKEN・しきい値以上は高活動頻度が [0,fMin] の外側なら LIGHT・内側なら DEEP・
 * しきい値未満は DEEP。ラベル変化点で区間化し・末尾を toMillis にクリップする。
 */
export function classifyActivitySegments(
  history: number[],
  highActivityFreq: number[],
  version: number,
  fromMillis: number,
  toMillis: number,
  millisPerPoint: number,
): HypnogramEventInterval[] {
  if (history.length !== highActivityFreq.length) return [];
  const threshold = getDeepSleepThreshold(version, history);
  const aggregation = Math.trunc(millisPerPoint / FRAMERATE_MS);
  const fMin = Math.min(3 / aggregation, 0.1);

  const labels: HypnogramLabel[] = history.map((value, i) => {
    if (value < 0) return 'BROKEN';
    if (value >= threshold) {
      const freq = highActivityFreq[i] ?? 0;
      return freq <= 0 || freq >= fMin ? 'LIGHT' : 'DEEP';
    }
    return 'DEEP';
  });

  const events: { ts: number; label: HypnogramLabel }[] = [];
  for (let i = 0; i < labels.length; i++) {
    const cur = labels[i] as HypnogramLabel;
    const prev = i === 0 ? undefined : labels[i - 1];
    const next = i === labels.length - 1 ? undefined : labels[i + 1];
    if (prev !== cur) {
      events.push({ ts: i * millisPerPoint + fromMillis, label: cur });
    }
    if (next !== cur) {
      events.push({ ts: (i + 1) * millisPerPoint + fromMillis, label: cur });
    }
  }
  const last = events[events.length - 1];
  if (last && last.ts < toMillis) {
    last.ts = toMillis;
  }
  const out: HypnogramEventInterval[] = [];
  for (let i = 0; i + 1 < events.length; i += 2) {
    out.push({ label: events[i]!.label, start: events[i]!.ts, end: events[i + 1]!.ts });
  }
  return out;
}

/**
 * 深眠区間の後処理（仕様メモ §2.5）: minDeepSleepLength 未満の DEEP を LIGHT に格下げし・
 * 格下げで隣接した LIGHT 区間をマージする。BROKEN は対象外。
 */
export function postProcessDeepIntervals(
  intervals: HypnogramEventInterval[],
  version: number,
  deviceTags: string,
): HypnogramEventInterval[] {
  const minDeep = getMinDeepSleepLength(version, deviceTags);
  const downgraded = intervals.map((interval) =>
    interval.label === 'DEEP' && interval.end - interval.start < minDeep
      ? { ...interval, label: 'LIGHT' as const }
      : interval,
  );

  const result: HypnogramEventInterval[] = [];
  let mergeStart: number | null = null;
  for (let i = 0; i < downgraded.length; i++) {
    const interval = downgraded[i] as HypnogramEventInterval;
    if (interval.label === 'LIGHT') {
      const prev = i === 0 ? undefined : downgraded[i - 1];
      const next = i === downgraded.length - 1 ? undefined : downgraded[i + 1];
      if (prev === undefined || prev.label !== 'LIGHT') {
        mergeStart = interval.start;
      }
      if (next === undefined || next.label !== 'LIGHT') {
        result.push({ label: 'LIGHT', start: mergeStart ?? interval.start, end: interval.end });
      }
    } else {
      result.push(interval);
    }
  }
  return result;
}

export type RemEventInterval = { label: 'REM'; start: number; end: number };

/**
 * REM 区間生成（仕様メモ §2.5）: 前区間が DEEP（>=10 分）で現区間が LIGHT（>=15 分）の
 * ペアに対し・LIGHT 開始+10 分から 5 分丸め半分の長さ（下限 5 分・上限 50 分）の REM 区間を
 * 置く。睡眠開始（先頭区間の開始）+50 分以前は REM としない（5 分以上残れば +50 分に圧縮）。
 */
export function detectREM(intervals: HypnogramEventInterval[]): RemEventInterval[] {
  const TEN = 10 * 60_000;
  const FIFTEEN = 15 * 60_000;
  const FIVE = 5 * 60_000;
  const FIFTY = 50 * 60_000;

  const first = intervals[0];
  if (!first) return [];
  const forbiddenStart = first.start + FIFTY;

  const out: RemEventInterval[] = [];
  for (let i = 1; i < intervals.length; i++) {
    const prev = intervals[i - 1] as HypnogramEventInterval;
    const prevLen = prev.end - prev.start;
    if (prev.label !== 'DEEP' || prevLen < TEN) continue;
    const cur = intervals[i] as HypnogramEventInterval;
    const curLen = cur.end - cur.start;
    if (cur.label !== 'LIGHT' || curLen < FIFTEEN) continue;

    const remStart = cur.start + TEN;
    const remaining = curLen - TEN;
    const unitCount = Math.floor(remaining / FIVE);
    const rounded = Math.floor((unitCount + 1) / 2) * FIVE;
    const remLength = Math.min(remaining, Math.min(FIFTY, Math.max(FIVE, rounded)));
    const remEnd = remStart + remLength;

    if (forbiddenStart <= remStart) {
      out.push({ label: 'REM', start: remStart, end: remEnd });
    } else if (remEnd - forbiddenStart >= FIVE) {
      out.push({ label: 'REM', start: forbiddenStart, end: remEnd });
    }
  }
  return out;
}

/** 個別 REM 区間の削断（仕様メモ §2.5・覚醒時 REM 除去 New 版相当）。残を採用すべき断片列を返す */
function clearRemAtAwakeNew(rem: Interval, awakes: Interval[]): Interval[] {
  const LONG_AWAKE_MS = 360_000;
  const cuts: Interval[] = [];
  let cur: Interval = { start: rem.start, end: rem.end };
  let terminatedEmpty = false;
  let terminatedCut = false;
  for (const aw of awakes) {
    if (cur.end <= aw.start) break;
    const intersectStart = Math.max(cur.start, aw.start);
    const intersectEnd = Math.min(cur.end, aw.end);
    if (intersectStart >= intersectEnd) continue;
    if (aw.start <= cur.start && aw.end >= cur.end) {
      terminatedEmpty = true;
      break;
    }
    if (aw.start > cur.start) {
      if (aw.end >= cur.end) {
        cuts.push({ start: cur.start, end: aw.start });
        terminatedCut = true;
        break;
      }
      cuts.push({ start: cur.start, end: aw.start });
      if (aw.end - aw.start >= LONG_AWAKE_MS) {
        terminatedCut = true;
        break;
      }
      cur = { start: aw.end, end: cur.end };
      continue;
    }
    // aw.start <= cur.start（先頭からの覚醒）
    if (aw.end - aw.start >= LONG_AWAKE_MS) {
      terminatedEmpty = true;
      break;
    }
    cur = { start: aw.end, end: cur.end };
  }
  if (!terminatedEmpty && !terminatedCut && cur.end > cur.start) {
    cuts.push(cur);
  }
  return cuts;
}

/**
 * 覚醒時 REM 除去（仕様メモ §2.5）。全 REM 区間を覚醒区間リストで削断し・
 * 断片のうち長さ >= 5 分のみ REM として採用する。
 */
export function clearRemAtAwake(
  remIntervals: RemEventInterval[],
  awakes: Interval[],
): RemEventInterval[] {
  const FIVE = 5 * 60_000;
  const out: RemEventInterval[] = [];
  for (const rem of remIntervals) {
    for (const piece of clearRemAtAwakeNew(rem, awakes)) {
      if (piece.end - piece.start >= FIVE) {
        out.push({ label: 'REM', start: piece.start, end: piece.end });
      }
    }
  }
  return out;
}

export interface HypnogramInput {
  /** 正規化活動値系列（filteredHistory 相当・負値=欠損） */
  history: number[];
  /** 高活動フラグ系列（0/1・DHA 相当） */
  flags: number[];
  /** 記録開始時刻（ミリ秒） */
  fromMillis: number;
  /** 記録終了時刻（ミリ秒） */
  toMillis: number;
  /** 睡眠記録 version（既定 10008=現行） */
  version?: number;
  /** デバイスタグ（WATCH/SONAR/PHASER 等・カンマ区切り・要素前後の空白は非対応） */
  deviceTags?: string;
  /**
   * 覚醒区間リスト（時系列昇順必須）。指定時は REM 生成後に clearRemAtAwake を適用する
   * （原典は覚醒イベント更新時に別段階で呼ぶため・未指定時は除去なしの後方互換挙動）
   */
  awakes?: Interval[];
}

export type HypnogramOutput = (HypnogramEventInterval | RemEventInterval)[];

/**
 * ヒプノグラム生成の統合エントリ（仕様メモ §2.5）。
 * 分類→短 DEEP 格下げと LIGHT マージ→REM 生成→（awakes 指定時）覚醒時 REM 除去の順。
 * 記録全体が 20 分以下（history 長×millisPerPoint<=1,200,000）なら空配列。
 * aggregation<1（version<10005 で可変 millisPerPoint が FRAMERATE 未満）は Error。
 */
export function computeHypnogram(input: HypnogramInput): HypnogramOutput {
  const version = input.version ?? 10008;
  const deviceTags = input.deviceTags ?? '';
  const millisPerPoint = getMillisPerPoint(
    version,
    input.fromMillis,
    input.toMillis,
    input.history.length,
  );
  if (input.history.length * millisPerPoint <= 1_200_000) return [];
  const aggregation = Math.trunc(millisPerPoint / FRAMERATE_MS);
  if (aggregation < 1) {
    throw new Error(
      `aggregation must be >= 1 (millisPerPoint=${millisPerPoint}, version=${version})`,
    );
  }
  const freq = getHighActivityFrequency(input.flags, input.history.length, aggregation);
  const segments = classifyActivitySegments(
    input.history,
    freq,
    version,
    input.fromMillis,
    input.toMillis,
    millisPerPoint,
  );
  const processed = postProcessDeepIntervals(segments, version, deviceTags);
  const withRem = [...processed, ...detectREM(processed)];
  if (input.awakes === undefined) return withRem;
  const remIntervals = withRem.filter((r): r is RemEventInterval => r.label === 'REM');
  const others = withRem.filter((r) => r.label !== 'REM');
  return [...others, ...clearRemAtAwake(remIntervals, input.awakes)];
}
