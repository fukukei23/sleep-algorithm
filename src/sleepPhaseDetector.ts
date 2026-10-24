import { ActivityFlags, Interval, SleepPhase } from './types';

/** スマート起床感度→チェック回数マップ（仕様メモ §2.3・未指定/範囲外は3） */
export function smartWakeupChecks(sensitivity?: number): number {
  switch (sensitivity) {
    case 1:
      return 1;
    case 2:
      return 3;
    case 3:
      return 6;
    case 4:
      return 10;
    default:
      return 3;
  }
}

const LOSS_WINDOW = 5;
const LOSS_RESET_RATIO = 0.9;
const MIN_POINTS = 12;
const DEEP_BACKDATE_MS = 5 * 60 * 1000;
const LIGHT_BACKDATE_MS = 10 * 1000;

export interface SleepPhaseDetectorOptions {
  /** 高活動の短窓サンプル数（スマホ6・スマートウォッチ12・仕様メモ §2.3） */
  shortWindow?: number;
  /** 微活動の長窓サンプル数（30） */
  longWindow?: number;
  /** スマート起床感度（checksマップ用） */
  sensitivity?: number;
}

/** 睡眠段階判定（仕様メモ §2・深眠/浅眠/不明の3値） */
export class SleepPhaseDetector {
  private phase: SleepPhase = 'UNKNOWN';
  private pointsCount = 0;
  private highFlags: number[] = [];
  private someFlags: number[] = [];
  private lossWindow: boolean[] = [];
  private readonly shortWindow: number;
  private readonly longWindow: number;
  private readonly checks: number;

  constructor(options: SleepPhaseDetectorOptions = {}) {
    this.shortWindow = options.shortWindow ?? 6;
    this.longWindow = options.longWindow ?? 30;
    this.checks = smartWakeupChecks(options.sensitivity);
  }

  /** フラグを1サンプル入力（null=欠損）して睡眠段階を得る */
  update(flags: ActivityFlags | null): SleepPhase {
    if (flags === null) {
      this.pushLoss(true);
      // 直近窓の欠損率>0.9 → リセット（仕様メモ §2.2）
      const lossCount = this.lossWindow.filter((x) => x).length;
      if (lossCount / LOSS_WINDOW > LOSS_RESET_RATIO) {
        this.reset();
      }
      return this.phase; // 欠損サンプルはスキップ（前状態維持）
    }
    this.pushLoss(false);

    this.highFlags.push(flags.isHighActivity ? 1 : 0);
    if (this.highFlags.length > this.shortWindow) this.highFlags.shift();
    this.someFlags.push(flags.isSomeActivity ? 1 : 0);
    if (this.someFlags.length > this.longWindow) this.someFlags.shift();

    this.pointsCount++;
    if (this.pointsCount < MIN_POINTS) {
      this.phase = 'UNKNOWN';
      return this.phase;
    }

    const sumShort = this.highFlags.reduce((a, b) => a + b, 0);
    const sumLong = this.someFlags.reduce((a, b) => a + b, 0);
    // OR条件（仕様メモ §2.3・原典挙動をそのまま再現）
    this.phase =
      Math.round(sumShort) < 1 || Math.round(sumLong) < this.checks
        ? 'DEEP_SLEEP'
        : 'LIGHT_SLEEP';
    return this.phase;
  }

  reset(): void {
    this.phase = 'UNKNOWN';
    this.pointsCount = 0;
    this.highFlags = [];
    this.someFlags = [];
    this.lossWindow = []; // MLR r1修正: リセット後の欠損率が旧フラグの影響を受けないようにする
  }

  private pushLoss(v: boolean): void {
    this.lossWindow.push(v);
    if (this.lossWindow.length > LOSS_WINDOW) this.lossWindow.shift();
  }
}

/** 睡眠段階から区間を記録する（仕様メモ §2.4・深眠は5分遡り・浅眠は10秒遡り） */
export class RemIntervalRecorder {
  private lastPhase: SleepPhase | null = null;
  private readonly deep: Interval[] = [];
  private readonly light: Interval[] = [];

  onPhase(phase: SleepPhase, clockMillis: number): void {
    if (phase === 'DEEP_SLEEP') {
      if (this.lastPhase === 'DEEP_SLEEP' && this.deep.length > 0) {
        const last = this.deep[this.deep.length - 1];
        if (last) last.end = clockMillis;
      } else {
        this.deep.push({ start: clockMillis - DEEP_BACKDATE_MS, end: clockMillis });
      }
    } else if (phase === 'LIGHT_SLEEP') {
      if (this.lastPhase === 'LIGHT_SLEEP' && this.light.length > 0) {
        const last = this.light[this.light.length - 1];
        if (last) last.end = clockMillis;
      } else {
        this.light.push({ start: clockMillis - LIGHT_BACKDATE_MS, end: clockMillis });
      }
    }
    this.lastPhase = phase;
  }

  /** 区間のディープコピーを返す（呼び出し側の破壊的変更から内部状態を保護・MLR r2修正） */
  getIntervals(): { deep: Interval[]; light: Interval[] } {
    return {
      deep: this.deep.map((i) => ({ ...i })),
      light: this.light.map((i) => ({ ...i })),
    };
  }

  /** 測定セッション再開時に区間をクリアする（MLR r1修正） */
  reset(): void {
    this.lastPhase = null;
    this.deep.length = 0;
    this.light.length = 0;
  }
}
