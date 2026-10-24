/** 睡眠段階の3値（仕様メモ §2） */
export type SleepPhase = 'DEEP_SLEEP' | 'LIGHT_SLEEP' | 'UNKNOWN';

/** 1サンプルあたりの活動フラグ（仕様メモ §1.2-6） */
export interface ActivityFlags {
  isSomeActivity: boolean;
  isHighActivity: boolean;
}

/** 活動なし（無活動判定に相当する固定値） */
export const NO_ACTIVITY: ActivityFlags = { isSomeActivity: false, isHighActivity: false };

/** 時間区間（ミリ秒・[start, end]） */
export interface Interval {
  start: number;
  end: number;
}
