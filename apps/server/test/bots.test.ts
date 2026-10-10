/**
 * 人机和托管的服务器接线（固定座位的做法，同斗地主）：开局空座自动补人机、一个人打完一整场、
 * 真人都离线的房间关闭、连续 2 次超时转托管后人机代打、离线 3 秒（测试里缩短）代打和原昵称回座。
 * 人机策略本身归人机阶段（packages/game/src/bot.ts），这里只测接线。
 */
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";
import type { AckResponse, ClientToServerEvents, LobbyRoomSnapshot, PublicRoomSummary, ServerToClientEvents } from "@gouji/game";

process.env.BOT_DELAY_SCALE = "0";
process.env.TURN_MS = "300";
process.env.BURN_WINDOW_MS = "50";
process.env.OFFLINE_TURN_MS = "200";
process.env.ROOM_ABANDON_MS = "400";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const clients = new Set<TestSocket>();
const latest = new Map<TestSocket, LobbyRoomSnapshot>();
let serverUrl = "";
let server: typeof import("../src/index.js");
let nameSeq = 0;

function connect(): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const client: TestSocket = createClient(serverUrl, { transports: ["websocket"], reconnection: false });
    clients.add(client);
    client.on("room:updated", (room) => latest.set(client, room));
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });
}
const nick = (prefix: string) => `${prefix}${(nameSeq += 1)}`;
const call = <T,>(send: (ack: (response: AckResponse<T>) => void) => void): Promise<AckResponse<T>> => new Promise((resolve) => send(resolve));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lobby = (client: TestSocket) => new Promise<PublicRoomSummary[]>((resolve) => client.emit("lobby:get", (response) => resolve(response.ok ? response.data : [])));

function updateWhere(client: TestSocket, test: (room: LobbyRoomSnapshot) => boolean, timeoutMs = 30_000): Promise<LobbyRoomSnapshot> {
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

async function create(client: TestSocket, name: string, options: Record<string, unknown> = {}): Promise<LobbyRoomSnapshot> {
  const response = await call<LobbyRoomSnapshot>((ack) => client.emit("room:create", { name, options }, ack));
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

describe("人机和托管", () => {
  beforeAll(async () => {
    server = await import("../src/index.js");
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    serverUrl = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.io.close(() => resolve()));
  });

  it("开局时 5 个空座自动补人机（咕噜一号…五号，带人机标记）；首页列表只列真人", async () => {
    const host = await connect();
    const name = nick("独自");
    await create(host, name, { hands: 1 });
    expect((await call<LobbyRoomSnapshot>((ack) => host.emit("room:start", ack))).ok).toBe(true);
    const room = await updateWhere(host, (snapshot) => snapshot.game !== undefined);
    expect(room.game!.players.filter((player) => player.bot).map((player) => player.name)).toEqual(["咕噜一号", "咕噜二号", "咕噜三号", "咕噜四号", "咕噜五号"]);
    expect(room.members).toHaveLength(1);
    const summary = (await lobby(host)).find((candidate) => candidate.players[0]?.name === name)!;
    expect(summary.players).toHaveLength(1);
    await call<void>((ack) => host.emit("room:dissolve", ack));
  });

  it("真人挂机：连续 2 次超时转托管，之后由人机替他打，不再超时；一整场能打完", async () => {
    const host = await connect();
    await create(host, nick("挂机"), { hands: 1 });
    expect((await call<LobbyRoomSnapshot>((ack) => host.emit("room:start", ack))).ok).toBe(true);
    const auto = await updateWhere(host, (snapshot) => snapshot.game?.players.find((player) => !player.bot)?.auto === true, 30_000);
    const seat = auto.game!.players.findIndex((player) => !player.bot);
    const timedOutBefore = auto.game!.history.filter((event) => event.type === "TimedOut" && event.seat === seat).length;
    expect(timedOutBefore).toBeGreaterThanOrEqual(1);
    const finished = await updateWhere(host, (snapshot) => snapshot.game?.phase === "finished", 60_000);
    const playedAfter = finished.game!.history.filter((event) => event.type === "Played" && event.seat === seat && !event.auto).length;
    expect(playedAfter + finished.game!.history.filter((event) => event.type === "Passed" && event.seat === seat && !event.auto).length).toBeGreaterThan(0);
    await call<void>((ack) => host.emit("room:dissolve", ack));
  }, 90_000);

  it("真人都离线的房间过一会儿关闭；离线的人轮到时人机代打", async () => {
    const host = await connect();
    const name = nick("离开");
    await create(host, name, { hands: 1 });
    expect((await call<LobbyRoomSnapshot>((ack) => host.emit("room:start", ack))).ok).toBe(true);
    await updateWhere(host, (snapshot) => snapshot.game !== undefined);
    host.disconnect();
    const watcher = await connect();
    await delay(150);
    expect((await lobby(watcher)).some((room) => room.players[0]?.name === name)).toBe(true);
    await delay(600);
    expect((await lobby(watcher)).some((room) => room.players[0]?.name === name)).toBe(false);
  });

  it("离线后用原昵称回来接管座位，托管 / 代打结束", async () => {
    const host = await connect();
    const name = nick("回来");
    const created = await create(host, name, { hands: 1 });
    const friend = await connect();
    await call<LobbyRoomSnapshot>((ack) => friend.emit("room:join", { name: nick("朋友"), code: created.code }, ack));
    expect((await call<LobbyRoomSnapshot>((ack) => host.emit("room:start", ack))).ok).toBe(true);
    await updateWhere(friend, (snapshot) => snapshot.game !== undefined);
    host.disconnect();
    await updateWhere(friend, (snapshot) => snapshot.members.find((member) => member.name === name)?.connected === false);
    await delay(500);
    const back = await connect();
    const rejoined = await call<LobbyRoomSnapshot>((ack) => back.emit("room:join", { name, code: created.code }, ack));
    expect(rejoined.ok).toBe(true);
    if (rejoined.ok) {
      const member = rejoined.data.members.find((candidate) => candidate.name === name)!;
      expect(member.connected).toBe(true);
      expect(member.seat).toBe(0);
      expect(rejoined.data.game!.players[0]!.hand.length).toBe(rejoined.data.game!.players[0]!.handCount);
    }
    await call<void>((ack) => back.emit("room:dissolve", ack));
  });
});
