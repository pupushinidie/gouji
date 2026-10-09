/**
 * 牌型识别和比较（规则书 4.7、4.8、5.4）。只看每个点数有几张，花色不管。
 */
import { BIG_JOKER, MAX_CHAIN_RANK, rankCounts, rankOf, SMALL_JOKER, sortCards, type Card } from "./cards.js";

export type ComboType =
  | "single"
  | "pair"
  | "trio"
  | "trio1"
  | "trio2"
  | "straight"
  | "pairs"
  | "plane"
  | "plane1"
  | "plane2"
  | "four2"
  | "four22"
  | "bomb"
  | "rocket";

export interface Combo {
  readonly type: ComboType;
  /** 比较时看的点数（顺子、连对、飞机看最大那组；带牌的看主体）。王炸是 17。 */
  readonly main: number;
  /** 张数。 */
  readonly size: number;
  /** 连续部分有几组：顺子几张、连对几对、飞机几个三张；其他牌型是 1。 */
  readonly chain: number;
}

export const COMBO_NAMES: Record<ComboType, string> = {
  single: "单张",
  pair: "对子",
  trio: "三张",
  trio1: "三带一",
  trio2: "三带一对",
  straight: "顺子",
  pairs: "连对",
  plane: "飞机",
  plane1: "飞机带单",
  plane2: "飞机带对",
  four2: "四带二",
  four22: "四带两对",
  bomb: "炸弹",
  rocket: "王炸",
};

/** 「顺子 3–7」「飞机带单 444555」这样的说明。 */
export function comboLabel(combo: Combo): string {
  const name = COMBO_NAMES[combo.type];
  const label = (rank: number) => ({ 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "小王", 17: "大王" } as Record<number, string>)[rank] ?? String(rank);
  if (combo.chain > 1) return `${name} ${label(combo.main - combo.chain + 1)}–${label(combo.main)}`;
  if (combo.type === "rocket") return name;
  return `${name} ${label(combo.main)}`;
}

const isBombLike = (combo: Combo) => combo.type === "bomb" || combo.type === "rocket";

/** next 能不能压 prev（4.8）。 */
export function beats(prev: Combo, next: Combo): boolean {
  if (prev.type === "rocket") return false;
  if (next.type === "rocket") return true;
  if (next.type === "bomb") return prev.type !== "bomb" || next.main > prev.main;
  if (prev.type === "bomb") return false;
  return next.type === prev.type && next.size === prev.size && next.main > prev.main;
}

/** 连续 k 个点数 [top-k+1, top] 都恰好有 n 张。 */
function runOf(counts: readonly number[], top: number, k: number, n: number): boolean {
  if (top > MAX_CHAIN_RANK || top - k + 1 < 3) return false;
  for (let rank = top - k + 1; rank <= top; rank += 1) if (counts[rank] !== n) return false;
  return true;
}

/**
 * 这组牌能认成的所有牌型（不合法返回空数组），按比较点数从大到小排。
 * 只有飞机带单可能有多种认法（不同的连续三张）。
 */
export function classify(cards: readonly Card[]): Combo[] {
  const n = cards.length;
  if (n === 0 || new Set(cards).size !== n || cards.some((card) => !Number.isInteger(card) || card < 0 || card > BIG_JOKER)) return [];
  const counts = rankCounts(cards);
  const ranks: number[] = [];
  for (let rank = 3; rank <= 17; rank += 1) if (counts[rank]! > 0) ranks.push(rank);
  const distinct = ranks.length;
  const top = ranks[ranks.length - 1]!;
  const uniform = (c: number) => ranks.every((rank) => counts[rank] === c);
  const consecutive = top - ranks[0]! + 1 === distinct;
  const combo = (type: ComboType, main: number, chain = 1): Combo => ({ type, main, size: n, chain });

  if (n === 1) return [combo("single", top)];
  if (n === 2) {
    if (counts[16] === 1 && counts[17] === 1) return [combo("rocket", 17)];
    return distinct === 1 && top <= 15 ? [combo("pair", top)] : [];
  }
  if (distinct === 1) {
    if (n === 3) return [combo("trio", top)];
    if (n === 4) return [combo("bomb", top)];
    return [];
  }
  const withCount = (c: number) => ranks.filter((rank) => counts[rank] === c);
  const bothJokers = counts[16] === 1 && counts[17] === 1;

  if (n === 4 && withCount(3).length === 1) return [combo("trio1", withCount(3)[0]!)];
  if (n === 5 && withCount(3).length === 1 && withCount(2).length === 1) return [combo("trio2", withCount(3)[0]!)];
  if (n >= 5 && uniform(1) && consecutive && top <= MAX_CHAIN_RANK) return [combo("straight", top, n)];
  if (n >= 6 && uniform(2) && consecutive && top <= MAX_CHAIN_RANK) return [combo("pairs", top, n / 2)];
  if (n >= 6 && uniform(3) && consecutive && top <= MAX_CHAIN_RANK) return [combo("plane", top, n / 3)];

  const fours = withCount(4);
  if (n === 6 && fours.length === 1 && !bothJokers) return [combo("four2", fours[0]!)];
  if (n === 8 && fours.length === 1) {
    const rest = ranks.filter((rank) => rank !== fours[0]);
    if (rest.length === 2 && rest.every((rank) => counts[rank] === 2)) return [combo("four22", fours[0]!)];
    return [];
  }

  const result: (Combo & { adjacentTriple?: boolean })[] = [];
  if (n >= 8 && n % 4 === 0) {
    const k = n / 4;
    for (let runTop = 3 + k - 1; runTop <= MAX_CHAIN_RANK; runTop += 1) {
      if (!runOf(counts, runTop, k, 3)) continue;
      const kickers = ranks.filter((rank) => rank < runTop - k + 1 || rank > runTop);
      if (bothJokers) continue;
      if (kickers.some((rank) => counts[rank] === 4)) continue;
      const adjacentTriple = counts[runTop - k] === 3 || counts[runTop + 1] === 3;
      result.push({ ...combo("plane1", runTop, k), adjacentTriple });
    }
  }
  if (n >= 10 && n % 5 === 0) {
    const k = n / 5;
    for (let runTop = 3 + k - 1; runTop <= MAX_CHAIN_RANK; runTop += 1) {
      if (!runOf(counts, runTop, k, 3)) continue;
      const kickers = ranks.filter((rank) => rank < runTop - k + 1 || rank > runTop);
      if (kickers.length === k && kickers.every((rank) => counts[rank] === 2)) result.push(combo("plane2", runTop, k));
    }
  }
  // 5.4：带的单牌凑成和飞机相邻的三张时，如果有连得更长的认法，就只按更长的认。
  const longest = Math.max(0, ...result.map((reading) => reading.chain));
  return result
    .filter((reading) => !(reading.adjacentTriple && reading.chain < longest))
    .map(({ adjacentTriple: _adjacent, ...reading }) => reading)
    .sort((a, b) => b.main - a.main);
}

/** 同一组牌、同一种认法的唯一标识（多种认法时让玩家选）。 */
export const comboKey = (combo: Combo) => `${combo.type}:${combo.main}:${combo.size}`;

// ---------------------------------------------------------------------------
// 从手牌里找出能出的牌（提示按钮、机器人用）

export interface Move {
  readonly cards: Card[];
  readonly combo: Combo;
}

/** 从手牌里按点数取牌的工具：每个点数取前几张（花色顺序）。 */
function picker(hand: readonly Card[]) {
  const byRank = new Map<number, Card[]>();
  for (const card of [...hand].sort((a, b) => a - b)) {
    const rank = rankOf(card);
    byRank.set(rank, [...(byRank.get(rank) ?? []), card]);
  }
  return (rank: number, count: number): Card[] => (byRank.get(rank) ?? []).slice(0, count);
}

/**
 * 带牌的代价：优先带本来就落单的小牌，其次拆对子、三张，最后才拆炸弹和王炸。
 * per 是每个带牌单位的张数（1 单张、2 对子）。
 */
function kickerCost(counts: readonly number[], rank: number, per: number): number {
  const c = counts[rank]!;
  const bomb = c === 4 || (rank >= 16 && counts[16] === 1 && counts[17] === 1);
  if (bomb) return 200 + rank;
  // 2 和王是控场的大牌，能不带就不带。
  const big = rank >= 15 ? 15 : 0;
  if (c === per) return rank + big;
  return (per === 1 && c === 2 ? 20 : 30) + rank + big;
}

/**
 * 给定主体（已经占用 used 里的点数）挑 k 个带牌单位（单张或对子），返回点数列表；挑不出返回 null。
 * 单张可以重复点数（飞机带单），但不能凑成和飞机相邻的三张，也不能同时带两张王、带 4 张同点数。
 */
function chooseKickers(counts: readonly number[], used: ReadonlySet<number>, k: number, per: 1 | 2, avoidAdjacent: readonly number[] = []): number[] | null {
  const options: { rank: number; cost: number }[] = [];
  for (let rank = 3; rank <= 17; rank += 1) {
    if (used.has(rank) || counts[rank]! < per) continue;
    if (per === 2 && rank >= 16) continue;
    // 每个点数最多能拆出几个单位：对子只拿一次（不能带两个同点数的对子）。
    const units = per === 2 ? 1 : Math.min(counts[rank]!, 3);
    for (let unit = 0; unit < units; unit += 1) options.push({ rank, cost: kickerCost(counts, rank, per) + unit * 30 });
  }
  options.sort((a, b) => a.cost - b.cost || a.rank - b.rank);
  const chosen: number[] = [];
  for (const option of options) {
    if (chosen.length === k) break;
    if (per === 1) {
      if (option.rank >= 16 && chosen.some((rank) => rank >= 16)) continue;
      const same = chosen.filter((rank) => rank === option.rank).length;
      if (same >= 2 && avoidAdjacent.includes(option.rank)) continue;
      if (same >= 3) continue;
    }
    chosen.push(option.rank);
  }
  return chosen.length === k ? chosen : null;
}

/** 某种牌型、某个张数下，所有能出的主体点数（main 从小到大），带牌挑最便宜的。 */
function movesOfShape(hand: readonly Card[], type: ComboType, size: number, above: number): Move[] {
  const counts = rankCounts(hand);
  const take = picker(hand);
  const moves: Move[] = [];
  const push = (cards: Card[]) => {
    const reading = classify(cards).find((candidate) => candidate.type === type && candidate.size === size && candidate.main > above);
    if (reading) moves.push({ cards: sortCards(cards), combo: reading });
  };
  const chainShape = (n: number, k: number, extraPer: 0 | 1 | 2) => {
    for (let runTop = Math.max(above + 1, 3 + k - 1); runTop <= MAX_CHAIN_RANK; runTop += 1) {
      const run: number[] = [];
      for (let rank = runTop - k + 1; rank <= runTop; rank += 1) run.push(rank);
      if (!run.every((rank) => counts[rank]! >= n)) continue;
      const cards = run.flatMap((rank) => take(rank, n));
      if (extraPer === 0) {
        push(cards);
        continue;
      }
      const used = new Set(run);
      const kickers = chooseKickers(counts, used, k, extraPer, [run[0]! - 1, runTop + 1]);
      if (!kickers) continue;
      const extra: Card[] = [];
      for (const rank of new Set(kickers)) extra.push(...take(rank, kickers.filter((r) => r === rank).length * extraPer));
      push([...cards, ...extra]);
    }
  };
  switch (type) {
    case "single":
    case "pair":
    case "trio":
    case "bomb": {
      const n = { single: 1, pair: 2, trio: 3, bomb: 4 }[type];
      for (let rank = Math.max(3, above + 1); rank <= 17; rank += 1) if (counts[rank]! >= n) push(take(rank, n));
      break;
    }
    case "rocket":
      if (counts[16] === 1 && counts[17] === 1) push([SMALL_JOKER, BIG_JOKER]);
      break;
    case "trio1":
    case "trio2":
    case "four2":
    case "four22": {
      const n = type.startsWith("trio") ? 3 : 4;
      const per = type === "trio2" || type === "four22" ? 2 : 1;
      const k = type.startsWith("trio") ? 1 : 2;
      for (let rank = Math.max(3, above + 1); rank <= 15; rank += 1) {
        if (counts[rank]! < n) continue;
        const kickers = chooseKickers(counts, new Set([rank]), k, per);
        if (!kickers) continue;
        const extra: Card[] = [];
        for (const kicker of new Set(kickers)) extra.push(...take(kicker, kickers.filter((r) => r === kicker).length * per));
        push([...take(rank, n), ...extra]);
      }
      break;
    }
    case "straight":
      chainShape(1, size, 0);
      break;
    case "pairs":
      chainShape(2, size / 2, 0);
      break;
    case "plane":
      chainShape(3, size / 3, 0);
      break;
    case "plane1":
      chainShape(3, size / 4, 1);
      break;
    case "plane2":
      chainShape(3, size / 5, 2);
      break;
  }
  return moves;
}

/** 拆牌代价：出了这手以后，手里被拆散的对子、三张、炸弹越多越差（提示排序用）。 */
function breakCost(hand: readonly Card[], move: Move): number {
  const before = rankCounts(hand);
  const after = rankCounts(move.cards);
  let cost = 0;
  for (let rank = 3; rank <= 17; rank += 1) {
    const used = after[rank]!;
    if (used === 0 || used === before[rank]) continue;
    cost += before[rank] === 4 ? 10 : before[rank] === 3 ? 3 : 2;
  }
  if (move.combo.type !== "rocket" && after[16]! + after[17]! === 1 && before[16] === 1 && before[17] === 1) cost += 10;
  return cost;
}

/**
 * 能压 prev 的所有出法（每个主体点数一种），顺序：同牌型（不拆牌的优先、再从小到大）→ 炸弹 → 王炸。
 * 「提示」按钮按这个顺序循环。
 */
export function beatingMoves(hand: readonly Card[], prev: Combo): Move[] {
  if (prev.type === "rocket") return [];
  const same = prev.type === "bomb" ? [] : movesOfShape(hand, prev.type, prev.size, prev.main);
  same.sort((a, b) => breakCost(hand, a) - breakCost(hand, b) || a.combo.main - b.combo.main);
  const bombs = movesOfShape(hand, "bomb", 4, prev.type === "bomb" ? prev.main : 0);
  const rocket = movesOfShape(hand, "rocket", 2, 0);
  return [...same, ...bombs, ...rocket];
}

/** 手里有没有能压 prev 的牌。 */
export const canBeat = (hand: readonly Card[], prev: Combo) => beatingMoves(hand, prev).length > 0;

/** 引牌时所有牌型、所有张数下能出的牌（机器人和测试用；数量不大，手牌最多 20 张）。 */
export function allLeadMoves(hand: readonly Card[]): Move[] {
  const moves: Move[] = [];
  const n = hand.length;
  const shapes: [ComboType, number][] = [
    ["single", 1],
    ["pair", 2],
    ["trio", 3],
    ["trio1", 4],
    ["trio2", 5],
    ["four2", 6],
    ["four22", 8],
    ["bomb", 4],
    ["rocket", 2],
  ];
  for (let size = 5; size <= Math.min(12, n); size += 1) shapes.push(["straight", size]);
  for (let size = 6; size <= Math.min(20, n); size += 2) shapes.push(["pairs", size]);
  for (let size = 6; size <= Math.min(18, n); size += 3) shapes.push(["plane", size]);
  for (let size = 8; size <= Math.min(20, n); size += 4) shapes.push(["plane1", size]);
  for (let size = 10; size <= Math.min(20, n); size += 5) shapes.push(["plane2", size]);
  for (const [type, size] of shapes) if (size <= n) moves.push(...movesOfShape(hand, type, size, 0));
  return moves;
}

export { isBombLike };
