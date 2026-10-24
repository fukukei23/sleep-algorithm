import { ActivityClassifier } from '../src/activityClassifier';
import { NO_ACTIVITY } from '../src/types';

/** 安定系列を投入するヘルパー（ampをnサンプル分送る） */
function feed(c: ActivityClassifier, n: number, amp: number): void {
  for (let i = 0; i < n; i++) c.update(amp);
}

describe('ActivityClassifier（仕様メモ §1 活動分類）', () => {
  test('安定振幅1.0の系列では無活動（peak<=1で判定終了）', () => {
    const c = new ActivityClassifier();
    feed(c, 720, 1.0);
    expect(c.update(1.0)).toEqual(NO_ACTIVITY);
  });

  test('安定1.0系列後に10.0へ急変 → norm=10・peak=10・score=10 → 両フラグON', () => {
    const c = new ActivityClassifier();
    feed(c, 720, 1.0);
    // 履歴720個が1.0・現在の10.0でnorm=10/median(1)=10 → peak=10
    // score = min(10,10)^(1/log10(10)) = 10^1 = 10
    const flags = c.update(10.0);
    expect(flags.isSomeActivity).toBe(true);
    expect(flags.isHighActivity).toBe(true);
  });

  test('静止0.0の後に0.5 → median=0で正規化不可・norm=0.5・peak<=1で無活動', () => {
    const c = new ActivityClassifier();
    feed(c, 720, 0.0);
    const flags = c.update(0.5);
    expect(flags).toEqual(NO_ACTIVITY);
  });

  test('静止0.0の後に2.0 → norm=2・peak=2 → score=2^(1/log10(2))=10 → 両フラグON', () => {
    const c = new ActivityClassifier();
    feed(c, 720, 0.0);
    const flags = c.update(2.0);
    expect(flags.isSomeActivity).toBe(true);
    expect(flags.isHighActivity).toBe(true);
  });

  test('起動補正: 360サンプル以内でpeak=5 → peak=100に持ち上げ・score=sqrt(5)≈2.236 → しきい値2.5未満で無活動', () => {
    const c = new ActivityClassifier();
    feed(c, 340, 1.0);
    feed(c, 19, 5.0);
    // 360サンプル目（起動補正期間内）で振幅5.0
    // 振幅履歴: 340×1.0+20×5.0（360個）→ median=1.0・norm=5.0
    // norm履歴: 340×1.0+20×5.0 → peak=5.0 → 補正でpeak=100
    // score = min(100, 5)^(1/log10(100)) = 5^0.5 = 2.2360...
    const flags = c.update(5.0);
    expect(flags.isSomeActivity).toBe(false);
    expect(flags.isHighActivity).toBe(false);
  });

  test('起動補正が過ぎた後（721サンプル目）は peak がそのまま使われる: 急変10で score=10', () => {
    const c = new ActivityClassifier();
    feed(c, 721, 1.0);
    const flags = c.update(10.0);
    // norm=10・peak=10（補正なし）・score=10
    expect(flags.isSomeActivity).toBe(true);
    expect(flags.isHighActivity).toBe(true);
  });

  test('norm<peak の圧縮: 履歴にpeak=8（norm）が59個・現在norm=4 → score=4^(1/log10(8))≈4.642', () => {
    const c = new ActivityClassifier();
    feed(c, 660, 1.0);
    feed(c, 59, 8.0); // norm=8が59個積む
    // 振幅履歴720個: 660×1.0+59×8.0+現在4.0 → median=1.0・norm=4.0
    // norm履歴: 660×1.0+59×8.0+1×4.0 → peak=8.0
    // score = min(8,4)^(1/log10(8)) = 4^1.10731 = 4.6416
    const flags = c.update(4.0);
    expect(flags.isSomeActivity).toBe(true); // 4.642 > 2.5
    expect(flags.isHighActivity).toBe(true); // 4.642 > 3.0
  });

  test('係数f=2: しきい値2.5→5.0・3.0→6.0 に引き上げられ、score≈4.642では両フラグOFF', () => {
    const c = new ActivityClassifier({ factor: 2 });
    feed(c, 660, 1.0);
    feed(c, 59, 8.0);
    const flags = c.update(4.0);
    expect(flags.isSomeActivity).toBe(false); // 4.642 < 5.0
    expect(flags.isHighActivity).toBe(false); // 4.642 < 6.0
  });

  describe('感度レベル別しきい値テーブル（§1.2-7）', () => {
    // score≈4.642 を使ってテーブル値を区別する
    const setup = () => {
      const c = new ActivityClassifier();
      feed(c, 660, 1.0);
      feed(c, 59, 8.0);
      return c.update(4.0); // score≈4.6416
    };

    test('感度1（低感度）: しきい値4.0/6.75 → some=false（4.642>4.0は超えるが高活動6.75は未満…両方検証）', () => {
      const c = new ActivityClassifier({ sensitivity: 1 });
      feed(c, 660, 1.0);
      feed(c, 59, 8.0);
      const flags = c.update(4.0);
      expect(flags.isSomeActivity).toBe(true); // 4.642 > 4.0
      expect(flags.isHighActivity).toBe(false); // 4.642 < 6.75
    });

    test('感度2: しきい値3.0/4.5 → some=true・high=true（4.642>3.0・4.642>4.5）', () => {
      const c = new ActivityClassifier({ sensitivity: 2 });
      feed(c, 660, 1.0);
      feed(c, 59, 8.0);
      const flags = c.update(4.0);
      expect(flags.isSomeActivity).toBe(true);
      expect(flags.isHighActivity).toBe(true); // 4.642 > 4.5
    });

    test('感度4（高感度）: しきい値2.0/2.0 → 両フラグON', () => {
      const c = new ActivityClassifier({ sensitivity: 4 });
      feed(c, 660, 1.0);
      feed(c, 59, 8.0);
      const flags = c.update(4.0);
      expect(flags.isSomeActivity).toBe(true);
      expect(flags.isHighActivity).toBe(true);
    });

    test('実験フラグ固定しきい値: 2.5/3.3 → some=true・high=true（4.642>3.3）', () => {
      const c = new ActivityClassifier({ fixedThresholds: true });
      feed(c, 660, 1.0);
      feed(c, 59, 8.0);
      const flags = c.update(4.0);
      expect(flags.isSomeActivity).toBe(true);
      expect(flags.isHighActivity).toBe(true);
    });

    test('実験フラグ固定しきい値は係数の影響を受けない: f=2でも2.5/3.3のまま', () => {
      const c = new ActivityClassifier({ fixedThresholds: true, factor: 2 });
      feed(c, 660, 1.0);
      feed(c, 59, 8.0);
      const flags = c.update(4.0);
      expect(flags.isSomeActivity).toBe(true); // 4.642 > 2.5（f=2で5.0になったらfalseになる）
      expect(flags.isHighActivity).toBe(true); // 4.642 > 3.3
    });
  });
});
