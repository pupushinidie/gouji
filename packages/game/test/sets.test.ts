/**
 * 核心判定函数（规则书 9.2）：和暴力枚举对拍，确认「按形状枚举」没漏没多。
 */
import { describe, expect, it } from "vitest";
import {
  beatingMoves,
  beats,
  burnCandidates,
  canBurnTail,
  createRng,
  DECK_SIZE,
  leadMoves,
  legalBurnLead,
  parseCards,
  parseSet,
  rankOf,
  setLabel,
  type Card,
} from "../src/index.js";

/** 形状的标识：普通点数 + 各种牌的张数（花色不影响规则）。 */
function shapeKey(cards: readonly Card[]): string {
  const counts = new Array<number>(18).fill(0);
  for (const card of cards) counts[rankOf(card)]! += 1;
  return counts.join(",");
}

function allSubsets(hand: readonly Card[]): Card[][] {
  const result: Card[][] = [];
  for (let mask = 1; mask < 1 << hand.length; mask += 1) result.push(hand.filter((_, index) => (mask >> index) & 1));
  return result;
}

describe("一套牌的读法和枚举", () => {
  it("出牌区读法", () => {
    expect(setLabel(parseSet(parseCards("10x5"))!)).toBe("5 张 10");
    expect(setLabel(parseSet(parseCards("Q Q 2 小"))!)).toBe("3 张 Q 挂小王");
    expect(setLabel(parseSet(parseCards("2 2 大"))!)).toBe("2 张 2 挂大王");
    expect(setLabel(parseSet(parseCards("大 小"))!)).toBe("大王 小王");
    expect(setLabel(parseSet(parseCards("9 9 大 大 小"))!)).toBe("2 张 9 挂 2 张大王、小王");
  });

  it("不合法：空、重复的牌、两种普通点数", () => {
    expect(parseSet([])).toBeNull();
    const [card] = parseCards("8");
    expect(parseSet([card!, card!])).toBeNull();
    expect(parseSet(parseCards("8 9 2"))).toBeNull();
  });

  it("和暴力枚举对拍：发牌能出的、能压住的、烧牌候选、烧牌状态下能发的（200 手随机小牌）", () => {
    const rng = createRng(2024);
    for (let trial = 0; trial < 200; trial += 1) {
      const deck = rng.shuffle(Array.from({ length: DECK_SIZE }, (_, card) => card));
      // 多放一些配牌，组合才丰富
      const wilds = deck.filter((card) => rankOf(card) >= 15).slice(0, 1 + rng.int(4));
      const plain = deck.filter((card) => rankOf(card) < 15).slice(0, 3 + rng.int(7));
      const hand = [...wilds, ...plain];
      const legal = new Map<string, Card[]>();
      for (const subset of allSubsets(hand)) if (parseSet(subset)) legal.set(shapeKey(subset), subset);
      const leads = leadMoves(hand);
      expect(new Set(leads.map(shapeKey))).toEqual(new Set(legal.keys()));
      expect(leads.length).toBe(legal.size);

      // 随便挑一套当桌面牌
      const topCards = [...legal.values()][rng.int(legal.size)]!;
      const top = parseSet(topCards)!;
      const beating = [...legal.values()].filter((cards) => beats(parseSet(cards)!, top));
      expect(new Set(beatingMoves(hand, top).map(shapeKey))).toEqual(new Set(beating.map(shapeKey)));

      const burnable = beating.filter((cards) => {
        const used = new Set(cards);
        return canBurnTail(hand.filter((card) => !used.has(card)));
      });
      expect(new Set(burnCandidates(hand, top).map(shapeKey))).toEqual(new Set(burnable.map(shapeKey)));

      const burnLeads = [...legal.values()].filter((cards) => legalBurnLead(hand, cards));
      expect(new Set(leadMoves(hand, true).map(shapeKey))).toEqual(new Set(burnLeads.map(shapeKey)));
    }
  });
});
