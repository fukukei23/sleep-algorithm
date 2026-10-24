import { ActivityFlags, NO_ACTIVITY } from './types';

/** 感度レベル別しきい値テーブル（仕様メモ §1.2-7・低感度順 some/high） */
const SOME_ACTIVITY_THRESHOLDS = [4.0, 3.0, 2.5, 2.0];
const HIGH_ACTIVITY_THRESHOLDS = [6.75, 4.5, 3.0, 2.0];
const DEFAULT_SOME_THRESHOLD = 2.5;
const DEFAULT_HIGH_THRESHOLD = 3.0;
const FIXED_SOME_THRESHOLD = 2.5;
const FIXED_HIGH_THRESHOLD = 3.3;

const WINDOW_SIZE = 720;
const WARMUP_SAMPLES = 360;

export interface ActivityClassifierOptions {
  /** 感度レベル1-4（テーブル外・未指定はデフォルト2.5/3.0） */
  sensitivity?: number;
  /** しきい値の係数（既定1） */
  factor?: number;
  /** 実験フラグ: 固定しきい値2.5/3.3（係数の影響を受けない・仕様メモ §1.2-7） */
  fixedThresholds?: boolean;
}

/** 窓内中央値を計算する */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** 固定長リングバッファ（窓集計用） */
class RingBuffer {
  private readonly buf: number[];
  private index = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array<number>(capacity).fill(0);
  }

  push(value: number): void {
    this.buf[this.index] = value;
    this.index = (this.index + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  values(): number[] {
    if (this.count < this.capacity) return this.buf.slice(0, this.count);
    return this.buf.slice();
  }

  max(): number {
    let m = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const v = this.buf[i];
      if (v !== undefined && v > m) m = v;
    }
    return m;
  }

}

export class ActivityClassifier {
  private readonly amplitudes: RingBuffer;
  private readonly norms: RingBuffer;
  private totalSamples = 0;
  private readonly someThreshold: number;
  private readonly highThreshold: number;

  constructor(options: ActivityClassifierOptions = {}) {
    this.amplitudes = new RingBuffer(WINDOW_SIZE);
    this.norms = new RingBuffer(WINDOW_SIZE);
    const factor = options.factor ?? 1;
    if (options.fixedThresholds === true) {
      this.someThreshold = FIXED_SOME_THRESHOLD;
      this.highThreshold = FIXED_HIGH_THRESHOLD;
    } else {
      const level = options.sensitivity;
      const tableIdx = level !== undefined && level >= 1 && level <= 4 ? level - 1 : null;
      const some = tableIdx !== null ? (SOME_ACTIVITY_THRESHOLDS[tableIdx] ?? DEFAULT_SOME_THRESHOLD) : DEFAULT_SOME_THRESHOLD;
      const high = tableIdx !== null ? (HIGH_ACTIVITY_THRESHOLDS[tableIdx] ?? DEFAULT_HIGH_THRESHOLD) : DEFAULT_HIGH_THRESHOLD;
      this.someThreshold = some * factor;
      this.highThreshold = high * factor;
    }
  }

  /** 振幅（ベースライン除去済みの|a-baseline|）を1サンプル入力し活動フラグを得る（仕様メモ §1.2） */
  update(amplitude: number): ActivityFlags {
    this.amplitudes.push(amplitude);
    this.totalSamples++;

    // 中央値正規化（median<=0 は正規化不可 → 振幅をそのまま使う）
    const med = median(this.amplitudes.values());
    const norm = med > 0 ? amplitude / med : amplitude;
    this.norms.push(norm);

    const peak = this.norms.max();
    // 無活動判定（仕様メモ §1.2-3）
    if (peak <= 1.0) return NO_ACTIVITY;

    // 起動補正（仕様メモ §1.2-4）
    let effectivePeak = peak;
    if (this.totalSamples <= WARMUP_SAMPLES && peak < 100) {
      effectivePeak = 100;
    }

    // 圧縮スコア（仕様メモ §1.2-5）
    const exponent = 1 / Math.log10(effectivePeak);
    const score = Math.pow(Math.min(effectivePeak, norm), exponent);

    return {
      isSomeActivity: score > this.someThreshold,
      isHighActivity: score > this.highThreshold,
    };
  }
}
