#!/usr/bin/env node
/**
 * 够级陪玩脚本（本地联调、线上在服务器上连 localhost 测试用）。先 npm run build:game（规则包的 dist）。
 * 服务器自己会给空座位补人机；这个脚本模拟「真人」连进房间（测多人房间、重连、抢座位、整场流程）。
 *
 * 用法：
 *   node scripts/test-bot.mjs host <昵称> [--start-at=N] [--hands=1] [--tribute=0] [--rang=0] [--peek=0]
 *       建房，打印房间码；凑够 N 个真人（含自己）自动开局；--start-at=1 就是建房后马上开局（5 个人机补位）
 *   node scripts/test-bot.mjs join <房间码> <昵称> [--seat=K]     加入房间（--seat 换到 K 号座）
 *   node scripts/test-bot.mjs fill <房间码> <人数> [昵称前缀=陪玩]   一次加入好几个
 *
 * 环境变量：BOT_URL（默认 http://localhost:3021）、BOT_DELAY（每步之前等多少毫秒，默认 600）、BOT_PATH（socket.io 路径，默认 /socket.io）、
 *          BOT_REMATCH=0（一场结束后不同意再来一局，打完就退出）、BOT_IDLE=1（只挂着不动，用来测超时和托管）。
 * 策略和服务器上的人机一样（botCommand / botBurn，只看自己座位的视图）。每次 ack 之后都按最新状态重新判断。
 */
import { io } from "socket.io-client";
import { botBurn, botCommand, legalCommands } from "@gouji/game";

const URL = process.env.BOT_URL ?? "http://localhost:3021";
const DELAY = Number(process.env.BOT_DELAY ?? 600);
const PATH = process.env.BOT_PATH ?? "/socket.io";
const IDLE = process.env.BOT_IDLE === "1";

const [mode, ...args] = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("--"));
const positional = args.filter((arg) => !arg.startsWith("--"));
const flag = (name, fallback) => flags.find((item) => item.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const startAt = Number(flag("start-at", 0));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runBot(name, setup) {
  const socket = io(URL, { path: PATH, transports: ["websocket"], reconnection: true });
  let room = null;
  let acting = false;
  let lastKey = "";
  let lastBurnTop = "";
  let started = false;
  const log = (...items) => console.log(`[${name}]`, ...items);
  const myPlayerId = () => room?.members.find((member) => member.id === socket.id)?.playerId;

  async function act() {
    if (acting || !room || IDLE) return;
    const game = room.game;
    if (room.rematch && game?.phase === "finished") {
      if (process.env.BOT_REMATCH === "0") {
        log("一场结束，退出");
        process.exit(0);
      }
      if (!room.rematch.acceptedIds.includes(socket.id)) {
        acting = true;
        await sleep(DELAY);
        socket.emit("room:rematch", true, () => { acting = false; });
      }
      return;
    }
    if (!game || game.phase !== "playing") return;
    const me = myPlayerId();
    const seat = game.players.findIndex((player) => player.id === me);
    if (seat < 0) return;
    // 轮外操作：能烧就问人机烧不烧（每套桌面牌只问一次）
    const top = game.round?.top;
    const topId = top ? `${game.handNo}:${game.redeals}:${top.seq}` : "";
    if (topId && topId !== lastBurnTop && game.you?.burnCandidates.length) {
      lastBurnTop = topId;
      const burn = botBurn(game, seat);
      if (burn) {
        acting = true;
        await sleep(Math.min(DELAY, 1200));
        socket.emit("game:command", burn, (response) => {
          acting = false;
          log(response.ok ? "烧牌！" : `烧牌被拒：${response.error}`);
          if (response.ok) room = response.data;
          void act();
        });
        return;
      }
    }
    if (legalCommands(game, me).filter((command) => command.type !== "BURN").length === 0) return;
    const key = `${game.version}:${game.stage}:${game.turn}`;
    if (key === lastKey) return;
    const command = botCommand(game, seat);
    acting = true;
    lastKey = key;
    await sleep(DELAY);
    socket.emit("game:command", command, (response) => {
      acting = false;
      if (!response.ok) {
        log("被拒绝：", command.type, response.error);
        lastKey = "";
      } else {
        room = response.data;
      }
      void act(); // ack 之后按最新状态再判断一次
    });
  }

  socket.on("connect", () => {
    if (room) return;
    setup(socket, (snapshot) => {
      room = snapshot;
      void act();
    }, log);
  });
  socket.on("room:updated", (snapshot) => {
    room = snapshot;
    const meMember = room.members.find((member) => member.id === socket.id);
    if (!started && startAt && room.status === "waiting" && room.members.length >= startAt && meMember?.isHost) {
      started = true;
      socket.emit("room:start", (response) => log(response.ok ? "开局" : `开局失败：${response.error}`));
    }
    const game = room.game;
    if (game?.stage === "handEnd" && game.result && game.events.some((event) => event.type === "HandEnded")) {
      const result = game.result;
      log(`第 ${result.handNo} 盘结束${result.sweep ? "（串三户）" : ""}：名次 ${result.order.join(",")}，甲 ${result.teamDeltas[0]} 乙 ${result.teamDeltas[1]}，累计 ${game.teamScores.join(":")}`);
    }
    if (game?.phase === "finished" && game.finalResult && !room.rematch?.acceptedIds.length) {
      log("一场结束：", game.finalResult.draw ? "平局" : `${game.finalResult.winnerTeam === 0 ? "甲" : "乙"}联邦赢`, game.teamScores.join(":"));
    }
    void act();
  });
  socket.on("room:closed", ({ reason }) => {
    log("房间关闭：", reason);
    process.exit(0);
  });
  socket.on("connect_error", (error) => log("连不上：", error.message));
  return socket;
}

if (mode === "host") {
  const [name = "房主陪玩"] = positional;
  const options = { hands: Number(flag("hands", 1)), tribute: flag("tribute", "1") !== "0", rang: flag("rang", "1") !== "0", peek: flag("peek", "1") !== "0" };
  runBot(name, (socket, done, log) => {
    socket.emit("room:create", { name, options }, (response) => {
      if (!response.ok) {
        log("建房失败：", response.error);
        process.exit(1);
      }
      log("房间码", response.data.code, "选项", JSON.stringify(options));
      console.log(`ROOM ${response.data.code}`);
      done(response.data);
    });
  });
} else if (mode === "join" || mode === "fill") {
  const code = positional[0];
  const count = mode === "fill" ? Number(positional[1] ?? 1) : 1;
  const prefix = mode === "fill" ? positional[2] ?? "陪玩" : positional[1] ?? "陪玩";
  const seat = flag("seat", undefined);
  for (let k = 0; k < count; k += 1) {
    const name = mode === "fill" ? `${prefix}${k + 1}` : prefix;
    runBot(name, (socket, done, log) => {
      socket.emit("room:join", { name, code }, (response) => {
        if (!response.ok) {
          log("加入失败：", response.error);
          return;
        }
        log("已加入", code, "座位", response.data.members.find((member) => member.id === socket.id)?.seat);
        done(response.data);
        if (seat !== undefined) socket.emit("room:seat", Number(seat), (moved) => log(moved.ok ? `换到 ${seat} 号座` : `换座失败：${moved.error}`));
      });
    });
    await sleep(150);
  }
} else {
  console.log("用法见文件开头的注释。");
  process.exit(1);
}
