/** 睡眠段階の3値（仕様メモ §2） */
export type SleepPhase = 'DEEP_SLEEP' | 'LIGHT_SLEEP' | 'UNKNOWN';

/** 1サンプルあたりの活動フラグ（仕様メモ §1.2-6） */
export interface ActivityFlags {
  isSomeActivity: boolean;
  isHighActivity: boolean;
}

/** 活動なし（無活動判定に相当する固定値・freezeで破壊的書換を防止） */
export const NO_ACTIVITY: Readonly<ActivityFlags> = Object.freeze({
  isSomeActivity: false,
  isHighActivity: false,
} as ActivityFlags);

/** 時間区間（ミリ秒・[start, end]） */
export interface Interval {
  start: number;
  end: number;
}
