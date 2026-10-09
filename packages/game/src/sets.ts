/**
 * 核心判定函数（规则书 9.2，全部有单测）：一套牌的合法性和等效牌（4.1）、比大小（4.2）、够级牌（4.3）、
 * 烧牌的「步步带王」（4.6 (2)）、烧牌候选 S₁、烧牌状态下的发牌限制（4.6 (4) 第 3 条）、枚举能出的牌。
 *
 * 一套牌只有三种：同点数的普通牌（3～A）+ 任意张配牌；只有 2 + 任意张王；只有王。
 * 挂上去的 2 当成那套牌的普通点数；王保留王的身份（16 小王、17 大王）。
 */
import { ACE, BIG_JOKER, groupByRank, MIN_RANK, rankCounts, rankLabel, rankOf, SMALL_JOKER, sortCards, TWO, type Card } from "./cards.js";

export interface PlaySet {
  /** 这套牌（从大到小）。 */
  readonly cards: Card[];
  /** 普通点数（3～14）；纯 2（可以挂王）是 15；只有王是 null。 */
  readonly base: number | null;
  /** 等效牌：挂的 2 换成 base，王不变，从大到小。 */
  readonly eff: number[];
  /** 够级牌（4.3）。 */
  readonly gouji: boolean;
  /** 几张普通牌、几张 2、几张小王、几张大王。 */
  readonly naturals: number;
  readonly twos: number;
  readonly small: number;
  readonly big: number;
}

/** 够级牌的最少张数（等效牌，挂的 2 算进去）：10 要 5 张、J 4 张、Q 3 张、K 和 A 2 张；9 及以下不挂王就不是。 */
export const GOUJI_THRESHOLD: Readonly<Record<number, number>> = { 10: 5, 11: 4, 12: 3, 13: 2, 14: 2 };

/** 一套牌的等效牌和够级判定；不合法返回 null（4.1、4.3）。 */
export function parseSet(cards: readonly Card[]): PlaySet | null {
  if (cards.length === 0 || new Set(cards).size !== cards.length) return null;
  let base: number | null = null;
  let naturals = 0;
  let twos = 0;
  let small = 0;
  let big = 0;
  for (const card of cards) {
    const rank = rankOf(card);
    if (rank <= ACE) {
      if (base !== null && base !== rank) return null; // 不同点数的普通牌不能一起出
      base = rank;
      naturals += 1;
    } else if (rank === TWO) twos += 1;
    else if (rank === SMALL_JOKER) small += 1;
    else big += 1;
  }
  if (base === null && twos > 0) base = TWO;
  const plain = naturals + twos;
  const eff = [...new Array<number>(big).fill(BIG_JOKER), ...new Array<number>(small).fill(SMALL_JOKER), ...new Array<number>(plain).fill(base ?? 0)];
  const gouji = small + big > 0 || base === TWO || (base !== null && GOUJI_THRESHOLD[base] !== undefined && plain >= GOUJI_THRESHOLD[base]!);
  return { cards: sortCards(cards), base, eff, gouji, naturals, twos, small, big };
}

/** 4.2：张数相同，两套等效牌从大到小逐张比较，每一张都严格大于才算压过。 */
export function beats(next: Pick<PlaySet, "eff">, prev: Pick<PlaySet, "eff">): boolean {
  if (next.eff.length !== prev.eff.length) return false;
  return next.eff.every((rank, index) => rank > prev.eff[index]!);
}

/** 两套牌按规则书的写法比较（测试、提示用）：合法且压得住。 */
export function cardsBeat(next: readonly Card[], prev: readonly Card[]): boolean {
  const a = parseSet(next);
  const b = parseSet(prev);
  return a !== null && b !== null && beats(a, b);
}

/** 出牌区显示的读法：「5 张 10」「3 张 Q 挂小王」「2 张 2 挂大王」「大王 小王」。 */
export function setLabel(set: Pick<PlaySet, "base" | "naturals" | "twos" | "small" | "big">): string {
  const jokers = [set.big > 0 ? (set.big === 1 ? "大王" : `${set.big} 张大王`) : "", set.small > 0 ? (set.small === 1 ? "小王" : `${set.small} 张小王`) : ""].filter(Boolean);
  if (set.base === null) return jokers.join(" ");
  const head = `${set.naturals + set.twos} 张 ${rankLabel(set.base)}`;
  return jokers.length > 0 ? `${head} 挂${jokers.join("")}` : head;
}

// ---------------------------------------------------------------------------
// 烧牌（4.6）

/** 一手牌的结构：普通点数有几种（d）、王有几张（J）。 */
function tailShape(counts: readonly number[]): { d: number; jokers: number; size: number } {
  let d = 0;
  let size = 0;
  for (let rank = MIN_RANK; rank <= ACE; rank += 1) {
    if (counts[rank]! > 0) d += 1;
    size += counts[rank]!;
  }
  const jokers = counts[SMALL_JOKER]! + counts[BIG_JOKER]!;
  size += counts[TWO]! + jokers;
  return { d, jokers, size };
}

const tailOk = (d: number, jokers: number, size: number): boolean => size === 0 || jokers >= Math.max(d, 1) - 1;

/**
 * 4.6 (2)：剩下的牌能不能分成若干套、除了最后一套每套都挂王。
 * 普通点数有 d 种、王有 J 张（2 能挂在任何一套上，不用管）：需要 m = max(d, 1) 套，可以 ⇔ J ≥ m − 1；没牌了也可以。
 */
export function canBurnTail(cards: readonly Card[]): boolean {
  const { d, jokers, size } = tailShape(rankCounts(cards));
  return tailOk(d, jokers, size);
}

/** 一种出法的「形状」：普通点数 base（纯 2 是 15、只有王是 null）+ 几张普通牌 + 几张 2 + 几张小王 + 几张大王。 */
export interface Shape {
  readonly base: number | null;
  readonly naturals: number;
  readonly twos: number;
  readonly small: number;
  readonly big: number;
}

const shapeSize = (shape: Shape) => shape.naturals + shape.twos + shape.small + shape.big;

/** 这种形状能不能压住等效牌 prev（prev 从大到小）：前 big 张是大王、接着 small 张小王、其余是 base。 */
function shapeBeats(shape: Shape, prev: readonly number[]): boolean {
  if (shapeSize(shape) !== prev.length) return false;
  if (shape.big > 0 && !(prev[0]! < BIG_JOKER)) return false;
  if (shape.small > 0 && !(prev[shape.big]! < SMALL_JOKER)) return false;
  const plain = shape.naturals + shape.twos;
  if (plain > 0 && !(prev[shape.big + shape.small]! < (shape.base ?? 0))) return false;
  return true;
}

/**
 * 枚举手里能组成的所有出法（每种形状一种，用哪几张同点数的牌不影响规则）。
 * size 给了就只要这个张数的。visit 返回 true 时停止。
 */
export function forEachShape(counts: readonly number[], visit: (shape: Shape) => boolean | void, size?: number): void {
  const twos = counts[TWO]!;
  const smalls = counts[SMALL_JOKER]!;
  const bigs = counts[BIG_JOKER]!;
  const emit = (base: number | null, naturals: number, two: number, small: number): boolean => {
    if (size !== undefined) {
      const big = size - naturals - two - small;
      if (big < 0 || big > bigs) return false;
      if (base === null && naturals + two + small + big === 0) return false;
      return visit({ base, naturals, twos: two, small, big }) === true;
    }
    for (let big = 0; big <= bigs; big += 1) {
      if (base === null && small + big === 0) continue;
      if (visit({ base, naturals, twos: two, small, big }) === true) return true;
    }
    return false;
  };
  for (let rank = MIN_RANK; rank <= ACE; rank += 1) {
    const have = counts[rank]!;
    for (let naturals = 1; naturals <= have; naturals += 1) {
      for (let two = 0; two <= twos; two += 1) {
        if (size !== undefined && naturals + two > size) break;
        for (let small = 0; small <= smalls; small += 1) if (emit(rank, naturals, two, small)) return;
      }
    }
  }
  for (let two = 1; two <= twos; two += 1) {
    if (size !== undefined && two > size) break;
    for (let small = 0; small <= smalls; small += 1) if (emit(TWO, 0, two, small)) return;
  }
  for (let small = 0; small <= smalls; small += 1) if (emit(null, 0, 0, small)) return;
}

/** 按形状从手牌里取出具体的牌。 */
export function shapeCards(groups: readonly Card[][], shape: Shape): Card[] {
  const cards: Card[] = [];
  if (shape.base !== null && shape.base <= ACE) cards.push(...groups[shape.base]!.slice(0, shape.naturals));
  cards.push(...groups[TWO]!.slice(0, shape.twos), ...groups[SMALL_JOKER]!.slice(0, shape.small), ...groups[BIG_JOKER]!.slice(0, shape.big));
  return sortCards(cards);
}

/** 拿出这种形状以后剩下的牌满不满足「步步带王」。 */
function restTailOk(counts: readonly number[], shape: Shape, total: number): boolean {
  const { d, jokers } = tailShape(counts);
  const rest = total - shapeSize(shape);
  const removesRank = shape.base !== null && shape.base <= ACE && shape.naturals === counts[shape.base];
  return tailOk(d - (removesRank ? 1 : 0), jokers - shape.small - shape.big, rest);
}

/**
 * 烧牌候选 S₁（4.6 (1) 第 4 条）：能压住 top、而且出掉以后剩下的牌满足「步步带王」的每种出法。
 * 按「普通点数 R + k 张 2 + a 张小王 + b 张大王」枚举，组合很少。
 */
export function burnCandidates(hand: readonly Card[], top: Pick<PlaySet, "eff">): Card[][] {
  const counts = rankCounts(hand);
  const groups = groupByRank(hand);
  const found: Card[][] = [];
  forEachShape(counts, (shape) => {
    if (shapeBeats(shape, top.eff) && restTailOk(counts, shape, hand.length)) found.push(shapeCards(groups, shape));
  }, top.eff.length);
  return found;
}

/** 手里有没有烧牌候选（只要知道能不能烧时用，找到一个就停）。 */
export function hasBurnCandidate(hand: readonly Card[], top: Pick<PlaySet, "eff">): boolean {
  const counts = rankCounts(hand);
  let found = false;
  forEachShape(counts, (shape) => {
    if (shapeBeats(shape, top.eff) && restTailOk(counts, shape, hand.length)) found = true;
    return found;
  }, top.eff.length);
  return found;
}

/**
 * 烧牌状态下发牌的限制（4.6 (4) 第 3 条）：要么出手里剩下的全部牌（恰好是一套合法的牌），
 * 要么出一套至少挂一张王、出完以后剩下的牌仍然能步步带王的牌。
 */
export function legalBurnLead(hand: readonly Card[], cards: readonly Card[]): boolean {
  const set = parseSet(cards);
  if (!set) return false;
  const left = new Set(hand);
  for (const card of cards) if (!left.delete(card)) return false;
  if (left.size === 0) return true;
  return set.small + set.big > 0 && canBurnTail([...left]);
}

/** 发牌时能出的所有出法（每种形状一种）；inBurn 为 true 时只留烧牌状态下允许的出法。 */
export function leadMoves(hand: readonly Card[], inBurn = false): Card[][] {
  const counts = rankCounts(hand);
  const groups = groupByRank(hand);
  const moves: Card[][] = [];
  forEachShape(counts, (shape) => {
    if (inBurn) {
      const allOut = shapeSize(shape) === hand.length;
      if (!allOut && (shape.small + shape.big === 0 || !restTailOk(counts, shape, hand.length))) return;
    }
    moves.push(shapeCards(groups, shape));
  });
  return moves;
}

/** 接牌时能压住 top 的所有出法（每种形状一种）。 */
export function beatingMoves(hand: readonly Card[], top: Pick<PlaySet, "eff">): Card[][] {
  const counts = rankCounts(hand);
  const groups = groupByRank(hand);
  const moves: Card[][] = [];
  forEachShape(counts, (shape) => {
    if (shapeBeats(shape, top.eff)) moves.push(shapeCards(groups, shape));
  }, top.eff.length);
  return moves;
}

/** 手里有没有能压住 top 的牌。 */
export function canBeat(hand: readonly Card[], top: Pick<PlaySet, "eff">): boolean {
  let found = false;
  forEachShape(rankCounts(hand), (shape) => {
    found = shapeBeats(shape, top.eff);
    return found;
  }, top.eff.length);
  return found;
}
