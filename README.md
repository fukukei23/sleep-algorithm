# sleep-algorithm

睡眠トラッカーのアルゴリズムコア（クリーンルーム実装）。仕様メモのみを入力にゼロから実装した pure-logic ライブラリ。センサー接続・UI は含まない（将来の adapter で接続）。

## モジュール構成（仕様メモ §7 対応）

| モジュール | 対応仕様 | 内容 |
|---|---|---|
| `activityClassifier.ts` | §1 | 加速度振幅→中央値正規化→圧縮スコア→微活動/高活動フラグ |
| `sleepPhaseDetector.ts` | §2 | 短窓6/長窓30のフラグ集計→深眠/浅眠/不明（OR条件）+ Rem区間記録 |
| `awakeDetectors.ts` | §3 | 覚醒検知4種（高活動量/高活動頻度/スマホ使用/照度）+ OR合成 Ensemble |
| `sleepScore.ts` | §4 | 10測定項目のしきい値合否比率スコア（年齢別 DURATION 上書き含む） |
| `smartWake.ts` | §5 | スマート期間判定+浅眠発火条件（smart wake） |
| `regularityIndex.ts` | §6 | SRI（当日/翌日の1分ビット XOR 一致率） |

## 使い方

```bash
npm install
npm test       # 91 tests
npm run typecheck
```

```typescript
import { ActivityClassifier, SleepPhaseDetector, SleepScoreCalculator } from './src';

// §1: 振幅（|a - baseline|）を1サンプルずつ入力
const classifier = new ActivityClassifier();
const flags = classifier.update(amplitude);

// §2: フラグを1サンプル（1分想定）ずつ入力
const detector = new SleepPhaseDetector();
const phase = detector.update(flags); // 'DEEP_SLEEP' | 'LIGHT_SLEEP' | 'UNKNOWN'

// §4: 測定値を入力してスコア集計
const score = new SleepScoreCalculator({ idealSleepMinutes: 480 });
score.setAge(30);
score.updateMeasure('DURATION', 500);
score.updateMeasure('DEEP_SLEEP', 0.22);
const percent = score.getScorePercentage();
```

## 実装裁量箇所（仕様メモ §4.4 に基づく）

以下は仕様メモで「実装側で自由に決めてよい」と明記された箇所の実装決定:

- **PhoneUsageDetector の閾値**: 画面ON最小2分・スクリーンセーバー時15分・最大60分
- **LightsOnDetector の lux テーブル**: 感度1-4 → [200, 50, 10, 5]（低感度→高しきい値）
- **高活動頻度検知の正規化**: 平均+3σ（sigmaMultiplier で変更可）
- **AverageActivityOverThreshold の移動平均**: 累積平均（原典の窓サイズは仕様メモ未記載）
- **スコアの max 型の色**: 合格=POSITIVE・不合格=NEGATIVE（NEUTRAL は未使用）
- **progress の丸め**: 全型で round 後 0-100 クリップ（整数）
- **DURATION 進捗の特例**: idealSleepMinutes 設定時のみ v/ideal×100（未設定時はしきい値比）

## 入力契約

- `ActivityClassifier.update()`: ベースライン除去済みの振幅（|a - baseline|）。**単位はストリーム内で一意であること**（G または milli-G・途中変更は未定義挙動。150超を1回でも観測すると milli-G モードへ恒久的に移行する）
- `SleepPhaseDetector.update()`: 活動フラグ（1サンプル=1分想定）・null=欠損。**shortWindow のデフォルトは6（スマホ）**・スマートウォッチでは明示的に `shortWindow: 12` を指定すること（§2.3表）
- `SleepScoreCalculator`: `idealSleepMinutes` は `undefined` との区別で判定（0指定時も特例progressが適用される）
- `computeRegularityIndex()`: **1日ちょうど1440要素**の boolean 配列 ×2（length≠1440 は throw・「データなし」は全false配列を渡すと -1 を返す）
- センサー由来の生値（加速度・照度・BLE心拍）は adapter 層で変換してから渡す
- `SmartWakeScheduler`: アラーム時刻は**端末ローカル時刻**前提（sameHourMinute の時分一致はローカルTZで評価）・smart wake の適用区間は `[alarm−窓, alarm)` の半開区間

## クリーンルール宣言

本リポジトリは解析対象 APK・デコンパイルコード・出典クラス名を一切参照せず、
仕様メモ（`30_RESEARCH/アプリ解析/2026-10-24_Sleep-as-Android仕様メモ_睡眠スコアと起床判定.md`）
のみを入力に実装されている。テストは仕様メモの数値（しきい値・窓長・判定式）を
黄金値として固定し、仕様通りの挙動を機械的に検証する。
