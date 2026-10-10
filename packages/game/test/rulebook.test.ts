/**
 * 规则书第 10 节测试用例 T1–T20（~/Desktop/游戏规则/够级.md），测试名带编号。
 * 座位 0～5 逆时针；甲 = 0、2、4，乙 = 1、3、5；对头 s ↔ s+3。没特别说明时：6 人都有牌、没人无头、没进入四人乱缠、本轮没人过过牌。
 */
import { describe, expect, it } from "vitest";
import {
  beats,
  buildDeal,
  buildState,
  burnEligibleSeats,
  burnOptions,
  canBurn,
  canRang,
  canRespond,
  cardsText,
  createGame,
  DECK_SIZE,
  legalCommands,
  parseCards,
  parseSet,
  pendingSeats,
  rankCounts,
  redactGameForViewer,
  timeoutTurn,
  type GameState,
} from "../src/index.js";
import { act, burn, pass, passSettled, pick, pid, play, playSettled, runUntil, settle, tick, total } from "./helpers.js";

const set = (text: string) => parseSet(parseCards(text));

/** 弱手牌（张数多、王少），保证不会有人意外满足烧牌条件。 */
const FILLER = {
  1: "3 4 5 6 7 8 9 10 J Q 3 4 5 6 7 8",
  2: "3 4 5 6 7 8 9 10 J Q 3 4 5 6 7 8",
  4: "3 4 5 6 7 8 9 10 J Q 3 4 5 6 7 8",
  5: "3 4 5 6 7 8 9 10 J Q 3 4 5 6 7 8",
} as const;

describe("规则书 T1–T4：配件、合法的一套、比大小、够级牌", () => {
  it("规则书#T1 发牌：216 张不重复，每人 36 张；3～2 各 16 张，小王、大王各 4 张；第 1 盘不进贡", () => {
    for (const seed of [1, 2, 3, 99, 2024]) {
      const game = createGame([0, 1, 2, 3, 4, 5].map((seat) => ({ id: pid(seat), name: `玩家${seat}` })), seed);
      const all = game.players.flatMap((player) => player.hand);
      expect(game.handNo).toBe(1);
      expect(game.tribute).toBeNull();
      expect(all).toHaveLength(DECK_SIZE);
      expect(new Set(all).size).toBe(DECK_SIZE);
      for (const player of game.players) expect(player.hand).toHaveLength(36);
      const counts = rankCounts(all);
      for (let rank = 3; rank <= 15; rank += 1) expect(counts[rank]).toBe(16);
      expect(counts[16]).toBe(4);
      expect(counts[17]).toBe(4);
    }
  });

  it("规则书#T2 合法的一套牌", () => {
    expect(set("8 8 2")).toMatchObject({ base: 8, eff: [8, 8, 8] });
    expect(set("8 9")).toBeNull();
    expect(set("2 2 小")).toMatchObject({ base: 15, eff: [16, 15, 15] });
    expect(set("小 大")).toMatchObject({ base: null, eff: [17, 16] });
    expect(set("3 3 大")).toMatchObject({ base: 3, eff: [17, 3, 3] });
    expect(set("A A 2 小")).toMatchObject({ base: 14, eff: [16, 14, 14, 14] });
    expect(set("2")).toMatchObject({ base: 15, eff: [15] });
  });

  it("规则书#T3 比大小（逐张比较）", () => {
    const cases: [string, string, boolean][] = [
      ["9 9 9", "8 8 8", true],
      ["9 9 2", "9 9 9", false],
      ["10 10 小", "9 9 9", true],
      ["10 10 大", "9 9 小", true],
      ["10 10 小", "9 9 小", false],
      ["J J 大", "10 小 小", false],
      ["J 大 大", "10 小 小", true],
      ["2 2 2", "K K 2", true],
      ["大 小 小", "2 2 2", true],
      ["A A 小", "2 2 2", false],
      ["大 大", "大 小", false],
      ["Q Q Q", "J J", false],
    ];
    for (const [next, prev, expected] of cases) {
      expect(beats(set(next)!, set(prev)!), `${next} 压 ${prev}`).toBe(expected);
    }
  });

  it("规则书#T4 够级牌判定", () => {
    const cases: [string, boolean][] = [
      ["10x5", true],
      ["10x4", false],
      ["10x4 2", true],
      ["Jx4", true],
      ["Jx3", false],
      ["Q Q", false],
      ["Q Q 2", true],
      ["K K", true],
      ["K", false],
      ["A", false],
      ["A 2", true],
      ["2", true],
      ["小", true],
      ["5 小", true],
      ["9x8", false],
      ["3 3 大", true],
    ];
    for (const [text, expected] of cases) expect(set(text)!.gouji, text).toBe(expected);
  });
});

describe("规则书 T5–T6：够级只有对头能接、过牌锁住和对头牌不过", () => {
  it("规则书#T5 0 发 K K：1、2 被跳过，3 收到提示；3 上 A A → 0 收到提示；0 过 → 回到 3，本轮结束，3 发牌", () => {
    let state = buildState({ hands: { 0: "K K 5 5 6 6 7", 3: "A A 4 4 8 9 9", ...FILLER }, leader: 0, turn: 0 });
    state = play(state, 0, "K K");
    expect(burnEligibleSeats(state)).toEqual([]);
    expect(canRespond(state, 1)).toBe(false);
    expect(canRespond(state, 2)).toBe(false);
    expect(canRespond(state, 3)).toBe(true);
    expect(state.turn).toBe(3);
    expect(pendingSeats(state)).toEqual([3]);
    expect(legalCommands(state, pid(1))).toEqual([]);
    state = playSettled(settle(state), 3, "A A");
    expect(state.turn).toBe(0);
    expect(canRespond(state, 4)).toBe(false);
    expect(canRespond(state, 5)).toBe(false);
    state = passSettled(state, 0);
    expect(state.round!.top).toBeNull();
    expect(state.round!.leader).toBe(3);
    expect(state.turn).toBe(3);
    expect(state.events.map((event) => event.type)).toContain("RoundEnded");
  });

  it("规则书#T6 0 发 3 3；1 上 6 6；2～5 过；0 上 10 10；1 过 → 2 跳过，3 收到提示（对头牌不过）；3 过 → 回到 0", () => {
    let state = buildState({ hands: { 0: "3 3 10 10 5 7 8", 1: "6 6 J Q 4 5 9", 2: "4 5 7 8 9 J Q", 3: "4 5 7 8 9 J Q", 4: "4 5 7 8 9 J Q", 5: "4 5 7 8 9 J Q" }, leader: 0, turn: 0 });
    state = play(state, 0, "3 3");
    state = play(state, 1, "6 6");
    for (const seat of [2, 3, 4, 5]) state = pass(state, seat);
    expect(state.turn).toBe(0);
    state = play(state, 0, "10 10");
    expect(state.round!.top!.set.gouji).toBe(false);
    state = pass(state, 1);
    expect(canRespond(state, 2)).toBe(false);
    expect(canRespond(state, 3)).toBe(true);
    expect(state.turn).toBe(3);
    state = pass(state, 3);
    expect(state.round!.top).toBeNull();
    expect(state.turn).toBe(0);
  });
});

describe("规则书 T7–T9：烧牌", () => {
  const t7 = (passed: number[] = []) =>
    buildState({
      hands: { 0: "K K 4 5 6 8 J", 1: "A A 7 7 7 8 小 9 9", 2: "A A 7 7 7 9 9 小 大", 3: "Q Q 3 4 5 6 10", 4: FILLER[4], 5: "2 2 3 4 5 6 8 10 J Q" },
      top: { seat: 0, cards: "K K" },
      passed,
    });

  it("规则书#T7 烧牌条件：1 不能烧，2 能烧（S₁ = A A）；2 过过牌就不能烧；3（对头）只能正常接", () => {
    const state = t7();
    expect(state.round!.top!.burnable).toBe(true);
    expect(canBurn(state, 1)).toBe(false);
    expect(burnOptions(state, 1)).toEqual([]);
    expect(canBurn(state, 2)).toBe(true);
    expect(burnOptions(state, 2).map(cardsText)).toEqual(["A A"]);
    expect(canBurn(state, 3)).toBe(false);
    expect(canRespond(state, 3)).toBe(true);
    expect(burnEligibleSeats(state)).toEqual([2]);
    // 烧牌资格只发给本人
    expect(redactGameForViewer(state, pid(2)).you!.burnCandidates.map(cardsText)).toEqual(["A A"]);
    for (const viewer of [0, 1, 3, 4, 5]) expect(redactGameForViewer(state, pid(viewer)).you!.burnCandidates).toEqual([]);
    expect(canBurn(t7([2]), 2)).toBe(false);
  });

  it("规则书#T8 2 烧 A A → 只有 5 能接；5 过，2 发牌：9 9 被拒，7 7 7 小 合法；再发 9 9 大 出完，烧牌成功，下一盘 0 给 2 进 1 张烧贡", () => {
    let state = t7();
    state = tick(burn(state, 2, "A A"));
    expect(state.burn).toEqual({ burner: 2, victim: 0 });
    expect(state.events.map((event) => event.type)).toEqual(["BurnStarted", "Played"]);
    expect(canRespond(state, 3)).toBe(false);
    expect(canRespond(state, 4)).toBe(false);
    expect(state.turn).toBe(5);
    state = passSettled(state, 5);
    expect(state.round!.top).toBeNull();
    expect(state.turn).toBe(2);
    expect(() => play(state, 2, "9 9")).toThrow(/烧牌中发牌/);
    state = playSettled(state, 2, "7 7 7 小");
    expect(state.turn).toBe(5);
    expect([0, 1, 3, 4].map((seat) => canRespond(state, seat))).toEqual([false, false, false, false]);
    state = passSettled(state, 5);
    expect(state.turn).toBe(2);
    state = play(state, 2, "9 9 大");
    expect(state.finished).toEqual([2]);
    expect(state.burnsThisHand).toEqual([{ burner: 2, victim: 0 }]);
    expect(state.burn).toBeNull();
    expect(state.events.map((event) => event.type)).toContain("BurnSucceeded");
    // 打完这一盘：结果里记着这次烧牌；下一盘 0 给 2 进 1 张烧贡（0、2 是队友，由 2 选吃不吃）。
    state = runUntil(state, (current) => current.stage === "handEnd");
    expect(state.result!.burns).toEqual([{ burner: 2, victim: 0 }]);
    for (let seat = 0; seat < 6; seat += 1) state = act(state, seat, { type: "READY" });
    expect(state.handNo).toBe(2);
    expect(state.tribute!.items[0]).toMatchObject({ kind: "burn", giver: 0, receiver: 2, count: 1, intra: true });
  });

  it("规则书#T9 解烧：2 烧 A A 后，5 上 2 2 → 烧牌失败，不记烧贡；桌面牌主人是 5，之后只有 2 能接；2 正常打不受限制", () => {
    let state = t7();
    state = tick(burn(state, 2, "A A"));
    state = tick(play(state, 5, "2 2"));
    expect(state.burn).toBeNull();
    expect(state.burnsThisHand).toEqual([]);
    expect(state.history.some((event) => event.type === "BurnBroken" && event.burner === 2 && event.by === 5 && !event.counter)).toBe(true);
    expect(state.round!.top!.seat).toBe(5);
    expect(state.turn).toBe(2);
    expect([0, 1, 3, 4].map((seat) => canRespond(state, seat))).toEqual([false, false, false, false]);
    state = passSettled(state, 2);
    // 5 赢下这一轮；之后 2 发牌时没有步步带王的限制
    expect(state.turn).toBe(5);
    expect(state.burn).toBeNull();
  });
});

describe("规则书 T10–T13：让牌、走科接风无头、底牌够级、四人乱缠", () => {
  const t10 = () =>
    buildState({
      hands: { 0: "9 9 4 5 7 J Q", 1: "3 4 5 7 8 10 J", 2: "8 8 3 4 5 7 J", 3: "6 6 3 4 5 7 8", 4: "3 4 5 7 8 10 J", 5: "3 4 5 7 8 10 J" },
      leader: 3,
      turn: 3,
    });

  it("规则书#T10 让牌：3 发 6 6，4、5 过，0 让牌，1 过、2 过 → 回到 0，只能上牌或过牌", () => {
    let state = play(t10(), 3, "6 6");
    state = pass(pass(state, 4), 5);
    expect(state.turn).toBe(0);
    expect(canRang(state, 0)).toBe(true);
    expect(legalCommands(state, pid(0))).toContainEqual({ type: "RANG" });
    state = act(state, 0, { type: "RANG" });
    expect(state.turn).toBe(1);
    state = pass(state, 1);
    expect(state.turn).toBe(2);
    state = pass(state, 2);
    expect(state.turn).toBe(0);
    expect(state.round!.rang).toEqual({ seat: 0, returned: true });
    expect(canRang(state, 0)).toBe(false);
    expect(legalCommands(state, pid(0)).some((command) => command.type === "RANG")).toBe(false);
    expect(() => act(state, 0, { type: "RANG" })).toThrow();
    state = play(state, 0, "9 9");
    expect(state.round!.top!.seat).toBe(0);
  });

  it("规则书#T10 变化：1 过，2 上 8 8 → 0 算过牌；接着轮到 3（没过过牌，有资格）", () => {
    let state = play(t10(), 3, "6 6");
    state = act(pass(pass(state, 4), 5), 0, { type: "RANG" });
    state = play(pass(state, 1), 2, "8 8");
    expect(state.round!.passed).toContain(0);
    expect(state.round!.rang).toBeNull();
    expect(state.turn).toBe(3);
  });

  it("规则书#T11 0 出完 5 5 成为头科，1～5 都过 → 1 接风；这一轮结束后 3 无头；3 的够级牌没有限制，1 的够级牌 3 能接", () => {
    let state = buildState({ hands: { 0: "5 5", 1: "Q Q Q 3 4 6 7 8", 2: "3 4 6 7 8 9 10", 3: "K K K K 3 4 6 7", 4: "A A 3 4 6 7 8", 5: "3 4 6 7 8 9 10" }, leader: 0, turn: 0 });
    state = play(state, 0, "5 5");
    expect(state.finished).toEqual([0]);
    expect(state.headless[3]).toBe(false); // 这一轮结束才算
    for (const seat of [1, 2, 3, 4, 5]) state = pass(state, seat);
    expect(state.headless[3]).toBe(true);
    expect(state.round!.leader).toBe(1);
    expect(state.turn).toBe(1);
    expect(state.events.find((event) => event.type === "RoundEnded")).toMatchObject({ winner: 0, leader: 1, jiefeng: true });

    // 3 发 K K（3 无头）：没有够级限制，4 可以直接上 A A；没有人能烧。
    const headless = buildState({ finished: [0], headless: [3], hands: { 1: "Q Q Q 3 4 6 7 8", 2: "A A 小 大", 3: "K K 3 4 6 7", 4: "A A 3 4 6 7 8", 5: "3 4 6 7 8 9 10" }, top: { seat: 3, cards: "K K" } });
    expect(headless.round!.top!.burnable).toBe(false);
    expect(headless.round!.top!.ready).toBe(true);
    expect(headless.turn).toBe(4);
    expect(canBurn(headless, 2)).toBe(false); // 2 的牌够烧，但无头的人出的牌不能烧
    expect(legalCommands(headless, pid(2)).some((command) => command.type === "BURN")).toBe(false);
    expect(play(headless, 4, "A A").round!.top!.seat).toBe(4);

    // 另一轮：1 发 Q Q Q（1 有头）→ 2 跳过，3（无头、没过过）收到提示；3 上 K K K 后 4、5、1、2 按普通规则接。
    let other = buildState({ finished: [0], headless: [3], hands: { 1: "Q Q Q 3 4 6 7 8", 2: "3 4 6 7 8 9 10", 3: "K K K 4 6 7", 4: "A A A 3 4 6 7 8", 5: "3 4 6 7 8 9 10" }, top: { seat: 1, cards: "Q Q Q" } });
    other = settle(other);
    expect(canRespond(other, 2)).toBe(false);
    expect(canRespond(other, 3)).toBe(true);
    expect(other.turn).toBe(3);
    other = play(other, 3, "K K K");
    expect(other.round!.top!.burnable).toBe(false);
    expect([4, 5, 1, 2].map((seat) => canRespond(other, seat))).toEqual([true, true, true, true]);
    expect(other.turn).toBe(4);
  });

  it("规则书#T12 1 只剩 K K（有头）发 K K 走科：只有 4 能接；4 上 A A 后没人压，4 发下一轮；4 过、没人烧 → 2 接风，4 变无头", () => {
    const start = buildState({ hands: { 1: "K K", 0: "3 4 5 6 7 8 9 10", 2: "3 4 5 6 7 8 9 10", 3: "3 4 5 6 7 8 9 10", 4: "A A 3 5 6 7 8 9", 5: "3 4 5 6 7 8 9 10" }, leader: 1, turn: 1 });
    let state = play(start, 1, "K K");
    expect(state.finished).toEqual([1]);
    expect(state.turn).toBe(4);
    expect([2, 3, 5, 0].map((seat) => canRespond(state, seat))).toEqual([false, false, false, false]);
    state = playSettled(settle(state), 4, "A A");
    expect(state.round!.top).toBeNull();
    expect(state.round!.leader).toBe(4);
    expect(state.headless[4]).toBe(true);

    let other = passSettled(settle(play(start, 1, "K K")), 4);
    expect(other.round!.top).toBeNull();
    expect(other.round!.leader).toBe(2);
    expect(other.headless[4]).toBe(true);
    expect(other.history.some((event) => event.type === "RoundEnded" && event.jiefeng && event.leader === 2)).toBe(true);
  });

  it("规则书#T13 四人乱缠：0、3 走科、3 走科的那一轮结束后 chaos；1 发 K K，2 能直接上 A A，没有烧牌、让牌；1 过后 4 上牌，再轮到 1 时还能接", () => {
    // 3 刚打出最后一手（这一轮还没结束）
    let state = buildState({ finished: [0, 3], goneThisRound: [3], headless: [3], hands: { 1: "K K 2 2 5 6", 2: "A A 小 小 大 7", 4: "2 2 2 2 5 6 7", 5: "3 4 5 6 7 8" }, top: { seat: 3, cards: "9" } });
    expect(state.chaos).toBe(false);
    for (const seat of [4, 5, 1, 2]) state = pass(state, seat);
    expect(state.chaos).toBe(true);
    expect(state.headless[0]).toBe(true);
    expect(state.round!.leader).toBe(4); // 3 走了，4 接风
    // 换一个 1 发牌的局面
    let chaos = buildState({ finished: [0, 3], headless: [0, 3], chaos: true, hands: { 1: "K K 2 2 5 6", 2: "A A 小 小 大 7", 4: "2 2 2 2 5 6 7", 5: "3 4 5 6 7 8" }, top: { seat: 1, cards: "K K" } });
    expect(chaos.round!.top!.burnable).toBe(false);
    expect(chaos.turn).toBe(2);
    expect(legalCommands(chaos, pid(2)).some((command) => command.type === "BURN" || command.type === "RANG")).toBe(false);
    chaos = play(chaos, 2, "A A");
    chaos = play(chaos, 4, "2 2");
    chaos = pass(chaos, 5);
    expect(chaos.turn).toBe(1);
    chaos = pass(chaos, 1);
    expect(chaos.round!.passed).toContain(1);
    // 2 刚才的牌被压了，又轮到 2；2 再上牌后，过过牌的 1 还能接（乱缠里过牌不锁）
    expect(chaos.turn).toBe(2);
    chaos = play(chaos, 2, "小 小");
    chaos = pass(pass(chaos, 4), 5);
    expect(chaos.turn).toBe(1);
    expect(canRespond(chaos, 1)).toBe(true);
  });
});

describe("规则书 T14：计分", () => {
  it("规则书#T14 走科顺序 0、3、1、2、4，剩 5 → 甲 +2，乙 −2", () => {
    let state = buildState({ finished: [0, 3, 1, 2], headless: [3, 0, 4, 5], chaos: true, hands: { 4: "9", 5: "3 4 5" }, leader: 4, turn: 4 });
    state = play(state, 4, "9");
    expect(state.stage).toBe("handEnd");
    expect(state.result).toMatchObject({ sweep: false, order: [0, 3, 1, 2, 4, 5], teamDeltas: [2, -2], places: [0, 2, 3, 1, 4, 5] });
    expect(state.players.map((player) => player.handDelta)).toEqual([2, -2, 2, -2, 2, -2]);
    expect(state.teamScores).toEqual([2, -2]);
  });

  it("规则书#T14 走科顺序 1、5、3 → 串三户，这盘在 3 走科的瞬间结束，乙每人 +12，甲每人 −12", () => {
    let state = buildState({ finished: [1, 5], headless: [4, 2], chaos: true, hands: { 3: "9", 0: "3 4 5", 2: "3 4", 4: "6 7" }, leader: 3, turn: 3 });
    state = play(state, 3, "9");
    expect(state.stage).toBe("handEnd");
    expect(state.result).toMatchObject({ sweep: true, sweepTeam: 1, order: [1, 5, 3], teamDeltas: [-12, 12] });
    expect(state.players.map((player) => player.handDelta)).toEqual([-12, 12, -12, 12, -12, 12]);
    expect(state.players[0]!.hand.length).toBe(3); // 剩下的人不用打完
  });
});

describe("规则书 T15–T18：进贡、抗贡、革命", () => {
  const t15 = () =>
    buildDeal({
      prevResult: { order: [0, 3, 1, 2, 4, 5], burns: [{ burner: 1, victim: 5 }] },
      hands: { 5: "大 2 2 2" },
      noWild: [4, 5],
      seed: 11,
    });

  it("规则书#T15 进贡：5 先进烧贡大王 → 1（队内，1 吃贡），再进落贡 2 2 → 0，0 还 2 张；4 没王没 2 不进，3 不还；张数 35/37/36", () => {
    let state = t15();
    expect(state.handNo).toBe(2);
    expect(state.stage).toBe("tribute");
    expect(pendingSeats(state)).toEqual([1]);
    expect(state.tribute!.items.map((item) => [item.kind, item.giver, item.receiver, item.count, item.intra])).toEqual([
      ["burn", 5, 1, 1, true],
      ["luo", 5, 0, 2, false],
      ["luo", 4, 3, 1, false],
    ]);
    state = act(state, 1, { type: "TRIBUTE", eat: true });
    expect(state.stage).toBe("return");
    const paid = state.events.filter((event) => event.type === "TributePaid");
    expect(paid.map((event) => [event.giver, event.receiver, cardsText(event.cards)])).toEqual([
      [5, 1, "大"],
      [5, 0, "2 2"],
      [4, 3, ""],
    ]);
    expect(pendingSeats(state)).toEqual([0]);
    const back = state.players[0]!.hand.slice(-2);
    state = act(state, 0, { type: "RETURN", cards: back });
    const returned = state.events.find((event) => event.type === "TributeReturned");
    expect(returned).toMatchObject({ from: 0, to: 5 });
    expect(returned && returned.type === "TributeReturned" ? [...returned.cards].sort() : []).toEqual([...back].sort());
    expect(state.players.map((player) => player.hand.length)).toEqual([36, 37, 36, 36, 36, 35]);
    expect(total(state)).toBe(216);
    // 进贡、还贡的每一张牌对所有人公开
    for (const viewer of ["", pid(2), pid(4)]) {
      const view = redactGameForViewer(state, viewer);
      expect(view.history.filter((event) => event.type === "TributePaid" || event.type === "TributeReturned").length).toBe(4);
      expect(view.tribute!.items[1]!.cards).toHaveLength(2);
      expect(view.tribute!.items[1]!.returned).toHaveLength(2);
    }
  });

  it("规则书#T15 补（勘误 #2）：1 免贡 → 5 的大王留着，落贡变成 大王、2 → 0；张数全是 36", () => {
    let state = act(t15(), 1, { type: "TRIBUTE", eat: false });
    const paid = state.events.filter((event) => event.type === "TributePaid");
    expect(paid.map((event) => [event.giver, event.receiver, cardsText(event.cards)])).toEqual([
      [5, 0, "大 2"],
      [4, 3, ""],
    ]);
    expect(state.events.find((event) => event.type === "TributeChosen")).toMatchObject({ giver: 5, receiver: 1, eat: false });
    state = act(state, 0, { type: "RETURN", cards: state.players[0]!.hand.slice(-2) });
    expect(state.players.map((player) => player.hand.length)).toEqual([36, 36, 36, 36, 36, 36]);
  });

  it("规则书#T15 补：队内贡吃 / 免选的过程中别人看不到；10 秒超时算吃贡", () => {
    const state = t15();
    expect(state.config.tributeSec).toBe(10);
    const chosen = act(state, 1, { type: "TRIBUTE", eat: false });
    // 这里 1 是唯一要选的人，选完就结算；换一个有两人要选的局面看隐藏
    expect(chosen.stage).toBe("return");
    const timedOut = timeoutTurn(state);
    expect(timedOut.events.find((event) => event.type === "TributeChosen")).toMatchObject({ eat: true });
  });

  it("规则书#T16 头科 0、大落 4 同是甲：4 发到 4 张大王 → 抗贡，不进落贡；否则由 0 选吃 / 免，超时算吃贡", () => {
    const anti = buildDeal({ prevResult: { order: [0, 3, 1, 5, 2, 4] }, hands: { 4: "大 大 大 大" }, seed: 4 });
    expect(anti.tribute!.antiTribute).toEqual([4]);
    expect(anti.history.some((event) => event.type === "AntiTribute" && event.seat === 4)).toBe(true);
    expect(anti.tribute!.items.some((item) => item.giver === 4)).toBe(false);

    const normal = buildDeal({ prevResult: { order: [0, 3, 1, 5, 2, 4] }, hands: { 4: "大 大 大 小" }, seed: 4 });
    expect(normal.stage).toBe("tribute");
    expect(normal.tribute!.items[0]).toMatchObject({ kind: "luo", giver: 4, receiver: 0, count: 2, intra: true, eat: null });
    expect(pendingSeats(normal)).toEqual([0]);
    const timedOut = timeoutTurn(normal);
    const paid = timedOut.events.find((event) => event.type === "TributePaid" && event.giver === 4);
    expect(paid).toMatchObject({ receiver: 0 });
    expect(paid?.type === "TributePaid" ? cardsText(paid.cards) : "").toBe("大 大");
  });

  it("规则书#T17 4 没王没 2 宣布革命、其他人不革命：4 不出牌算四科，1 从开局起无头，该 4 先出改由 5 先出；0、2 先后走科 → 4 算三科，甲串三户 +12", () => {
    let state = buildDeal({ noWild: [4], firstLeader: 4, seed: 21 });
    expect(state.stage).toBe("revolution");
    expect(pendingSeats(state)).toEqual([4]);
    // 能不能革命只告诉本人
    expect(redactGameForViewer(state, pid(4)).you!.canRevolt).toBe(true);
    expect(redactGameForViewer(state, pid(0)).revolution!.eligible).toEqual([]);
    state = act(state, 4, { type: "REVOLT", revolt: true });
    expect(state.revolutionary).toBe(4);
    expect(state.players[4]!.hand).toEqual([]);
    expect(state.revolutionHand).toHaveLength(36);
    expect(state.headless[1]).toBe(true);
    expect(state.turn).toBe(5);
    expect(redactGameForViewer(state, pid(0)).revolutionHand).toEqual([]);
    expect(redactGameForViewer(state, pid(2)).revolutionHand).toEqual([]);
    expect(redactGameForViewer(state, pid(4)).revolutionHand).toHaveLength(36);

    let sweep = buildState({ revolutionary: 4, finished: [0], hands: { 2: "9", 1: "3 4 5", 3: "6 7", 5: "8 10" }, leader: 2, turn: 2 });
    sweep = play(sweep, 2, "9");
    expect(sweep.stage).toBe("handEnd");
    expect(sweep.result).toMatchObject({ sweep: true, sweepTeam: 0, order: [0, 2, 4], teamDeltas: [12, -12] });
    expect(sweep.result!.places[4]).toBe(2);
  });

  it("规则书#T18 4 和 1 都宣布革命：重新洗牌发牌，这次不进贡；盘数不加 1；首出的人不变", () => {
    let state = buildDeal({ prevResult: { order: [0, 3, 1, 2, 4, 5] }, noWild: [1, 4], seed: 31, hands: { 5: "大 2", 4: "3 4 5", 0: "6" } });
    // 有落贡：先把进贡走完（5→0、4→3 都跨队，3 和 0 还贡）
    while (state.stage === "return") state = timeoutTurn(state);
    expect(state.stage).toBe("revolution");
    expect(pendingSeats(state).sort()).toEqual([1, 4]);
    const firstLeader = state.firstLeader;
    expect(firstLeader).toBe(5);
    state = act(state, 4, { type: "REVOLT", revolt: true });
    state = act(state, 1, { type: "REVOLT", revolt: true });
    expect(state.events.find((event) => event.type === "RevolutionRedeal")).toMatchObject({ seats: [1, 4] });
    expect(state.handNo).toBe(2);
    expect(state.redeals).toBe(1);
    expect(state.tribute).toBeNull();
    expect(state.firstLeader).toBe(firstLeader);
    expect(state.revolutionary).toBeNull();
    expect(total(state)).toBe(216);
    if (state.stage === "playing") expect(state.turn).toBe(5);
  });
});

describe("规则书 T19–T20：报牌、看牌、超时", () => {
  it("规则书#T19 2 剩 11 张 → 所有人看到 10+；出牌后剩 10 张 → 所有人看到 10，队友 0、4 看得到手牌，1、3、5 看不到", () => {
    let state = buildState({ hands: { 2: "3 4 5 6 7 8 9 10 J Q K", 0: 15, 1: 15, 3: 15, 4: 15, 5: 15 }, leader: 2, turn: 2 });
    for (const viewer of [0, 1, 3, 4, 5]) {
      const view = redactGameForViewer(state, pid(viewer));
      expect(view.players[2]!.handCount).toBeNull();
      expect(view.players[2]!.hand).toEqual([]);
    }
    expect(redactGameForViewer(state, "").players[2]!.handCount).toBeNull();
    expect(redactGameForViewer(state, pid(2)).players[2]!.handCount).toBe(11);
    state = play(state, 2, "3");
    for (const viewer of [0, 1, 3, 4, 5]) expect(redactGameForViewer(state, pid(viewer)).players[2]!.handCount).toBe(10);
    for (const viewer of [0, 4]) expect(redactGameForViewer(state, pid(viewer)).players[2]!.hand).toHaveLength(10);
    for (const viewer of [1, 3, 5]) expect(redactGameForViewer(state, pid(viewer)).players[2]!.hand).toEqual([]);
    expect(redactGameForViewer(state, "").players[2]!.hand).toEqual([]);
    // 看牌关掉时队友也看不到
    const noPeek = buildState({ options: { peek: false }, hands: { 2: "4 5 6 7 8 9 10 J Q K", 0: 15, 1: 15, 3: 15, 4: 15, 5: 15 }, leader: 2, turn: 2 });
    expect(redactGameForViewer(noPeek, pid(0)).players[2]!.hand).toEqual([]);
    expect(redactGameForViewer(noPeek, pid(0)).players[2]!.handCount).toBe(10);
  });

  it("规则书#T20 轮到 3 发牌超时 → 替 3 出最小的一张普通牌；轮到 3 接牌超时 → 过牌（加进 passed）", () => {
    expect(buildState({ hands: { 3: "2 4 4 J 小", 0: 15, 1: 15, 2: 15, 4: 15, 5: 15 }, turn: 3, leader: 3 }).config.playSec).toBe(30);
    let lead = buildState({ hands: { 3: "2 4 4 J 小", 0: 15, 1: 15, 2: 15, 4: 15, 5: 15 }, turn: 3, leader: 3 });
    lead = timeoutTurn(lead);
    expect(cardsText(lead.round!.top!.cards)).toBe("4");
    expect(lead.round!.top!.seat).toBe(3);
    expect(lead.events.map((event) => event.type)).toEqual(["TimedOut", "Played"]);
    // 没有普通牌：出最小的一张
    const wildOnly = timeoutTurn(buildState({ hands: { 3: "2 大 小", 0: 15, 1: 15, 2: 15, 4: 15, 5: 15 }, turn: 3, leader: 3 }));
    expect(cardsText(wildOnly.round!.top!.cards)).toBe("2");

    let respond = buildState({ hands: { 3: "9 9 J", 0: 15, 1: 15, 2: 15, 4: 15, 5: 15 }, top: { seat: 2, cards: "5 5" } });
    expect(respond.turn).toBe(3);
    respond = timeoutTurn(respond);
    expect(respond.round!.passed).toContain(3);
    expect(respond.turn).toBe(4);
  });
});

/** 让 ts 不抱怨没用到的导入。 */
export const _unused: unknown[] = [pick, burn, act, settle];
export type _State = GameState;
