import { NO_ACTIVITY, type Interval } from './types';

/** 覚醒検知器の共通インターフェース（仕様メモ §3） */
export interface AwakeDetector {
  isAwake(...args: never[]): boolean;
  stop(): void;
}

/** 高活動量検知（仕様メモ §3・移動平均がしきい値超で覚醒・milli-G自動補正） */
export class AverageActivityOverThresholdDetector {
  /** 移動平均の窓（仕様メモ §3「移動平均」・評価開始条件と同じ30サンプルで統一） */
  private static readonly AVERAGE_WINDOW = 30;
  private readonly history: number[] = [];
  private callCount = 0;
  private looksLikeMilliG = false;
  private lastResult = false;

  constructor(private readonly threshold: number) {}

  /** 活動値を1サンプル入力 */
  update(activity: number): boolean {
    this.callCount++;
    if (activity > 150.0 && !this.looksLikeMilliG) {
      this.looksLikeMilliG = true;
    }
    const effectiveThreshold = this.looksLikeMilliG ? this.threshold * 100.0 : this.threshold;
    this.history.push(activity);
    if (this.history.length > AverageActivityOverThresholdDetector.AVERAGE_WINDOW) {
      this.history.shift();
    }
    const avg = this.history.reduce((a, b) => a + b, 0) / this.history.length;
    this.lastResult = this.callCount >= 30 && avg > effectiveThreshold;
    return this.lastResult;
  }

  isAwake(): boolean {
    return this.lastResult;
  }

  stop(): void {
    this.history.length = 0;
    this.callCount = 0;
    this.lastResult = false;
  }
}

/** 高活動頻度検知（仕様メモ §3・平均+3σ超フラグの直近窓比率で覚醒判定・純関数） */
export class HighActivityFrequencyDetector {
  constructor(
    private readonly options: { windowSize: number; threshold: number; sigmaMultiplier?: number }
  ) {}

  /** 振幅履歴全体を受け取り覚醒判定する */
  isAwake(history: number[]): boolean {
    const { windowSize, threshold, sigmaMultiplier = 3.0 } = this.options;
    if (history.length < windowSize) return false;
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
    const sigma = Math.sqrt(variance);
    const flags: number[] = history.map((v) => (v > mean + sigmaMultiplier * sigma ? 1 : 0));
    const recent = flags.slice(-windowSize);
    const ratio = recent.reduce((a, b) => a + b, 0) / recent.length;
    return ratio >= threshold;
  }

  stop(): void {}
}

/**
 * スマホ使用検知（仕様メモ §3・画面ON継続時間で覚醒・スクリーンセーバー時は別閾値）。
 * 定数値は仕様メモ §4.4 に基づく実装裁量（原典の正確値は未解析）。
 * MLR r1修正: MAX超過でfalseを返すのは「覚醒でない」ことと矛盾するため、MAXは
 * 判定対象の継続時間の頭打ち（cap）とし・MIN以上なら覚醒を継続報告する。
 * screensaver は onScreenOn 時点の値でスナップショット（判定時点の状態競合を遮断）。
 */
export class PhoneUsageDetector {
  /** 通常時: 画面ON最小継続時間（2分） */
  static readonly SCREEN_ON_MIN_TIME_MS = 2 * 60 * 1000;
  /** スクリーンセーバー時: 最小継続時間（15分） */
  static readonly SCREEN_ON_MIN_TIME_SCREENSAVER_MS = 15 * 60 * 1000;
  /** 画面ON継続時間の累積上限（これ以上は覚醒判定を継続報告する・省電力の打ち切りではない） */
  static readonly SCREEN_ON_MAX_TIME_MS = 60 * 60 * 1000;

  private screenOnStart: number | null = null;
  private screenSaverSetting = false;
  private screenSaverAtOn = false;
  private lastResult = false;

  onScreenOn(timestampMs: number): void {
    // MLR r3修正: OSの重複ONイベントで screenOnStart が上書きされ継続時間がリセットされるのを防ぐ
    if (this.screenOnStart !== null) return;
    this.screenOnStart = timestampMs;
    this.screenSaverAtOn = this.screenSaverSetting; // ON開始時点でスナップショット確定
  }

  onScreenOff(_timestampMs: number): void {
    this.screenOnStart = null;
    this.lastResult = false;
  }

  /** スクリーンセーバー状態を設定する（次のonScreenOnから適用される） */
  setScreenSaver(v: boolean): void {
    this.screenSaverSetting = v;
  }

  /** 現在時刻で覚醒判定する */
  isAwake(nowMs: number): boolean {
    if (this.screenOnStart === null) {
      this.lastResult = false;
      return false;
    }
    const onDuration = nowMs - this.screenOnStart;
    const cappedDuration = Math.min(onDuration, PhoneUsageDetector.SCREEN_ON_MAX_TIME_MS);
    const minTime = this.screenSaverAtOn
      ? PhoneUsageDetector.SCREEN_ON_MIN_TIME_SCREENSAVER_MS
      : PhoneUsageDetector.SCREEN_ON_MIN_TIME_MS;
    this.lastResult = cappedDuration >= minTime;
    return this.lastResult;
  }

  stop(): void {
    this.screenOnStart = null;
    this.lastResult = false;
  }
}

export interface SunState {
  sunriseMs: number;
  sunsetMs: number;
}

/**
 * 照度検知（仕様メモ §3・夜間のみ照度で覚醒・日中は無効）。
 * 感度→luxしきい値テーブルは実装裁量（§4.4）。
 */
export class LightsOnDetector {
  /** 感度レベル→luxしきい値（低感度→高しきい値） */
  static readonly LUX_THRESHOLDS = [200, 50, 10, 5];

  private lux = 0;

  constructor(private readonly options: { sensitivity: number }) {}

  updateLux(lux: number): void {
    this.lux = lux;
  }

  /** 現在時刻と日の出/日の入りを受け取り覚醒判定する */
  isAwake(nowMs: number, sun: SunState): boolean {
    // 日中（日の出後〜日の入り前）は照度覚醒を無効化
    if (nowMs >= sun.sunriseMs && nowMs < sun.sunsetMs) return false;
    const idx = this.options.sensitivity - 1;
    const threshold =
      idx >= 0 && idx < LightsOnDetector.LUX_THRESHOLDS.length
        ? (LightsOnDetector.LUX_THRESHOLDS[idx] ?? 10)
        : 10;
    return this.lux > threshold;
  }

  stop(): void {}
}

/** 覚醒検知器のOR合成（仕様メモ §3） */
export class EnsembleAwakeDetector {
  private readonly detectors: { isAwake: () => boolean; stop?: () => void }[] = [];
  private forced: boolean | null = null;

  add(detector: { isAwake: () => boolean; stop?: () => void }): boolean {
    this.detectors.push(detector);
    return true;
  }

  isAwake(): boolean {
    if (this.forced !== null) return this.forced;
    return this.detectors.some((d) => d.isAwake());
  }

  forceAwakeNow(): void {
    this.forced = true;
  }

  forceNotAwake(): void {
    this.forced = false;
  }

  stop(): void {
    this.forced = null;
    // MLR r3修正: 子detectorのstop()を伝播（履歴残留を防ぐ・stop未実装detectorは無視）
    for (const d of this.detectors) d.stop?.();
  }
}

/** バッチ覚醒区間列挙のオプション（§3 表・実装裁量値は §4.4 に基づく明示値） */
export interface AwakeBatchOptions {
  /** 高活動量検知のしきい値（§3 表・既定 1.5） */
  activityThreshold?: number;
  /** 高活動頻度検知の直近窓（実装裁量・既定 30=評価開始条件と統一） */
  freqWindowSize?: number;
  /** 高活動頻度検知のフラグ比率しきい値（実装裁量・既定 0.5） */
  freqThreshold?: number;
  /** 高活動頻度検知を有効化（既定 true・スマホ使用/照度検知は実データに列が無いため合成検証のみ） */
  enableFrequency?: boolean;
}

/** 欠損ギャップ判定の倍率（直前サンプル差のこの倍数超で区間を分断） */
const GAP_FACTOR = 2;

/**
 * 活動系列から覚醒区間を列挙する（仕様メモ §3 のバッチ版）。
 * バッチ経路は活動系列のみから判定できる**高活動量検知と高活動頻度検知の OR 合成**の2検知器
 * （PhoneUsage/LightsOn は画面ON/lux イベント入力が必要なため本関数の対象外・
 * ストリーム経路は EnsembleAwakeDetector で4検知器合成になる）。
 * サンプル単位に覚醒判定し・連続する覚醒サンプルを「開始=覚醒先頭の 1 ループ前
 * （=1サンプル前・§3「覚醒開始（1 ループ前）」の語彙）・終了=覚醒最終の次サンプル時刻」
 * の Interval に変換する。ts 差が直前サンプル差の GAP_FACTOR 倍超の欠損ギャップでは
 * 区間を分断する（ギャップ帯が覚醒に化けるのを防ぐ）。
 * 分断時は start の1ループ前拡張がギャップ直前のサンプル ts を指すため・隣接区間の
 * 境界が重なり得る（start<end は常に維持・交差は clearRemAtAwake 側で問題なく処理）。
 * 覚醒判定は高活動量検知の評価開始（callCount>=30）と高活動頻度検知の窓充足
 * （history>=windowSize・かつ単調系列では σ=0 でフラグが立たない）が必要なため・
 * flags[0..29] は常に非覚醒。特に flags[0]=false より区間化の j>=1 が保証され・
 * endTs の samples[j-1] 参照は常に安全。
 */
export function detectAwakeIntervals(
  samples: { ts: number; amp: number }[],
  options: AwakeBatchOptions = {},
): Interval[] {
  if (samples.length === 0) return [];
  const threshold = options.activityThreshold ?? 1.5;
  const windowSize = options.freqWindowSize ?? 30;
  const freqThreshold = options.freqThreshold ?? 0.5;
  const enableFrequency = options.enableFrequency ?? true;

  const avgDetector = new AverageActivityOverThresholdDetector(threshold);
  const freqDetector = new HighActivityFrequencyDetector({
    windowSize,
    threshold: freqThreshold,
  });

  const awakeFlags: boolean[] = samples.map((sample, i) => {
    const history = samples.slice(0, i + 1).map((s) => s.amp);
    const byAvg = avgDetector.update(sample.amp);
    const byFreq = enableFrequency && freqDetector.isAwake(history);
    return byAvg || byFreq;
  });

  const out: Interval[] = [];
  let i = 0;
  while (i < awakeFlags.length) {
    if (!awakeFlags[i]) {
      i++;
      continue;
    }
    let j = i;
    let gapBreak = false;
    while (j + 1 < awakeFlags.length && awakeFlags[j + 1]) {
      const gap = (samples[j + 1] as { ts: number }).ts - (samples[j] as { ts: number }).ts;
      const prevGap = (samples[j] as { ts: number }).ts - (samples[j - 1] as { ts: number }).ts;
      if (gap > GAP_FACTOR * prevGap) {
        gapBreak = true;
        break;
      }
      j++;
    }
    const startTs = i > 0 ? (samples[i - 1] as { ts: number }).ts : (samples[0] as { ts: number }).ts;
    // 通常終了（次サンプルが非覚醒で近接）は次サンプル時刻で閉じる。
    // 末尾・ギャップ分断時は最終覚醒サンプル時刻+直前差分（サンプル幅）で閉じる。
    const endTs =
      j + 1 < samples.length && !gapBreak
        ? (samples[j + 1] as { ts: number }).ts
        : (samples[j] as { ts: number }).ts + ((samples[j] as { ts: number }).ts - (samples[j - 1] as { ts: number }).ts);
    out.push({ start: startTs, end: endTs });
    i = j + 1;
  }
  return out;
}

// NO_ACTIVITY は段階判定と共通の「無活動」定数（将来の加速度直結経路用）
export const NO_ACTIVITY_FLAGS = NO_ACTIVITY;
