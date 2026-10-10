#!/usr/bin/env node
/**
 * 抓包检查（隐藏信息）：连上真实服务器，A（房主，0 号座）和 B（3 号座，A 的对头）两个真人 + 一个观战的人，
 * 开一场（空座人机补位），两人都按人机策略打到终局；记下服务器发给 B 和观战的每一条 room:updated，检查：
 * - 没有种子、随机数状态（任何一层都没有 seed / rng 字段）；
 * - B 拿到的别人的手牌只有：看牌打开时剩 10 张以下的队友、一盘结束时公开的；A（对手）的手牌一张都没有（和 A 自己看到的手牌对照）；
 * - 超过 10 张的人张数是 null；革命者扣下的牌拿不到；
 * - 私人信息（烧牌候选、烧牌请求、先收下的动作）只有 B 自己的；
 * - 观战（默认只看公开信息）拿不到任何手牌和私人信息。
 *
 * 用法：node scripts/spy.mjs [盘数=1]   环境变量 BOT_URL（默认 http://localhost:3021）、BOT_PATH、BOT_DELAY（默认 40 毫秒）。
 * 服务器建议用 BOT_DELAY_SCALE=0.05 起，跑得快。
 */
import { io } from "socket.io-client";
import { botBurn, botCommand, legalCommands } from "@gouji/game";

const URL = process.env.BOT_URL ?? "http://localhost:3021";
const PATH = process.env.BOT_PATH ?? "/socket.io";
const DELAY = Number(process.env.BOT_DELAY ?? 40);
const hands = Number(process.argv[2] ?? 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connect = () => new Promise((resolve, reject) => {
  const socket = io(URL, { path: PATH, transports: ["websocket"], reconnection: false });
  socket.once("connect", () => resolve(socket));
  socket.once("connect_error", reject);
});
const call = (socket, event, ...args) => new Promise((resolve) => socket.emit(event, ...args, resolve));

const violations = [];
const stats = { toB: 0, toSpectator: 0, bursts: 0, teammateVisible: 0, handEndShown: 0, burnSeenByB: 0, revolution: 0 };
let aHands = new Map(); // version → A 的手牌

function hasKey(value, keys, path = "") {
  if (!value || typeof value !== "object") return null;
  for (const [key, inner] of Object.entries(value)) {
    if (keys.includes(key)) return `${path}.${key}`;
    const found = hasKey(inner, keys, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function checkView(room, viewerSeat, label) {
  const game = room.game;
  if (!game) return;
  const leaked = hasKey(game, ["seed", "rng", "log", "actions"]);
  if (leaked) violations.push(`${label}：有服务端字段 ${leaked}`);
  const showAll = game.stage === "handEnd" || game.phase === "finished";
  game.players.forEach((player, seat) => {
    if (seat === viewerSeat) return;
    const teammate = viewerSeat >= 0 && seat % 2 === viewerSeat % 2;
    const allowed = showAll || (teammate && game.config.peek && player.handCount !== null && player.handCount <= 10);
    if (player.hand.length > 0) {
      if (!allowed) violations.push(`${label}：看到了 ${seat} 号的手牌（${player.hand.length} 张，version ${game.version}）`);
      else if (showAll) stats.handEndShown += 1;
      else stats.teammateVisible += 1;
    }
    if (!showAll && player.handCount !== null && player.handCount > 10) violations.push(`${label}：${seat} 号超过 10 张却给了张数`);
  });
  if (game.revolutionHand.length > 0 && game.revolutionary !== viewerSeat) violations.push(`${label}：看到了革命者扣下的牌`);
  if (game.revolutionary !== null) stats.revolution += 1;
  if (viewerSeat < 0 && game.you) violations.push(`${label}：观战拿到了私人信息`);
  if (viewerSeat >= 0 && game.you && game.you.seat !== viewerSeat) violations.push(`${label}：you 不是自己`);
  if (game.round?.pending && game.round.pending.seat !== viewerSeat) violations.push(`${label}：看到了别人先收下的动作`);
  if (game.round?.burnRequests?.some((request) => request.seat !== viewerSeat)) violations.push(`${label}：看到了别人的烧牌请求`);
  if (game.revolution?.eligible.some((seat) => seat !== viewerSeat)) violations.push(`${label}：看到了别人能不能革命`);
  // 和 A 自己看到的手牌对照：B 的视图里任何私人字段都不能出现 A 手里的牌
  const aHand = aHands.get(game.version);
  if (aHand && !showAll) {
    const privateCards = new Set([
      ...game.players.flatMap((player, seat) => (seat === viewerSeat ? [] : player.hand)),
      ...game.revolutionHand,
      ...(game.you?.burnCandidates.flat() ?? []),
      ...(game.round?.burnRequests?.flatMap((request) => request.cards) ?? []),
    ]);
    const overlap = aHand.filter((card) => privateCards.has(card));
    if (overlap.length > 0) violations.push(`${label}：私人字段里出现了 A 的手牌 ${overlap.length} 张（version ${game.version}）`);
  }
}

function autoplay(socket, name) {
  let room = null;
  let acting = false;
  let lastKey = "";
  let lastBurnTop = "";
  const me = () => room?.members.find((member) => member.id === socket.id)?.playerId;
  async function act() {
    if (acting || !room?.game || room.game.phase !== "playing") return;
    const game = room.game;
    const seat = game.players.findIndex((player) => player.id === me());
    const top = game.round?.top;
    const topId = top ? `${game.handNo}:${game.redeals}:${top.seq}` : "";
    if (topId && topId !== lastBurnTop && game.you?.burnCandidates.length) {
      lastBurnTop = topId;
      const burn = botBurn(game, seat);
      if (burn) {
        acting = true;
        socket.emit("game:command", burn, () => { acting = false; stats.bursts += 1; void act(); });
        return;
      }
    }
    if (legalCommands(game, me()).filter((command) => command.type !== "BURN").length === 0) return;
    const key = `${game.version}:${game.stage}:${game.turn}`;
    if (key === lastKey) return;
    lastKey = key;
    acting = true;
    await sleep(DELAY);
    socket.emit("game:command", botCommand(game, seat), (response) => {
      acting = false;
      if (!response.ok) lastKey = "";
      else room = response.data;
      void act();
    });
  }
  socket.on("room:updated", (snapshot) => {
    room = snapshot;
    void act();
  });
  return { set: (snapshot) => { room = snapshot; void act(); }, name };
}

const a = await connect();
const b = await connect();
const watcher = await connect();
const created = await call(a, "room:create", { name: "抓包A", options: { hands } });
if (!created.ok) throw new Error(created.error);
const code = created.data.code;
const joined = await call(b, "room:join", { name: "抓包B", code });
if (!joined.ok) throw new Error(joined.error);
const bSeat = joined.data.members.find((member) => member.id === b.id).seat;
await call(watcher, "room:join", { name: "抓包观战", code, spectate: true });

a.on("room:updated", (room) => {
  if (room.game) aHands.set(room.game.version, room.game.players[0].hand);
});
let finished = false;
b.on("room:updated", (room) => {
  stats.toB += 1;
  checkView(room, bSeat, `发给 B（${bSeat} 号）`);
  if (room.game?.phase === "finished") finished = true;
});
watcher.on("room:updated", (room) => {
  stats.toSpectator += 1;
  checkView(room, -1, "发给观战");
});
autoplay(a, "A");
autoplay(b, "B");
const started = await call(a, "room:start");
if (!started.ok) throw new Error(started.error);
const begin = Date.now();
while (!finished && Date.now() - begin < 20 * 60_000) await sleep(200);
await sleep(300);
console.log(`房间 ${code}：A 在 0 号、B 在 ${bSeat} 号（对头），${hands} 盘${finished ? "打完了" : "没打完（超时）"}；发给 B ${stats.toB} 条、观战 ${stats.toSpectator} 条；B 看到队友手牌 ${stats.teammateVisible} 次（看牌规则内）、结算时公开 ${stats.handEndShown} 次；有革命的快照 ${stats.revolution} 条；A/B 按烧牌 ${stats.bursts} 次`);
if (violations.length > 0) {
  console.log(`✗ 发现 ${violations.length} 处泄露：`);
  for (const line of violations.slice(0, 20)) console.log("  ", line);
} else console.log("✓ 没有发现泄露（种子、对手手牌、超过 10 张的张数、革命者的牌、别人的烧牌资格和请求都拿不到）");
a.disconnect();
b.disconnect();
watcher.disconnect();
process.exit(violations.length > 0 || !finished ? 1 : 0);
