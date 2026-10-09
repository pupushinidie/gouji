/**
 * 一副 54 张牌的编码。牌 id 0–53：
 * - 0–51：点数 rank = 3 + (id >> 2)（3–15，11=J 12=Q 13=K 14=A 15=2），花色 id & 3（0 黑桃 1 红桃 2 梅花 3 方块）；
 * - 52 小王（rank 16），53 大王（rank 17）。
 * 隐藏的牌（别人的手牌、没翻开的底牌）用 -1。花色不影响任何规则，只用于画面。
 */
export type Card = number;

export const DECK_SIZE = 54;
export const SMALL_JOKER = 52;
export const BIG_JOKER = 53;
/** 点数：3 … 15（2），16 小王，17 大王。 */
export const MIN_RANK = 3;
export const MAX_RANK = 17;
/** 顺子、连对、飞机的连续部分只能用 3 到 A。 */
export const MAX_CHAIN_RANK = 14;

export const SUITS = ["S", "H", "C", "D"] as const;
export type Suit = (typeof SUITS)[number];

export const rankOf = (card: Card): number => (card >= 52 ? card - 36 : 3 + (card >> 2));
export const suitOf = (card: Card): Suit | "J" => (card >= 52 ? "J" : SUITS[card & 3]!);

const RANK_LABELS: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "小王", 17: "大王" };
export const rankLabel = (rank: number): string => RANK_LABELS[rank] ?? String(rank);

const SUIT_NAMES: Record<Suit, string> = { S: "黑桃", H: "红桃", C: "梅花", D: "方块" };
export function cardName(card: Card): string {
  if (card < 0) return "牌背";
  const suit = suitOf(card);
  return suit === "J" ? rankLabel(rankOf(card)) : `${SUIT_NAMES[suit]}${rankLabel(rankOf(card))}`;
}

/** 某个点数的第 k 张（花色顺序）；王只有 k=0。 */
export function cardOf(rank: number, k = 0): Card {
  if (rank === 16) return SMALL_JOKER;
  if (rank === 17) return BIG_JOKER;
  return (rank - 3) * 4 + k;
}

/** 从大到小排：点数大的在前，同点数按花色。 */
export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => rankOf(b) - rankOf(a) || a - b);
}

/** 每个点数有几张，下标是点数（0–17）。 */
export function rankCounts(cards: readonly Card[]): number[] {
  const counts = new Array<number>(MAX_RANK + 1).fill(0);
  for (const card of cards) counts[rankOf(card)]! += 1;
  return counts;
}

/** 每种点数一副牌里有几张。 */
export const totalOfRank = (rank: number): number => (rank >= 16 ? 1 : 4);

/** 测试用：把「3 3 4 4 小 大 10 J」这样的写法换成牌（同点数依次取不同花色）。 */
export function parseCards(text: string): Card[] {
  const used = new Map<number, number>();
  const names: Record<string, number> = { J: 11, Q: 12, K: 13, A: 14, "2": 15, 小: 16, 大: 17, 小王: 16, 大王: 17 };
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const rank = names[token.toUpperCase()] ?? names[token] ?? Number(token);
      if (!Number.isInteger(rank) || rank < 3 || rank > 17) throw new Error(`不认识的牌：${token}`);
      const k = used.get(rank) ?? 0;
      if (k >= totalOfRank(rank)) throw new Error(`${token} 超过了 ${totalOfRank(rank)} 张`);
      used.set(rank, k + 1);
      return cardOf(rank, k);
    });
}
