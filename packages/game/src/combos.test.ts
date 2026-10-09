import { describe, expect, it } from "vitest";
import { parseCards } from "./cards.js";
import { allLeadMoves, beatingMoves, beats, classify, type ComboType } from "./combos.js";

const read = (text: string) => classify(parseCards(text));

describe("T5 牌型识别", () => {
  const cases: [string, ComboType | null, number?][] = [
    ["3 4 5 6 7", "straight", 7],
    ["10 J Q K A", "straight", 14],
    ["J Q K A 2", null],
    ["3 4 5 6", null],
    ["3 3 4 4 5 5", "pairs", 5],
    ["3 3 4 4", null],
    ["3 3 3 4 4 4 5 5", "plane1", 4],
    ["3 3 3 4 4 4 3 5", null],
    ["3 3 3 4 4 4 5 5 5 6 6 6", "plane", 6],
    ["4 4 4 5 5 5 6 6 6 9 9 9", "plane1", 6],
    ["7 7 7 8 8 8 小 大", null],
    ["7 7 7 8 8 8 小 3", "plane1", 8],
    ["5 5 5 5 3 9", "four2", 5],
    ["5 5 5 5 3 3", "four2", 5],
    ["9 9 9 9 6 6 8 8", "four22", 9],
    ["9 9 9 9 6 6 6 6", null],
    ["6 6 6 6", "bomb", 6],
    ["小 大", "rocket", 17],
    ["2 2", "pair", 15],
    ["小 2", null],
    ["Q Q Q 6 6", "trio2", 12],
    ["Q Q Q 大", "trio1", 12],
  ];
  for (const [text, type, main] of cases) {
    it(`${text} → ${type ?? "不合法"}`, () => {
      const readings = read(text);
      if (type === null) {
        expect(readings).toEqual([]);
        return;
      }
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({ type, main });
    });
  }

  it("其他牌型和边界", () => {
    expect(read("8")[0]).toMatchObject({ type: "single", main: 8 });
    expect(read("大")[0]).toMatchObject({ type: "single", main: 17 });
    expect(read("7 7 7")[0]).toMatchObject({ type: "trio", main: 7 });
    expect(read("9 9 9 3")[0]).toMatchObject({ type: "trio1", main: 9 });
    expect(read("3 3 3 大")[0]).toMatchObject({ type: "trio1", main: 3 });
    expect(read("5 5 5 2 2")[0]).toMatchObject({ type: "trio2", main: 5 });
    expect(read("6 6 6 7 7 7")[0]).toMatchObject({ type: "plane", main: 7, chain: 2 });
    expect(read("3 3 3 4 4 4 5 5 9 9")[0]).toMatchObject({ type: "plane2", main: 4, chain: 2 });
    expect(read("3 3 3 4 4 4 2 2 9 9")[0]).toMatchObject({ type: "plane2", main: 4 });
    expect(read("3 3 3 4 4 4 9 9 9 9")).toEqual([]); // 两个对子同点数
    expect(read("3 4 5 6 7 8 9 10 J Q K A")[0]).toMatchObject({ type: "straight", main: 14, chain: 12 });
    expect(read("3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q")[0]).toMatchObject({ type: "pairs", chain: 10 });
    expect(read("K K K A A A 2 2 2")).toEqual([]); // 2 不能进飞机
    expect(read("3 3 3 4 4 4 5 6 7 7")).toEqual([]);
    expect(read("5 5 5 5 小 大")).toEqual([]); // 四带二不能带王炸
    expect(read("5 5 5 5 小 3")[0]).toMatchObject({ type: "four2", main: 5 });
    expect(read("3 3 3 3 4 4 4 4")).toEqual([]);
    expect(read("小 大 3 3")).toEqual([]);
    expect(read("3 3 3 小 大")).toEqual([]);
    // 带的单牌凑成相邻三张，但没有更长的认法时，两种连续段都可以认（默认按点数大的）。
    const readings = read("3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 9");
    expect(readings.map((reading) => reading.main)).toEqual([7, 6]);
    expect(readings.every((reading) => reading.type === "plane1")).toBe(true);
  });
});

describe("T6 比较", () => {
  const cases: [string, string, boolean][] = [
    ["8 8 8 A", "9 9 9 3", true],
    ["3 4 5 6 7", "4 5 6 7 8", true],
    ["3 4 5 6 7", "4 5 6 7 8 9", false],
    ["2", "小", true],
    ["小", "大", true],
    ["K K K K", "2 2 2 2", true],
    ["2 2 2 2", "小 大", true],
    ["9 9 9 9 3 4", "3 3 3 3", true],
    ["3 3 3 3", "9 9 9 9 5 6", false],
    ["Q Q", "Q Q", false],
    ["3 3 3 4 4 4 5 6", "4 4 4 5 5 5 7 7", true],
    ["3 3 3 4 4 4 5 6", "4 4 4 5 5 5 7 7 8 8", false],
  ];
  for (const [prev, next, expected] of cases) {
    it(`${next} ${expected ? "能" : "不能"}压 ${prev}`, () => {
      const prevCombo = classify(parseCards(prev))[0]!;
      const nextCombo = classify(parseCards(next))[0];
      expect(Boolean(nextCombo && beats(prevCombo, nextCombo))).toBe(expected);
    });
  }
  it("王炸最大，炸弹按点数比", () => {
    const rocket = read("小 大")[0]!;
    expect(beats(rocket, read("2 2 2 2")[0]!)).toBe(false);
    expect(beats(read("4 4 4 4")[0]!, read("3 3 3 3")[0]!)).toBe(false);
    expect(beats(read("3 3 3 3")[0]!, read("4 4 4 4")[0]!)).toBe(true);
  });
});

describe("找能压的牌（提示 / 机器人）", () => {
  it("同牌型从小到大，再是炸弹、王炸；不拆炸弹的优先", () => {
    const hand = parseCards("3 5 5 6 6 6 6 9 2 小 大");
    const moves = beatingMoves(hand, read("4")[0]!);
    const first = moves[0]!;
    expect(first.combo).toMatchObject({ type: "single", main: 9 }); // 9 落单，不拆对子和炸弹
    expect(moves.some((move) => move.combo.type === "bomb")).toBe(true);
    expect(moves.at(-1)!.combo.type).toBe("rocket");
    for (const move of moves) expect(beats(read("4")[0]!, move.combo)).toBe(true);
  });
  it("飞机带单、四带两对、连对都能找出来", () => {
    const hand = parseCards("4 4 4 5 5 5 7 8 9 9 10 10 J J Q Q Q Q K");
    expect(beatingMoves(hand, read("3 3 3 4 4 4 5 6")[0]!).some((move) => move.combo.type === "plane1" && move.combo.main === 5)).toBe(true);
    expect(beatingMoves(hand, read("3 3 4 4 5 5")[0]!).some((move) => move.combo.type === "pairs" && move.combo.main === 11)).toBe(true);
    expect(beatingMoves(hand, read("5 5 5 5 3 3 4 4")[0]!).some((move) => move.combo.type === "four22" && move.combo.main === 12)).toBe(true);
  });
  it("找出来的出法都合法、牌都在手里", () => {
    const hand = parseCards("3 3 3 4 4 4 5 5 5 6 7 8 9 10 J Q K 2 2 大");
    const moves = allLeadMoves(hand);
    expect(moves.length).toBeGreaterThan(20);
    for (const move of moves) {
      expect(move.cards.every((card) => hand.includes(card))).toBe(true);
      expect(classify(move.cards).some((reading) => reading.type === move.combo.type && reading.main === move.combo.main)).toBe(true);
    }
  });
});
