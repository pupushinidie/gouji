/**
 * 四副带大小王的扑克牌（216 张）的编码。牌 id 0–215：
 * - 副数 deck = floor(id / 54)（0–3），副内编号 local = id % 54；
 * - local 0–51：点数 rank = 3 + (local >> 2)（3–15，11=J 12=Q 13=K 14=A 15=2），花色 local & 3（0 黑桃 1 红桃 2 梅花 3 方块）；
 * - local 52 小王（rank 16），53 大王（rank 17）。
 * 隐藏的牌（别人的手牌）不下发；需要占位时用 -1。花色和副数不影响任何规则，只用于画面（网页按 local 找牌面图）。
 */
export type Card = number;

export const DECKS = 4;
export const DECK_CARDS = 54;
export const DECK_SIZE = DECKS * DECK_CARDS; // 216
/** 点数：3 … 14（A），15 是 2，16 小王，17 大王。 */
export const MIN_RANK = 3;
export const ACE = 14;
export const TWO = 15;
export const SMALL_JOKER = 16;
export const BIG_JOKER = 17;
export const MAX_RANK = 17;

export const SUITS = ["S", "H", "C", "D"] as const;
export type Suit = (typeof SUITS)[number];

export const localOf = (card: Card): number => card % DECK_CARDS;
export const deckOf = (card: Card): number => Math.floor(card / DECK_CARDS);
export const rankOf = (card: Card): number => {
  const local = card % DECK_CARDS;
  return local >= 52 ? local - 36 : 3 + (local >> 2);
};
export const suitOf = (card: Card): Suit | "J" => {
  const local = card % DECK_CARDS;
  return local >= 52 ? "J" : SUITS[local & 3]!;
};

/** 普通牌（3～A）。 */
export const isNatural = (card: Card): boolean => rankOf(card) <= ACE;
/** 王（小王、大王）。 */
export const isJoker = (card: Card): boolean => rankOf(card) >= SMALL_JOKER;
/** 配牌（2、小王、大王）。 */
export const isWild = (card: Card): boolean => rankOf(card) >= TWO;

const RANK_LABELS: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "小王", 17: "大王" };
export const rankLabel = (rank: number): string => RANK_LABELS[rank] ?? String(rank);

const SUIT_NAMES: Record<Suit, string> = { S: "黑桃", H: "红桃", C: "梅花", D: "方块" };
export function cardName(card: Card): string {
  if (card < 0) return "牌背";
  const suit = suitOf(card);
  return suit === "J" ? rankLabel(rankOf(card)) : `${SUIT_NAMES[suit]}${rankLabel(rankOf(card))}`;
}

/** 某个点数的第 k 张（k 从 0 起）：普通牌和 2 每种 16 张，王每种 4 张。 */
export function cardOf(rank: number, k = 0): Card {
  if (rank === SMALL_JOKER || rank === BIG_JOKER) {
    if (k < 0 || k >= DECKS) throw new Error(`${rankLabel(rank)}只有 ${DECKS} 张`);
    return k * DECK_CARDS + (rank === SMALL_JOKER ? 52 : 53);
  }
  if (rank < MIN_RANK || rank > TWO || k < 0 || k >= 16) throw new Error(`没有这张牌：${rank} 第 ${k} 张`);
  return Math.floor(k / 4) * DECK_CARDS + (rank - 3) * 4 + (k % 4);
}

/** 每种点数四副牌里一共几张。 */
export const totalOfRank = (rank: number): number => (rank >= SMALL_JOKER ? DECKS : 16);

/** 从大到小排：点数大的在前，同点数按 id。 */
export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => rankOf(b) - rankOf(a) || a - b);
}

/** 每个点数有几张，下标是点数（0–17）。 */
export function rankCounts(cards: readonly Card[]): number[] {
  const counts = new Array<number>(MAX_RANK + 1).fill(0);
  for (const card of cards) counts[rankOf(card)]! += 1;
  return counts;
}

/** 按点数分组（下标是点数），每组按 id 排好。 */
export function groupByRank(cards: readonly Card[]): Card[][] {
  const groups: Card[][] = Array.from({ length: MAX_RANK + 1 }, () => []);
  for (const card of [...cards].sort((a, b) => a - b)) groups[rankOf(card)]!.push(card);
  return groups;
}

const NAMED_RANKS: Record<string, number> = { J: 11, Q: 12, K: 13, A: 14, "2": 15, 小: 16, 大: 17, 小王: 16, 大王: 17 };

/** 把「8」「Q」「小」「大王」这样的写法换成点数。 */
export function parseRank(token: string): number {
  const rank = NAMED_RANKS[token.toUpperCase()] ?? NAMED_RANKS[token] ?? Number(token);
  if (!Number.isInteger(rank) || rank < MIN_RANK || rank > MAX_RANK) throw new Error(`不认识的牌：${token}`);
  return rank;
}

/**
 * 把「3 3 4 4 小 大 10 J」这样的写法换成牌（同点数依次取不同的牌）。也支持「10x5」「K×2」表示 5 张 10、2 张 K。
 * used 可以传进来让几次调用之间不重复取同一张（预览局面工厂给好几个座位分牌时用）。
 */
export function parseCards(text: string, used: Map<number, number> = new Map()): Card[] {
  const cards: Card[] = [];
  for (const raw of text.trim().split(/[\s,，、]+/).filter(Boolean)) {
    const match = /^(.+?)[x×*](\d+)$/i.exec(raw);
    const token = match ? match[1]! : raw;
    const times = match ? Number(match[2]) : 1;
    const rank = parseRank(token);
    for (let t = 0; t < times; t += 1) {
      const k = used.get(rank) ?? 0;
      if (k >= totalOfRank(rank)) throw new Error(`${rankLabel(rank)} 超过了 ${totalOfRank(rank)} 张`);
      used.set(rank, k + 1);
      cards.push(cardOf(rank, k));
    }
  }
  return cards;
}

/** 牌的简写（「大 8 8 2」，从大到小），日志、测试、调试牌桌用。 */
export function cardsText(cards: readonly Card[]): string {
  return sortCards(cards)
    .map((card) => {
      const rank = rankOf(card);
      return rank === SMALL_JOKER ? "小" : rank === BIG_JOKER ? "大" : rankLabel(rank);
    })
    .join(" ");
}
