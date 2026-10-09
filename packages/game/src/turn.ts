/**
 * 轮转和资格判定（规则书 4.4 末尾的判定、4.6 (1) 谁能烧、9.2 nextTurn），全部是只读的纯函数。
 *
 * 「在打的人」= 手里有牌、并且不是革命者（勘误 #1：革命者扣下的牌不算手里有牌）。
 */
import { burnCandidates, hasBurnCandidate } from "./sets.js";
import type { Card } from "./cards.js";
import type { GoujiState } from "./types.js";

export const SEAT_COUNT = 6;
export const SEATS = [0, 1, 2, 3, 4, 5] as const;
/** 下家（逆时针下一个）。 */
export const nextSeat = (seat: number): number => (seat + 1) % SEAT_COUNT;
/** 对头（正对面）。 */
export const oppOf = (seat: number): number => (seat + 3) % SEAT_COUNT;
/** 联邦：0 甲（0、2、4），1 乙（1、3、5）。 */
export const teamOf = (seat: number): 0 | 1 => (seat % 2) as 0 | 1;
export const teammates = (seat: number): number[] => SEATS.filter((other) => other !== seat && teamOf(other) === teamOf(seat));

type View = Pick<GoujiState, "players" | "revolutionary" | "headless" | "chaos" | "round">;

/** 在打的人：手里有牌，不是革命者。 */
export function isActive(state: Pick<GoujiState, "players" | "revolutionary">, seat: number): boolean {
  return seat !== state.revolutionary && state.players[seat]!.hand.length > 0;
}

/** 在打的人数。 */
export function activeCount(state: Pick<GoujiState, "players" | "revolutionary">): number {
  return SEATS.filter((seat) => isActive(state, seat)).length;
}

/** 有头：对头没走科（对头走科的那一轮结束起才算无头；革命者的对头从开局起无头）。 */
export const hasHead = (state: Pick<GoujiState, "headless">, seat: number): boolean => !state.headless[seat];

/**
 * 4.4：轮到 X 时有没有资格接桌面牌。
 * - 四人乱缠：有。
 * - 桌面牌是有头的人出的够级牌：只有他的对头（过过牌也可以）和这一轮没过过牌的无头的人能接，其他人只能烧。
 * - 否则：这一轮没过过牌就能接；桌面牌是自己有头的对头出的，过过牌也能接（对头牌不过）。
 */
export function canRespond(state: View, seat: number): boolean {
  const top = state.round?.top;
  if (!top || seat === top.seat || !isActive(state, seat)) return false;
  if (state.chaos) return true;
  const owner = top.seat;
  const passed = state.round!.passed.includes(seat);
  if (top.set.gouji && hasHead(state, owner)) {
    if (seat === oppOf(owner)) return true;
    return state.headless[seat] === true && !passed;
  }
  if (!passed) return true;
  return seat === oppOf(owner) && hasHead(state, owner);
}

/**
 * 9.2 nextTurn：从 from 的下家开始逆时针找下一个有资格接牌的人；转回桌面牌主人的座位（主人走科了也算）就是这一轮结束，返回 null。
 * 让牌的轮转（先让下家、下下家）由引擎另外处理。
 */
export function nextResponder(state: View, from: number): number | null {
  const owner = state.round?.top?.seat;
  if (owner === undefined) return null;
  for (let seat = nextSeat(from); seat !== owner; seat = nextSeat(seat)) {
    if (canRespond(state, seat)) return seat;
  }
  return null;
}

/** 从 seat 往后（不含 seat）第一个在打的人；接风、首出用。 */
export function nextActive(state: Pick<GoujiState, "players" | "revolutionary">, seat: number): number {
  for (let step = 1; step <= SEAT_COUNT; step += 1) {
    const other = (seat + step) % SEAT_COUNT;
    if (isActive(state, other)) return other;
  }
  return -1;
}

/**
 * 4.6 (1) 前三条：这位玩家现在按规则有没有烧牌的身份（还没看手牌能不能一口气出完）。
 * 桌面牌是有头的人 O 打出的够级牌、不在四人乱缠；不是 O 也不是 O 的对头；在打；不是无头的人；这一轮没过过牌。
 */
export function mayBurn(state: View, seat: number): boolean {
  const round = state.round;
  const top = round?.top;
  if (!round || !top || !top.burnable || state.chaos) return false;
  if (seat === top.seat || seat === oppOf(top.seat)) return false;
  if (!isActive(state, seat) || state.headless[seat]) return false;
  return !round.passed.includes(seat);
}

/** 4.6 (1)：现在能不能烧（身份 + 手牌能一口气出完）。 */
export function canBurn(state: View, seat: number): boolean {
  return mayBurn(state, seat) && hasBurnCandidate(state.players[seat]!.hand, state.round!.top!.set);
}

/** 这位玩家现在的烧牌候选 S₁（不能烧是空数组）。 */
export function burnOptions(state: View, seat: number): Card[][] {
  return mayBurn(state, seat) ? burnCandidates(state.players[seat]!.hand, state.round!.top!.set) : [];
}

/** 现在能烧牌的座位（服务器给人机安排烧牌用；不能发给浏览器）。 */
export function burnEligibleSeats(state: View): number[] {
  return SEATS.filter((seat) => canBurn(state, seat));
}

/** 能不能让牌（4.7）：轮到 X，桌面牌是 X 的对头出的非够级牌，开房选项打开，不在四人乱缠，这次不是让牌后轮回来的。 */
export function canRang(state: Pick<GoujiState, "config" | "players" | "revolutionary" | "headless" | "chaos" | "round" | "turn" | "stage">, seat: number): boolean {
  const round = state.round;
  const top = round?.top;
  if (state.stage !== "playing" || !state.config.rang || state.chaos || !round || !top || state.turn !== seat) return false;
  if (top.seat !== oppOf(seat) || top.set.gouji) return false;
  if (round.rang?.seat === seat) return false;
  if (round.pending) return false;
  return canRespond(state, seat);
}
