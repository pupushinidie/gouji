/**
 * 够级房间服务器：选座换座、开局补人机、一整场 + 再来一局、烧牌窗口（先按的烧牌别人察觉不到、满窗口才结算）、
 * 计时 key（烧牌是轮外操作，不重置别人的倒计时）、超时和托管、离线代打和原昵称回座、复盘日志。
 */
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";
import {
  applyCommand,
  buildState,
  legalCommands,
  createGame,
  tickBurnWindow,
  timeoutTurn,
  type AckResponse,
  type ClientToServerEvents,
  type GameCommand,
  type GameState,
  type LobbyRoomSnapshot,
  type ServerToClientEvents,
} from "@gouji/game";

// 服务端在导入时读这些变量：人机立刻出手、每步 600 ms 超时、烧牌窗口 300 ms、离线 200 ms 后代打。
process.env.BOT_DELAY_SCALE = "0";
process.env.TURN_MS = "600";
process.env.BURN_WINDOW_MS = "300";
process.env.OFFLINE_TURN_MS = "200";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const clients = new Set<TestSocket>();
const latest = new Map<TestSocket, LobbyRoomSnapshot>();
const received = new Map<TestSocket, { at: number; room: LobbyRoomSnapshot }[]>();
let serverUrl = "";
let server: typeof import("../src/index.js");
let nameSeq = 0;

function connect(): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const client: TestSocket = createClient(serverUrl, { transports: ["websocket"], reconnection: false });
    clients.add(client);
    received.set(client, []);
    client.on("room:updated", (room) => {
      latest.set(client, room);
      received.get(client)!.push({ at: Date.now(), room });
    });
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });
}

const nick = (prefix: string) => `${prefix}${(nameSeq += 1)}`;
const call = <T,>(send: (ack: (response: AckResponse<T>) => void) => void): Promise<AckResponse<T>> => new Promise((resolve) => send(resolve));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function create(client: TestSocket, name: string, options: Record<string, unknown> = {}): Promise<LobbyRoomSnapshot> {
  const response = await call<LobbyRoomSnapshot>((ack) => client.emit("room:create", { name, options }, ack));
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

async function join(client: TestSocket, name: string, code: string): Promise<LobbyRoomSnapshot> {
  const response = await call<LobbyRoomSnapshot>((ack) => client.emit("room:join", { name, code }, ack));
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

function updateWhere(client: TestSocket, test: (room: LobbyRoomSnapshot) => boolean, timeoutMs = 20_000): Promise<LobbyRoomSnapshot> {
  return new Promise((resolve, reject) => {
    const current = latest.get(client);
    if (current && test(current)) return resolve(current);
    const timer = setTimeout(() => {
      client.off("room:updated", handler);
      reject(new Error("等不到想要的房间状态"));
    }, timeoutMs);
    const handler = (room: LobbyRoomSnapshot) => {
      if (!test(room)) return;
      clearTimeout(timer);
      client.off("room:updated", handler);
      resolve(room);
    };
    client.on("room:updated", handler);
  });
}

const me = (client: TestSocket) => latest.get(client)!.members.find((member) => member.id === client.id)!;

/** 把预览局面工厂造的局面换成房间里的玩家：有人坐的座位用他的 id，空座是人机。 */
function adopt(state: GameState, room: LobbyRoomSnapshot): GameState {
  const next = structuredClone(state);
  next.players = next.players.map((player, seat) => {
    const member = room.members.find((candidate) => candidate.seat === seat);
    return member ? { ...player, id: member.playerId, name: member.name, bot: false } : { ...player, id: `bot${seat}`, bot: true };
  });
  return next;
}

/** 轮到这个真人时自动出第一个合法操作（发牌出最小的单张、接牌过牌……）。 */
function autoplay(client: TestSocket): () => void {
  let sentFor = "";
  const handler = (room: LobbyRoomSnapshot) => {
    const game = room.game;
    if (!game || game.phase === "finished") return;
    const actions = legalCommands(game, me(client).playerId).filter((command) => command.type !== "BURN");
    const key = `${game.version}:${game.turn}:${game.stage}`;
    if (actions.length === 0 || sentFor === key) return;
    sentFor = key;
    client.emit("game:command", actions[0]!, () => {});
  };
  client.on("room:updated", handler);
  const current = latest.get(client);
  if (current) handler(current);
  return () => client.off("room:updated", handler);
}

describe("够级房间", () => {
  beforeAll(async () => {
    server = await import("../src/index.js");
    await new Promise<void>((resolve, reject) => {
      server.httpServer.once("error", reject);
      server.httpServer.listen(0, resolve);
    });
    serverUrl = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.io.close(() => resolve()));
  });

  it("建房默认 5 盘、进贡让牌看牌都开；选座就是选队：自动按 0、3、1… 坐，能换空座，房主能对调；开局空座由咕噜一号…补满", async () => {
    const host = await connect();
    const room = await create(host, nick("房主"));
    expect(room.options).toEqual({ hands: 5, tribute: true, rang: true, peek: true });
    expect(room.members[0]!.seat).toBe(0);
    const guest = await connect();
    const guestName = nick("客人");
    expect((await join(guest, guestName, room.code)).members.find((member) => member.name === guestName)!.seat).toBe(3);
    const third = await connect();
    await join(third, nick("路人"), room.code);
    expect(me(third)?.seat ?? (await updateWhere(third, (snapshot) => snapshot.members.length === 3)).members[2]!.seat).toBe(1);

    expect((await call<void>((ack) => guest.emit("room:seat", 0, ack))).ok).toBe(false); // 有人
    expect((await call<void>((ack) => guest.emit("room:seat", 9, ack))).ok).toBe(false);
    expect((await call<void>((ack) => guest.emit("room:seat", 2, ack))).ok).toBe(true);
    expect((await call<void>((ack) => guest.emit("room:swap-seats", { a: 0, b: 5 }, ack))).ok).toBe(false); // 不是房主
    expect((await call<void>((ack) => host.emit("room:swap-seats", { a: 0, b: 5 }, ack))).ok).toBe(true);
    const seated = await updateWhere(host, (snapshot) => snapshot.members.find((member) => member.id === host.id)?.seat === 5);
    expect(seated.members.map((member) => member.seat).sort()).toEqual([1, 2, 5]);
    expect((await call<void>((ack) => host.emit("room:options", { hands: 4 } as never, ack))).ok).toBe(false);
    expect((await call<void>((ack) => host.emit("room:options", { hands: 1, rang: false }, ack))).ok).toBe(true);

    expect((await call<LobbyRoomSnapshot>((ack) => host.emit("room:start", ack))).ok).toBe(true);
    const started = await updateWhere(host, (snapshot) => snapshot.game !== undefined);
    const game = started.game!;
    expect(game.config.hands).toBe(1);
    expect(game.config.rang).toBe(false);
    expect(game.players[5]!.id).toBe(me(host).playerId);
    expect(game.players[2]!.name).toBe(guestName);
    expect(game.players.filter((player) => player.bot).map((player) => player.name)).toEqual(["咕噜一号", "咕噜二号", "咕噜三号"]);
    expect(game.players.map((player) => player.team)).toEqual([0, 1, 0, 1, 0, 1]);
    expect((await call<void>((ack) => guest.emit("room:seat", 4, ack))).ok).toBe(false); // 开局后不能换
    await call<void>((ack) => host.emit("room:dissolve", ack));
  });

  it("一个真人 + 5 个人机打完一场（1 盘），再来一局；对局记录能用种子和操作序列复现", async () => {
    const host = await connect();
    const room = await create(host, nick("单人"), { hands: 1 });
    const stop = autoplay(host);
    expect((await call<LobbyRoomSnapshot>((ack) => host.emit("room:start", ack))).ok).toBe(true);
    const finished = await updateWhere(host, (snapshot) => snapshot.game?.phase === "finished", 60_000);
    stop();
    expect(finished.game!.finalResult).toBeDefined();
    expect(finished.rematch).toBeDefined();
    // 复盘：同一种子重放操作序列，得到同样的结果
    const { seed, actions } = server.testHooks.actions(room.code);
    const real = server.testHooks.game(room.code)!;
    let replay = createGame(real.players.map((player) => ({ id: player.id, name: player.name, bot: player.bot })), seed!, { hands: 1 });
    for (const action of actions) {
      if (action.command.type === "TIMEOUT") replay = timeoutTurn(replay, action.command.seats);
      else if (action.command.type === "TICK") replay = tickBurnWindow(replay);
      else replay = applyCommand(replay, replay.players[action.seat]!.id, action.command as GameCommand);
    }
    expect(replay.teamScores).toEqual(real.teamScores);
    expect(replay.version).toBe(real.version);
    expect(actions.some((action) => action.command.type === "TICK")).toBe(true);

    expect((await call<void>((ack) => host.emit("room:rematch", true, ack))).ok).toBe(true);
    const again = await updateWhere(host, (snapshot) => snapshot.game?.phase === "playing" && !snapshot.rematch);
    expect(again.game!.handNo).toBe(1);
    expect(again.game!.teamScores).toEqual([0, 0]);
    await call<void>((ack) => host.emit("room:dissolve", ack));
  }, 90_000);

  it("烧牌窗口：先按的烧牌只有自己收到更新，别人一条都收不到；满窗口时一起结算；对头的动作也等满窗口才生效", async () => {
    const host = await connect();
    const room = await create(host, nick("烧牌"));
    const guest = await connect();
    await join(guest, nick("对面"), room.code); // 座位 3
    await updateWhere(host, (snapshot) => snapshot.members.length === 2);
    const snapshotNow = latest.get(host)!;
    // 座位 1（人机）发 K K；座位 0（房主）能烧；座位 4（人机，1 的对头）是正常接牌的人
    const scene = buildState({ hands: { 0: "A A 7 7 7 9 9 小 大", 1: 20, 2: "3 4 5 6 7 8 9 10 J Q 3 4 5 6 7 8", 3: 20, 4: 20, 5: "3 4 5 6 7 8 9 10 J Q 3 4 5 6 7 8" }, top: { seat: 1, cards: "K K" } });
    const t0 = Date.now();
    server.testHooks.setGame(room.code, adopt(scene, snapshotNow));
    const first = await updateWhere(guest, (snapshot) => snapshot.game?.round?.top?.seat === 1);
    expect(first.game!.you!.burnCandidates).toEqual([]);
    const hostView = await updateWhere(host, (snapshot) => snapshot.game?.round?.top?.seat === 1);
    expect(hostView.game!.you!.burnCandidates.length).toBe(1);
    const guestCount = received.get(guest)!.length;
    const burnAck = await call<LobbyRoomSnapshot>((ack) => host.emit("game:command", { type: "BURN", cards: hostView.game!.you!.burnCandidates[0]! }, ack));
    expect(burnAck.ok).toBe(true);
    expect(burnAck.ok && burnAck.data.game!.you!.burnRequested).not.toBeNull();
    await delay(150);
    // 窗口没满：对面一条更新都没收到（人机 4 的过牌也只是先收下）
    expect(received.get(guest)!.length).toBe(guestCount);
    const resolved = await updateWhere(guest, (snapshot) => snapshot.game?.burn?.burner === 0);
    const at = received.get(guest)!.find((entry) => entry.room === resolved)!.at;
    expect(at - t0).toBeGreaterThanOrEqual(290);
    expect(resolved.game!.round!.top!.seat).toBe(0);
    await call<void>((ack) => host.emit("room:dissolve", ack));
  });

  it("计时 key：烧牌窗口里别人按烧牌（轮外操作）不会让轮到的人收到更新、倒计时不重置；窗口满了没人烧，倒计时接着走", async () => {
    const host = await connect();
    const room = await create(host, nick("计时"));
    const guest = await connect();
    await join(guest, nick("对头"), room.code); // 座位 3
    const burner = await connect();
    await join(burner, nick("烧家"), room.code); // 座位 1
    await updateWhere(host, (snapshot) => snapshot.members.length === 3);
    const hands = { 0: "5 6 7 8 9 10 J Q 4 4 4 4", 3: "A A 4 9 10 J Q 5 5 6 6 7", 1: "A A 7 7 7 9 9 小 大", 2: 20, 4: 20, 5: 20 };
    // 座位 0（房主）发 K K，座位 3（真人对头）接；座位 1（真人）能烧
    server.testHooks.setGame(room.code, adopt(buildState({ hands, top: { seat: 0, cards: "K K" } }), latest.get(host)!));
    const start = await updateWhere(guest, (snapshot) => snapshot.game?.turn === 3 && snapshot.game.round?.top?.seat === 0);
    expect(start.turnRemainingMs).toBeGreaterThan(400);
    const burnView = await updateWhere(burner, (snapshot) => (snapshot.game?.you?.burnCandidates.length ?? 0) > 0);
    const before = received.get(guest)!.length;
    expect((await call<LobbyRoomSnapshot>((ack) => burner.emit("game:command", { type: "BURN", cards: burnView.game!.you!.burnCandidates[0]! }, ack))).ok).toBe(true);
    await delay(120);
    expect(received.get(guest)!.length).toBe(before);
    // 满窗口：烧牌成立，轮到 1 的对头 4（人机）——这是换人，计时重新开始
    const burned = await updateWhere(guest, (snapshot) => snapshot.game?.burn?.burner === 1);
    expect(burned.game!.turn).not.toBe(3);

    // 没人烧的情况：窗口满了还是轮到 3，倒计时接着走（没有重新开始）
    server.testHooks.setGame(room.code, adopt(buildState({ hands: { ...hands, 1: 20 }, top: { seat: 0, cards: "K K" } }), latest.get(host)!));
    const again = await updateWhere(guest, (snapshot) => snapshot.game?.turn === 3 && snapshot.game.round?.top?.ready === false && !snapshot.game.burn);
    const ticked = await updateWhere(guest, (snapshot) => snapshot.game?.round?.top?.ready === true);
    expect(ticked.game!.turn).toBe(3);
    expect(ticked.turnRemainingMs).toBeLessThan(again.turnRemainingMs! - 200);
    await call<void>((ack) => host.emit("room:dissolve", ack));
  });

  it("超时：发牌超时出最小的一张；连续 2 次超时转托管（人机代打），取消托管后恢复", async () => {
    const host = await connect();
    const room = await create(host, nick("超时"));
    await updateWhere(host, (snapshot) => snapshot.members.length === 1);
    const leadScene = () => buildState({ hands: { 0: "4 4 6 9 J 2", 1: 20, 2: 20, 3: 20, 4: 20, 5: 20 }, turn: 0, leader: 0 });
    server.testHooks.setGame(room.code, adopt(leadScene(), latest.get(host)!));
    const first = await updateWhere(host, (snapshot) => snapshot.game?.history.some((event) => event.type === "TimedOut" && event.seat === 0) === true, 5000);
    expect(first.game!.players[0]!.timeouts).toBe(1);
    expect(first.game!.history.find((event) => event.type === "Played" && event.seat === 0)).toMatchObject({ auto: true });
    const second = adopt(leadScene(), latest.get(host)!);
    second.players[0]!.timeouts = 1;
    server.testHooks.setGame(room.code, second);
    const auto = await updateWhere(host, (snapshot) => snapshot.game?.players[0]!.auto === true, 5000);
    expect(auto.game!.history.some((event) => event.type === "AutoChanged" && event.on)).toBe(true);
    expect((await call<LobbyRoomSnapshot>((ack) => host.emit("game:command", { type: "AUTO", on: false }, ack))).ok).toBe(true);
    await updateWhere(host, (snapshot) => snapshot.game?.players[0]!.auto === false);
    await call<void>((ack) => host.emit("room:dissolve", ack));
  });

  it("离线的人轮到时由人机代打；用原昵称加房间码回来，座位和手牌都还在", async () => {
    const host = await connect();
    const room = await create(host, nick("房主"));
    const guest = await connect();
    const guestName = nick("掉线");
    await join(guest, guestName, room.code); // 座位 3
    await updateWhere(host, (snapshot) => snapshot.members.length === 2);
    const scene = buildState({ hands: { 3: "4 4 6 9 J 2 8 8", 0: 20, 1: 20, 2: 20, 4: 20, 5: 20 }, turn: 3, leader: 3 });
    server.testHooks.setGame(room.code, adopt(scene, latest.get(host)!));
    await updateWhere(guest, (snapshot) => snapshot.game?.turn === 3);
    guest.disconnect();
    const covered = await updateWhere(host, (snapshot) => snapshot.game?.history.some((event) => event.type === "Played" && event.seat === 3) === true, 5000);
    expect(covered.members.find((member) => member.name === guestName)!.connected).toBe(false);
    const back = await connect();
    const rejoined = await join(back, guestName, room.code);
    const member = rejoined.members.find((candidate) => candidate.name === guestName)!;
    expect(member.connected).toBe(true);
    expect(member.seat).toBe(3);
    expect(rejoined.game!.players[3]!.hand.length).toBe(rejoined.game!.players[3]!.handCount);
    expect(rejoined.game!.players[3]!.hand.length).toBeGreaterThan(0);
    await call<void>((ack) => host.emit("room:dissolve", ack));
  });
});
