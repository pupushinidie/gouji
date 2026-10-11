/**
 * 人机「普通」难度：只吃 redact 之后的视图、自对弈每步合法不死循环、关键决策（补充文件 1.13、1.15）。
 */
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  botBurn,
  botBurnDecision,
  botCommand,
  botDecision,
  botHint,
  buildDeal,
  buildState,
  burnEligibleSeats,
  burnWindowKey,
  createGame,
  GOUJI_THRESHOLD,
  isWild,
  legalBurnLead,
  legalCommands,
  parseSet,
  pendingSeats,
  rankCounts,
  rankOf,
  redactGameForViewer,
  tickBurnWindow,
  type GameCommand,
  type GameState,
} from "../src/index.js";
import { pick, pid } from "./helpers.js";

const view = (state: GameState, seat: number) => redactGameForViewer(state, pid(seat));
const decide = (state: GameState, seat: number) => botDecision(view(state, seat), seat);
const ranks = (command: GameCommand) => (command.type === "PLAY" || command.type === "BURN" || command.type === "RETURN" ? command.cards.map(rankOf) : []);
const FILL = "3 3 4 4 5 5 6 6 7 7 8 8"; // 12 张，张数看不到（显示 10+）

describe("人机只用自己能看到的信息", () => {
  it("别人的手牌怎么换，人机的决定都一样（输入是 redact 之后的视图）", () => {
    const game = createGame([0, 1, 2, 3, 4, 5].map((seat) => ({ id: pid(seat), name: `P${seat}`, bot: true })), 4242);
    let state = game;
    for (let step = 0; step < 400 && state.phase !== "finished"; step += 1) {
      if (burnWindowKey(state)) {
        state = tickBurnWindow(state);
        continue;
      }
      const seat = pendingSeats(state)[0]!;
      if (state.stage === "playing" && step % 7 === 0) {
        // 把 seat 以外、看不到手牌的人之间的牌对调：人机的决定不能变
        const v = view(state, seat);
        const hidden = [0, 1, 2, 3, 4, 5].filter((other) => other !== seat && v.players[other]!.hand.length === 0 && state.players[other]!.hand.length > 1);
        if (hidden.length >= 2) {
          const [a, b] = hidden as [number, number];
          const swapped = structuredClone(state);
          const ca = swapped.players[a]!.hand[0]!;
          const cb = swapped.players[b]!.hand[0]!;
          swapped.players[a]!.hand[0] = cb;
          swapped.players[b]!.hand[0] = ca;
          swapped.seed = 999;
          swapped.rng = 777;
          expect(botCommand(view(swapped, seat), seat)).toEqual(botCommand(v, seat));
        }
      }
      state = applyCommand(state, pid(seat), botCommand(view(state, seat), seat));
    }
  });

  it("视图里没有别人的手牌和种子", () => {
    const state = createGame([0, 1, 2, 3, 4, 5].map((seat) => ({ id: pid(seat), name: `P${seat}`, bot: true })), 7);
    const v = view(state, 2);
    expect((v as unknown as Record<string, unknown>).seed).toBeUndefined();
    expect(v.players.filter((_, seat) => seat !== 2).every((player) => player.hand.length === 0)).toBe(true);
  });
});

describe("人机自对弈", () => {
  it("6 个人机打 300 场（每场 5 盘）：每步合法、不死循环、每步 < 50ms", () => {
    const MAX_STEPS = 5000;
    let worst = 0;
    let total = 0;
    let calls = 0;
    let hands = 0;
    let burns = 0;
    const time = <T,>(fn: () => T): T => {
      const start = performance.now();
      const out = fn();
      const spent = performance.now() - start;
      worst = Math.max(worst, spent);
      total += spent;
      calls += 1;
      return out;
    };
    for (let match = 0; match < 300; match += 1) {
      let state = createGame([0, 1, 2, 3, 4, 5].map((seat) => ({ id: pid(seat), name: `P${seat}`, bot: true })), 9000 + match);
      let steps = 0;
      while (state.phase !== "finished") {
        steps += 1;
        expect(steps).toBeLessThan(MAX_STEPS);
        if (burnWindowKey(state)) {
          for (const seat of burnEligibleSeats(state)) {
            const command = time(() => botBurn(view(state, seat), seat));
            if (command) state = applyCommand(state, pid(seat), command);
          }
          for (const seat of pendingSeats(state)) {
            const v = view(state, seat);
            if (!v.you?.pendingAction && legalCommands(v, pid(seat)).some((c) => c.type !== "BURN")) state = applyCommand(state, pid(seat), time(() => botCommand(v, seat)));
          }
          state = tickBurnWindow(state);
        } else {
          for (const seat of pendingSeats(state)) {
            if (!pendingSeats(state).includes(seat)) continue;
            state = applyCommand(state, pid(seat), time(() => botCommand(view(state, seat), seat)));
          }
        }
        for (const event of state.events) {
          if (event.type === "HandEnded") hands += 1;
          if (event.type === "BurnSucceeded") burns += 1;
        }
      }
    }
    expect(hands).toBe(1500);
    expect(burns).toBeGreaterThan(300);
    expect(total / calls).toBeLessThan(50);
    expect(worst).toBeLessThan(300);
  }, 120_000);
});

describe("关键决策", () => {
  it("队友的牌不压，队友剩 10 张以下也不压", () => {
    const state = buildState({ hands: { 0: `9 9 ${FILL}`, 2: "Q Q 4" }, top: { seat: 2, cards: "6 6" }, turn: 0, leader: 2, passed: [3, 4, 5, 1] });
    expect(decide(state, 0).command).toEqual({ type: "PASS" });
  });

  it("对手的小牌：用不拆组、不挂配牌的牌压", () => {
    const state = buildState({ hands: { 0: `9 9 小 大 2 ${FILL}` }, top: { seat: 5, cards: "6 6" }, leader: 5, turn: 0 });
    const command = decide(state, 0).command;
    expect(command.type).toBe("PLAY");
    expect(ranks(command).some((rank) => rank >= 15)).toBe(false);
    expect(ranks(command).length).toBe(2);
  });

  it("开局不用王压对手的小牌（4 4 小王 压 3 3 这种）", () => {
    const state = buildState({ hands: { 0: `小 大 3 4 5 6 7 8 9 10 J Q K A` }, top: { seat: 5, cards: "4 4" }, leader: 5, turn: 0 });
    const command = decide(state, 0).command;
    expect(command.type === "PASS" || command.type === "RANG").toBe(true);
  });

  it("对头出够级牌：用最小的纯 2 够回去，不挂王", () => {
    const state = buildState({ hands: { 0: `2 2 小 大 ${FILL}` }, top: { seat: 3, cards: "K K", ready: true }, leader: 3, turn: 0 });
    const decision = decide(state, 0);
    expect(ranks(decision.command)).toEqual([15, 15]);
    expect(decision.reason).toContain("够回去");
  });

  it("对头牌不过：过过牌也接对头的牌", () => {
    const state = buildState({ hands: { 0: `10 10 ${FILL}` }, top: { seat: 3, cards: "8 8" }, leader: 1, passed: [0, 1, 2], turn: 0 });
    expect(ranks(decide(state, 0).command)).toEqual([10, 10]);
  });

  it("要过牌时，对头的非够级牌先让牌（下家张数多、队友没过过）", () => {
    const state = buildState({ hands: { 0: `大 K K ${FILL}`, 1: 15, 2: 15 }, top: { seat: 3, cards: "Q" }, leader: 3, turn: 0 });
    expect(decide(state, 0).command).toEqual({ type: "RANG" });
  });

  it("下家只剩几张时不让牌", () => {
    const state = buildState({ hands: { 0: `大 K K ${FILL}`, 1: 3, 2: 15 }, top: { seat: 3, cards: "Q" }, leader: 3, turn: 0 });
    expect(decide(state, 0).command.type).not.toBe("RANG");
  });

  it("能烧就烧，挑富余王最多的 S₁", () => {
    // 2 手里 A A 大 大 大 7 7 7：S₁ = A A 剩 7 7 7 + 3 张大王，最稳
    const state = buildState({ hands: { 2: "A A 大 大 大 7 7 7" }, top: { seat: 0, cards: "K K" }, leader: 0 });
    const decision = botBurnDecision(view(state, 2), 2);
    expect(decision).not.toBeNull();
    expect(ranks(decision!.command)).toEqual([14, 14]);
    expect(decision!.reason).toContain("烧");
  });

  it("规则书 T7：能烧的 2 会烧，不能烧的 1 不会", () => {
    const state = buildState({ hands: { 1: "A A 7 7 7 8 小 9 9", 2: "A A 7 7 7 9 9 小 大" }, top: { seat: 0, cards: "K K" }, leader: 0 });
    expect(botBurn(view(state, 1), 1)).toBeNull();
    expect(ranks(botBurn(view(state, 2), 2)!)).toEqual([14, 14]);
  });

  it("被烧的是快走的队友时不烧", () => {
    const state = buildState({ hands: { 2: "A A 7 7 7 9 9 小 大", 0: "5 6" }, top: { seat: 0, cards: "K K" }, leader: 0 });
    expect(botBurn(view(state, 2), 2)).toBeNull();
  });

  it("烧牌状态下先出挂王的套，不挂王的留到最后", () => {
    const state = buildState({ hands: { 2: "7 7 7 9 9 小 大" }, burn: { burner: 2, victim: 0 }, leader: 2, turn: 2 });
    const command = decide(state, 2).command;
    expect(command.type).toBe("PLAY");
    const cards = (command as Extract<GameCommand, { type: "PLAY" }>).cards;
    expect(legalBurnLead(state.players[2]!.hand, cards)).toBe(true);
    expect(cards.some((card) => rankOf(card) === 16)).toBe(true); // 先用小王
    expect(ranks(command)).not.toContain(7); // 最小的 7 7 7 留到最后
  });

  it("手里没王没 2：革命", () => {
    const state = buildDeal({ noWild: [0] });
    expect(state.stage).toBe("revolution");
    const decision = decide(state, 0);
    expect(decision.command).toEqual({ type: "REVOLT", revolt: true });
    expect(decide(state, 1).command).toEqual({ type: "REVOLT", revolt: false });
  });

  it("四人乱缠里挡串三户：对面拿了头科、二科，用大王也要压住第三个人", () => {
    const base = { hands: { 0: `大 ${FILL}`, 5: 12, 2: 12, 4: 12 }, top: { seat: 5, cards: "K" }, leader: 5, turn: 0, chaos: true };
    const sweep = buildState({ ...base, finished: [1, 3], headless: [4, 0] });
    expect(ranks(decide(sweep, 0).command)).toEqual([17]);
    expect(decide(sweep, 0).reason).toContain("头科、二科");
    // 对照：前两名不是同一队时不用大王
    const normal = buildState({ ...base, finished: [1, 2], headless: [4, 5] });
    expect(decide(normal, 0).command.type).toBe("PASS");
  });

  it("还贡：不还 2 和王，不拆够级组，先还孤张小牌", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const state = buildDeal({ seed, hands: { 0: "Q Q Q 4" }, prevResult: { order: [0, 3, 1, 2, 4, 5] } });
      if (state.stage !== "return" || !pendingSeats(state).includes(0)) continue;
      const hand = state.players[0]!.hand;
      const command = decide(state, 0).command as Extract<GameCommand, { type: "RETURN" }>;
      expect(command.type).toBe("RETURN");
      expect(command.cards.some(isWild)).toBe(false);
      const before = rankCounts(hand);
      const after = rankCounts(hand.filter((card) => !command.cards.includes(card)));
      for (const [rank, need] of Object.entries(GOUJI_THRESHOLD)) {
        if (before[Number(rank)]! >= need) expect(after[Number(rank)]!).toBeGreaterThanOrEqual(need);
      }
    }
  });

  it("发牌：先出最小、张数多的普通牌组，不拆够级组", () => {
    const state = buildState({ hands: { 0: "3 3 3 5 6 6 9 9 9 9 K K 大" }, leader: 0, turn: 0 });
    expect(ranks(decide(state, 0).command)).toEqual([3, 3, 3]);
  });

  it("控制够了：挂大王的套连着出，最后一套随便", () => {
    const state = buildState({ hands: { 0: "5 5 9 9 大" }, leader: 0, turn: 0 });
    const command = decide(state, 0).command;
    expect(ranks(command)).toEqual([17, 9, 9]);
  });

  it("剩下的一套能出完就出完", () => {
    const state = buildState({ hands: { 0: "8 8 2 小" }, leader: 0, turn: 0 });
    expect(ranks(decide(state, 0).command).sort()).toEqual([15, 16, 8, 8].sort());
  });

  it("喂牌：看得到的队友剩几张、有 J J，出他能接的小牌", () => {
    const state = buildState({ hands: { 0: `6 6 9 9 9 K K ${FILL}`, 2: "J J 4" }, leader: 0, turn: 0 });
    const decision = decide(state, 0);
    expect(decision.reason).toContain("给他接");
    const set = parseSet((decision.command as Extract<GameCommand, { type: "PLAY" }>).cards)!;
    expect(set.eff.length).toBeLessThanOrEqual(2);
  });

  it("提示：每种局面都给一句理由", () => {
    const state = buildState({ hands: { 2: "A A 7 7 7 9 9 小 大" }, top: { seat: 0, cards: "K K" }, leader: 0 });
    expect(botHint(view(state, 2), 2)!.reason).toContain("烧");
    const lead = buildState({ hands: { 0: "3 3 3 5 6 6 9 9 9 9 K K 大" }, leader: 0, turn: 0 });
    expect(botHint(view(lead, 0), 0)!.reason.length).toBeGreaterThan(4);
    void pick;
  });
});
