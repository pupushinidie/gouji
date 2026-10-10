import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "socket.io";
import {
  applyCommand,
  botBurn,
  botCommand,
  burnEligibleSeats,
  burnWindowKey,
  createGame,
  DEFAULT_OPTIONS,
  DEFAULT_ROOM_ACCESS,
  pendingSeats,
  redactGameForViewer,
  SEAT_COUNT,
  spectatorView,
  stepSeconds,
  tickBurnWindow,
  timeoutTurn,
  timerKey,
  topKey,
  scoreOf,
  type ClientToServerEvents,
  type GameCommand,
  type GameOptions,
  type IceServerConfig,
  type CreateRoomPayload,
  type GameState,
  type JoinRoomPayload,
  type LobbyMember,
  type LobbyRoomSnapshot,
  type PublicRoomSummary,
  type RoomChatMessage,
  type RoomAccess,
  type ServerToClientEvents,
  type Spectator,
  type VoiceSignal,
} from "@gouji/game";

interface RoomState {
  code: string;
  /** 对外展示用的随机标识，不泄露房间码。 */
  publicId: string;
  /** 玩法和开房选项（等待中房主可以改）。 */
  options: GameOptions;
  status: "waiting" | "playing";
  ownerId: string;
  members: LobbyMember[];
  /** 观战的人：不占座位，离开或断线就移出。 */
  spectators: Spectator[];
  /** 拿房间码进来（或者本来坐着改成观战）的观战者：看得到房间码，也能坐下。从列表进来的只有公开房间才能坐下。 */
  invited: Set<string>;
  access: RoomAccess;
  chat: RoomChatMessage[];
  game?: GameState;
  /** 下一位加入者的座位编号；座位 id 在对局里固定，断线重连只换连接 id。 */
  nextSeat: number;
  /** 对局中所有玩家都离线时启动的关闭计时器。 */
  abandonTimer?: ReturnType<typeof setTimeout>;
  /** 在语音里的成员及其是否静音。 */
  voice: Map<string, { muted: boolean }>;
  /** 整轮结束后的继续投票。 */
  rematch?: { deadline: number; accepted: Set<string>; timer: ReturnType<typeof setTimeout> };
  /** 真人这一步的截止时间；到点自动处理（见 timeoutTurn）。 */
  turn?: { deadline: number; timer: ReturnType<typeof setTimeout>; key: string };
  /** 当前决定点（timerKey）和它开始的时间。 */
  stageKey?: string;
  stageStartedAt: number;
  /** 机器人（空座位、托管、离线的人）的动作计时，按「决定点:座位」区分。 */
  botTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** 这个决定点里每个还没决定的真人座位的截止时间。 */
  seatDeadlines: Map<number, number>;
  /** 烧牌窗口（有头的人打出的够级牌）：满 BURN_WINDOW_MS 时发 TICK。 */
  windowKey?: string;
  windowTimer?: ReturnType<typeof setTimeout>;
  /** 人机（含托管、离线代打）对每套可能被烧的牌只考虑一次烧不烧，按「桌面牌#座位」区分。 */
  burnTimers: Map<string, ReturnType<typeof setTimeout>>;
  burnDecided: Set<string>;
  /** 这一场的操作序列（座位、操作），和种子一起写进 logs/games.jsonl，同一种子重放就能复现。 */
  actions: { seat: number; command: GameCommand | { type: "TIMEOUT"; seats: number[] } | { type: "TICK" } }[];
  /** 这一场的种子（只在服务端）。 */
  gameSeed?: number;
  /** 每个连接上一次收到的房间快照（去掉倒计时），没变化就不重发：烧牌窗口里先收下的动作不能让别人察觉到任何动静。 */
  lastSent: Map<string, string>;
}

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const ROOM_CHAT_LIMIT = 100;
const ROOM_CHAT_MAX_LENGTH = 200;
const ROOM_CHAT_RATE_LIMIT_MS = 1_000;
const ROOM_ABANDON_MS = Number(process.env.ROOM_ABANDON_MS ?? 2 * 60_000);
const REMATCH_TIMEOUT_MS = Number(process.env.REMATCH_TIMEOUT_MS ?? 60_000);
const ADMIN_RETRY_DELAY_MS = 2_000;
const VOICE_SIGNAL_MAX_LENGTH = 20_000;
const MAX_SPECTATORS = 20;
/** 每一步的计时（毫秒）；默认用规则里的 stepTimeoutSec，测试时可以用环境变量缩短。 */
const TURN_MS_OVERRIDE = process.env.TURN_MS ? Number(process.env.TURN_MS) : undefined;
/** 离线的人由机器人代打，先等 3 秒（全站统一；不算超时），回来能接上。 */
const OFFLINE_TURN_MS = Number(process.env.OFFLINE_TURN_MS ?? 3_000);
/** 人机每个决定的随机延迟：0.6–1.6 秒，像个人在想。BOT_DELAY_SCALE=0 时立刻出手（测试用）。 */
const BOT_DELAY_SCALE = Number(process.env.BOT_DELAY_SCALE ?? 1);
const BOT_MIN_MS = Number(process.env.BOT_MIN_MS ?? 600);
const BOT_MAX_MS = Number(process.env.BOT_MAX_MS ?? 1_600);
/** 人机按「烧牌」的时刻：够级牌打出后 0.4–1.6 秒里随机（补充文件 1.7），不要每次卡同一个时间点。 */
const BURN_MIN_MS = Number(process.env.BURN_MIN_MS ?? 400);
const BURN_MAX_MS = Number(process.env.BURN_MAX_MS ?? 1_600);
/** 烧牌窗口：有头的人打出够级牌后，出牌 / 过牌生效 / 本轮结束都等满这么久（规则默认 2 秒，测试可以用环境变量缩短）。 */
const BURN_WINDOW_MS_OVERRIDE = process.env.BURN_WINDOW_MS ? Number(process.env.BURN_WINDOW_MS) : undefined;
/** 空座位人机的名字（全站统一：咕噜一号、二号……，显示时带「人机」标签）。 */
const BOT_NAMES = ["咕噜一号", "咕噜二号", "咕噜三号", "咕噜四号", "咕噜五号", "咕噜六号"];
/** 进房间时自动分配座位的顺序：两个人先坐正对面（0 甲、3 乙），之后每多两个人两队各加一个（规则书 8.2 建议每队至少 1 个真人）。 */
const SEAT_ORDER = [0, 3, 1, 4, 2, 5] as const;
/** 每局结束后把种子和动作序列追加到这里，便于复盘。 */
const GAME_LOG = process.env.GAME_LOG ?? resolve(process.cwd(), "logs/games.jsonl");
const TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;
const rooms = new Map<string, RoomState>();
const socketRooms = new Map<string, string>();
const roomChatTimes = new Map<string, number>();
const adminFailureTimes = new Map<string, number>();

export const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "gouji-server" }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

/** 本地开发时网页的端口（默认 5292，和 vite.config.ts 一致；另起一套服务时用 WEB_PORT 改）。 */
const DEV_WEB_PORT = process.env.WEB_PORT ?? "5292";

const configuredWebOrigins = new Set(
  (process.env.WEB_ORIGINS ?? process.env.WEB_ORIGIN ?? `http://localhost:${DEV_WEB_PORT}`)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return first === 10 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
}

function isAllowedWebOrigin(origin: string | undefined): boolean {
  if (!origin || configuredWebOrigins.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && parsed.port === DEV_WEB_PORT
      && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || isPrivateIpv4(parsed.hostname));
  } catch {
    return false;
  }
}

export const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedWebOrigin(origin)),
    methods: ["GET", "POST"],
  },
});

function normalizeChatMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  return message.length >= 1 && message.length <= ROOM_CHAT_MAX_LENGTH ? message : null;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ");
  return name.length >= 2 && name.length <= 18 ? name : null;
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "");
  return /^[A-HJ-NP-Z2-9]{6}$/.test(code) ? code : null;
}

/** 检查开房选项（规则书 8.1），不合法返回 null；没给的用默认值。 */
function normalizeOptions(value: unknown): GameOptions | null {
  if (value !== undefined && (!value || typeof value !== "object")) return null;
  const input = (value ?? {}) as Record<string, unknown>;
  const pick = <T,>(key: string, allowed: readonly T[], fallback: T): T | undefined => {
    const raw = input[key];
    if (raw === undefined) return fallback;
    return allowed.includes(raw as T) ? (raw as T) : undefined;
  };
  const flags = [true, false] as const;
  const hands = pick("hands", [1, 3, 5, 8] as const, DEFAULT_OPTIONS.hands);
  const tribute = pick("tribute", flags, DEFAULT_OPTIONS.tribute);
  const rang = pick("rang", flags, DEFAULT_OPTIONS.rang);
  const peek = pick("peek", flags, DEFAULT_OPTIONS.peek);
  if (hands === undefined || tribute === undefined || rang === undefined || peek === undefined) return null;
  return { hands, tribute, rang, peek };
}

/** 等候房间里第一个空座位（按 SEAT_ORDER）。 */
function freeSeat(room: RoomState): number | undefined {
  return SEAT_ORDER.find((seat) => !room.members.some((member) => member.seat === seat));
}

function generateRoomCode(): string {
  return Array.from({ length: ROOM_CODE_LENGTH }, () =>
    ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)],
  ).join("");
}

function snapshot(room: RoomState, viewerId: string): LobbyRoomSnapshot {
  const seated = room.members.some((member) => member.id === viewerId);
  return {
    code: seated || room.invited.has(viewerId) ? room.code : "",
    options: { ...room.options },
    status: room.status,
    members: room.members.map((member) => ({ ...member })),
    spectators: room.spectators.map((spectator) => ({ ...spectator })),
    access: { ...room.access },
    chat: room.chat.map((entry) => ({ ...entry })),
    voice: [...room.voice].map(([id, state]) => ({ id, muted: state.muted })),
    ...(countdownFor(room, viewerId) !== undefined ? { turnRemainingMs: Math.max(0, countdownFor(room, viewerId)! - Date.now()) } : {}),
    ...(room.rematch ? { rematch: { remainingMs: Math.max(0, room.rematch.deadline - Date.now()), acceptedIds: [...room.rematch.accepted] } } : {}),
    ...(room.game ? { game: seated ? redactGameForViewer(room.game, seatOf(room, viewerId)) : spectatorView(room.game, room.access.spectatorsSeeAll) } : {}),
  };
}

/**
 * 这位观看者看到的倒计时（截止时间）：出牌阶段是轮到的那个真人的（人机、托管、离线的人不显示）；
 * 同时决定的阶段（进贡、还贡、革命、结算）大家看到同一个阶段截止时间——不按「谁还没选」显示，免得暴露谁能革命。
 * 轮到的人在烧牌窗口里先选好了动作，倒计时照常显示，别人看不出他已经选了。
 */
function countdownFor(room: RoomState, _viewerId: string): number | undefined {
  const game = room.game;
  if (!game || game.phase === "finished") return undefined;
  const deadline = room.stageStartedAt + stepMs(game);
  if (game.stage === "playing") return game.turn >= 0 && !robotSeat(room, game.turn) ? deadline : undefined;
  return room.seatDeadlines.size > 0 || pendingSeats(game).length > 0 ? deadline : undefined;
}

function isSpectator(room: RoomState, socketId: string): boolean {
  return room.spectators.some((spectator) => spectator.id === socketId);
}

function nameTaken(room: RoomState, name: string): boolean {
  return room.members.some((member) => member.name === name) || room.spectators.some((spectator) => spectator.name === name);
}

function seatOf(room: RoomState, memberId: string): string {
  return room.members.find((member) => member.id === memberId)?.playerId ?? "";
}

function roomSummaries(): PublicRoomSummary[] {
  const order = { playing: 0, waiting: 1, finished: 2 } as const;
  return [...rooms.values()]
    .map((room): PublicRoomSummary => {
      const game = room.game;
      const status = room.status === "waiting" ? "waiting" : game?.phase === "finished" ? "finished" : "playing";
      return {
        id: room.publicId,
        status,
        options: { ...room.options },
        open: room.access.open,
        allowSpectators: room.access.allowSpectators,
        spectators: room.spectators.length,
        ...(game ? { round: game.handNo } : {}),
        players: room.members.map((member) => {
          const player = game?.players.find((candidate) => candidate.id === member.playerId);
          return {
            name: member.name,
            isHost: member.isHost,
            connected: member.connected,
            seat: member.seat,
            ...(player ? {
              score: scoreOf(game!, game!.players.findIndex((candidate) => candidate.id === player.id)),
              isActive: game!.phase !== "finished" && game!.players[game!.turn]?.id === player.id,
              isWinner: game!.finalResult?.winners.includes(player.id) ?? false,
            } : {}),
          };
        }),
      };
    })
    .sort((left, right) => order[left.status] - order[right.status]);
}

/** 「在线牌桌」列表最多每秒推送一次，期间的变化合并到下一次。 */
const LOBBY_UPDATE_INTERVAL_MS = 1_000;
let lobbyUpdateTimer: ReturnType<typeof setTimeout> | undefined;
let lobbyUpdatePending = false;

/** 只推送给停留在首页（不在任何房间里）的连接；房间里的玩家看不到这个列表。 */
function sendLobbyUpdate(): void {
  const summaries = roomSummaries();
  for (const [socketId, client] of io.sockets.sockets) {
    if (!socketRooms.has(socketId)) client.emit("lobby:updated", summaries);
  }
}

function emitLobbyUpdate(): void {
  if (lobbyUpdateTimer) {
    lobbyUpdatePending = true;
    return;
  }
  sendLobbyUpdate();
  const flush = () => {
    if (!lobbyUpdatePending) {
      lobbyUpdateTimer = undefined;
      return;
    }
    lobbyUpdatePending = false;
    sendLobbyUpdate();
    lobbyUpdateTimer = setTimeout(flush, LOBBY_UPDATE_INTERVAL_MS);
    lobbyUpdateTimer.unref();
  };
  lobbyUpdateTimer = setTimeout(flush, LOBBY_UPDATE_INTERVAL_MS);
  lobbyUpdateTimer.unref();
}

/** 快照里随时间变的部分（倒计时）不算「有变化」。 */
function snapshotKey(snap: LobbyRoomSnapshot): string {
  const { turnRemainingMs: _remaining, rematch, ...rest } = snap;
  return JSON.stringify({ ...rest, rematch: rematch ? { acceptedIds: rematch.acceptedIds } : null });
}

/** 发给一个连接；和上次发给它的一样就不发（force 为 true 时总是发，比如刚进房间）。 */
function sendSnapshot(room: RoomState, socketId: string, force = false): void {
  const snap = snapshot(room, socketId);
  const key = snapshotKey(snap);
  if (!force && room.lastSent.get(socketId) === key) return;
  room.lastSent.set(socketId, key);
  io.to(socketId).emit("room:updated", snap);
}

function emitRoomUpdate(room: RoomState): void {
  // 每位成员单独发送（各自的座位视角）；看到的东西没变的人不发——烧牌窗口里有人先按了烧牌或先选了动作，
  // 别人连「收到一条更新」这样的动静都不能有。
  for (const member of room.members) sendSnapshot(room, member.id);
  for (const spectator of room.spectators) sendSnapshot(room, spectator.id);
  emitLobbyUpdate();
}

function findRoomForSocket(socketId: string): RoomState | undefined {
  const code = socketRooms.get(socketId);
  return code ? rooms.get(code) : undefined;
}

function removeWaitingMember(socketId: string): void {
  const code = socketRooms.get(socketId);
  if (!code) return;
  socketRooms.delete(socketId);
  rooms.get(code)?.voice.delete(socketId);
  rooms.get(code)?.lastSent.delete(socketId);

  const room = rooms.get(code);
  if (!room) return;
  if (isSpectator(room, socketId)) {
    room.spectators = room.spectators.filter((spectator) => spectator.id !== socketId);
    room.invited.delete(socketId);
    emitRoomUpdate(room);
    return;
  }
  if (room.status === "playing") {
    room.members = room.members.map((member) =>
      member.id === socketId ? { ...member, connected: false } : member,
    );
    if (room.members.every((member) => !member.connected)) scheduleAbandonedRoomClose(room);
    // 掉线的人由机器人代打。
    if (room.game?.phase === "playing") afterGameChange(room);
    emitRoomUpdate(room);
    return;
  }

  room.members = room.members.filter((member) => member.id !== socketId);
  if (room.members.length === 0) {
    deleteRoom(room, "玩家都离开了，房间已关闭。");
    return;
  }
  if (room.ownerId === socketId) {
    room.ownerId = room.members[0]!.id;
    room.members = room.members.map((member) => ({
      ...member,
      isHost: member.id === room.ownerId,
    }));
  }
  emitRoomUpdate(room);
}

/** 所有玩家离线满 ROOM_ABANDON_MS 后关闭房间；期间有人重新加入则取消。 */
function scheduleAbandonedRoomClose(room: RoomState): void {
  clearTimeout(room.abandonTimer);
  room.abandonTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room || room.members.some((member) => member.connected)) return;
    deleteRoom(room, "玩家都离线了，房间已关闭。");
  }, ROOM_ABANDON_MS);
  room.abandonTimer.unref();
}

/** 通知某个连接已被移出房间，并断开它和房间的关联。 */
function closeMemberConnection(room: RoomState, memberId: string, reason: string): void {
  socketRooms.delete(memberId);
  const memberSocket = io.sockets.sockets.get(memberId);
  if (!memberSocket) return;
  void memberSocket.leave(room.code);
  memberSocket.emit("room:closed", { reason });
}

/** 删除房间；还在看的观战者会收到 reason。 */
function deleteRoom(room: RoomState, reason = "房间已关闭。"): void {
  clearTimeout(room.abandonTimer);
  clearGameTimers(room);
  clearTimeout(room.rematch?.timer);
  for (const spectator of room.spectators) closeMemberConnection(room, spectator.id, reason);
  room.spectators = [];
  for (const member of room.members) socketRooms.delete(member.id);
  rooms.delete(room.code);
  emitLobbyUpdate();
}

function dissolveRoom(room: RoomState, reason: string): void {
  for (const member of room.members) closeMemberConnection(room, member.id, reason);
  deleteRoom(room, reason);
}

/** 移出成员并在需要时转移房主；房间空了就删除。返回房间是否还在。 */
function removeMembers(room: RoomState, memberIds: string[], reason: string): boolean {
  for (const memberId of memberIds) closeMemberConnection(room, memberId, reason);
  for (const memberId of memberIds) room.voice.delete(memberId);
  room.members = room.members.filter((member) => !memberIds.includes(member.id));
  if (room.members.length === 0) {
    deleteRoom(room);
    return false;
  }
  if (!room.members.some((member) => member.id === room.ownerId)) room.ownerId = room.members[0]!.id;
  room.members = room.members.map((member) => ({ ...member, isHost: member.id === room.ownerId }));
  return true;
}

/** 有人拒绝或超时：移出这些人和已离线的人，其余玩家回到等待大厅。 */
function returnToWaiting(room: RoomState, kickedIds: string[], reason: string): void {
  clearTimeout(room.rematch?.timer);
  delete room.rematch;
  clearTimeout(room.abandonTimer);
  delete room.abandonTimer;
  const offlineIds = room.members.filter((member) => !member.connected && !kickedIds.includes(member.id)).map((member) => member.id);
  if (!removeMembers(room, [...kickedIds, ...offlineIds], reason)) return;
  room.status = "waiting";
  clearGameTimers(room);
  delete room.game;
  emitRoomUpdate(room);
}

function clearTurnTimer(room: RoomState): void {
  clearTimeout(room.turn?.timer);
  delete room.turn;
}

function clearGameTimers(room: RoomState): void {
  clearTurnTimer(room);
  for (const timer of room.botTimers.values()) clearTimeout(timer);
  room.botTimers.clear();
  for (const timer of room.burnTimers.values()) clearTimeout(timer);
  room.burnTimers.clear();
  room.burnDecided.clear();
  clearTimeout(room.windowTimer);
  delete room.windowTimer;
  delete room.windowKey;
  delete room.stageKey;
}

/** 执行一个操作并记进这一场的操作序列。 */
function applyAndLog(room: RoomState, seat: number, playerId: string, command: GameCommand): void {
  room.game = applyCommand(room.game!, playerId, command);
  room.actions.push({ seat, command });
}

const botDelay = (min: number, max: number) => (min + Math.random() * (max - min)) * BOT_DELAY_SCALE;

function setTurnDeadline(room: RoomState, deadline: number, key: string): void {
  clearTurnTimer(room);
  const timer = setTimeout(() => expireTurn(room), Math.max(0, deadline - Date.now()));
  timer.unref();
  room.turn = { deadline, timer, key };
}

/** 这个座位由机器人出手：空座位的机器人、托管、离线的人。 */
function robotSeat(room: RoomState, seat: number): boolean {
  const player = room.game!.players[seat]!;
  if (player.bot || player.auto) return true;
  const member = room.members.find((candidate) => candidate.playerId === player.id);
  return !member || !member.connected;
}

/**
 * 每次对局变化后重新安排计时：
 * - 真人：这个决定点开始后 stepSeconds 秒内没决定就套用默认动作（timeoutTurn）；
 * - 机器人、托管、离线的人：随机等一会儿（离线代打等 OFFLINE_TURN_MS）出手。
 */
function updateTurnTimer(room: RoomState): void {
  const game = room.game;
  if (!game || game.phase === "finished") {
    clearGameTimers(room);
    return;
  }
  const key = timerKey(game);
  if (room.stageKey !== key) {
    room.stageKey = key;
    room.stageStartedAt = Date.now();
    clearTurnTimer(room);
  }
  const pending = pendingSeats(game);
  const robots = pending.filter((seat) => robotSeat(room, seat));
  const humans = pending.filter((seat) => !robots.includes(seat));

  room.seatDeadlines = new Map(humans.map((seat) => [seat, seatDeadline(room, game, seat)]));
  if (humans.length === 0) clearTurnTimer(room);
  else {
    const earliest = Math.min(...room.seatDeadlines.values());
    if (room.turn?.key !== key || room.turn.deadline !== earliest) setTurnDeadline(room, earliest, key);
  }

  for (const [timerId, timer] of room.botTimers) {
    const [timerKeyPart, seatPart] = timerId.split("#");
    if (timerKeyPart !== key || !robots.includes(Number(seatPart))) {
      clearTimeout(timer);
      room.botTimers.delete(timerId);
    }
  }
  for (const seat of robots) {
    const timerId = `${key}#${seat}`;
    if (room.botTimers.has(timerId)) continue;
    const player = game.players[seat]!;
    const delay = player.bot || player.auto ? botDelay(BOT_MIN_MS, BOT_MAX_MS) : OFFLINE_TURN_MS;
    const timer = setTimeout(() => runRobot(room, seat, key, timerId), delay);
    timer.unref();
    room.botTimers.set(timerId, timer);
  }
  scheduleBurnWindow(room, game);
  scheduleBotBurns(room, game);
}

/** 有头的人打出够级牌：满烧牌窗口时发 TICK（不管有没有人能烧，时间都一样）。 */
function scheduleBurnWindow(room: RoomState, game: GameState): void {
  const key = burnWindowKey(game);
  if (key === (room.windowKey ?? null)) return;
  clearTimeout(room.windowTimer);
  delete room.windowTimer;
  delete room.windowKey;
  if (!key) return;
  room.windowKey = key;
  const timer = setTimeout(() => tickWindow(room, key), BURN_WINDOW_MS_OVERRIDE ?? game.config.burnWindowMs);
  timer.unref();
  room.windowTimer = timer;
}

function tickWindow(room: RoomState, key: string): void {
  if (rooms.get(room.code) !== room || !room.game || burnWindowKey(room.game) !== key) return;
  delete room.windowTimer;
  room.game = tickBurnWindow(room.game);
  room.actions.push({ seat: -1, command: { type: "TICK" } });
  afterGameChange(room);
  emitRoomUpdate(room);
}

/** 人机座位（空座、托管、离线的人）能烧时，随机等 0.4–1.6 秒问一次人机烧不烧；每套桌面牌只问一次。 */
function scheduleBotBurns(room: RoomState, game: GameState): void {
  const top = topKey(game);
  for (const [timerId, timer] of room.burnTimers) {
    if (!timerId.startsWith(`${top}#`)) {
      clearTimeout(timer);
      room.burnTimers.delete(timerId);
    }
  }
  for (const decided of room.burnDecided) if (!decided.startsWith(`${top}#`)) room.burnDecided.delete(decided);
  if (!top) return;
  for (const seat of burnEligibleSeats(game)) {
    if (!robotSeat(room, seat)) continue;
    const timerId = `${top}#${seat}`;
    if (room.burnTimers.has(timerId) || room.burnDecided.has(timerId)) continue;
    const timer = setTimeout(() => runBotBurn(room, seat, top, timerId), botDelay(BURN_MIN_MS, BURN_MAX_MS));
    timer.unref();
    room.burnTimers.set(timerId, timer);
  }
}

function runBotBurn(room: RoomState, seat: number, top: string, timerId: string): void {
  room.burnTimers.delete(timerId);
  room.burnDecided.add(timerId);
  const game = room.game;
  if (rooms.get(room.code) !== room || !game || topKey(game) !== top || !robotSeat(room, seat) || !burnEligibleSeats(game).includes(seat)) return;
  const id = game.players[seat]!.id;
  let command: GameCommand | null = null;
  try {
    // 人机只看这个座位自己能看到的信息（烧牌候选在 you 里）
    command = botBurn(redactGameForViewer(game, id), seat);
    if (command) applyAndLog(room, seat, id, command);
  } catch (error) {
    console.error("人机烧牌出错", error);
    return;
  }
  if (!command) return;
  afterGameChange(room);
  emitRoomUpdate(room);
}

const stepMs = (game: GameState) => TURN_MS_OVERRIDE ?? stepSeconds(game) * 1000;

function seatDeadline(room: RoomState, game: GameState, _seat: number): number {
  return room.stageStartedAt + stepMs(game);
}

function runRobot(room: RoomState, seat: number, key: string, timerId: string): void {
  room.botTimers.delete(timerId);
  const game = room.game;
  if (rooms.get(room.code) !== room || !game || game.phase === "finished" || timerKey(game) !== key) return;
  if (!pendingSeats(game).includes(seat) || !robotSeat(room, seat)) return;
  try {
    // 人机只看这个座位自己能看到的信息
    const id = game.players[seat]!.id;
    applyAndLog(room, seat, id, botCommand(redactGameForViewer(game, id), seat));
  } catch (error) {
    console.error("人机出错", error);
    room.game = timeoutTurn(game, [seat]);
    room.actions.push({ seat: -1, command: { type: "TIMEOUT", seats: [seat] } });
  }
  afterGameChange(room);
  emitRoomUpdate(room);
}

function expireTurn(room: RoomState): void {
  if (rooms.get(room.code) !== room || !room.game || room.game.phase === "finished") return;
  const now = Date.now() + 30;
  const due = [...room.seatDeadlines].filter(([, deadline]) => deadline <= now).map(([seat]) => seat);
  // 只超时到点的真人座位；机器人座位由自己的计时出手。
  if (due.length > 0) {
    room.game = timeoutTurn(room.game, due);
    room.actions.push({ seat: -1, command: { type: "TIMEOUT", seats: due } });
  }
  afterGameChange(room);
  emitRoomUpdate(room);
}

/** 对局状态变化后：结束则清空聊天并发起继续投票，否则更新计时。 */
function afterGameChange(room: RoomState): void {
  if (room.game?.phase === "finished") {
    clearGameTimers(room);
    room.chat = [];
    void logFinishedGame(room, room.game);
    startRematchVote(room);
    return;
  }
  updateTurnTimer(room);
}

/**
 * 种子用服务端的安全随机数生成；牌在服务端洗，不发给浏览器。
 * 真人按自己选的座位坐（选座就是选队），空座由人机（咕噜一号、二号……）补满 6 个。
 */
function newGame(room: RoomState, seed = randomInt(2 ** 32 - 1)): GameState {
  const names = BOT_NAMES.filter((name) => !room.members.some((member) => member.name === name));
  let botIndex = 0;
  const players = Array.from({ length: SEAT_COUNT }, (_, seat) => {
    const member = room.members.find((candidate) => candidate.seat === seat);
    if (member) return { id: member.playerId, name: member.name };
    return { id: `bot${seat}`, name: names[botIndex++]!, bot: true };
  });
  room.actions = [];
  room.lastSent.clear();
  room.gameSeed = seed;
  return createGame(players, seed, room.options);
}

/** 记录一局的种子、玩家和动作序列，同一种子重放这串动作就能复现整局。 */
async function logFinishedGame(room: RoomState, game: GameState): Promise<void> {
  try {
    await mkdir(dirname(GAME_LOG), { recursive: true });
    const entry = {
      endedAt: new Date().toISOString(),
      seed: room.gameSeed ?? game.seed,
      options: game.config,
      players: game.players.map((player, seat) => ({ id: player.id, name: player.name, bot: player.bot, score: scoreOf(game, seat) })),
      teamScores: game.teamScores,
      actions: room.actions,
    };
    await appendFile(GAME_LOG, JSON.stringify(entry) + "\n");
  } catch (error) {
    console.error("写对局记录失败", error);
  }
}

/** 整轮结束：所有人需在 REMATCH_TIMEOUT_MS 内确认是否继续。 */
function startRematchVote(room: RoomState): void {
  clearTimeout(room.rematch?.timer);
  const timer = setTimeout(() => {
    if (rooms.get(room.code) !== room || !room.rematch) return;
    const accepted = room.rematch.accepted;
    const pending = room.members.filter((member) => !accepted.has(member.id)).map((member) => member.id);
    returnToWaiting(room, pending, "没有在 1 分钟内确认继续，已被移出房间。");
  }, REMATCH_TIMEOUT_MS);
  timer.unref();
  room.rematch = { deadline: Date.now() + REMATCH_TIMEOUT_MS, accepted: new Set(), timer };
}

/** 未配置 ADMIN_TOKEN 时管理功能关闭。 */
const adminTokenHash = process.env.ADMIN_TOKEN
  ? createHash("sha256").update(process.env.ADMIN_TOKEN).digest()
  : null;

function checkAdminToken(socketId: string, token: unknown): string | null {
  if (!adminTokenHash) return "管理功能未启用。";
  const now = Date.now();
  if (now - (adminFailureTimes.get(socketId) ?? 0) < ADMIN_RETRY_DELAY_MS) {
    return "尝试太频繁了，请稍后再试。";
  }
  const tokenHash = createHash("sha256").update(typeof token === "string" ? token : "").digest();
  if (!timingSafeEqual(tokenHash, adminTokenHash)) {
    adminFailureTimes.set(socketId, now);
    return "管理员口令不正确。";
  }
  return null;
}

/**
 * 语音用的 STUN/TURN 配置。配置了 TURN_HOST 和 TURN_SECRET 时，按 coturn 的
 * use-auth-secret 约定发放 24 小时有效的临时凭证；否则只靠局域网直连（本地开发）。
 */
function iceServersFor(memberId: string): IceServerConfig[] {
  const host = process.env.TURN_HOST;
  const secret = process.env.TURN_SECRET;
  if (!host || !secret) return [];
  const username = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS}:${memberId}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return [
    { urls: `stun:${host}:3478` },
    { urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential },
  ];
}

function isVoiceSignal(value: unknown): value is VoiceSignal {
  if (!value || typeof value !== "object") return false;
  if (JSON.stringify(value).length > VOICE_SIGNAL_MAX_LENGTH) return false;
  const data = value as { description?: { type?: unknown; sdp?: unknown }; candidate?: { candidate?: unknown } };
  if (data.description) {
    return (data.description.type === "offer" || data.description.type === "answer") && typeof data.description.sdp === "string";
  }
  return Boolean(data.candidate) && typeof data.candidate?.candidate === "string";
}

/** 把离线玩家的座位交给新的连接，保留其对局状态。 */
function reassignMember(room: RoomState, previousId: string, nextId: string): void {
  const swap = (id: string) => (id === previousId ? nextId : id);
  room.lastSent.delete(previousId);
  room.members = room.members.map((member) =>
    member.id === previousId ? { ...member, id: nextId, connected: true } : member,
  );
  room.ownerId = swap(room.ownerId);
  room.chat = room.chat.map((entry) => ({ ...entry, senderId: swap(entry.senderId) }));
  if (room.rematch) room.rematch.accepted = new Set([...room.rematch.accepted].map(swap));
}

function invalidNameMessage(payload: CreateRoomPayload | JoinRoomPayload): string | null {
  return normalizeName(payload?.name) ? null : "昵称长度需为 2–18 个字符。";
}

/**
 * 同一个账号同时登录的设备有上限。网关（Caddy forward_auth）把每条连接属于哪次登录放在
 * X-GC-Session 请求头里；游戏中心挤掉某次登录时发 admin:kick-session，这里断开它的所有连接。
 */
const socketsBySession = new Map<string, Set<string>>();

io.on("connection", (socket) => {
  const loginSession = socket.handshake.headers["x-gc-session"];
  if (typeof loginSession === "string" && loginSession) {
    const sockets = socketsBySession.get(loginSession) ?? new Set<string>();
    sockets.add(socket.id);
    socketsBySession.set(loginSession, sockets);
    socket.on("disconnect", () => {
      sockets.delete(socket.id);
      if (sockets.size === 0 && socketsBySession.get(loginSession) === sockets) socketsBySession.delete(loginSession);
    });
  }

  socket.on("lobby:get", (ack) => {
    ack({ ok: true, data: roomSummaries() });
  });

  socket.on("room:create", (payload, ack) => {
    if (socketRooms.has(socket.id)) {
      ack({ ok: false, error: "请先离开当前房间，再创建新房间。" });
      return;
    }
    const invalidName = invalidNameMessage(payload);
    if (invalidName) {
      ack({ ok: false, error: invalidName });
      return;
    }
    const options = normalizeOptions(payload?.options);
    if (!options) {
      ack({ ok: false, error: "开房选项不正确。" });
      return;
    }

    let code = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = generateRoomCode();
      if (!rooms.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      ack({ ok: false, error: "暂时无法分配房间码，请重试。" });
      return;
    }

    const room: RoomState = {
      code,
      publicId: randomUUID(),
      options,
      stageStartedAt: Date.now(),
      botTimers: new Map(),
      seatDeadlines: new Map(),
      burnTimers: new Map(),
      burnDecided: new Set(),
      actions: [],
      lastSent: new Map(),
      status: "waiting",
      ownerId: socket.id,
      members: [{ id: socket.id, playerId: "p1", name: normalizeName(payload.name)!, isHost: true, connected: true, seat: SEAT_ORDER[0] }],
      nextSeat: 2,
      spectators: [],
      invited: new Set(),
      access: { ...DEFAULT_ROOM_ACCESS },
      chat: [],
      voice: new Map(),
    };
    rooms.set(code, room);
    socketRooms.set(socket.id, code);
    void socket.join(code);
    ack({ ok: true, data: snapshot(room, socket.id) });
    emitRoomUpdate(room);
  });

  socket.on("room:join", (payload, ack) => {
    if (socketRooms.has(socket.id)) {
      ack({ ok: false, error: "请先离开当前房间，再加入新房间。" });
      return;
    }
    const invalidName = invalidNameMessage(payload);
    if (invalidName) {
      ack({ ok: false, error: invalidName });
      return;
    }
    // 从首页列表点进来的带 roomId（公开 id），用房间码进来的带 code。
    const viaList = typeof payload.roomId === "string";
    let room: RoomState | undefined;
    if (viaList) {
      room = [...rooms.values()].find((candidate) => candidate.publicId === payload.roomId);
      if (!room) {
        ack({ ok: false, error: "这个房间已经不在了。" });
        return;
      }
    } else {
      const code = normalizeCode(payload?.code);
      if (!code) {
        ack({ ok: false, error: "请输入有效的 6 位房间码。" });
        return;
      }
      room = rooms.get(code);
      if (!room) {
        ack({ ok: false, error: "找不到这个房间，请检查房间码。" });
        return;
      }
    }
    const code = room.code;
    const name = normalizeName(payload.name)!;

    if (payload.spectate === true) {
      if (!room.access.allowSpectators) {
        ack({ ok: false, error: "这个房间没有开放观战。" });
        return;
      }
      if (room.spectators.length >= MAX_SPECTATORS) {
        ack({ ok: false, error: "观战的人已经满了。" });
        return;
      }
      if (nameTaken(room, name)) {
        ack({ ok: false, error: "房间里已有同名的人，请换一个昵称。" });
        return;
      }
      room.spectators.push({ id: socket.id, name });
      if (!viaList) room.invited.add(socket.id);
      socketRooms.set(socket.id, code);
      void socket.join(code);
      ack({ ok: true, data: snapshot(room, socket.id) });
      emitRoomUpdate(room);
      return;
    }

    if (room.status !== "waiting") {
      if (viaList) {
        ack({ ok: false, error: "对局已经开始了，可以进去观战。" });
        return;
      }
      // 对局中只允许离线玩家用原昵称回到自己的座位。
      const seat = room.members.find((member) => member.name === name);
      if (!seat) {
        ack({ ok: false, error: "对局已经开始，只有原房间玩家可以用原昵称重新加入。" });
        return;
      }
      if (seat.connected) {
        ack({ ok: false, error: "这个昵称的玩家仍在线，无法重新加入。" });
        return;
      }
      clearTimeout(room.abandonTimer);
      delete room.abandonTimer;
      reassignMember(room, seat.id, socket.id);
      socketRooms.set(socket.id, code);
      void socket.join(code);
      ack({ ok: true, data: snapshot(room, socket.id) });
      emitRoomUpdate(room);
      return;
    }
    if (viaList && !room.access.open) {
      ack({ ok: false, error: "这个房间是邀请制，要有房间码才能加入。" });
      return;
    }
    if (room.members.length >= SEAT_COUNT) {
      ack({ ok: false, error: "房间已满。" });
      return;
    }
    if (nameTaken(room, name)) {
      ack({ ok: false, error: "房间里已有同名的人，请换一个昵称。" });
      return;
    }

    const member: LobbyMember = {
      id: socket.id,
      playerId: `p${room.nextSeat++}`,
      name,
      isHost: false,
      connected: true,
      seat: freeSeat(room)!,
    };
    room.members.push(member);
    socketRooms.set(socket.id, code);
    void socket.join(code);
    ack({ ok: true, data: snapshot(room, socket.id) });
    emitRoomUpdate(room);
  });

  socket.on("room:access", (settings, ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.ownerId !== socket.id) {
      ack({ ok: false, error: "只有房主可以修改房间设置。" });
      return;
    }
    const next = { ...room.access };
    for (const key of ["allowSpectators", "spectatorsSeeAll", "open"] as const) {
      const value = settings?.[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") {
        ack({ ok: false, error: "设置内容不正确。" });
        return;
      }
      next[key] = value;
    }
    room.access = next;
    if (!next.allowSpectators && room.spectators.length > 0) {
      for (const spectator of room.spectators) closeMemberConnection(room, spectator.id, "房主关闭了观战。");
      room.spectators = [];
      room.invited.clear();
    }
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("room:options", (value, ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.ownerId !== socket.id) {
      ack({ ok: false, error: "只有房主可以修改开房选项。" });
      return;
    }
    if (room.status !== "waiting") {
      ack({ ok: false, error: "对局开始后不能改选项。" });
      return;
    }
    const options = normalizeOptions(value && typeof value === "object" ? { ...room.options, ...value } : value);
    if (!options) {
      ack({ ok: false, error: "开房选项不正确。" });
      return;
    }
    room.options = options;
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("room:sit", (ack) => {
    const room = findRoomForSocket(socket.id);
    const spectator = room?.spectators.find((candidate) => candidate.id === socket.id);
    if (!room || !spectator) {
      ack({ ok: false, error: "你现在不在观战。" });
      return;
    }
    if (room.status !== "waiting") {
      ack({ ok: false, error: "对局开始后不能再坐下，等这局结束吧。" });
      return;
    }
    if (room.members.length >= SEAT_COUNT) {
      ack({ ok: false, error: "座位已经满了。" });
      return;
    }
    if (!room.access.open && !room.invited.has(socket.id)) {
      ack({ ok: false, error: "这个房间是邀请制，要有房间码才能坐下。" });
      return;
    }
    room.spectators = room.spectators.filter((candidate) => candidate.id !== socket.id);
    room.invited.delete(socket.id);
    room.members.push({ id: socket.id, playerId: `p${room.nextSeat++}`, name: spectator.name, isHost: false, connected: true, seat: freeSeat(room)! });
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("room:stand", (ack) => {
    const room = findRoomForSocket(socket.id);
    const member = room?.members.find((candidate) => candidate.id === socket.id);
    if (!room || !member) {
      ack({ ok: false, error: "你当前不在座位上。" });
      return;
    }
    if (room.status !== "waiting") {
      ack({ ok: false, error: "对局中不能离开座位。" });
      return;
    }
    if (member.isHost) {
      ack({ ok: false, error: "房主不能改成观战。" });
      return;
    }
    if (!room.access.allowSpectators) {
      ack({ ok: false, error: "这个房间没有开放观战。" });
      return;
    }
    room.members = room.members.filter((candidate) => candidate.id !== socket.id);
    room.voice.delete(socket.id);
    room.spectators.push({ id: socket.id, name: member.name });
    room.invited.add(socket.id);
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("room:seat", (seat, ack) => {
    const room = findRoomForSocket(socket.id);
    const member = room?.members.find((candidate) => candidate.id === socket.id);
    if (!room || !member) {
      ack({ ok: false, error: "你当前不在座位上。" });
      return;
    }
    if (room.status !== "waiting") {
      ack({ ok: false, error: "对局开始后不能换座位。" });
      return;
    }
    if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) {
      ack({ ok: false, error: "没有这个座位。" });
      return;
    }
    if (room.members.some((candidate) => candidate.seat === seat && candidate.id !== socket.id)) {
      ack({ ok: false, error: "这个座位已经有人了。" });
      return;
    }
    room.members = room.members.map((candidate) => (candidate.id === socket.id ? { ...candidate, seat } : candidate));
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("room:swap-seats", (payload, ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.ownerId !== socket.id) {
      ack({ ok: false, error: "只有房主可以调换座位。" });
      return;
    }
    if (room.status !== "waiting") {
      ack({ ok: false, error: "对局开始后不能换座位。" });
      return;
    }
    const a = payload?.a;
    const b = payload?.b;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= SEAT_COUNT || b >= SEAT_COUNT || a === b) {
      ack({ ok: false, error: "座位不对。" });
      return;
    }
    room.members = room.members.map((member) => (member.seat === a ? { ...member, seat: b } : member.seat === b ? { ...member, seat: a } : member));
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("room:start", (ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room) {
      ack({ ok: false, error: "你当前不在房间中。" });
      return;
    }
    if (room.ownerId !== socket.id) {
      ack({ ok: false, error: "只有房主可以开始对局。" });
      return;
    }
    if (room.status !== "waiting") {
      ack({ ok: false, error: "对局已经开始。" });
      return;
    }

    try {
      room.game = newGame(room);
      room.status = "playing";
      updateTurnTimer(room);
      const roomSnapshot = snapshot(room, socket.id);
      ack({ ok: true, data: roomSnapshot });
      emitRoomUpdate(room);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法开始对局。";
      ack({ ok: false, error: message });
    }
  });

  socket.on("room:leave", (ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room) {
      ack({ ok: false, error: "你当前不在房间中。" });
      return;
    }
    if (room.status === "playing" && !isSpectator(room, socket.id)) {
      ack({ ok: false, error: "对局开始后暂不能离开房间。" });
      return;
    }
    const code = room.code;
    removeWaitingMember(socket.id);
    void socket.leave(code);
    ack({ ok: true, data: undefined });
  });

  socket.on("game:command", (command, ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.status !== "playing" || !room.game) {
      ack({ ok: false, error: "当前没有进行中的对局。" });
      return;
    }
    if (isSpectator(room, socket.id)) {
      ack({ ok: false, error: "观战中不能操作。" });
      return;
    }

    try {
      const playerId = seatOf(room, socket.id);
      applyAndLog(room, room.game.players.findIndex((player) => player.id === playerId), playerId, command);
      afterGameChange(room);
      const roomSnapshot = snapshot(room, socket.id);
      ack({ ok: true, data: roomSnapshot });
      emitRoomUpdate(room);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法执行这个行动。";
      ack({ ok: false, error: message });
    }
  });

  socket.on("room:rematch", (accept, ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room?.rematch || !room.members.some((member) => member.id === socket.id)) {
      ack({ ok: false, error: "现在不需要确认。" });
      return;
    }
    ack({ ok: true, data: undefined });
    if (accept !== true) {
      returnToWaiting(room, [socket.id], "你选择了不继续，已离开房间。");
      return;
    }
    room.rematch.accepted.add(socket.id);
    if (room.members.every((member) => room.rematch!.accepted.has(member.id))) {
      clearTimeout(room.rematch.timer);
      delete room.rematch;
      room.game = newGame(room);
      updateTurnTimer(room);
    }
    emitRoomUpdate(room);
  });

  socket.on("room:kick", (memberId, ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.ownerId !== socket.id) {
      ack({ ok: false, error: "只有房主可以移出玩家。" });
      return;
    }
    if (isSpectator(room, memberId)) {
      // 观战的人随时可以移出。
      closeMemberConnection(room, memberId, "你已被房主移出房间。");
      room.spectators = room.spectators.filter((spectator) => spectator.id !== memberId);
      room.invited.delete(memberId);
      ack({ ok: true, data: undefined });
      emitRoomUpdate(room);
      return;
    }
    if (room.status !== "waiting") {
      ack({ ok: false, error: "对局中不能移出玩家；有人挂机可以解散房间。" });
      return;
    }
    if (memberId === socket.id || !room.members.some((member) => member.id === memberId)) {
      ack({ ok: false, error: "找不到这位玩家。" });
      return;
    }
    removeMembers(room, [memberId], "你已被房主移出房间。");
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("room:dissolve", (ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.ownerId !== socket.id) {
      ack({ ok: false, error: "只有房主可以解散房间。" });
      return;
    }
    ack({ ok: true, data: undefined });
    dissolveRoom(room, "房主解散了房间。");
  });

  socket.on("admin:verify", (token, ack) => {
    const error = checkAdminToken(socket.id, token);
    ack(error ? { ok: false, error } : { ok: true, data: undefined });
  });

  socket.on("admin:kick-session", (payload, ack) => {
    const error = checkAdminToken(socket.id, payload?.token);
    if (error) {
      ack({ ok: false, error });
      return;
    }
    const ids = typeof payload?.sessionId === "string" ? [...(socketsBySession.get(payload.sessionId) ?? [])] : [];
    let kicked = 0;
    for (const id of ids) {
      const target = io.sockets.sockets.get(id);
      if (!target) continue;
      target.emit("session:kicked");
      target.disconnect(true);
      kicked += 1;
    }
    ack({ ok: true, data: kicked });
  });

  socket.on("admin:dissolve", (payload, ack) => {
    const error = checkAdminToken(socket.id, payload?.token);
    if (error) {
      ack({ ok: false, error });
      return;
    }
    const room = [...rooms.values()].find((candidate) => candidate.publicId === payload.roomId);
    if (!room) {
      ack({ ok: false, error: "这个房间已经不存在。" });
      return;
    }
    dissolveRoom(room, "管理员解散了这个房间。");
    ack({ ok: true, data: undefined });
  });

  socket.on("voice:join", (payload, ack) => {
    const room = findRoomForSocket(socket.id);
    if (!room) {
      ack({ ok: false, error: "你当前不在房间中。" });
      return;
    }
    if (isSpectator(room, socket.id)) {
      ack({ ok: false, error: "观战时不能加入语音。" });
      return;
    }
    room.voice.set(socket.id, { muted: payload?.muted === true });
    ack({ ok: true, data: iceServersFor(socket.id) });
    emitRoomUpdate(room);
  });

  socket.on("voice:mute", (muted, ack) => {
    const room = findRoomForSocket(socket.id);
    const state = room?.voice.get(socket.id);
    if (!room || !state) {
      ack({ ok: false, error: "你还没有加入语音。" });
      return;
    }
    state.muted = muted === true;
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("voice:leave", (ack) => {
    const room = findRoomForSocket(socket.id);
    if (room?.voice.delete(socket.id)) emitRoomUpdate(room);
    ack({ ok: true, data: undefined });
  });

  socket.on("voice:signal", (payload) => {
    // 只在同一房间、都在语音里的两人之间转发。
    const room = findRoomForSocket(socket.id);
    if (!room || !room.voice.has(socket.id) || !room.voice.has(payload?.to) || payload.to === socket.id) return;
    if (!isVoiceSignal(payload.data)) return;
    io.to(payload.to).emit("voice:signal", { from: socket.id, data: payload.data });
  });

  socket.on("room:chat", (payload, ack) => {
    const room = findRoomForSocket(socket.id);
    const member = room?.members.find((candidate) => candidate.id === socket.id)
      ?? room?.spectators.find((candidate) => candidate.id === socket.id);
    if (!room || !member) {
      ack({ ok: false, error: "你当前不在房间中。" });
      return;
    }
    const spectator = isSpectator(room, socket.id);
    const message = normalizeChatMessage(payload?.message);
    if (!message) {
      ack({ ok: false, error: `消息需为 1–${ROOM_CHAT_MAX_LENGTH} 个字符。` });
      return;
    }
    const now = Date.now();
    if (now - (roomChatTimes.get(socket.id) ?? 0) < ROOM_CHAT_RATE_LIMIT_MS) {
      ack({ ok: false, error: "发送太快了，请稍等一下。" });
      return;
    }

    roomChatTimes.set(socket.id, now);
    room.chat = [
      ...room.chat,
      { id: randomUUID(), senderId: socket.id, name: member.name, message, createdAt: new Date(now).toISOString(), ...(spectator ? { spectator: true } : {}) },
    ].slice(-ROOM_CHAT_LIMIT);
    ack({ ok: true, data: undefined });
    emitRoomUpdate(room);
  });

  socket.on("disconnect", () => {
    roomChatTimes.delete(socket.id);
    adminFailureTimes.delete(socket.id);
    removeWaitingMember(socket.id);
  });
});

/** 仅供测试：直接把某个房间的对局标记为结束并发起继续投票。 */
export const testHooks = {
  finishGame(code: string): void {
    const room = rooms.get(code);
    if (!room?.game) throw new Error("no game");
    room.game = { ...room.game, phase: "finished" as const };
    clearGameTimers(room);
    startRematchVote(room);
    emitRoomUpdate(room);
  },
  /** 用指定种子重开当前对局，方便测试固定开局。 */
  reseed(code: string, seed: number): void {
    const room = rooms.get(code);
    if (!room) throw new Error("no room");
    room.game = newGame(room, seed);
    updateTurnTimer(room);
    emitRoomUpdate(room);
  },
  /** 让当前回合立即超时。 */
  expireTurn(code: string): void {
    const room = rooms.get(code);
    if (!room) throw new Error("no room");
    expireTurn(room);
  },
  /** 换成指定的局面（预览局面工厂造的，玩家 id 要和房间里的对上），用来测特定情形。 */
  setGame(code: string, game: GameState): void {
    const room = rooms.get(code);
    if (!room) throw new Error("no room");
    clearGameTimers(room);
    room.game = game;
    room.status = "playing";
    updateTurnTimer(room);
    emitRoomUpdate(room);
  },
  /** 这一场的操作序列（复盘测试用）。 */
  actions(code: string) {
    const room = rooms.get(code);
    if (!room) throw new Error("no room");
    return { seed: room.gameSeed, actions: room.actions };
  },
  /** 当前局面（服务器上的完整状态，测试核对用）。 */
  game(code: string): GameState | undefined {
    return rooms.get(code)?.game;
  },
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 3021);
  httpServer.listen(port, () => {
    console.log(`Gouji server listening on http://localhost:${port}`);
  });
}
