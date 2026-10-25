import {
  getMillisPerPoint,
  getDeepSleepThreshold,
  getMinDeepSleepLength,
  getHighActivityFrequency,
  classifyActivitySegments,
  postProcessDeepIntervals,
  detectREM,
  clearRemAtAwake,
  computeHypnogram,
} from '../src/hypnogramGeneration';

const MIN = 60_000;

describe('ヒプノグラム生成パラメータ（仕様メモ §2.5）', () => {
  describe('getMillisPerPoint（§2.5・version>=10005は量子化）', () => {
    test('粗い値<=25000ms → 10000ms（10秒粒度）', () => {
      // 3時間43分=13,380,000ms / 1,342サンプル ≈ 9,970ms → 10000
      expect(getMillisPerPoint(10008, 0, 13_380_000, 1342)).toBe(10000);
    });

    test('粗い値<=50000ms → 30000ms', () => {
      // coarse = 100000/2 = 50000
      expect(getMillisPerPoint(10008, 0, 100_000, 2)).toBe(30000);
    });

    test('粗い値<=100000ms → 60000ms', () => {
      // coarse = 200000/2 = 100000
      expect(getMillisPerPoint(10008, 0, 200_000, 2)).toBe(60000);
    });

    test('粗い値>100000ms → 300000ms', () => {
      expect(getMillisPerPoint(10008, 0, 300_000, 2)).toBe(300000);
    });

    test('version<10005は量子化せず (to-from)/size を返す', () => {
      expect(getMillisPerPoint(10004, 1000, 21_000, 10)).toBe(2000);
    });
  });

  describe('getDeepSleepThreshold（§2.5・version分岐）', () => {
    test('version>=10008（現行）は固定3.1', () => {
      expect(getDeepSleepThreshold(10008, [1, 2, 3, 100])).toBe(3.1);
      expect(getDeepSleepThreshold(20000, [])).toBe(3.1);
    });

    test('version 10005-10007は固定3.3', () => {
      expect(getDeepSleepThreshold(10006, [1, 2, 3, 100])).toBe(3.3);
    });

    test('version 10002-10004はhistoryの65パーセンタイル', () => {
      // 65パーセンタイル: 値を昇順ソートし・rank = ceil(0.65 * n) 番目（1-indexed）
      const hist = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const expected = 7; // ceil(0.65*10)=ceil(6.5)=7 → 7番目
      expect(getDeepSleepThreshold(10003, hist)).toBe(expected);
    });

    test('version<=10001は非負値の平均', () => {
      expect(getDeepSleepThreshold(10001, [2, 4, -1])).toBe(3);
    });
  });

  describe('getMinDeepSleepLength（§2.5後処理・version分岐）', () => {
    test('version>=10008（現行）は900000ms（15分）', () => {
      expect(getMinDeepSleepLength(10008, '')).toBe(900_000);
    });

    test('version 10005-10007はスマホ900000ms', () => {
      expect(getMinDeepSleepLength(10007, '')).toBe(900_000);
    });

    test('version 10005-10007のWATCHタグは600000ms（10分）', () => {
      expect(getMinDeepSleepLength(10007, 'WATCH')).toBe(600_000);
      expect(getMinDeepSleepLength(10007, 'SONAR')).toBe(600_000);
    });

    test('version 10003-10004は960000ms', () => {
      expect(getMinDeepSleepLength(10004, '')).toBe(960_000);
    });

    test('default（10000-10002等）はスマホ1190000ms', () => {
      expect(getMinDeepSleepLength(10000, '')).toBe(1_190_000);
    });

    test('defaultのWATCHタグは960000ms', () => {
      expect(getMinDeepSleepLength(10002, 'WATCH')).toBe(960_000);
    });
  });

  describe('getHighActivityFrequency（§2.5入力・フラグ→移動平均→間引き）', () => {
    test('aggregation=1はフラグ値そのまま', () => {
      expect(getHighActivityFrequency([1, 0, 1], 3, 1)).toEqual([1, 0, 1]);
    });

    test('aggregation=2は先頭窓移動平均後に2点ごとに間引き', () => {
      // flags=[1,1,0,0,0,0]（size*aggregation=6）
      // movingAverage(窓2・先頭窓): [1, 0.5, 0, 0, 0, 0]
      // decimate(2): [arr[0], arr[2], arr[4]] = [1, 0, 0]
      expect(getHighActivityFrequency([1, 1, 0, 0, 0, 0], 3, 2)).toEqual([1, 0, 0]);
    });

    test('先頭窓の平均は現在位置から窓個分先まで（前向き）', () => {
      // flags=[1,0,0,0] size=2 aggregation=2
      // 1.0化: [1,0,0,0]
      // movingAverage(窓2): [0.5, 0, 0, 0]
      // decimate(2): [0.5, 0]
      expect(getHighActivityFrequency([1, 0, 0, 0], 2, 2)).toEqual([0.5, 0]);
    });

    test('フラグ長がsize*aggregation未満でも出力はsize個（残り0）', () => {
      // size=3 aggregation=2 → target=6・フラグ4個のみ
      // 1.0化: [1,1,0,0,0,0]（後半0埋め）
      // movingAverage: [1, 0.5, 0, 0, 0, 0]・decimate: [1, 0, 0]
      expect(getHighActivityFrequency([1, 1, 0, 0], 3, 2)).toEqual([1, 0, 0]);
    });
  });

  describe('classifyActivitySegments（§2.5・サンプル分類）', () => {
    // 現行version=10008 → しきい値3.1固定・from=0・mpp=10000 → aggregation=1 → fMin=0.1
    const FROM = 0;
    const TO = 50_000;
    const MPP = 10_000;

    test('history全てしきい値未満 → 全体が1個のDEEP区間', () => {
      const result = classifyActivitySegments([1, 2, 0, 1, 2], [0, 0, 0, 0, 0], 10008, FROM, TO, MPP);
      expect(result).toEqual([{ label: 'DEEP', start: 0, end: TO }]);
    });

    test('history>=しきい値で高活動頻度0 → LIGHT区間', () => {
      // labels=[D,L,L,D,D]・区間はサンプル境界で切れる（サンプルiがLなら[i*10000,(i+1)*10000]）
      const result = classifyActivitySegments([1, 3.2, 3.2, 1, 1], [0, 0, 0, 0, 0], 10008, FROM, TO, MPP);
      expect(result).toEqual([
        { label: 'DEEP', start: 0, end: 10_000 },
        { label: 'LIGHT', start: 10_000, end: 30_000 },
        { label: 'DEEP', start: 30_000, end: TO },
      ]);
    });

    test('history<0 → BROKEN区間', () => {
      const result = classifyActivitySegments([1, -1, -1, 1, 1], [0, 0, 0, 0, 0], 10008, FROM, TO, MPP);
      expect(result).toEqual([
        { label: 'DEEP', start: 0, end: 10_000 },
        { label: 'BROKEN', start: 10_000, end: 30_000 },
        { label: 'DEEP', start: 30_000, end: TO },
      ]);
    });

    test('しきい値以上で高活動頻度が0超fMin未満 → DEEP（高活動頻度修正条件）', () => {
      // mpp=300000（5分粒度）→ aggregation=30 → fMin=min(3/30, 0.1)=0.1
      // freq=0.05 は 0<0.05<0.1 → DEEP
      const result = classifyActivitySegments(
        [3.2, 3.2, 3.2],
        [0.05, 0.05, 0.05],
        10008,
        FROM,
        900_000,
        300_000,
      );
      expect(result).toEqual([{ label: 'DEEP', start: 0, end: 900_000 }]);
    });

    test('しきい値以上で高活動頻度がfMin以上 → LIGHT（同historyでfreq差のみで分岐）', () => {
      const result = classifyActivitySegments(
        [3.2, 3.2, 3.2],
        [0.5, 0.5, 0.5],
        10008,
        FROM,
        900_000,
        300_000,
      );
      expect(result).toEqual([{ label: 'LIGHT', start: 0, end: 900_000 }]);
    });

    test('末尾の区間endがtoTime未満ならtoTimeにクリップ', () => {
      // toTime=55,000（5サンプル×10,000=50,000より大きい）
      const result = classifyActivitySegments([1, 1, 1, 1, 1], [0, 0, 0, 0, 0], 10008, FROM, 55_000, MPP);
      expect(result).toEqual([{ label: 'DEEP', start: 0, end: 55_000 }]);
    });
  });

  describe('postProcessDeepIntervals（§2.5後処理）', () => {
    // version=10008 → minDeep=900000ms（15分）

    test('minDeepSleepLength未満のDEEPはLIGHTに格下げ', () => {
      const result = postProcessDeepIntervals(
        [{ label: 'DEEP', start: 0, end: 600_000 }], // 10分
        10008,
        '',
      );
      expect(result).toEqual([{ label: 'LIGHT', start: 0, end: 600_000 }]);
    });

    test('minDeepSleepLength以上のDEEPは保持', () => {
      const result = postProcessDeepIntervals(
        [{ label: 'DEEP', start: 0, end: 900_000 }], // ちょうど15分
        10008,
        '',
      );
      expect(result).toEqual([{ label: 'DEEP', start: 0, end: 900_000 }]);
    });

    test('格下げで隣接したLIGHT区間は1区間にマージ', () => {
      // DEEP 15分・LIGHT 5分・DEEP 5分（格下げ対象）・LIGHT 8分
      // → 格下げ後: DEEP・LIGHT・LIGHT・LIGHT → マージ: DEEP・LIGHT
      const result = postProcessDeepIntervals(
        [
          { label: 'DEEP', start: 0, end: 900_000 },
          { label: 'LIGHT', start: 900_000, end: 1_200_000 },
          { label: 'DEEP', start: 1_200_000, end: 1_500_000 },
          { label: 'LIGHT', start: 1_500_000, end: 2_300_000 },
        ],
        10008,
        '',
      );
      expect(result).toEqual([
        { label: 'DEEP', start: 0, end: 900_000 },
        { label: 'LIGHT', start: 900_000, end: 2_300_000 },
      ]);
    });

    test('格下げLIGHTが末尾でもマージされる', () => {
      const result = postProcessDeepIntervals(
        [
          { label: 'DEEP', start: 0, end: 900_000 },
          { label: 'LIGHT', start: 900_000, end: 1_000_000 },
          { label: 'DEEP', start: 1_000_000, end: 1_100_000 }, // 格下げ
        ],
        10008,
        '',
      );
      expect(result).toEqual([
        { label: 'DEEP', start: 0, end: 900_000 },
        { label: 'LIGHT', start: 900_000, end: 1_100_000 },
      ]);
    });

    test('BROKEN区間は格下げ・マージとも対象外', () => {
      const result = postProcessDeepIntervals(
        [
          { label: 'BROKEN', start: 0, end: 600_000 },
          { label: 'DEEP', start: 600_000, end: 900_000 },
        ],
        10008,
        '',
      );
      expect(result).toEqual([
        { label: 'BROKEN', start: 0, end: 600_000 },
        { label: 'LIGHT', start: 600_000, end: 900_000 },
      ]);
    });
  });

  describe('detectREM（§2.5・REM区間生成）', () => {
    // 条件: 前区間DEEP>=10分・現区間LIGHT>=15分 → REM=[LIGHT+10分, +min(残り, min(50分, 5分丸め半分))]
    // 睡眠開始=list[0].start・開始+50分以前のREMは除外（一部は+50分に押し込み）

    test('DEEP 80分直後のLIGHT 60分 → REM開始=LIGHT+10分・長さ25分', () => {
      // remaining=50分 → n=10 → floor(11/2)=5 → 25分・forbidden(50分)<=remStart(90分)で素の区間
      const result = detectREM([
        { label: 'DEEP', start: 0, end: 80 * MIN },
        { label: 'LIGHT', start: 80 * MIN, end: 140 * MIN },
      ]);
      expect(result).toEqual([{ label: 'REM', start: 90 * MIN, end: 115 * MIN }]);
    });

    test('前区間DEEPが10分未満 → REM無し', () => {
      const result = detectREM([
        { label: 'DEEP', start: 0, end: 9 * MIN },
        { label: 'LIGHT', start: 9 * MIN, end: 69 * MIN },
      ]);
      expect(result).toEqual([]);
    });

    test('現区間LIGHTが15分未満 → REM無し', () => {
      const result = detectREM([
        { label: 'DEEP', start: 0, end: 20 * MIN },
        { label: 'LIGHT', start: 20 * MIN, end: 34 * MIN },
      ]);
      expect(result).toEqual([]);
    });

    test('LIGHT 15分ちょうど → REM長は下限の5分', () => {
      // remStart=70分（forbidden 50分を越える位置）・remaining=5分 → REM 5分
      const result = detectREM([
        { label: 'DEEP', start: 0, end: 60 * MIN },
        { label: 'LIGHT', start: 60 * MIN, end: 75 * MIN },
      ]);
      expect(result).toEqual([{ label: 'REM', start: 70 * MIN, end: 75 * MIN }]);
    });

    test('LIGHT 110分 → REM長は上限の50分', () => {
      // remaining=100分 → n=20 → floor(21/2)=10 → 50分 → min(100, min(50,50))=50
      const result = detectREM([
        { label: 'DEEP', start: 0, end: 60 * MIN },
        { label: 'LIGHT', start: 60 * MIN, end: 170 * MIN },
      ]);
      expect(result).toEqual([{ label: 'REM', start: 70 * MIN, end: 120 * MIN }]);
    });

    test('睡眠開始+50分より前のREM開始で・押し込みでも5分未満 → 除外', () => {
      // DEEP 38分・LIGHT 15分（38-53分）: remStart=48分・remaining=5分・remEnd=53分
      // forbidden=50分。50<=48 は false・53-50=3分<5分 → 除外
      const result = detectREM([
        { label: 'DEEP', start: 0, end: 38 * MIN },
        { label: 'LIGHT', start: 38 * MIN, end: 53 * MIN },
      ]);
      expect(result).toEqual([]);
    });

    test('睡眠開始+50分より前のREM開始で押し込み可能 → 開始を+50分に圧縮', () => {
      // DEEP 30分・LIGHT 60分（30-90分）: remStart=40分・remaining=50分・remLength=25分・remEnd=65分
      // forbidden=50分。50<=40 false・65-50=15分>=5分 → [50分, 65分]
      const result = detectREM([
        { label: 'DEEP', start: 0, end: 30 * MIN },
        { label: 'LIGHT', start: 30 * MIN, end: 90 * MIN },
      ]);
      expect(result).toEqual([{ label: 'REM', start: 50 * MIN, end: 65 * MIN }]);
    });

    test('複数サイクルで複数REM区間を生成', () => {
      const result = detectREM([
        { label: 'DEEP', start: 0, end: 80 * MIN },
        { label: 'LIGHT', start: 80 * MIN, end: 140 * MIN },
        { label: 'DEEP', start: 140 * MIN, end: 260 * MIN },
        { label: 'LIGHT', start: 260 * MIN, end: 320 * MIN },
      ]);
      expect(result).toEqual([
        { label: 'REM', start: 90 * MIN, end: 115 * MIN },
        { label: 'REM', start: 270 * MIN, end: 295 * MIN },
      ]);
    });

    test('前区間がLIGHT（DEEP直後でない）→ REM無し', () => {
      const result = detectREM([
        { label: 'LIGHT', start: 0, end: 20 * MIN },
        { label: 'LIGHT', start: 20 * MIN, end: 80 * MIN },
      ]);
      expect(result).toEqual([]);
    });
  });

  describe('computeHypnogram（§2.5統合）', () => {
    test('記録全体が20分以下 → 空配列', () => {
      // 120サンプル×10000ms=1,200,000ms=ちょうど20分（<= で空）
      const history = new Array(120).fill(1);
      const flags = new Array(120).fill(0);
      expect(computeHypnogram({ history, flags, fromMillis: 0, toMillis: 1_200_000 })).toEqual([]);
    });

    test('分類→格下げ→マージ→REM生成の全フロー（10秒粒度・80分記録）', () => {
      // 480サンプル×10秒=80分
      // サンプル0-89（0-15分）: DEEP・90-239（15-40分）: LIGHT・240-329（40-55分）: DEEP・330-479（55-80分）: LIGHT
      const history: number[] = [
        ...new Array(90).fill(1),
        ...new Array(150).fill(3.2),
        ...new Array(90).fill(1),
        ...new Array(150).fill(3.2),
      ];
      const flags = new Array(480).fill(0);
      const result = computeHypnogram({ history, flags, fromMillis: 0, toMillis: 4_800_000 });
      // 分類: DEEP[0,900000] LIGHT[900000,2400000] DEEP[2400000,3300000] LIGHT[3300000,4800000]
      // 格下げ・マージなし（15分ちょうどは保持）→ REM判定: ペア1はforbidden(50分)内で除外・ペア2は生成
      expect(result).toEqual([
        { label: 'DEEP', start: 0, end: 900_000 },
        { label: 'LIGHT', start: 900_000, end: 2_400_000 },
        { label: 'DEEP', start: 2_400_000, end: 3_300_000 },
        { label: 'LIGHT', start: 3_300_000, end: 4_800_000 },
        { label: 'REM', start: 3_900_000, end: 4_500_000 },
      ]);
    });

    test('格下げで隣接LIGHTがマージされ・元DEEP直後LIGHTがREM対象になる', () => {
      // サンプル0-89（0-15分）: DEEP（15分保持）
      // サンプル90-149（15-25分）: LIGHT（3.2・10分）
      // サンプル150-159（25-26.7分）: DEEP（1.7分 → 格下げ）
      // サンプル160-239（26.7-40分）: LIGHT（3.2・13.3分）
      // → マージ後: DEEP[0,900000] LIGHT[900000,2400000]（25分）
      // REM: prev DEEP 15分>=10分・cur LIGHT 25分>=15分 → remStart=1500000
      // remaining=900000 → n=3 → 600000（10分）→ remEnd=2100000・forbidden=3000000<=1500000 でない・2100000-3000000<0 → 除外
      const history: number[] = [
        ...new Array(90).fill(1),
        ...new Array(60).fill(3.2),
        ...new Array(10).fill(1),
        ...new Array(80).fill(3.2),
      ];
      const flags = new Array(240).fill(0);
      const result = computeHypnogram({ history, flags, fromMillis: 0, toMillis: 2_400_000 });
      expect(result).toEqual([
        { label: 'DEEP', start: 0, end: 900_000 },
        { label: 'LIGHT', start: 900_000, end: 2_400_000 },
      ]);
    });
  });

  describe('clearRemAtAwake（§2.5・覚醒時REM除去・New版）', () => {
    const rem = (startMin: number, endMin: number) => ({ label: 'REM' as const, start: startMin * MIN, end: endMin * MIN });
    const aw = (startMin: number, endMin: number) => ({ start: startMin * MIN, end: endMin * MIN });

    test('覚醒区間なし → REM全額残る', () => {
      expect(clearRemAtAwake([rem(30, 90)], [])).toEqual([rem(30, 90)]);
    });

    test('覚醒がREM完全包含 → REM消える', () => {
      expect(clearRemAtAwake([rem(30, 90)], [aw(25, 95)])).toEqual([]);
    });

    test('覚醒がREM後半を削る（aw.end>=rem.end）→ 前半部分が残る', () => {
      // rem 30-90・awake 70-100: aw.start(70)>rem.start・aw.end(100)>=90 → [30,70]確定
      expect(clearRemAtAwake([rem(30, 90)], [aw(70, 100)])).toEqual([rem(30, 70)]);
    });

    test('中途カット+長覚醒（>=6分）→ 残り破棄で前半のみ', () => {
      // rem 30-90・awake 50-60（10分>=6分）: [30,50]カットで残余破棄
      expect(clearRemAtAwake([rem(30, 90)], [aw(50, 60)])).toEqual([rem(30, 50)]);
    });

    test('中途カット+短覚醒（<6分）→ 残余が残る（2区間）', () => {
      // rem 30-90・awake 50-54（4分<6分）: [30,50]カット・cur=[54,90]・走査尽き→[54,90]採用
      expect(clearRemAtAwake([rem(30, 90)], [aw(50, 54)])).toEqual([rem(30, 50), rem(54, 90)]);
    });

    test('先頭からの長覚醒（>=6分）→ REM消える', () => {
      // rem 30-90・awake 25-35（10分>=6分・aw.start(25)<=rem.start(30)）→ 破棄
      expect(clearRemAtAwake([rem(30, 90)], [aw(25, 35)])).toEqual([]);
    });

    test('REM開始前に終わる覚醒（交差なし）は削断しない', () => {
      // rem 30-90・awake 25-28: aw.end(28)<rem.start(30)で交差なし→原典ではintersection=nullで全額残る
      expect(clearRemAtAwake([rem(30, 90)], [aw(25, 28)])).toEqual([rem(30, 90)]);
    });

    test('先頭に重なる短覚醒（<6分）→ 残余が残る', () => {
      // rem 30-90・awake 27-30は交差なし（aw.end=30==rem.startで非交差）なので・重なるのはaw.start<30<aw.end
      // rem 30-90・awake 29-32（3分<6分）: cur=[32,90]・走査尽き→[32,90]採用
      expect(clearRemAtAwake([rem(30, 90)], [aw(29, 32)])).toEqual([rem(32, 90)]);
    });

    test('削断後の断片が5分未満 → 除外', () => {
      // rem 30-40（10分）・awake 33-36（3分<6分・中途カット）: [30,33]=3分と[36,40]=4分はともに5分未満→空
      expect(clearRemAtAwake([rem(30, 40)], [aw(33, 36)])).toEqual([]);
    });

    test('REM後の覚醒（交差なし）→ REM全額残る', () => {
      expect(clearRemAtAwake([rem(30, 60)], [aw(70, 80)])).toEqual([rem(30, 60)]);
    });

    test('境界: 覚醒ちょうど6分（360000ms）は長覚醒扱い', () => {
      // rem 30-90・awake 25-31（ちょうど6分・先頭から）→ 破棄
      expect(clearRemAtAwake([rem(30, 90)], [aw(25, 31)])).toEqual([]);
    });

    test('複数REM区間を個別に処理', () => {
      const result = clearRemAtAwake([rem(30, 90), rem(200, 260)], [aw(70, 100)]);
      // rem1: 後半削り→[30,70]・rem2: 交差なし→全額
      expect(result).toEqual([rem(30, 70), rem(200, 260)]);
    });
  });
});
