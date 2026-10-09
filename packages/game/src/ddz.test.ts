import { describe, expect, it } from "vitest";
import { botCommand } from "./bot.js";
import { DECK_SIZE, parseCards, rankOf, type Card } from "./cards.js";
import { classify } from "./combos.js";
import { applyDdz, createDdz, legalCommands, multiplierOf, pendingSeats, redactDdz, stackDeal } from "./ddz.js";
import { createRng } from "./rng.js";
import type { DdzCommand, DdzOptions, DdzState } from "./types.js";

const PLAYERS = [
  { id: "a", name: "甲" },
  { id: "b", name: "乙" },
  { id: "c", name: "丙" },
];

function newGame(options: Partial<DdzOptions> = {}, seed = 7): DdzState {
  return createDdz(PLAYERS, seed, options);
}

const idOf = (state: DdzState, seat: number) => state.players[seat]!.id;
const run = (state: DdzState, seat: number, command: DdzCommand) => applyDdz(state, idOf(state, seat), command).state;

/** 跳过明牌开始（都不明牌）。 */
function skipShowStart(state: DdzState): DdzState {
  let next = state;
  for (const seat of [0, 1, 2]) if (next.stage === "showStart") next = run(next, seat, { type: "SHOW_START", show: false });
  return next;
}

/** 按 0、1、2 号座位各给一组牌，其余的牌按顺序补满，最后 3 张是底牌（可以指定）。 */
function deckOf(hands: [string, string, string], bottom = ""): Card[] {
  const fixed = hands.map((text) => (text ? parseCardsFrom(text) : []));
  const bottomCards = bottom ? parseCardsFrom(bottom) : [];
  const used = new Set([...fixed.flat(), ...bottomCards]);
  const rest = Array.from({ length: DECK_SIZE }, (_, card) => card).filter((card) => !used.has(card));
  const deck: Card[] = [];
  for (const seat of [0, 1, 2]) {
    const cards = [...fixed[seat]!];
    while (cards.length < 17) cards.push(rest.shift()!);
    deck.push(...cards);
  }
  const tail = [...bottomCards];
  while (tail.length < 3) tail.push(rest.shift()!);
  deck.push(...tail);
  return deck;
}

/** parseCards 每次都从第一个花色开始；这里跨多组牌时避开已经用过的。 */
let usedInDeck = new Set<Card>();
function parseCardsFrom(text: string): Card[] {
  const result: Card[] = [];
  for (const card of parseCards(text)) {
    let candidate = card;
    while (usedInDeck.has(candidate)) candidate += 1;
    if (rankOf(candidate) !== rankOf(card)) throw new Error(`${text} 里的牌超过了 4 张`);
    usedInDeck.add(candidate);
    result.push(candidate);
  }
  return result;
}
function deck(hands: [string, string, string], bottom = ""): Card[] {
  usedInDeck = new Set();
  return deckOf(hands, bottom);
}

/** 直接把局面改成出牌阶段：landlord 是地主，各家手牌给定（测试计分和出牌流程用，不管总牌数）。 */
function playingWith(hands: [string, string, string], landlord: number, patch: Partial<DdzState> = {}): DdzState {
  usedInDeck = new Set();
  let state = skipShowStart(newGame({ doubling: false, mingpai: false }));
  state = structuredClone(state);
  state.players.forEach((player, seat) => {
    player.hand = parseCardsFrom(hands[seat]!).sort((a, b) => rankOf(b) - rankOf(a));
    player.handCount = player.hand.length;
  });
  Object.assign(state, { stage: "playing", landlord, turn: landlord, lastPlay: null, passes: 0, caller: landlord, ...patch });
  return state;
}

const play = (state: DdzState, seat: number, text: string) => {
  const wanted = parseCards(text).map(rankOf);
  const hand = [...state.players[seat]!.hand];
  const cards = wanted.map((rank) => {
    const index = hand.findIndex((card) => rankOf(card) === rank);
    if (index < 0) throw new Error(`座位 ${seat} 手里没有 ${text}`);
    return hand.splice(index, 1)[0]!;
  });
  return run(state, seat, { type: "PLAY", cards });
};
const pass = (state: DdzState, seat: number) => run(state, seat, { type: "PASS" });

describe("T1 发牌", () => {
  it("每人 17 张、底牌 3 张，54 张不重复；地主 20 张，底牌公开", () => {
    let state = newGame();
    expect(state.stage).toBe("showStart");
    expect(state.players.every((player) => player.hand.length === 0)).toBe(true);
    state = skipShowStart(state);
    expect(state.stage).toBe("bidding");
    expect(state.players.map((player) => player.hand.length)).toEqual([17, 17, 17]);
    expect(state.bottom).toHaveLength(3);
    const all = [...state.players.flatMap((player) => player.hand), ...state.bottom];
    expect(new Set(all).size).toBe(54);
    // 确定地主前谁都看不到底牌
    expect(redactDdz(state, "a").bottom).toEqual([-1, -1, -1]);
    const first = state.turn;
    state = run(state, first, { type: "BID", call: true });
    for (let k = 0; k < 2 && state.stage === "robbing"; k += 1) state = run(state, state.turn, { type: "ROB", rob: false });
    expect(state.landlord).toBe(first);
    expect(state.players[first]!.hand).toHaveLength(20);
    for (const viewer of ["a", "b", "c", ""]) expect(redactDdz(state, viewer).bottom).toEqual(state.bottom);
  });
});

describe("叫地主、抢地主", () => {
  const atBidding = (first: number) => stackDeal(newGame({ doubling: false, mingpai: false }), deck(["", "", ""]), first);

  it("T2 叫地主后连续抢：A 叫 → B 抢 → C 抢 → A 抢", () => {
    let state = atBidding(0);
    state = run(state, 0, { type: "BID", call: true });
    expect(state.stage).toBe("robbing");
    expect(state.turn).toBe(1);
    state = run(state, 1, { type: "ROB", rob: true });
    state = run(state, 2, { type: "ROB", rob: true });
    expect(state.turn).toBe(0);
    state = run(state, 0, { type: "ROB", rob: true });
    expect(state.landlord).toBe(0);
    expect(state.robs).toBe(3);
    expect(2 ** state.robs).toBe(8);
  });

  it("规则书 4.2 例：A 叫，B 抢，C 不抢，A 抢 → 地主 A，×4", () => {
    let state = atBidding(0);
    state = run(state, 0, { type: "BID", call: true });
    state = run(state, 1, { type: "ROB", rob: true });
    state = run(state, 2, { type: "ROB", rob: false });
    state = run(state, 0, { type: "ROB", rob: true });
    expect(state.landlord).toBe(0);
    expect(multiplierOf(state).total).toBe(4);
  });

  it("叫地主的人最后不抢：地主是最后抢的人", () => {
    let state = atBidding(0);
    state = run(state, 0, { type: "BID", call: true });
    state = run(state, 1, { type: "ROB", rob: true });
    state = run(state, 2, { type: "ROB", rob: false });
    state = run(state, 0, { type: "ROB", rob: false });
    expect(state.landlord).toBe(1);
    expect(state.robs).toBe(1);
  });

  it("T3 说过不叫的人不能抢", () => {
    let state = atBidding(0);
    state = run(state, 0, { type: "BID", call: false });
    state = run(state, 1, { type: "BID", call: true });
    expect(state.stage).toBe("robbing");
    expect(state.turn).toBe(2);
    expect(() => run(state, 0, { type: "ROB", rob: true })).toThrow();
    state = run(state, 2, { type: "ROB", rob: false });
    expect(state.landlord).toBe(1);
    expect(state.robs).toBe(0);
    expect(state.players[0]!.rob).toBeNull();
  });

  it("T4 没人抢时叫地主的人不再表态", () => {
    let state = atBidding(1);
    state = run(state, 1, { type: "BID", call: true });
    state = run(state, 2, { type: "ROB", rob: false });
    state = run(state, 0, { type: "ROB", rob: false });
    expect(state.landlord).toBe(1);
    expect(state.robs).toBe(0);
    expect(state.stage).toBe("playing");
    expect(state.players[1]!.rob).toBeNull();
  });

  it("最后一个叫的人叫地主：前两人都不叫，直接当地主", () => {
    let state = atBidding(0);
    state = run(state, 0, { type: "BID", call: false });
    state = run(state, 1, { type: "BID", call: false });
    state = run(state, 2, { type: "BID", call: true });
    expect(state.landlord).toBe(2);
    expect(state.stage).toBe("playing");
  });

  it("每人叫抢加起来最多表态 2 次", () => {
    let state = atBidding(0);
    const said = [0, 0, 0];
    state = run(state, 0, { type: "BID", call: true });
    said[0]! += 1;
    while (state.stage === "robbing") {
      said[state.turn]! += 1;
      state = run(state, state.turn, { type: "ROB", rob: true });
    }
    expect(Math.max(...said)).toBeLessThanOrEqual(2);
  });

  it("不轮到你不能叫", () => {
    const state = atBidding(0);
    expect(() => run(state, 1, { type: "BID", call: true })).toThrow("还没轮到你");
  });
});

describe("出牌流程", () => {
  it("T7 一轮的结束和下一轮（中间先过后来又出合法）", () => {
    let state = playingWith(["5 7 7 A", "9 3 3 4", "K K 6 8"], 0);
    state = play(state, 0, "5");
    state = play(state, 1, "9");
    state = pass(state, 2);
    state = pass(state, 0);
    expect(state.turn).toBe(1);
    expect(state.lastPlay).toBeNull();
    expect(() => pass(state, 1)).toThrow("引牌不能不出");
    state = play(state, 1, "3 3");
    state = pass(state, 2);
    state = play(state, 0, "7 7");
    state = pass(state, 1);
    state = play(state, 2, "K K");
    state = pass(state, 0);
    state = pass(state, 1);
    expect(state.turn).toBe(2);
    expect(state.lastPlay).toBeNull();
  });

  it("压不过、牌型不对、牌不在手里都会被拒绝", () => {
    let state = playingWith(["5 6 7 8 9 3", "4 4 J", "Q Q K"], 0);
    expect(() => play(state, 0, "5 6")).toThrow("不是合法的牌型");
    state = play(state, 0, "5 6 7 8 9");
    expect(() => play(state, 1, "4 4")).toThrow("压不过");
    expect(() => run(state, 1, { type: "PLAY", cards: [53] })).toThrow("不在你手里");
  });

  it("T8 出完立即结束", () => {
    let state = playingWith(["2 3", "K 5", "4 6"], 0);
    state = play(state, 0, "3");
    state = play(state, 1, "K");
    state = pass(state, 2);
    state = play(state, 0, "2");
    expect(state.players[0]!.hand).toHaveLength(0);
    expect(state.stage).toBe("handEnd");
    expect(state.summary?.landlordWon).toBe(true);
    expect(() => play(state, 1, "5")).toThrow();
  });
});

describe("计分", () => {
  it("T9 抢 + 加倍 + 炸弹（例 1）：M=16，A +96，B −64，C −32", () => {
    let state = playingWith(["小 大 3", "4 5", "6 6 6 6 7"], 0, { robs: 2 });
    state.players[0]!.double = 2;
    state.players[1]!.double = 2;
    state.players[2]!.double = 1;
    state = play(state, 0, "3");
    state = play(state, 1, "4");
    state = play(state, 2, "6 6 6 6");
    state = play(state, 0, "小 大");
    const summary = state.summary!;
    expect(summary.multiplier.total).toBe(16);
    expect(summary.multiplier.spring).toBeNull();
    expect(summary.deltas).toEqual([96, -64, -32]);
  });

  it("T10 反春（例 2）：M=2，C +2，A +2，B −4", () => {
    let state = playingWith(["9", "3 4 5", "2 8"], 1);
    state = play(state, 1, "3");
    state = play(state, 2, "2");
    state = pass(state, 0);
    state = pass(state, 1);
    state = play(state, 2, "8");
    const summary = state.summary!;
    expect(summary.landlordWon).toBe(false);
    expect(summary.multiplier.spring).toBe("antiSpring");
    expect(summary.multiplier.total).toBe(2);
    expect(summary.deltas).toEqual([2, -4, 2]);
  });

  it("T11 明牌开始 + 春天 + 炸弹（例 3）：M=20，C +40", () => {
    let state = playingWith(["4", "5", "K K K K 3"], 2, { showStarts: [2] });
    state = play(state, 2, "K K K K");
    state = pass(state, 0);
    state = pass(state, 1);
    state = play(state, 2, "3");
    const summary = state.summary!;
    expect(summary.multiplier).toMatchObject({ show: 5, bombs: 1, spring: "spring", total: 20 });
    expect(summary.deltas).toEqual([-20, -20, 40]);
  });

  it("T12 多人明牌只取最大：A 明牌开始，地主 B 再明牌 → 5", () => {
    let state = newGame({ mingpai: true, doubling: true });
    state = run(state, 0, { type: "SHOW_START", show: true });
    state = run(state, 1, { type: "SHOW_START", show: false });
    state = run(state, 2, { type: "SHOW_START", show: false });
    expect(state.turn).toBe(0); // 明牌开始的人第一个叫
    state = run(state, 0, { type: "BID", call: false });
    state = run(state, 1, { type: "BID", call: true });
    state = run(state, 2, { type: "ROB", rob: false });
    expect(state.landlord).toBe(1);
    expect(state.stage).toBe("doubling");
    for (const seat of [0, 1, 2]) state = run(state, seat, { type: "DOUBLE", factor: 1 });
    expect(state.stage).toBe("landlordShow");
    state = run(state, 1, { type: "LANDLORD_SHOW", show: true });
    expect(state.stage).toBe("playing");
    expect(multiplierOf(state).show).toBe(5);
  });

  it("每盘 3 人积分加起来是 0", () => {
    let state = playingWith(["3", "4 5", "6 7"], 0, { robs: 1, bombs: 2 });
    state.players[1]!.double = 4;
    state = play(state, 0, "3");
    expect(state.summary!.deltas.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("T13 3 人都不叫", () => {
  it("没人明牌开始：重新洗牌发牌，盘数不加", () => {
    let state = stackDeal(newGame({ mingpai: false }), deck(["", "", ""]), 0);
    const before = state.players.map((player) => [...player.hand]);
    for (const seat of [0, 1, 2]) state = run(state, seat, { type: "BID", call: false });
    expect(state.handNo).toBe(1);
    expect(state.redeals).toBe(1);
    expect(state.stage).toBe("bidding");
    expect(state.players.map((player) => player.hand)).not.toEqual(before);
    expect(state.players.every((player) => player.bid === null)).toBe(true);
  });

  it("B 明牌开始、都不叫：地主 B，抢 0 次，明牌 ×5", () => {
    let state = newGame({ mingpai: true });
    state = run(state, 0, { type: "SHOW_START", show: false });
    state = run(state, 1, { type: "SHOW_START", show: true });
    state = run(state, 2, { type: "SHOW_START", show: false });
    expect(state.turn).toBe(1);
    for (const seat of [1, 2, 0]) state = run(state, seat, { type: "BID", call: false });
    expect(state.landlord).toBe(1);
    expect(state.robs).toBe(0);
    expect(multiplierOf(state).show).toBe(5);
    expect(state.handNo).toBe(1);
  });
});

describe("T14 超时默认动作", () => {
  const timeout = (state: DdzState) => applyDdz(state, "", { type: "TIMEOUT" }).state;

  it("首攻超时出最小的单张，跟牌超时不出", () => {
    let state = playingWith(["9 4 K", "5 J", "6 Q"], 0);
    state = timeout(state);
    expect(state.lastPlay?.combo).toMatchObject({ type: "single", main: 4 });
    state = timeout(state);
    expect(state.table[1]).toEqual({ kind: "pass" });
  });

  it("叫地主超时 → 不叫；加倍超时 → 不加倍；连续 2 次超时进入托管", () => {
    let state = stackDeal(newGame({ mingpai: false, doubling: true }), deck(["", "", ""]), 0);
    state = timeout(state);
    expect(state.players[0]!.bid).toBe("noCall");
    state = run(state, 1, { type: "BID", call: true });
    state = run(state, 2, { type: "ROB", rob: false });
    expect(state.stage).toBe("doubling");
    state = run(state, 1, { type: "DOUBLE", factor: 2 });
    state = timeout(state);
    expect(state.players.map((player) => player.double)).toEqual([1, 2, 1]);
    expect(state.players[0]!.auto).toBe(true); // 叫地主、加倍连续超时两次
    expect(state.players[2]!.auto).toBe(false);
  });

  it("托管时由机器人代打（出合法的牌）；点取消托管恢复", () => {
    let state = playingWith(["9 4 K", "5 J", "6 Q"], 0);
    state.players[0]!.auto = true;
    const command = botCommand(redactDdz(state, idOf(state, 0)), 0);
    expect(command.type).toBe("PLAY");
    state = run(state, 0, command);
    expect(state.lastPlay?.seat).toBe(0);
    state = run(state, 0, { type: "AUTO", on: false });
    expect(state.players[0]!.auto).toBe(false);
  });
});

describe("隐藏信息", () => {
  it("别人的手牌只给张数；明牌的人公开；加倍 3 人选完前保密", () => {
    let state = newGame({ mingpai: true, doubling: true }, 11);
    state = run(state, 2, { type: "SHOW_START", show: true });
    state = run(state, 0, { type: "SHOW_START", show: false });
    state = run(state, 1, { type: "SHOW_START", show: false });
    const view = redactDdz(state, "a");
    const seatA = state.players.findIndex((player) => player.id === "a");
    view.players.forEach((player, seat) => {
      if (seat === seatA) expect(player.hand).toHaveLength(17);
      else if (seat === 2) expect(player.hand).toEqual(state.players[2]!.hand);
      else expect(player.hand).toEqual([]);
      expect(player.handCount).toBe(17);
    });
    expect(view.rng).toBeUndefined();
    expect(view.seed).toBeUndefined();
    expect(view.log).toBeUndefined();
    // 观战（公开信息）
    const publicView = redactDdz(state, "");
    expect(publicView.players.filter((player) => player.hand.length > 0)).toHaveLength(1);

    state = run(state, 2, { type: "BID", call: true });
    while (state.stage === "robbing") state = run(state, state.turn, { type: "ROB", rob: false });
    expect(state.stage).toBe("doubling");
    state = run(state, 0, { type: "DOUBLE", factor: 2 });
    const mid = redactDdz(state, idOf(state, 1));
    expect(mid.players[0]!.double).toBeNull();
    expect(mid.players[0]!.doubleChosen).toBe(true);
    expect(redactDdz(state, idOf(state, 0)).players[0]!.double).toBe(2);
    state = run(state, 1, { type: "DOUBLE", factor: 1 });
    state = run(state, 2, { type: "DOUBLE", factor: 1 });
    expect(redactDdz(state, idOf(state, 1)).players[0]!.double).toBe(2);
  });

  it("超级加倍只在开房选项打开时能选", () => {
    let state = stackDeal(newGame({ mingpai: false, doubling: true, superDouble: false }), deck(["", "", ""]), 0);
    state = run(state, 0, { type: "BID", call: true });
    state = run(state, 1, { type: "ROB", rob: false });
    state = run(state, 2, { type: "ROB", rob: false });
    expect(() => run(state, 0, { type: "DOUBLE", factor: 4 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 随机对局：每一步检查牌数守恒、积分和为 0、隐藏信息不漏

function checkInvariants(state: DdzState, checkViews = true): string | null {
  const inHands = state.players.flatMap((player) => player.hand);
  if (state.stage === "showStart") return inHands.length === 0 ? null : "明牌开始阶段不该有手牌";
  const all = [...inHands, ...state.played, ...(state.landlord === null ? state.bottom : [])];
  if (all.length !== 54 || new Set(all).size !== 54) return `牌数不对：${all.length}`;
  const total = state.players.reduce((sum, player) => sum + player.score, 0);
  if (total !== 0) return `积分和不是 0：${total}`;
  if (state.players.some((player) => player.handCount !== player.hand.length)) return "handCount 不对";
  if (!checkViews) return null;
  for (const viewer of state.players) {
    const view = redactDdz(state, viewer.id);
    for (const other of view.players) {
      if (other.id === viewer.id) continue;
      const original = state.players.find((player) => player.id === other.id)!;
      if (!original.shown && state.stage !== "handEnd" && state.phase !== "finished" && other.hand.length > 0) return "别人的手牌漏了";
    }
    if (state.landlord === null && view.bottom.some((card) => card >= 0)) return "底牌漏了";
  }
  return null;
}

describe("随机对局", () => {
  it("300 局随机合法操作：不变量都成立，对局能打完", () => {
    let finished = 0;
    for (let game = 0; game < 300; game += 1) {
      const rng = createRng(1000 + game);
      const options: Partial<DdzOptions> = { hands: 3, mingpai: rng.next() < 0.7, doubling: rng.next() < 0.7, superDouble: rng.next() < 0.5 };
      let state = createDdz(PLAYERS, 5000 + game, options);
      let steps = 0;
      while (state.phase !== "finished" && steps < 3000) {
        steps += 1;
        if (rng.next() < 0.03) {
          state = applyDdz(state, "", { type: "TIMEOUT" }).state;
        } else {
          const seat = rng.pick(pendingSeats(state));
          const commands = legalCommands(state, idOf(state, seat));
          expect(commands.length).toBeGreaterThan(0);
          // 偏向出牌和叫地主，免得一直不叫重新发牌
          const preferred = commands.filter((command) => command.type === "PLAY" || (command.type === "BID" && command.call));
          const pool = preferred.length > 0 && rng.next() < 0.7 ? preferred : commands;
          state = applyDdz(state, idOf(state, seat), rng.pick(pool)).state;
        }
        const problem = checkInvariants(state, steps % 5 === 0);
        if (problem) throw new Error(`第 ${game} 局第 ${steps} 步：${problem}`);
      }
      if (state.phase === "finished") {
        finished += 1;
        expect(state.handNo).toBe(3);
        expect(state.finalResult!.winners.length).toBeGreaterThan(0);
      }
    }
    expect(finished).toBe(300);
  }, 120_000);

  it("100 局机器人对打：每一步都合法，能打完", () => {
    let landlordWins = 0;
    let hands = 0;
    for (let game = 0; game < 100; game += 1) {
      let state = createDdz(PLAYERS, 9000 + game, { hands: 3, superDouble: true });
      let steps = 0;
      while (state.phase !== "finished" && steps < 5000) {
        steps += 1;
        const seat = pendingSeats(state)[0]!;
        const before = state.handNo;
        const view = redactDdz(state, idOf(state, seat));
        const command = botCommand(view, seat);
        state = applyDdz(state, idOf(state, seat), command).state;
        if (state.summary && state.stage === "handEnd" && state.handNo === before && state.ready.length === 0) {
          hands += 1;
          if (state.summary.landlordWon) landlordWins += 1;
        }
      }
      expect(state.phase).toBe("finished");
    }
    // 机器人看自己的视角就能打（不偷看别人的牌）；地主胜率在一个说得过去的范围里
    expect(hands).toBeGreaterThan(250);
    expect(landlordWins / hands).toBeGreaterThan(0.2);
    expect(landlordWins / hands).toBeLessThan(0.9);
  }, 60_000);

  it("机器人出的牌都是合法牌型", () => {
    for (let game = 0; game < 30; game += 1) {
      let state = createDdz(PLAYERS, 300 + game, { hands: 3 });
      while (state.phase !== "finished") {
        const seat = pendingSeats(state)[0]!;
        const command = botCommand(state, seat);
        if (command.type === "PLAY") expect(classify(command.cards).length).toBeGreaterThan(0);
        state = applyDdz(state, idOf(state, seat), command).state;
      }
    }
  });
});
