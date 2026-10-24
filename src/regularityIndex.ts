const MINUTES_PER_DAY = 1440;

/**
 * Sleep Regularity Index（仕様メモ §6）:
 * 当日と翌日の1分単位睡眠ビット列のXOR一致率。
 * SRI = 1 − (睡眠状態が異なった分数 / 1440)。どちらかがデータなし（全false）なら -1。
 */
export function computeRegularityIndex(dayA: boolean[], dayB: boolean[]): number {
  if (dayA.length !== MINUTES_PER_DAY || dayB.length !== MINUTES_PER_DAY) {
    throw new Error(`sleep bits must be exactly ${MINUTES_PER_DAY} minutes per day`);
  }
  const countTrue = (bits: boolean[]): number => bits.reduce((n, b) => (b ? n + 1 : n), 0);
  if (countTrue(dayA) === 0 || countTrue(dayB) === 0) return -1;

  let diffBits = 0;
  for (let i = 0; i < MINUTES_PER_DAY; i++) {
    if (dayA[i] !== dayB[i]) diffBits++;
  }
  return 1 - diffBits / MINUTES_PER_DAY;
}
