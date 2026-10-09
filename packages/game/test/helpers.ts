/** 测试用的小工具：按点数从手里取牌、按座位发操作、走到烧牌窗口满 2 秒。 */
import {
  applyCommand,
  parseRank,
  rankOf,
  tickBurnWindow,
  timeoutTurn,
  type Card,
  type GameCommand,
  type GameState,
} from "../src/index.js";

export const pid = (seat: number) => `p${seat + 1}`;

/** 从 seat 的手里按「A A 小」这样的写法取出具体的牌（找不到就抛错）。 */
export function pick(state: GameState, seat: number, text: string): Card[] {
  const hand = [...state.players[seat]!.hand];
  const cards: Card[] = [];
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(.+?)x(\d+)$/i.exec(token);
    const rank = parseRank(match ? match[1]! : token);
    const times = match ? Number(match[2]) : 1;
    for (let t = 0; t < times; t += 1) {
      const index = hand.findIndex((card) => rankOf(card) === rank);
      if (index < 0) throw new Error(`座位 ${seat} 手里没有 ${token}（手牌 ${state.players[seat]!.hand.length} 张）`);
      cards.push(hand.splice(index, 1)[0]!);
    }
  }
  return cards;
}

export const act = (state: GameState, seat: number, command: GameCommand): GameState => applyCommand(state, pid(seat), command);
export const play = (state: GameState, seat: number, text: string): GameState => act(state, seat, { type: "PLAY", cards: pick(state, seat, text) });
export const pass = (state: GameState, seat: number): GameState => act(state, seat, { type: "PASS" });
export const burn = (state: GameState, seat: number, text: string): GameState => act(state, seat, { type: "BURN", cards: pick(state, seat, text) });
export const tick = (state: GameState): GameState => tickBurnWindow(state);
/** 有等着的烧牌窗口就让它满 2 秒。 */
export const settle = (state: GameState): GameState => (state.round?.top && state.round.top.burnable && !state.round.top.ready ? tickBurnWindow(state) : state);
/** 出牌后如果是可能被烧的够级牌，就让窗口满 2 秒（不烧）。 */
export const playSettled = (state: GameState, seat: number, text: string): GameState => settle(play(state, seat, text));
export const passSettled = (state: GameState, seat: number): GameState => settle(pass(state, seat));

/** 一路用超时和 TICK 往下走，直到 until 成立（最多 steps 步）。 */
export function runUntil(state: GameState, until: (state: GameState) => boolean, steps = 5000): GameState {
  let current = state;
  for (let k = 0; k < steps && !until(current); k += 1) {
    if (current.round?.top && current.round.top.burnable && !current.round.top.ready) current = tickBurnWindow(current);
    else current = timeoutTurn(current);
  }
  if (!until(current)) throw new Error("走不到想要的局面");
  return current;
}

export const total = (state: GameState): number =>
  state.players.reduce((sum, player) => sum + player.hand.length, 0) + state.revolutionHand.length + state.discard.length;
