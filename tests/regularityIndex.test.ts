import { computeRegularityIndex } from '../src/regularityIndex';

const DAY = 1440;
const allTrue = (n: number): boolean[] => new Array<boolean>(n).fill(true);
const allFalse = (n: number): boolean[] => new Array<boolean>(n).fill(false);

describe('computeRegularityIndex（仕様メモ §6 SRI）', () => {
  test('両日完全一致（全睡眠）→ SRI=1', () => {
    expect(computeRegularityIndex(allTrue(DAY), allTrue(DAY))).toBe(1);
  });

  test('両日完全一致（同じパターン）→ SRI=1', () => {
    const pattern = (i: number): boolean => i % 3 === 0;
    const a = Array.from({ length: DAY }, (_, i) => pattern(i));
    const b = Array.from({ length: DAY }, (_, i) => pattern(i));
    expect(computeRegularityIndex(a, b)).toBe(1);
  });

  test('全ビット不一致（A前半睡眠・B後半睡眠）→ SRI=0', () => {
    const a = [...allTrue(DAY / 2), ...allFalse(DAY / 2)];
    const b = [...allFalse(DAY / 2), ...allTrue(DAY / 2)];
    expect(computeRegularityIndex(a, b)).toBe(0);
  });

  test('半分一致（XOR=720ビット）→ SRI=0.5', () => {
    const a = allTrue(DAY);
    const b = allTrue(DAY);
    for (let i = 0; i < DAY / 2; i++) b[i] = false; // 前半720ビット不一致
    expect(computeRegularityIndex(a, b)).toBe(0.5);
  });

  test('どちらかが全false（データなし）→ -1（無効値・§6）', () => {
    expect(computeRegularityIndex(allTrue(DAY), allFalse(DAY))).toBe(-1);
    expect(computeRegularityIndex(allFalse(DAY), allTrue(DAY))).toBe(-1);
  });

  test('長さが1440でない配列はエラー（日単位契約）', () => {
    expect(() => computeRegularityIndex(allTrue(100), allTrue(100))).toThrow();
  });
});
