/**
 * 预览局面工厂是对外接口（界面、教程、验收都靠它）：每个场景都能造出来、216 张守恒、停在说好的阶段，
 * buildState / buildDeal 按参数造出精确局面，previewRoom 只带该看的东西。
 */
import { describe, expect, it } from "vitest";
import {
  buildDeal,
  buildState,
  burnWindowKey,
  canRang,
  cardsText,
  createScene,
  pendingSeats,
  previewRoom,
  redactGameForViewer,
  SCENE_NAMES,
  type SceneName,
} from "../src/index.js";
import { total } from "./helpers.js";

const EXPECT: Partial<Record<SceneName, (state: ReturnType<typeof createScene>) => void>> = {
  opening: (state) => {
    expect(state.stage).toBe("playing");
    expect(state.turn).toBe(0);
    expect(state.players.every((player) => player.hand.length === 36)).toBe(true);
  },
  tribute: (state) => {
    expect(state.stage).toBe("tribute");
    expect(pendingSeats(state)).toEqual([1]);
  },
  tributeReturn: (state) => expect(state.stage).toBe("return"),
  tributeWaived: (state) => expect(state.stage).toBe("return"),
  antiTribute: (state) => expect(state.tribute!.antiTribute).toEqual([4]),
  revolution: (state) => {
    expect(state.stage).toBe("revolution");
    expect(redactGameForViewer(state, "p1").you!.canRevolt).toBe(true);
  },
  revolutionPlay: (state) => {
    expect(state.revolutionary).toBe(4);
    expect(state.headless[1]).toBe(true);
  },
  goujiDuel: (state) => {
    expect(state.turn).toBe(3);
    expect(state.round!.top!.ready).toBe(true);
  },
  goujiWait: (state) => expect(burnWindowKey(state)).not.toBeNull(),
  burnWindow: (state) => expect(redactGameForViewer(state, "p1").you!.burnCandidates.map(cardsText)).toEqual(["A A"]),
  burnState: (state) => expect(state.burn).toEqual({ burner: 0, victim: 1 }),
  burnBroken: (state) => {
    expect(state.burn).toBeNull();
    expect(state.events.some((event) => event.type === "BurnBroken")).toBe(true);
  },
  rang: (state) => expect(canRang(state, 0)).toBe(true),
  rangReturned: (state) => expect(state.round!.rang).toEqual({ seat: 0, returned: true }),
  jiefeng: (state) => {
    expect(state.round!.leader).toBe(1);
    expect(state.headless[3]).toBe(true);
  },
  headless: (state) => expect(state.round!.top!.burnable).toBe(false),
  chaos: (state) => expect(state.chaos).toBe(true),
  handEnd: (state) => expect(state.result!.teamDeltas).toEqual([2, -2]),
  sweepEnd: (state) => expect(state.result!.sweep).toBe(true),
  revolutionSweepEnd: (state) => expect(state.result!.order).toEqual([0, 2, 4]),
  matchEnd: (state) => expect(state.finalResult!.winnerTeam).toBe(0),
  matchDraw: (state) => expect(state.finalResult!.draw).toBe(true),
  timeout: (state) => expect(state.events[0]).toMatchObject({ type: "TimedOut", seat: 3 }),
  auto: (state) => expect(state.players[0]!.auto).toBe(true),
};

describe("预览局面工厂", () => {
  for (const name of SCENE_NAMES) {
    it(`createScene("${name}")：216 张守恒，状态符合说明`, () => {
      const state = createScene(name);
      expect(total(state)).toBe(216);
      EXPECT[name]?.(state);
      // 每个视角都能正常 redact，并且拿不到种子
      for (const viewer of ["", "p1", "p2", "p3", "p4", "p5", "p6"]) expect(redactGameForViewer(state, viewer).seed).toBeUndefined();
    });
  }

  it("buildState：按参数造精确局面（手牌、桌面牌、过牌、无头、乱缠、走科、轮到谁按规则算）", () => {
    const state = buildState({
      hands: { 0: "A A 7 7 7 9 9 小 大", 1: 12, 2: "3 4 5", 3: 8, 4: 20 },
      finished: [5],
      headless: [2],
      top: { seat: 1, cards: "K K" },
      passed: [3],
      teamScores: [6, -6],
      handNo: 3,
    });
    expect(cardsText(state.players[0]!.hand)).toBe("大 小 A A 9 9 7 7 7");
    expect(state.players.map((player) => player.hand.length)).toEqual([9, 12, 3, 8, 20, 0]);
    expect(state.round!.top!.burnable).toBe(true);
    expect(state.round!.top!.ready).toBe(false);
    // 1 有头的够级牌：对头 4 接；2 无头、没过过牌，排在 4 前面
    expect(state.turn).toBe(2);
    expect(state.teamScores).toEqual([6, -6]);
    expect(state.players[1]!.score).toBe(-6);
    expect(total(state)).toBe(216);
  });

  it("buildDeal：指定的牌一定在手里，其余随机补满 36 张；noWild 的座位没有 2 和王", () => {
    const state = buildDeal({ hands: { 2: "大 大 大 大 K K" }, noWild: [3], seed: 9, firstLeader: 2 });
    expect(state.players.every((player) => player.hand.length === 36)).toBe(true);
    expect(cardsText(state.players[2]!.hand).startsWith("大 大 大 大")).toBe(true);
    expect(state.players[3]!.hand.every((card) => card % 54 < 48)).toBe(true);
    expect(state.stage).toBe("revolution");
  });

  it("previewRoom：带房间码、成员、倒计时；观战没有房间码和手牌", () => {
    const state = createScene("beforeRespond");
    const room = previewRoom(state, { viewerSeat: 0, turnRemainingMs: 12_000, offline: [5] });
    expect(room.code).toBe("ABC234");
    expect(room.members).toHaveLength(6);
    expect(room.members.find((member) => member.seat === 5)!.connected).toBe(false);
    expect(room.turnRemainingMs).toBe(12_000);
    expect(room.game!.you!.seat).toBe(0);
    const watch = previewRoom(state, { viewerSeat: -1, spectatorsSeeAll: true });
    expect(watch.code).toBe("");
    expect(watch.game!.you).toBeUndefined();
    expect(watch.game!.players.every((player) => player.hand.length === player.handCount)).toBe(true);
  });
});
