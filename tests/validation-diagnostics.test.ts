/**
 * 実機検証の診断テスト（MLR r4 GLM#2指摘採用）:
 * 「DEEP飽和」がフラグ分布のどこに起因するか（無活動連鎖 vs OR条件恒常成立）を
 * 最小入力で分離可能にする。合成データのtruth一致率は本来の指標ではなく・
 * 原典判定 vs 自作判定の一致率が主指標（等価性は比較実験で検証予定）。
 */
import { ActivityClassifier, SleepPhaseDetector } from '../src/index';
import { ActivityFlags } from '../src/types';

function feed(c: ActivityClassifier, d: SleepPhaseDetector, n: number, amp: number): { flags: ActivityFlags; phase: string } {
  let flags: ActivityFlags = { isSomeActivity: false, isHighActivity: false };
  let phase = 'UNKNOWN';
  for (let i = 0; i < n; i++) {
    flags = c.update(amp);
    phase = d.update(flags);
  }
  return { flags, phase };
}

describe('実機検証の診断: 最小入力でフラグ/段階の挙動を分離（MLR r4採用）', () => {
  test('持続単一レベル振幅（1.5×60分）は norm=1 で無活動扱い→DEEP（仕様§1.2-3の構造的挙動を固定化）', () => {
    const c = new ActivityClassifier();
    const d = new SleepPhaseDetector();
    const r = feed(c, d, 60, 1.5);
    // 中央値正規化は「相対変化」を検知する設計: 持続同値では norm=1 → peak<=1 → 無活動
    // （MLR r4 GLM指摘「wake-onlyでLIGHTになるべき」は仕様§1.2-3と不一致=却下・
    //  仕様通りの挙動をこのテストで固定化する）
    expect(r.phase).toBe('DEEP_SLEEP');
  });

  test('静穏→覚醒への遷移（変化あり）なら高活動フラグが立ちLIGHTになる', () => {
    const c = new ActivityClassifier();
    const d = new SleepPhaseDetector();
    // 40分の静穏（norm基準を形成）→ 20分の高振幅（変化）→ 変化検知で LIGHT
    // 起動補正のsqrt圧縮下では norm>9（score>3.0）が必要 → 振幅5.0（norm=12.5）
    feed(c, d, 40, 0.4);
    const r = feed(c, d, 20, 5.0);
    expect(r.phase).toBe('LIGHT_SLEEP');
  });

  test('deep-only入力（振幅0.3×60分）はDEEP多めになる（仕様通りの構造）', () => {
    const c = new ActivityClassifier();
    const d = new SleepPhaseDetector();
    const r = feed(c, d, 60, 0.3);
    expect(r.phase).toBe('DEEP_SLEEP');
  });

  test('静穏55分+スパイク5分でフラグ変化が観測できる（OR条件の分離診断）', () => {
    const c = new ActivityClassifier();
    const d = new SleepPhaseDetector();
    for (let i = 0; i < 55; i++) c.update(0.3);
    let sawHigh = false;
    let sawSome = false;
    for (let i = 0; i < 5; i++) {
      const flags = c.update(2.5);
      if (flags.isHighActivity) sawHigh = true;
      if (flags.isSomeActivity) sawSome = true;
    }
    // スパイクで少なくとも微活動は観測されること（完全無活動なら診断不能）
    expect(sawSome || sawHigh).toBe(true);
  });
});
