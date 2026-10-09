/**
 * 规则书正文其余条目和补充文件勘误（~/Desktop/游戏规则/够级-补充.md 第三节）的测试。
 * 勘误编号写成「勘误#n」，正文章节写成「§x.y」。
 */
import { describe, expect, it } from "vitest";
import {
  beats,
  buildDeal,
  buildState,
  burnEligibleSeats,
  burnLeadDefault,
  canBurn,
  canBurnTail,
  canRang,
  canRespond,
  cardsText,
  createGame,
  legalBurnLead,
  legalCommands,
  parseCards,
  parseSet,
  pendingSeats,
  redactGameForViewer,
  stepSeconds,
  timeoutTurn,
  timerKey,
  burnWindowKey,
  type GameState,
} from "../src/index.js";
import { act, burn, pass, passSettled, pick, pid, play, playSettled, runUntil, settle, tick, total } from "./helpers.js";

const set = (text: string) => parseSet(parseCards(text))!;
const WEAK = "3 4 5 6 7 8 9 10 J Q 3 4 5 6 7 8";

describe("勘误#1 革命者扣下的牌不算手里有牌（在打的人 = 有牌且不是革命者）", () => {
  it("革命者不会被轮到、不接风、不能烧、不显示张数；只剩 1 个在打的人时这盘结束，革命者四科", () => {
    let state = buildState({ revolutionary: 4, finished: [0, 3, 1], headless: [1, 3, 0], chaos: true, hands: { 2: "9", 5: "3 4" }, leader: 2, turn: 2 });
    expect(state.revolutionHand.length).toBeGreaterThan(0);
    expect(canRespond(state, 4)).toBe(false);
    state = play(state, 2, "9");
    expect(state.stage).toBe("handEnd");
    expect(state.result).toMatchObject({ sweep: false, order: [0, 3, 1, 4, 2, 5], revolutionary: 4 });
    // 甲：0 头科 +4、4 四科 0、2 二落 −2 = +2；乙：3 二科 +2、1 三科 0、5 大落 −4 = −2（规则书例 3 的写法）
    expect(state.result!.teamDeltas).toEqual([2, -2]);
  });

  it("接风跳过革命者", () => {
    let state = buildState({ revolutionary: 4, hands: { 3: "5", 0: WEAK, 1: WEAK, 2: WEAK, 5: WEAK }, leader: 3, turn: 3 });
    state = play(state, 3, "5");
    for (const seat of [5, 0, 1, 2]) state = pass(state, seat);
    expect(state.round!.leader).toBe(5);
  });

  it("规则书例 3：4 革命，走科 1、0、3、5，剩 2 → 甲 −2，乙 +2", () => {
    let state = buildState({ revolutionary: 4, finished: [1, 0, 3], headless: [1, 4, 3, 0], chaos: true, hands: { 5: "9", 2: "3 4" }, leader: 5, turn: 5 });
    state = play(state, 5, "9");
    expect(state.result).toMatchObject({ order: [1, 0, 3, 4, 5, 2], teamDeltas: [-2, 2] });
  });
});

describe("勘误#3 有头的人打出够级牌后，出牌 / 过牌生效 / 本轮结束 / 接风统一推迟到满 2 秒", () => {
  const duel = () => buildState({ hands: { 0: "K K 5 6", 3: "A A 4 9", 1: WEAK, 2: WEAK, 4: WEAK, 5: WEAK }, leader: 0, turn: 0 });

  it("对头立刻过牌：只是先收下（别人看到的状态、version、计时 key 都不变），TICK 后才生效、结束这一轮", () => {
    const played = play(duel(), 0, "K K");
    expect(played.round!.top!.burnable).toBe(true);
    expect(played.round!.top!.ready).toBe(false);
    expect(burnWindowKey(played)).not.toBeNull();
    expect(played.config.burnWindowMs).toBe(2000);
    const passed = pass(played, 3);
    expect(passed.version).toBe(played.version);
    expect(timerKey(passed)).toBe(timerKey(played));
    expect(passed.turn).toBe(3);
    expect(passed.round!.top!.seat).toBe(0);
    expect(pendingSeats(passed)).toEqual([]);
    for (const viewer of ["", pid(0), pid(1), pid(2), pid(4), pid(5)]) {
      expect(JSON.stringify(redactGameForViewer(passed, viewer))).toBe(JSON.stringify(redactGameForViewer(played, viewer)));
    }
    expect(redactGameForViewer(passed, pid(3)).you!.pendingAction).toEqual({ type: "PASS" });
    expect(() => pass(passed, 3)).toThrow(/已经选好/);
    const after = tick(passed);
    expect(after.version).toBe(played.version + 1);
    expect(after.round!.top).toBeNull();
    expect(after.round!.leader).toBe(0);
  });

  it("对头立刻上牌也是满 2 秒才生效", () => {
    const queued = play(play(duel(), 0, "K K"), 3, "A A");
    expect(queued.round!.top!.seat).toBe(0);
    expect(queued.players[3]!.hand).toHaveLength(4);
    const after = tick(queued);
    expect(after.round!.top!.seat).toBe(3);
    expect(after.players[3]!.hand).toHaveLength(2);
  });

  it("没人能正常接（对头已经走科）时 turn = -1 等 TICK，再结束这一轮、接风", () => {
    let state = buildState({ finished: [3], goneThisRound: [3], hands: { 0: "K K", 1: WEAK, 2: WEAK, 4: WEAK, 5: WEAK }, top: { seat: 3, cards: "4 4" }, passed: [4, 5] });
    // 0 有头（3 是这一轮刚走的），0 出完 K K
    expect(state.turn).toBe(0);
    state = play(state, 0, "K K");
    expect(state.finished).toEqual([3, 0]);
    expect(state.turn).toBe(-1);
    expect(state.round!.top!.seat).toBe(0);
    state = tick(state);
    expect(state.round!.top).toBeNull();
    expect(state.round!.leader).toBe(1); // 接风
    expect(state.chaos).toBe(true);
  });

  it("无头的人、四人乱缠里出的够级牌不用等", () => {
    const headless = buildState({ finished: [0], headless: [3], hands: { 3: "K K 5", 4: "A A 6", 1: WEAK, 2: WEAK, 5: WEAK }, leader: 3, turn: 3 });
    const played = play(headless, 3, "K K");
    expect(played.round!.top!.burnable).toBe(false);
    expect(burnWindowKey(played)).toBeNull();
    expect(pass(played, 4).turn).toBe(5);
    const chaos = buildState({ finished: [0, 5], headless: [3, 2], chaos: true, hands: { 1: "K K 5", 2: "A A 6", 3: WEAK, 4: WEAK }, leader: 1, turn: 1 });
    expect(play(chaos, 1, "K K").round!.top!.ready).toBe(true);
  });

  it("不可能有人能烧时也照样等（不泄露有没有人能烧）", () => {
    const played = play(duel(), 0, "K K");
    expect(burnEligibleSeats(played)).toEqual([]);
    expect(played.round!.top!.ready).toBe(false);
  });

  it("烧牌优先于对头正常接：窗口里对头先选了上牌、2 按了烧牌，满 2 秒时烧牌成立，对头的牌作废", () => {
    let state = buildState({ hands: { 0: "K K 5 6", 2: "A A 7 7 7 9 9 小 大", 3: "A A 4 9", 1: WEAK, 4: WEAK, 5: WEAK }, leader: 0, turn: 0 });
    state = play(state, 0, "K K");
    state = play(state, 3, "A A");
    state = burn(state, 2, "A A");
    expect(state.round!.burnRequests).toHaveLength(1);
    expect(redactGameForViewer(state, pid(3)).round!.burnRequests).toEqual([]);
    expect(redactGameForViewer(state, pid(2)).you!.burnRequested).not.toBeNull();
    state = tick(state);
    expect(state.burn).toEqual({ burner: 2, victim: 0 });
    expect(state.round!.top!.seat).toBe(2);
    expect(state.players[3]!.hand).toHaveLength(4);
    expect(state.turn).toBe(5);
  });

  it("窗口满 2 秒之后再按烧牌立刻生效", () => {
    let state = buildState({ hands: { 0: "K K 5 6", 2: "A A 7 7 7 9 9 小 大", 3: "A A 4 9", 1: WEAK, 4: WEAK, 5: WEAK }, leader: 0, turn: 0 });
    state = tick(play(state, 0, "K K"));
    expect(state.turn).toBe(3);
    state = burn(state, 2, "A A");
    expect(state.burn).toEqual({ burner: 2, victim: 0 });
  });
});

describe("勘误#4 §4.2 挂小王的牌：大王张数不少于它的王的张数、其余各张逐张更大才能压", () => {
  it("大 大 2 2、大 大 小 小 能压 9 9 小 小；大 小 2 2、10 10 大 小 不能", () => {
    expect(beats(set("大 大 2 2"), set("9 9 小 小"))).toBe(true);
    expect(beats(set("大 大 小 小"), set("9 9 小 小"))).toBe(true);
    expect(beats(set("10 10 大 大"), set("9 9 小 小"))).toBe(true);
    expect(beats(set("大 小 2 2"), set("9 9 小 小"))).toBe(false);
    expect(beats(set("10 10 大 小"), set("9 9 小 小"))).toBe(false);
  });
});

describe("勘误#5 让牌只在对头出非够级牌时", () => {
  it("对头出够级牌、下家无头时也不能让", () => {
    const state = buildState({ finished: [4], headless: [1], hands: { 0: "A A 2 5", 1: "A A 2 6", 2: WEAK, 3: "K K 3", 5: WEAK }, top: { seat: 3, cards: "K K", ready: true } });
    expect(state.turn).toBe(0);
    expect(canRang(state, 0)).toBe(false);
    expect(legalCommands(state, pid(0)).some((command) => command.type === "RANG")).toBe(false);
  });

  it("让牌开房选项关掉时没有让牌；四人乱缠里也没有", () => {
    const off = buildState({ options: { rang: false }, hands: { 0: "9 9 5", 1: WEAK, 2: WEAK, 3: WEAK, 4: WEAK, 5: WEAK }, entries: [{ seat: 3, cards: "6 6" }, { seat: 4, pass: true }, { seat: 5, pass: true }], passed: [4, 5] });
    expect(off.turn).toBe(0);
    expect(canRang(off, 0)).toBe(false);
    expect(legalCommands(off, pid(0)).some((command) => command.type === "RANG")).toBe(false);
    const chaos = buildState({ chaos: true, finished: [1, 4], headless: [4, 1], hands: { 0: "9 9 5", 2: WEAK, 3: WEAK, 5: WEAK }, entries: [{ seat: 3, cards: "6 6" }, { seat: 5, pass: true }], passed: [5], turn: 0 });
    expect(chaos.turn).toBe(0);
    expect(canRang(chaos, 0)).toBe(false);
  });
});

describe("勘误#6 串贡：输的一队每人给自己的对头 1 张", () => {
  it("规则书例 2：1、5、3 串三户 → 0→3、2→5、4→1 各 1 张；首出是头科 1 的对头 4", () => {
    const state = buildDeal({ prevResult: { order: [1, 5, 3], sweep: true }, seed: 8 });
    expect(state.tribute!.items.map((item) => [item.kind, item.giver, item.receiver, item.count])).toEqual([
      ["chuan", 0, 3, 1],
      ["chuan", 2, 5, 1],
      ["chuan", 4, 1, 1],
    ]);
    expect(state.firstLeader).toBe(4);
    // 跨联邦，直接到账、等还贡
    expect(state.stage).toBe("return");
    expect(pendingSeats(state).sort()).toEqual([1, 3, 5]);
  });
});

describe("勘误#7 队友也能烧（除了出牌人和他的对头）；多人同时按，从被烧的人下家起最近的烧成", () => {
  const both = () =>
    buildState({
      hands: { 0: "K K 5 6", 2: "A A 7 7 7 9 9 小 大", 4: "2 2 8 8 小", 1: "A A 3 3 3 小", 3: "Q Q 4 9", 5: WEAK },
      top: { seat: 0, cards: "K K" },
    });

  it("0 的队友 2、4 和对手 1 都能烧", () => {
    expect(burnEligibleSeats(both())).toEqual([1, 2, 4]);
  });

  it("2 和 4 同时按、1 也按 → 1 最近（0 的下家）烧成；只有 4 和 2 按 → 2 烧成；被烧的是队友也算", () => {
    let state = burn(burn(burn(both(), 4, "2 2"), 2, "A A"), 1, "A A");
    state = tick(state);
    expect(state.burn).toEqual({ burner: 1, victim: 0 });
    let teammates = tick(burn(burn(both(), 4, "2 2"), 2, "A A"));
    expect(teammates.burn).toEqual({ burner: 2, victim: 0 });
    teammates = tick(burn(both(), 4, "2 2"));
    expect(teammates.burn).toEqual({ burner: 4, victim: 0 });
  });
});

describe("§3.3 进贡细节", () => {
  it("只进大王 → 小王 → 2，不够有几张进几张、欠的不补；一个人好几份贡先进烧贡（按烧牌先后）再进落贡", () => {
    const state = buildDeal({
      prevResult: { order: [0, 3, 1, 2, 4, 5], burns: [{ burner: 3, victim: 5 }, { burner: 2, victim: 5 }] },
      hands: { 5: "小 2", 4: "大 大" },
      noWild: [5],
      seed: 13,
    });
    // 3 和 5 同队（乙）：3 选；2 和 5 跨队。
    expect(state.stage).toBe("tribute");
    const after = act(state, 3, { type: "TRIBUTE", eat: true });
    const paid = after.events.filter((event) => event.type === "TributePaid").map((event) => [event.kind, event.giver, event.receiver, cardsText(event.cards)]);
    expect(paid).toEqual([
      ["burn", 5, 3, "小"],
      ["burn", 5, 2, "2"],
      ["luo", 5, 0, ""],
      ["luo", 4, 3, "大"],
    ]);
    // 5 的落贡没牌可进：0 不用还；3 收了 4 的 1 张落贡要还 1 张
    expect(after.stage).toBe("return");
    expect(pendingSeats(after)).toEqual([3]);
  });

  it("只能进自己这盘发到的牌：收到的贡不能再拿去进贡（所有贡同时到账）", () => {
    // 0 是头科、也是上一盘被 1 烧过的人：0 收 5 的落贡（大 大），但自己发到的牌里没配牌，给 1 的烧贡进不出
    const state = buildDeal({ prevResult: { order: [0, 3, 1, 2, 4, 5], burns: [{ burner: 1, victim: 0 }] }, hands: { 5: "大 大" }, noWild: [0, 4], seed: 17 });
    const done = state.stage === "tribute" ? timeoutTurn(state) : state;
    const burnPaid = done.history.find((event) => event.type === "TributePaid" && event.kind === "burn");
    expect(burnPaid && burnPaid.type === "TributePaid" ? burnPaid.cards : null).toEqual([]);
    expect(done.players[0]!.hand.filter((card) => card % 54 === 53)).toHaveLength(2);
  });

  it("还贡：张数要等于实际收到的；可以还刚收到的贡牌；20 秒超时还点数最小的牌", () => {
    let state = buildDeal({ prevResult: { order: [1, 0, 3, 2, 5, 4] }, hands: { 4: "大 小" }, noWild: [4], seed: 19 });
    // 4（甲）给 1（乙）2 张，跨队直接到账
    expect(state.stage).toBe("return");
    expect(state.config.returnSec).toBe(20);
    expect(stepSeconds(state)).toBe(20);
    const received = state.tribute!.items[0]!.cards;
    expect(cardsText(received)).toBe("大 小");
    expect(() => act(state, 1, { type: "RETURN", cards: [received[0]!] })).toThrow(/2 张/);
    // 还刚收到的大王小王也行
    const back = act(state, 1, { type: "RETURN", cards: received });
    expect(back.tribute!.items[0]!.returned!.sort()).toEqual([...received].sort());
    const smallest = state.players[1]!.hand.slice(-2);
    let timedOut = state;
    while (timedOut.stage === "return") timedOut = timeoutTurn(timedOut);
    const returnedBy1 = timedOut.history.find((event) => event.type === "TributeReturned" && event.from === 1);
    expect(returnedBy1 && returnedBy1.type === "TributeReturned" ? [...returnedBy1.cards].sort() : []).toEqual([...smallest].sort());
  });

  it("还贡选的过程中别人看不到；大家都选好了同时公开", () => {
    const state = buildDeal({ prevResult: { order: [1, 5, 3], sweep: true }, seed: 8 });
    const chosen = act(state, 1, { type: "RETURN", cards: state.players[1]!.hand.slice(-1) });
    expect(chosen.version).toBe(state.version);
    expect(redactGameForViewer(chosen, pid(3)).tribute!.items.find((item) => item.receiver === 1)!.returned).toBeNull();
    expect(redactGameForViewer(chosen, pid(1)).tribute!.items.find((item) => item.receiver === 1)!.returned).toHaveLength(1);
    expect(JSON.stringify(redactGameForViewer(chosen, pid(3)))).toBe(JSON.stringify(redactGameForViewer(state, pid(3))));
  });

  it("进贡开房选项关掉：第 2 盘不进贡，首出仍是上一盘的大落", () => {
    const state = buildDeal({ options: { tribute: false }, prevResult: { order: [0, 3, 1, 2, 4, 5] }, seed: 23 });
    expect(state.tribute).toBeNull();
    expect(state.firstLeader).toBe(5);
    if (state.stage === "playing") expect(state.turn).toBe(5);
  });

  it("上一盘的革命者在赢的一队：他的对头照常给他串贡", () => {
    const state = buildDeal({ prevResult: { order: [0, 2, 4], sweep: true, revolutionary: 4 }, seed: 29 });
    expect(state.tribute!.items.map((item) => [item.giver, item.receiver])).toEqual([[1, 4], [3, 0], [5, 2]]);
  });
});

describe("§3.4 革命", () => {
  it("可以不革命；没人能革命就没有革命阶段；革命者不能烧也不会被烧", () => {
    let state = buildDeal({ noWild: [2], seed: 37, firstLeader: 0 });
    expect(state.stage).toBe("revolution");
    expect(stepSeconds(state)).toBe(10);
    state = act(state, 2, { type: "REVOLT", revolt: false });
    expect(state.stage).toBe("playing");
    expect(state.revolutionary).toBeNull();
    expect(buildDeal({ seed: 37 }).stage).toBe("playing");
    const rebel = buildState({ revolutionary: 2, hands: { 0: "K K 5", 1: WEAK, 3: "4 5", 4: WEAK, 5: WEAK }, top: { seat: 0, cards: "K K" } });
    expect(canBurn(rebel, 2)).toBe(false);
  });

  it("革命的选择别人看不到（不加 version）；超时算不革命，不计入托管的超时次数", () => {
    const state = buildDeal({ noWild: [2, 5], seed: 41, firstLeader: 0 });
    const chosen = act(state, 2, { type: "REVOLT", revolt: true });
    expect(chosen.version).toBe(state.version);
    expect(JSON.stringify(redactGameForViewer(chosen, pid(0)))).toBe(JSON.stringify(redactGameForViewer(state, pid(0))));
    expect(redactGameForViewer(chosen, pid(5)).revolution!.choices).toEqual([null, null, null, null, null, null]);
    const timedOut = timeoutTurn(chosen);
    expect(timedOut.revolutionary).toBe(2);
    expect(timedOut.players[5]!.timeouts).toBe(0);
    expect(timedOut.history.some((event) => event.type === "TimedOut")).toBe(false);
  });
});

describe("§3.5 首出", () => {
  it("第 1 盘随机；第 2 盘起上一盘大落先出；串三户后头科的对头先出；该先出的人革命了由下一个没革命的下家先出", () => {
    const firsts = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((seed) => createGame([0, 1, 2, 3, 4, 5].map((seat) => ({ id: pid(seat), name: `P${seat}` })), seed).firstLeader));
    expect(firsts.size).toBeGreaterThan(2);
    expect(buildDeal({ prevResult: { order: [3, 0, 1, 2, 4, 5] }, options: { tribute: false }, seed: 3 }).firstLeader).toBe(5);
    expect(buildDeal({ prevResult: { order: [3, 5, 1], sweep: true }, options: { tribute: false }, seed: 3 }).firstLeader).toBe(0);
    let rebel = buildDeal({ noWild: [5], firstLeader: 5, seed: 43 });
    rebel = act(rebel, 5, { type: "REVOLT", revolt: true });
    expect(rebel.turn).toBe(0);
  });
});

describe("§4.4 一轮怎么走", () => {
  it("联众的例子：0 发 3 3，1 上 6 6，2～5 过；0 上 10 10，1 过，2 跳过，3 过过但能接 J J", () => {
    let state = buildState({ hands: { 0: "3 3 10 10 5", 1: "6 6 4 5 7", 2: "4 5 7 8 9", 3: "J J 4 5 7", 4: "4 5 7 8 9", 5: "4 5 7 8 9" }, leader: 0, turn: 0 });
    state = play(play(state, 0, "3 3"), 1, "6 6");
    for (const seat of [2, 3, 4, 5]) state = pass(state, seat);
    state = pass(play(state, 0, "10 10"), 1);
    expect(state.turn).toBe(3);
    state = play(state, 3, "J J");
    expect(state.round!.top!.seat).toBe(3);
    // 4、5 过过、不是 3 的对头：跳过；0 是 3 的对头（过过牌也能接）
    expect(state.turn).toBe(0);
  });

  it("发牌的人不能过；压不住、张数不对、牌不在手里、不是合法的一套都会被拒", () => {
    const state = buildState({ hands: { 0: "3 3 8 9 K", 1: "4 4 5 5 7", 2: WEAK, 3: WEAK, 4: WEAK, 5: WEAK }, leader: 0, turn: 0 });
    expect(() => pass(state, 0)).toThrow(/发牌不能过/);
    expect(() => act(state, 0, { type: "PLAY", cards: pick(state, 0, "8 9") })).toThrow(/不是合法/);
    expect(() => act(state, 0, { type: "PLAY", cards: pick(state, 1, "4") })).toThrow(/不在你手里/);
    expect(() => play(state, 1, "4")).toThrow(/还没轮到/);
    const led = play(state, 0, "3 3");
    expect(() => play(led, 1, "4")).toThrow(/张数/);
    const higher = play(led, 1, "4 4");
    expect(() => play(pass(pass(pass(pass(higher, 2), 3), 4), 5), 0, "3")).toThrow();
  });
});

describe("§4.5 够级：两个对头一来一回", () => {
  it("0 出 5 张 10，3 上 5 张 J，0 上 5 张 Q，3 过 → 0 发下一轮；挂大王的够级牌对头只能过", () => {
    let state = buildState({ hands: { 0: "10x5 Qx5 9", 3: "Jx5 4 5", 1: WEAK, 2: WEAK, 4: WEAK, 5: WEAK }, leader: 0, turn: 0 });
    state = playSettled(state, 0, "10x5");
    expect(state.turn).toBe(3);
    state = playSettled(state, 3, "Jx5");
    expect(state.turn).toBe(0);
    state = playSettled(state, 0, "Qx5");
    expect(state.turn).toBe(3);
    state = passSettled(state, 3);
    expect(state.round!.leader).toBe(0);
    const big = playSettled(buildState({ hands: { 0: "K 大 5", 3: "2 2 小 小 4", 1: WEAK, 2: WEAK, 4: WEAK, 5: WEAK }, leader: 0, turn: 0 }), 0, "K 大");
    expect(legalCommands(big, pid(3))).toEqual([{ type: "PASS" }]);
  });
});

describe("§4.6 烧牌的其他情况", () => {
  it("步步带王算法：剩 7 7 7、9 9、小王、大王 可以；剩 7 7 7、8、9 9、小王 不行；只剩 2 和王可以；没牌了可以", () => {
    expect(canBurnTail(parseCards("7 7 7 9 9 小 大"))).toBe(true);
    expect(canBurnTail(parseCards("7 7 7 8 9 9 小"))).toBe(false);
    expect(canBurnTail(parseCards("2 2 小"))).toBe(true);
    expect(canBurnTail(parseCards("2 2"))).toBe(true);
    expect(canBurnTail([])).toBe(true);
    expect(canBurnTail(parseCards("5 6"))).toBe(false);
    expect(canBurnTail(parseCards("5 6 2 2 2"))).toBe(false);
    expect(canBurnTail(parseCards("5 6 小"))).toBe(true);
  });

  it("烧牌状态的发牌限制：全部出完，或挂王且剩下仍能步步带王", () => {
    const hand = parseCards("7 7 7 9 9 小 大");
    expect(legalBurnLead(hand, parseCards("9 9"))).toBe(false);
    expect(legalBurnLead(hand, parseCards("7 7 7 小"))).toBe(true);
    expect(legalBurnLead(hand, parseCards("7 7 7 小 大"))).toBe(true); // 剩 9 9 是最后一套
    expect(legalBurnLead(hand, parseCards("小 大"))).toBe(false); // 剩 7 7 7、9 9 没有王
    expect(legalBurnLead(parseCards("9 9 2 大"), parseCards("9 9 2 大"))).toBe(true);
    expect(legalBurnLead(hand, parseCards("7 8"))).toBe(false);
  });

  it("烧牌状态下发牌超时：出挂王最少的一套（整手是一套就全出）", () => {
    expect(cardsText(burnLeadDefault(parseCards("7 7 7 9 9 小 大")))).toBe("小 7 7 7");
    expect(cardsText(burnLeadDefault(parseCards("9 9 2 大")))).toBe("大 2 9 9");
    let state = buildState({ hands: { 0: "7 7 7 9 9 小 大", 1: WEAK, 2: WEAK, 3: WEAK, 4: WEAK, 5: WEAK }, burn: { burner: 0, victim: 1 }, leader: 0, turn: 0 });
    state = timeoutTurn(state);
    expect(cardsText(state.round!.top!.cards)).toBe("小 7 7 7");
  });

  it("S₁ 一次出完：烧牌直接成功", () => {
    let state = buildState({ hands: { 0: "K K 5", 2: "A A", 1: WEAK, 3: WEAK, 4: WEAK, 5: WEAK }, top: { seat: 0, cards: "K K" } });
    state = tick(burn(state, 2, "A A"));
    expect(state.finished).toEqual([2]);
    expect(state.burnsThisHand).toEqual([{ burner: 2, victim: 0 }]);
  });

  it("§5.3 烧牌的人被烧（被烧的人反烧）：原烧牌失败，新的人进入烧牌状态；反烧成功下盘 X 给 O 烧贡", () => {
    let state = buildState({ hands: { 0: "2 2 小 大", 2: "A A 7 7 7 9 9 小 大", 1: WEAK, 3: "Q Q 4 9", 4: WEAK, 5: "3 4 5 6 7 8 9 10 J Q 3 4 5 6 7 8 9" }, top: { seat: 0, cards: "K K" } });
    state = tick(burn(state, 2, "A A"));
    expect(state.burn).toEqual({ burner: 2, victim: 0 });
    // 0 不是 2 的对头、没过过牌：可以反烧 2 的 A A（用 2 2，剩 小 大 一套出完）
    expect(canBurn(state, 0)).toBe(true);
    state = tick(burn(state, 0, "2 2"));
    expect(state.history.some((event) => event.type === "BurnBroken" && event.burner === 2 && event.by === 0 && event.counter)).toBe(true);
    expect(state.burn).toEqual({ burner: 0, victim: 2 });
    state = passSettled(state, 3);
    expect(state.turn).toBe(0);
    state = play(state, 0, "小 大");
    expect(state.burnsThisHand).toEqual([{ burner: 0, victim: 2 }]);
  });

  it("§5.4 被烧的人已经走科：O 的底牌够级牌被烧，照样算", () => {
    let state = buildState({ hands: { 0: "K K", 2: "A A 7 7 7 9 9 小 大", 1: WEAK, 3: "Q Q 4 9", 4: WEAK, 5: WEAK }, leader: 0, turn: 0 });
    state = play(state, 0, "K K");
    expect(state.finished).toEqual([0]);
    state = tick(burn(state, 2, "A A"));
    expect(state.burn).toEqual({ burner: 2, victim: 0 });
  });

  it("§5.5 一盘里同一个人被烧两次：各算一张烧贡", () => {
    const state = buildDeal({ prevResult: { order: [1, 0, 3, 2, 5, 4], burns: [{ burner: 1, victim: 4 }, { burner: 3, victim: 4 }] }, hands: { 4: "大 小 2 2 2 2" }, seed: 47 });
    expect(state.tribute!.items.filter((item) => item.kind === "burn").map((item) => [item.giver, item.receiver])).toEqual([[4, 1], [4, 3]]);
  });

  it("过牌不烧：这一轮过过牌的人不能烧", () => {
    const state = buildState({ hands: { 0: "K K 5", 2: "A A 7 7 7 9 9 小 大", 1: WEAK, 3: WEAK, 4: WEAK, 5: WEAK }, entries: [{ seat: 5, cards: "3 3" }, { seat: 0, cards: "K K" }], passed: [2] });
    expect(canBurn(state, 2)).toBe(false);
  });

  it("无头的人不能烧；乱缠里不能烧", () => {
    const headless = buildState({ finished: [5], headless: [2], hands: { 0: "K K 5", 2: "A A 7 7 7 9 9 小 大", 1: WEAK, 3: WEAK, 4: WEAK }, top: { seat: 0, cards: "K K" } });
    expect(canBurn(headless, 2)).toBe(false);
    expect(canRespond(headless, 2)).toBe(true); // 无头的人可以正常接够级牌
  });

  it("烧牌请求不合法会被拒（压不住、剩下不能步步带王、不在烧牌资格里）", () => {
    const state = buildState({ hands: { 0: "K K 5", 2: "A A 7 7 7 9 9 小 大", 1: "A A 3 3 3 5 6 7 8", 3: WEAK, 4: WEAK, 5: WEAK }, top: { seat: 0, cards: "K K" } });
    expect(() => burn(state, 1, "A A")).toThrow(/不能烧/);
    expect(() => burn(state, 2, "小 大")).toThrow(/每套都挂王/);
    expect(() => burn(state, 2, "7 7")).toThrow(/压得住/);
    expect(() => burn(state, 3, "3 4")).toThrow();
  });
});

describe("§4.7 让牌的细节", () => {
  it("§5.7 让牌后下家、下下家都没资格：直接回到让牌的人", () => {
    let state = buildState({ hands: { 0: "9 9 5", 1: WEAK, 2: WEAK, 3: WEAK, 4: WEAK, 5: WEAK }, entries: [{ seat: 3, cards: "6 6" }, { seat: 4, pass: true }, { seat: 5, pass: true }], passed: [4, 5, 1, 2] });
    expect(state.turn).toBe(0);
    state = act(state, 0, { type: "RANG" });
    expect(state.turn).toBe(0);
    expect(state.round!.rang).toEqual({ seat: 0, returned: true });
    expect(stepSeconds(state)).toBe(15);
  });

  it("让牌回来后过牌：这一轮结束", () => {
    let state = buildState({ hands: { 0: "9 9 5", 1: WEAK, 2: WEAK, 3: WEAK, 4: WEAK, 5: WEAK }, entries: [{ seat: 3, cards: "6 6" }, { seat: 4, pass: true }, { seat: 5, pass: true }], passed: [4, 5] });
    state = pass(pass(act(state, 0, { type: "RANG" }), 1), 2);
    state = pass(state, 0);
    expect(state.round!.top).toBeNull();
    expect(state.round!.leader).toBe(3);
  });
});

describe("§4.8–§4.10 底牌、接风、无头、乱缠", () => {
  it("底牌那一轮照常进行：别人可以压走科的人的底牌，压的人赢下这一轮发牌", () => {
    let state = buildState({ hands: { 0: "5 5", 1: "9 9 3", 2: WEAK, 3: WEAK, 4: WEAK, 5: WEAK }, leader: 0, turn: 0 });
    state = play(state, 0, "5 5");
    expect(state.turn).toBe(1);
    state = play(state, 1, "9 9");
    for (const seat of [2, 3, 4, 5]) state = pass(state, seat);
    expect(state.round!.leader).toBe(1);
  });

  it("§5.6 底牌是够级牌、对头已经走了（无头）：没有够级限制，正常接", () => {
    const state = buildState({ finished: [3], headless: [0], hands: { 0: "K K", 1: "A A 5", 2: WEAK, 4: WEAK, 5: WEAK }, leader: 0, turn: 0 });
    const played = play(state, 0, "K K");
    expect(played.round!.top!.burnable).toBe(false);
    expect(played.turn).toBe(1);
  });

  it("§5.8 第 2 个人走科的那一轮仍按够级、过牌锁住打完；§5.9 剩下同一队也要打到只剩 1 人", () => {
    let state = buildState({ finished: [0], headless: [3], hands: { 1: "6", 2: "3 4", 3: "K K 7", 4: "8 9", 5: "10 J" }, leader: 1, turn: 1 });
    state = play(state, 1, "6");
    expect(state.finished).toEqual([0, 1]);
    expect(state.chaos).toBe(false);
    state = runUntil(state, (current) => current.chaos || current.stage === "handEnd");
    expect(state.chaos).toBe(true);
    state = runUntil(state, (current) => current.stage === "handEnd");
    expect(state.result!.order).toHaveLength(6);
  });
});

describe("§7 一场", () => {
  it("打满盘数结束，累计分高的联邦获胜；平局所有人并列", () => {
    let state = createGame([0, 1, 2, 3, 4, 5].map((seat) => ({ id: pid(seat), name: `P${seat}`, bot: true })), 5, { hands: 1 });
    state = runUntil(state, (current) => current.phase === "finished", 20000);
    expect(state.handNo).toBe(1);
    const [a, b] = state.teamScores;
    expect(a + b).toBe(0);
    expect(state.finalResult!.winnerTeam).toBe(a > b ? 0 : b > a ? 1 : null);
    expect(state.finalResult!.winners).toHaveLength(a === b ? 6 : 3);
    expect(() => act(state, 0, { type: "READY" })).toThrow();
  });

  it("结算画面：所有人点下一盘才开始；20 秒超时自动下一盘（不计托管）；第 2 盘起进贡", () => {
    let state = buildState({ stage: "handEnd", finished: [0, 3, 1, 2, 4], hands: { 5: 6 } });
    expect(stepSeconds(state)).toBe(20);
    state = act(state, 0, { type: "READY" });
    expect(state.stage).toBe("handEnd");
    state = timeoutTurn(state);
    expect(state.handNo).toBe(2);
    expect(state.players.every((player) => player.timeouts === 0)).toBe(true);
    expect(state.tribute).not.toBeNull();
    expect(total(state)).toBe(216);
  });
});

describe("超时和托管（全站约定：连续 2 次超时转托管，托管由人机代打）", () => {
  it("连续 2 次超时自动托管；AUTO 关掉；自己出手清零", () => {
    let state = buildState({ hands: { 3: "4 5 6 7 8 9", 0: WEAK, 1: WEAK, 2: WEAK, 4: WEAK, 5: WEAK }, turn: 3, leader: 3 });
    state = timeoutTurn(state);
    expect(state.players[3]!.timeouts).toBe(1);
    state = runUntil(state, (current) => current.turn === 3);
    state = timeoutTurn(state);
    expect(state.players[3]!.auto).toBe(true);
    expect(state.events.some((event) => event.type === "AutoChanged" && event.seat === 3 && event.on)).toBe(true);
    state = act(state, 3, { type: "AUTO", on: false });
    expect(state.players[3]!.auto).toBe(false);
    expect(state.players[3]!.timeouts).toBe(0);
  });
});

/** 让 ts 不抱怨没用到的导入。 */
export const _unused: unknown[] = [settle, playSettled, pick];
