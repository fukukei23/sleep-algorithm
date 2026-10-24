import { SmartWakeScheduler } from '../src/smartWake';

/** 2026-10-24 22:00 JST 相当の固定タイムスタンプ（TZ非依存の算術で扱う） */
const T0 = 1791900000000; // 任意の基準（テスト内で一貫使用）
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function at(minutesFromT0: number): number {
  return T0 + minutesFromT0 * MIN;
}

describe('SmartWakeScheduler（仕様メモ §5 smart wake）', () => {
  describe('resolveSmartPeriod（§5.1・個別設定>=0が優先）', () => {
    test('個別設定15 → 15', () => {
      expect(SmartWakeScheduler.resolveSmartPeriod({ smartWindowOverride: 15 }, 30)).toBe(15);
    });
    test('個別設定なし → グローバル30', () => {
      expect(SmartWakeScheduler.resolveSmartPeriod({}, 30)).toBe(30);
    });
    test('個別設定-1（無効値）→ グローバル30', () => {
      expect(SmartWakeScheduler.resolveSmartPeriod({ smartWindowOverride: -1 }, 30)).toBe(30);
    });
    test('グローバル省略 → デフォルト30', () => {
      expect(SmartWakeScheduler.resolveSmartPeriod({})).toBe(30);
    });
  });

  describe('isInSmartPeriod（§5.1）', () => {
    test('アラーム60分前・窓30 → false（まだ窓に入っていない）', () => {
      const s = new SmartWakeScheduler();
      expect(s.isInSmartPeriod(at(0), at(60), 30, { snoozing: false, targetAchieved: true })).toBe(false);
    });

    test('アラーム29分前・窓30 → true（now+30 > alarm）', () => {
      const s = new SmartWakeScheduler();
      expect(s.isInSmartPeriod(at(31), at(60), 30, { snoozing: false, targetAchieved: true })).toBe(true);
    });

    test('境界: アラーム30分前ちょうど（now+30 == alarm）→ false（strict超過）', () => {
      const s = new SmartWakeScheduler();
      expect(s.isInSmartPeriod(at(30), at(60), 30, { snoozing: false, targetAchieved: true })).toBe(false);
    });

    test('スヌーズ中 → false', () => {
      const s = new SmartWakeScheduler();
      expect(s.isInSmartPeriod(at(45), at(60), 30, { snoozing: true, targetAchieved: true })).toBe(false);
    });

    test('窓0 → false', () => {
      const s = new SmartWakeScheduler();
      expect(s.isInSmartPeriod(at(50), at(60), 0, { snoozing: false, targetAchieved: true })).toBe(false);
    });

    test('目標睡眠未達成 → false（§5.2）', () => {
      const s = new SmartWakeScheduler();
      expect(
        s.isInSmartPeriod(at(45), at(60), 30, { snoozing: false, targetAchieved: false })
      ).toBe(false);
    });
  });

  describe('targetSleepAchieved（§5.2）', () => {
    test('actOnTargetSleep=true・ideal=480・sleep=470 → false', () => {
      const s = new SmartWakeScheduler({ actOnTargetSleep: true, idealSleepMinutes: 480 });
      expect(s.targetSleepAchieved(470)).toBe(false);
    });
    test('actOnTargetSleep=true・ideal=480・sleep=480 → true（>=）', () => {
      const s = new SmartWakeScheduler({ actOnTargetSleep: true, idealSleepMinutes: 480 });
      expect(s.targetSleepAchieved(480)).toBe(true);
    });
    test('actOnTargetSleep=false → 常にtrue', () => {
      const s = new SmartWakeScheduler({ actOnTargetSleep: false, idealSleepMinutes: 480 });
      expect(s.targetSleepAchieved(0)).toBe(true);
    });
    test('ideal未設定 → 常にtrue', () => {
      const s = new SmartWakeScheduler({ actOnTargetSleep: true });
      expect(s.targetSleepAchieved(100)).toBe(true);
    });
  });

  describe('shouldFireSmartWake（§5.3 発火条件）', () => {
    const base = {
      nowMs: at(45), // アラーム(at 60)の15分前=smart期間内
      alarmMs: at(60),
      phase: 'LIGHT_SLEEP' as const,
      sleepLengthMinutes: 500,
    };

    test('smart期間+LIGHT+目標達成+未鳴動 → fire=true・元アラーム停止', () => {
      const s = new SmartWakeScheduler();
      const r = s.shouldFireSmartWake({
        ...base,
        alarmAlreadyRinging: false,
        lastRingingTs: null,
        trialValid: true,
      });
      expect(r.fire).toBe(true);
      expect(r.suspendOriginalAlarm).toBe(true);
    });

    test('アラーム時刻ちょうど（時・分一致）→ fire=false（通常アラームに任せる）', () => {
      const s = new SmartWakeScheduler();
      const r = s.shouldFireSmartWake({
        ...base,
        nowMs: at(60), // アラーム時刻そのもの
        alarmAlreadyRinging: false,
        lastRingingTs: null,
        trialValid: true,
      });
      expect(r.fire).toBe(false);
      expect(r.suspendOriginalAlarm).toBe(false);
    });

    test('深眠（DEEP_SLEEP）では発火しない', () => {
      const s = new SmartWakeScheduler();
      const r = s.shouldFireSmartWake({
        ...base,
        phase: 'DEEP_SLEEP',
        alarmAlreadyRinging: false,
        lastRingingTs: null,
        trialValid: true,
      });
      expect(r.fire).toBe(false);
    });

    test('鳴動済み（1時間以内）→ 発火しない', () => {
      const s = new SmartWakeScheduler();
      const r = s.shouldFireSmartWake({
        ...base,
        alarmAlreadyRinging: true,
        lastRingingTs: base.nowMs - 10 * MIN,
        trialValid: true,
      });
      expect(r.fire).toBe(false);
    });

    test('鳴動済みでも1時間超過なら判定を続行（§5.3）', () => {
      const s = new SmartWakeScheduler();
      const r = s.shouldFireSmartWake({
        ...base,
        nowMs: at(45),
        alarmMs: at(90), // まだsmart期間外に見えるが鳴動超過優先で判定継続
        alarmAlreadyRinging: false,
        lastRingingTs: at(45) - 2 * HOUR, // 2時間前に鳴動
        trialValid: true,
      });
      // smart期間外（now 45 vs alarm 90・窓30 → 45+30=75 < 90）→ 発火しない
      expect(r.fire).toBe(false);
    });

    test('UNKNOWN（不明）では発火しない（浅眠のみ・§5.3）', () => {
      const s = new SmartWakeScheduler();
      const r = s.shouldFireSmartWake({
        ...base,
        phase: 'UNKNOWN',
        alarmAlreadyRinging: false,
        lastRingingTs: null,
        trialValid: true,
      });
      expect(r.fire).toBe(false);
    });

    test('トライアル無効 → 発火しない（§5.3）', () => {
      const s = new SmartWakeScheduler();
      const r = s.shouldFireSmartWake({
        ...base,
        alarmAlreadyRinging: false,
        lastRingingTs: null,
        trialValid: false,
      });
      expect(r.fire).toBe(false);
    });

    test('目標睡眠未達成（actOnTargetSleep有効）→ 発火しない（§5.2）', () => {
      const s = new SmartWakeScheduler({ actOnTargetSleep: true, idealSleepMinutes: 480 });
      const r = s.shouldFireSmartWake({
        ...base,
        sleepLengthMinutes: 400,
        alarmAlreadyRinging: false,
        lastRingingTs: null,
        trialValid: true,
      });
      expect(r.fire).toBe(false);
    });
  });
});

describe('自己点検で追加した欠落テスト（coverage BrPart削減）', () => {
  test('lastRingingTsが1時間以内なら鳴動扱いで発火しない（alarmAlreadyRinging=false経路）', () => {
    const s = new SmartWakeScheduler();
    const r = s.shouldFireSmartWake({
      nowMs: at(45),
      alarmMs: at(60),
      phase: 'LIGHT_SLEEP',
      sleepLengthMinutes: 500,
      alarmAlreadyRinging: false,
      lastRingingTs: at(45) - 10 * MIN, // 10分前に鳴動（1時間以内）
      trialValid: true,
    });
    expect(r.fire).toBe(false);
  });
});

describe('MLR r1修正の回帰テスト（個別窓設定が本番経路に効くこと）', () => {
  const base = {
    nowMs: at(45),
    alarmMs: at(60),
    phase: 'LIGHT_SLEEP' as const,
    sleepLengthMinutes: 500,
    alarmAlreadyRinging: false,
    lastRingingTs: null,
    trialValid: true,
  };

  test('個別窓0（無効設定）のアラームは smart期間に入らない → 発火しない', () => {
    const s = new SmartWakeScheduler();
    const r = s.shouldFireSmartWake({ ...base, smartWindowOverride: 0 });
    expect(r.fire).toBe(false); // 修正前は30分固定で発火していた（結合欠陥）
  });

  test('個別窓5分のアラームはアラーム5分前からのみsmart期間に入る（40分前では未発火）', () => {
    const s = new SmartWakeScheduler();
    // now=at(45)はアラーム(at 60)の15分前 → 窓5ではまだsmart期間外
    const r1 = s.shouldFireSmartWake({ ...base, smartWindowOverride: 5 });
    expect(r1.fire).toBe(false);
    // now=at(56)はアラームの4分前 → 窓5内 → 発火
    const r2 = s.shouldFireSmartWake({ ...base, nowMs: at(56), smartWindowOverride: 5 });
    expect(r2.fire).toBe(true);
  });

  test('個別窓-1（無効値）はグローバル30分にフォールバックする', () => {
    const s = new SmartWakeScheduler();
    // now=at(45)（15分前）は窓30ではsmart期間内・窓5では圏外 → -1は30分扱い
    const r = s.shouldFireSmartWake({ ...base, smartWindowOverride: -1 });
    expect(r.fire).toBe(true);
  });
});

describe('MLR r2修正の回帰テスト', () => {
  test('アラーム時刻経過後はsmart期間外（半開区間 [alarm-窓, alarm)）', () => {
    const s = new SmartWakeScheduler();
    // now = アラーム+1分・時分は一致しない・LIGHT・達成済み → 修正前は発火していた
    const r = s.shouldFireSmartWake({
      nowMs: at(61),
      alarmMs: at(60),
      phase: 'LIGHT_SLEEP',
      sleepLengthMinutes: 500,
      alarmAlreadyRinging: false,
      lastRingingTs: null,
      trialValid: true,
    });
    expect(r.fire).toBe(false);
  });
});

describe('MLR r3修正の回帰テスト', () => {
  test('グローバル窓設定（≠30）が本番経路に伝播する', () => {
    const s = new SmartWakeScheduler({ globalWindowMinutes: 60 });
    const base = {
      alarmMs: at(60),
      phase: 'LIGHT_SLEEP' as const,
      sleepLengthMinutes: 500,
      alarmAlreadyRinging: false,
      lastRingingTs: null,
      trialValid: true,
    };
    // now=アラーム45分前・個別設定なし → グローバル60分窓ならsmart期間内（30分窓なら圏外）
    const r = s.shouldFireSmartWake({ ...base, nowMs: at(15) });
    expect(r.fire).toBe(true); // 60分窓: 15+60=75 > 60 → smart期間内
    // 個別設定5分がグローバル60分より優先される
    const r2 = s.shouldFireSmartWake({ ...base, nowMs: at(15), smartWindowOverride: 5 });
    expect(r2.fire).toBe(false); // 15+5=20 < 60 → smart期間外
  });

  test('前回鳴動からちょうど1時間は再判定可（<1hで抑止の原典整合）', () => {
    const s = new SmartWakeScheduler();
    const r = s.shouldFireSmartWake({
      nowMs: at(45),
      alarmMs: at(60),
      phase: 'LIGHT_SLEEP',
      sleepLengthMinutes: 500,
      alarmAlreadyRinging: false,
      lastRingingTs: at(45) - 60 * MIN, // ちょうど1時間前
      trialValid: true,
    });
    expect(r.fire).toBe(true); // 1時間ちょうどは「超過」扱い（<1hのみ抑止）
  });
});
