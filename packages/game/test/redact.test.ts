/**
 * 隐藏信息（规则书 4.12、9.4，流水线引擎交付标准第 4 条）：每个座位视角和观战视角都写断言。
 * 随机对局里还有几千次抽查（sim.ts 的 checkRedaction）。
 */
import { describe, expect, it } from "vitest";
import {
  buildDeal,
  buildState,
  createGame,
  createScene,
  previewRoom,
  redactGameForViewer,
  spectatorView,
  type Card,
  type GameState,
} from "../src/index.js";
import { burn, pid, play } from "./helpers.js";

const VIEWERS = [0, 1, 2, 3, 4, 5];

/** 视图里出现过的所有牌（手牌、革命者的牌、私人信息）。 */
function privateCards(view: GameState): Set<Card> {
  const cards = new Set<Card>();
  for (const player of view.players) for (const card of player.hand) cards.add(card);
  for (const card of view.revolutionHand) cards.add(card);
  for (const request of view.round?.burnRequests ?? []) for (const card of request.cards) cards.add(card);
  const pending = view.round?.pending?.command;
  if (pending?.type === "PLAY") for (const card of pending.cards) cards.add(card);
  for (const candidate of view.you?.burnCandidates ?? []) for (const card of candidate) cards.add(card);
  return cards;
}

describe("隐藏信息", () => {
  it("开局：每个座位只看得到自己的 36 张，别人的张数是 null（10+）；观战什么手牌都看不到；种子和随机数状态不下发", () => {
    const game = createGame(VIEWERS.map((seat) => ({ id: pid(seat), name: `P${seat}` })), 77);
    for (const viewer of VIEWERS) {
      const view = redactGameForViewer(game, pid(viewer));
      expect(view.seed).toBeUndefined();
      expect(view.rng).toBeUndefined();
      expect([...privateCards(view)].sort()).toEqual([...game.players[viewer]!.hand].sort());
      view.players.forEach((player, seat) => {
        if (seat !== viewer) expect(player.handCount).toBeNull();
      });
      expect(view.you!.seat).toBe(viewer);
    }
    const spectator = redactGameForViewer(game, "");
    expect(privateCards(spectator).size).toBe(0);
    expect(spectator.you).toBeUndefined();
    const seeAll = spectatorView(game, true);
    expect(seeAll.seed).toBeUndefined();
    expect(seeAll.players.every((player) => player.hand.length === 36)).toBe(true);
    expect(seeAll.you).toBeUndefined();
  });

  it("烧牌资格只发给本人：别人的视图里找不到候选，也看不出谁能烧", () => {
    const state = createScene("burnWindow");
    const own = redactGameForViewer(state, pid(0));
    expect(own.you!.burnCandidates.length).toBeGreaterThan(0);
    for (const viewer of [1, 2, 3, 4, 5]) {
      const view = redactGameForViewer(state, pid(viewer));
      expect(view.you!.burnCandidates).toEqual([]);
      expect(JSON.stringify(view)).not.toContain("burnCandidates\":[[");
    }
    expect(spectatorView(state, true).you).toBeUndefined();
  });

  it("按了烧牌（窗口还没满 2 秒）：只有自己看得到，别人的视图一个字节都不变", () => {
    const state = createScene("burnWindow");
    const requested = burn(state, 0, "A A");
    expect(requested.version).toBe(state.version);
    for (const viewer of [1, 2, 3, 4, 5]) {
      expect(JSON.stringify(redactGameForViewer(requested, pid(viewer)))).toBe(JSON.stringify(redactGameForViewer(state, pid(viewer))));
    }
    expect(JSON.stringify(spectatorView(requested, true))).toBe(JSON.stringify(spectatorView(state, true)));
    expect(redactGameForViewer(requested, pid(0)).you!.burnRequested).not.toBeNull();
  });

  it("看牌：队友剩 10 张以下看得到全部手牌，对手和观战看不到；10 张以上队友也看不到", () => {
    const state = buildState({ hands: { 0: "3 4 5 6 7 8 9 10 J Q", 1: 12, 2: 11, 3: 9, 4: 15, 5: 15 }, turn: 0, leader: 0 });
    for (const viewer of VIEWERS) {
      const view = redactGameForViewer(state, pid(viewer));
      expect(view.players[0]!.handCount).toBe(10);
      expect(view.players[3]!.handCount).toBe(9);
      expect(view.players[0]!.hand.length).toBe(viewer === 0 || viewer === 2 || viewer === 4 ? 10 : 0);
      expect(view.players[3]!.hand.length).toBe(viewer === 1 || viewer === 3 || viewer === 5 ? 9 : 0);
      if (viewer !== 2) {
        expect(view.players[2]!.hand).toEqual([]); // 11 张，队友也看不到
        expect(view.players[2]!.handCount).toBeNull();
      }
    }
    expect(redactGameForViewer(state, "").players[0]!.hand).toEqual([]);
  });

  it("革命者扣下的牌：队友、对手、观战（包括看全部手牌）都看不到，只有他自己", () => {
    const state = createScene("revolutionPlay");
    expect(state.revolutionHand.length).toBe(30);
    for (const viewer of [0, 1, 2, 3, 5]) expect(redactGameForViewer(state, pid(viewer)).revolutionHand).toEqual([]);
    expect(redactGameForViewer(state, pid(4)).revolutionHand).toHaveLength(30);
    expect(spectatorView(state, true).revolutionHand).toEqual([]);
    expect(redactGameForViewer(state, "").revolutionHand).toEqual([]);
  });

  it("革命阶段：谁能革命、选了什么只有自己知道", () => {
    const state = buildDeal({ noWild: [2], seed: 51, firstLeader: 0 });
    expect(state.stage).toBe("revolution");
    for (const viewer of VIEWERS) {
      const view = redactGameForViewer(state, pid(viewer));
      expect(view.revolution!.eligible).toEqual(viewer === 2 ? [2] : []);
      expect(view.you!.canRevolt).toBe(viewer === 2);
    }
    expect(redactGameForViewer(state, "").revolution!.eligible).toEqual([]);
  });

  it("一盘结束：剩下的人的手牌对所有人公开（革命者扣下的牌除外）", () => {
    const state = createScene("handEnd");
    for (const viewer of [0, 1, -1]) {
      const view = viewer >= 0 ? redactGameForViewer(state, pid(viewer)) : redactGameForViewer(state, "");
      expect(view.players[5]!.hand).toHaveLength(6);
      expect(view.players[5]!.handCount).toBe(6);
    }
  });

  it("先收下的出牌只给本人：对头在窗口里选了上牌，别人看不到他选了什么", () => {
    const state = createScene("goujiWait");
    const queued = play(state, 3, "2 2");
    expect(redactGameForViewer(queued, pid(3)).you!.pendingAction).toMatchObject({ type: "PLAY" });
    for (const viewer of [0, 1, 2, 4, 5]) {
      const view = redactGameForViewer(queued, pid(viewer));
      expect(view.round!.pending).toBeNull();
      expect(view.you!.pendingAction).toBeNull();
      expect(view.players[3]!.hand).toEqual(viewer === 5 || viewer === 1 ? view.players[3]!.hand : []);
    }
  });

  it("previewRoom：对手离线、观战视角都只带该看的东西", () => {
    const state = createScene("offline");
    const room = previewRoom(state, { viewerSeat: 0, offline: [3], turnRemainingMs: 0 });
    expect(room.members.find((member) => member.seat === 3)!.connected).toBe(false);
    expect(room.turnRemainingMs).toBe(0);
    expect(room.game!.players[3]!.hand).toEqual([]);
    const watch = previewRoom(state, { viewerSeat: -1 });
    expect(watch.code).toBe("");
    expect(watch.game!.players.every((player) => player.hand.length === 0)).toBe(true);
  });
});
