import { SleepPhase } from './types';

const DEFAULT_WINDOW_MINUTES = 30;
const RINGING_STALE_MS = 60 * 60 * 1000;

export interface SmartWakeSettings {
  /** 目標睡眠達成条件を有効化（§5.2） */
  actOnTargetSleep?: boolean;
  /** 理想睡眠時間（分） */
  idealSleepMinutes?: number;
  /** グローバルのスマート窓（分・未指定は30・MLR r3修正: 設定値が本番経路に伝播していなかった） */
  globalWindowMinutes?: number;
}

export interface SmartPeriodContext {
  snoozing: boolean;
  targetAchieved: boolean;
}

export interface SmartWakeInput {
  nowMs: number;
  alarmMs: number;
  phase: SleepPhase;
  sleepLengthMinutes: number;
  alarmAlreadyRinging: boolean;
  lastRingingTs: number | null;
  /** アラーム個別のスマート窓設定（分・§5.1の smartWindowOverride・未指定ならグローバル30分） */
  smartWindowOverride?: number;
  /** トライアル/使用制限の有効性（§5.3） */
  trialValid?: boolean;
}

export interface SmartWakeDecision {
  fire: boolean;
  suspendOriginalAlarm: boolean;
}

/** smart wake の時刻窓判定と発火条件（仕様メモ §5） */
export class SmartWakeScheduler {
  constructor(private readonly settings: SmartWakeSettings = {}) {}

  /** 窓(分)の決定: アラーム個別設定>=0が優先・無ければグローバル（デフォルト30） */
  static resolveSmartPeriod(
    alarm?: { smartWindowOverride?: number },
    globalMinutes: number = DEFAULT_WINDOW_MINUTES
  ): number {
    const override = alarm?.smartWindowOverride;
    if (override !== undefined && override >= 0) return override;
    return globalMinutes;
  }

  /** 目標睡眠達成（§5.2・設定無効またはideal未設定なら常に達成扱い） */
  targetSleepAchieved(sleepLengthMinutes: number): boolean {
    if (this.settings.actOnTargetSleep !== true) return true;
    if (this.settings.idealSleepMinutes === undefined) return true;
    return sleepLengthMinutes >= this.settings.idealSleepMinutes;
  }

  /** スマート期間（§5.1・スヌーズ中でない・窓>0・[alarm−窓, alarm) の半開区間・目標達成） */
  isInSmartPeriod(nowMs: number, alarmMs: number, windowMinutes: number, ctx: SmartPeriodContext): boolean {
    if (ctx.snoozing) return false;
    if (windowMinutes <= 0) return false;
    if (nowMs >= alarmMs) return false; // MLR r2修正: アラーム時刻経過後はsmart期間外（元アラーム経路に任せる）
    if (nowMs + windowMinutes * 60 * 1000 <= alarmMs) return false;
    if (!ctx.targetAchieved) return false;
    return true;
  }

  /** 同一時・分か（アラームちょうど=通常アラーム経路に任せる・§5.3） */
  private static sameHourMinute(a: number, b: number): boolean {
    const da = new Date(a);
    const db = new Date(b);
    return da.getHours() === db.getHours() && da.getMinutes() === db.getMinutes();
  }

  /**
   * 発火判定（§5.3・メイン監視ループの1周期分）:
   * 未鳴動でアラーム時分ちょうど以外のとき、スマート期間内かつ浅眠かつ目標達成なら発火し
   * 元アラームを停止させる。覚醒検知は条件に含まれない（仕様メモ §3/§5.3）。
   */
  shouldFireSmartWake(input: SmartWakeInput): SmartWakeDecision {
    const noFire: SmartWakeDecision = { fire: false, suspendOriginalAlarm: false };

    // 未鳴動条件（前回鳴動から1時間超過なら再判定可・MLR r3修正: 原典の「<1hで抑止」に整合し1hちょうどは再判定可）
    if (input.alarmAlreadyRinging) return noFire;
    if (input.lastRingingTs !== null && input.nowMs - input.lastRingingTs < RINGING_STALE_MS) {
      return noFire;
    }

    // アラーム時刻ちょうど → 何もしない
    if (SmartWakeScheduler.sameHourMinute(input.nowMs, input.alarmMs)) return noFire;

    const trialValid = input.trialValid !== false;
    const targetAchieved = this.targetSleepAchieved(input.sleepLengthMinutes);
    // §5.1: 窓はアラーム個別設定>=0が優先・無ければグローバル設定（未指定は30分）
    // MLR r3修正: グローバル窓設定が本番経路に伝播していなかった
    const windowMinutes = SmartWakeScheduler.resolveSmartPeriod(
      { smartWindowOverride: input.smartWindowOverride },
      this.settings.globalWindowMinutes ?? 30
    );
    const inSmartPeriod = this.isInSmartPeriod(input.nowMs, input.alarmMs, windowMinutes, {
      snoozing: false,
      targetAchieved,
    });

    if (inSmartPeriod && input.phase === 'LIGHT_SLEEP' && targetAchieved && trialValid) {
      return { fire: true, suspendOriginalAlarm: true };
    }
    return noFire;
  }
}
