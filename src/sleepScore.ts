/**
 * 睡眠スコア計算（仕様メモ §4・10測定項目の合否比率）。
 * SCORE は集計対象外（仕様メモ §4.4・空区間のため表示用メタデータ扱い）。
 */

export type MeasureType = 'RANGE' | 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';

export type MeasureKey =
  | 'DURATION'
  | 'DEEP_SLEEP'
  | 'EFFICIENCY'
  | 'IRREGULARITY'
  | 'SNORE'
  | 'RATING'
  | 'HR'
  | 'HRV'
  | 'RDI';

export interface MeasureSpec {
  type: MeasureType;
  limitPositive: number;
  limitNegative: number;
}

/** 測定項目のしきい値表（仕様メモ §4.2・数値はそのまま再現） */
export const MEASURE_SPECS: Record<MeasureKey, MeasureSpec> = {
  DURATION: { type: 'RANGE', limitPositive: 410, limitNegative: 540 },
  DEEP_SLEEP: { type: 'HIGHER_IS_BETTER', limitPositive: 0.2, limitNegative: 0.1 },
  EFFICIENCY: { type: 'HIGHER_IS_BETTER', limitPositive: 0.95, limitNegative: 0.85 },
  IRREGULARITY: { type: 'HIGHER_IS_BETTER', limitPositive: 0.9, limitNegative: 0.75 },
  SNORE: { type: 'LOWER_IS_BETTER', limitPositive: 0.04, limitNegative: 0.1 },
  RATING: { type: 'HIGHER_IS_BETTER', limitPositive: 3.8, limitNegative: 2.5 },
  HR: { type: 'RANGE', limitPositive: 35, limitNegative: 55 },
  HRV: { type: 'HIGHER_IS_BETTER', limitPositive: 2.0, limitNegative: -5.0 },
  RDI: { type: 'LOWER_IS_BETTER', limitPositive: 10, limitNegative: 20 },
};

export type ScoreColorType = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface MeasureResult {
  /** 表示進捗 0-100（整数・四捨五入後クリップ） */
  progress: number;
  colorType: ScoreColorType;
}

/** 年齢→DURATIONしきい値上書き（仕様メモ §4.3・米国睡眠財団準拠の数値構造） */
const AGE_DURATION_LIMITS: { minAge: number; maxAge: number; pos: number; neg: number }[] = [
  { minAge: 6, maxAge: 13, pos: 540, neg: 720 },
  { minAge: 14, maxAge: 17, pos: 480, neg: 660 },
  { minAge: 18, maxAge: 25, pos: 420, neg: 600 },
  { minAge: 65, maxAge: Infinity, pos: 360, neg: 600 },
];

function clamp100(v: number): number {
  return Math.max(Math.min(v, 100), 0);
}

export class SleepScoreCalculator {
  private score = 0;
  private maxScore = 0;
  private durationSpec: MeasureSpec = { ...MEASURE_SPECS.DURATION };

  constructor(private readonly options: { idealSleepMinutes?: number } = {}) {}

  /** 年齢でDURATIONしきい値を上書き（age<=0は無視・§4.3） */
  setAge(age: number): void {
    if (age <= 0) return;
    for (const lim of AGE_DURATION_LIMITS) {
      if (age >= lim.minAge && age <= lim.maxAge) {
        this.durationSpec = { type: 'RANGE', limitPositive: lim.pos, limitNegative: lim.neg };
        return;
      }
    }
    // 26-64歳は初期値のまま
  }

  /** 測定値を入力し合否・進捗・色を得る（呼び出しごとに集計に加算される） */
  updateMeasure(key: MeasureKey, value: number): MeasureResult {
    const spec = key === 'DURATION' ? this.durationSpec : (MEASURE_SPECS[key] as MeasureSpec);
    this.maxScore++;
    const result = this.evaluate(spec, key, value);
    if (result.passed) this.score++;
    return result;
  }

  getScore(): number {
    return this.score;
  }

  getScoreMax(): number {
    return this.maxScore;
  }

  /** スコアのパーセント（0-100・評価対象0件時は0） */
  getScorePercentage(): number {
    if (this.maxScore === 0) return 0;
    return Math.round((this.score / this.maxScore) * 100);
  }

  private evaluate(spec: MeasureSpec, key: MeasureKey, v: number): MeasureResult & { passed: boolean } {
    switch (spec.type) {
      case 'RANGE': {
        const passed = v >= spec.limitPositive && v <= spec.limitNegative;
        // DURATIONの表示進捗だけは理想睡眠時間ベースの特例（§4.3）
        const progress =
          key === 'DURATION' && this.options.idealSleepMinutes !== undefined
            ? clamp100(Math.round((v / this.options.idealSleepMinutes) * 100))
            : v < spec.limitPositive
              ? clamp100(Math.round((v / spec.limitPositive) * 100))
              : v > spec.limitNegative
                ? clamp100(Math.round((2 - v / spec.limitNegative) * 100))
                : 100;
        // 緩衝帯（仕様メモ §4.1・±25%）
        const colorType: ScoreColorType =
          v >= spec.limitPositive * 0.75 && v <= spec.limitNegative * 1.25 ? 'POSITIVE' : 'NEGATIVE';
        return { progress, colorType, passed };
      }
      case 'HIGHER_IS_BETTER': {
        const passed = v >= spec.limitPositive;
        const base = spec.limitNegative / 2;
        const progress = clamp100(Math.round(((v - base) * 100) / (spec.limitPositive - base)));
        return { progress, colorType: passed ? 'POSITIVE' : 'NEGATIVE', passed };
      }
      case 'LOWER_IS_BETTER': {
        const passed = v <= spec.limitPositive;
        const upper = spec.limitNegative * 2;
        const progress = clamp100(Math.round(((upper - v) * 100) / (upper - spec.limitPositive)));
        return { progress, colorType: passed ? 'POSITIVE' : 'NEGATIVE', passed };
      }
    }
  }
}
