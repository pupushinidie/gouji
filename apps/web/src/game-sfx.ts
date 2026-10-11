/**
 * 够级的动作音效：看对局里新来的事件（game.history 比上一次多出来的那几条）放对应的声音。
 * 声音都来自全站共用的 gm-sound.tsx（sfx.* 和 synth），这里只决定「什么动作配什么声音、什么时候响」。
 *
 * - 自己的动作 mine=true 响亮，别人的减半；观战时都算别人的。
 * - 第一次拿到对局（进房间、重连、观战刚进来、教程换一局）不出声；剧本跳到新局面不出声，一下来了一大串（断线很久又回来）只放最后一步。
 * - 同一步里的几个声音按顺序错开几十到几百毫秒，听起来像一个动作的结果。
 * - 只有自己看得到的变化（烧牌窗口里先收下的出牌 / 过牌、按了烧牌、吃贡免贡、还贡、革命表态）在按下时就给自己响一声，
 *   等它公开时（事件到了）不再重复；别人的这些选择在公开前不出声（不然一听就知道）。
 */
import { useEffect, useRef } from "react";
import type { GoujiEvent, GoujiState } from "@gouji/game";
import { sfx, synth, type SfxName } from "./gm-sound.js";

/** 开发时把放过的声音名字记进 window.__sfxLog（自测脚本靠它确认响的是哪个）。 */
function log(name: string) {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as { __sfxLog?: string[] };
  (w.__sfxLog ??= []).push(name);
}

type SfxArgs<N extends SfxName> = Parameters<(typeof sfx)[N]>;

/** delay 毫秒后放一个 sfx.* 声音。 */
function play<N extends SfxName>(delay: number, name: N, ...args: SfxArgs<N>) {
  const run = () => {
    log(name);
    (sfx[name] as (...a: SfxArgs<N>) => void)(...args);
  };
  if (delay <= 0) run();
  else window.setTimeout(run, delay);
}

/** delay 毫秒后放一个这款游戏自己的声音。 */
function cue(delay: number, name: string, run: () => void) {
  const go = () => {
    log(name);
    run();
  };
  if (delay <= 0) go();
  else window.setTimeout(go, delay);
}

const { tone, noise, level } = synth;

/** 表态（吃贡 / 免贡、革命 / 不革命、让牌）：要的往上两三个音，不要的轻轻往下一声。 */
function claim(yes: boolean, mine: boolean, strong = false) {
  const v = level(mine);
  if (!yes) {
    tone(587, { duration: 0.12, volume: 0.09 * v, type: "triangle", glideTo: 440 });
    return;
  }
  const notes = strong ? [659, 880, 1175] : [659, 880];
  notes.forEach((f, i) => tone(f, { at: i * 0.07, duration: 0.14, volume: 0.13 * v, type: "triangle" }));
  if (strong) noise({ at: 0.14, duration: 0.08, volume: 0.1 * v, filter: "highpass", freq: 3000 });
}

/** 够级牌：牌拍下去之后一记低沉的鼓。 */
function goujiDrum(mine: boolean) {
  const v = level(mine);
  tone(98, { duration: 0.3, volume: 0.28 * v, glideTo: 60 });
  noise({ duration: 0.08, volume: 0.2 * v, filter: "lowpass", freq: 700 });
  tone(196, { at: 0.02, duration: 0.15, volume: 0.1 * v, type: "triangle" });
}

/** 烧牌：一团火呼地烧起来，噼啪几声。 */
function fire(mine: boolean, big = false) {
  const v = level(mine) * (big ? 1.2 : 1);
  noise({ duration: 0.55, volume: 0.22 * v, freq: 300, freqTo: 2400, q: 0.6 });
  noise({ at: 0.2, duration: 0.5, volume: 0.12 * v, filter: "lowpass", freq: 1200, freqTo: 400 });
  for (let i = 0; i < 5; i += 1) noise({ at: 0.12 + i * 0.09 + Math.random() * 0.04, duration: 0.02, volume: 0.2 * v, filter: "highpass", freq: 4000 });
}

/** 革命：一阵鼓点滚上去，然后重重一下。 */
function revolution(mine: boolean) {
  const v = level(mine);
  for (let i = 0; i < 6; i += 1) {
    tone(110 + i * 12, { at: i * 0.07, duration: 0.08, volume: (0.1 + i * 0.03) * v, type: "triangle" });
    noise({ at: i * 0.07, duration: 0.04, volume: (0.08 + i * 0.02) * v, filter: "lowpass", freq: 900 });
  }
  window.setTimeout(() => sfx.boom(mine), 440);
}

/** 剩 1–2 张时提醒（两声短促的嘀）。 */
function alarm(mine: boolean, left: number) {
  const v = level(mine);
  const f = left === 1 ? 1320 : 1100;
  tone(f, { duration: 0.07, volume: 0.11 * v, type: "square" });
  tone(f, { at: 0.12, duration: 0.07, volume: 0.11 * v, type: "square" });
}

/** 别人点了「下一盘」：一声很轻的嗒。 */
function tick() {
  tone(1400, { duration: 0.04, volume: 0.05, type: "triangle" });
}

/** 已经在按下时给自己响过的（等公开时不再重复，用掉一次就清零）：出牌 / 过牌 / 吃贡 / 还贡，记的是按下的时间。 */
interface Early {
  play: number;
  pass: number;
  tribute: number;
  ret: number;
}
const RECENT = 6000;

/**
 * 上一次之后新来的事件：在新的 history 里找到上一次 history 的最后两条，后面的就是新的。
 * 引擎一步可能连走好几下（教程里烧牌窗口、服务器连着处理），所以不只看 game.events。对不上（剧本跳到新局面）返回 null。
 */
function freshEvents<E>(before: readonly E[], after: readonly E[]): E[] | null {
  if (before.length === 0) return [...after];
  const lastKey = JSON.stringify(before[before.length - 1]);
  const prevKey = before.length > 1 ? JSON.stringify(before[before.length - 2]) : null;
  for (let i = after.length - 1; i >= 0; i -= 1) {
    if (JSON.stringify(after[i]) !== lastKey) continue;
    if (prevKey === null || i === 0 || JSON.stringify(after[i - 1]) === prevKey) return after.slice(i + 1);
  }
  return null;
}

/** 一步里的事件 → 声音，按顺序错开。返回这些声音一共排到了多少毫秒以后（「轮到你」排在它们后面）。 */
function playEvents(events: readonly GoujiEvent[], game: GoujiState, mySeat: number | null, early: Early): number {
  let t = 0;
  const mine = (seat: number) => seat === mySeat;
  const now = Date.now();
  const myTeam = mySeat === null ? null : game.players[mySeat]?.team ?? null;
  for (const event of events) {
    switch (event.type) {
      case "HandStarted":
        if (event.handNo > 1) {
          play(t, "shuffle");
          t += 380;
        }
        break;
      case "RevolutionRedeal":
        play(t, "shuffle");
        t += 380;
        break;
      case "Dealt":
        play(t, "deal", 12);
        t += 600;
        break;
      case "AntiTribute":
        // 发到 4 张大王：抗贡
        play(t + 100, "sparkle", mine(event.seat));
        t += 500;
        break;
      case "TributeChosen":
        if (mine(event.receiver) && now - early.tribute < RECENT) {
          early.tribute = 0;
          break;
        }
        cue(t, event.eat ? "claim:eat" : "claim:no", () => claim(event.eat, mine(event.receiver)));
        t += 200;
        break;
      case "TributePaid":
        if (event.cards.length === 0) break;
        play(t, "card", mine(event.giver), event.cards.length);
        play(t + 250, "draw", mine(event.receiver), event.cards.length);
        t += 450;
        break;
      case "TributeReturned":
        if (mine(event.from) && now - early.ret < RECENT) {
          early.ret = 0;
          play(t, "draw", mine(event.to), event.cards.length);
          t += 200;
          break;
        }
        play(t, "card", mine(event.from), event.cards.length);
        play(t + 250, "draw", mine(event.to), event.cards.length);
        t += 450;
        break;
      case "Revolted": {
        const m = mine(event.seat);
        cue(t, "revolution", () => revolution(m));
        t += 1000;
        break;
      }
      case "FirstLead":
        break;
      case "Played": {
        const m = mine(event.seat);
        const already = m && now - early.play < RECENT;
        if (already) early.play = 0;
        if (!already) play(t, "card", m, event.cards.length);
        if (event.gouji) {
          cue(t + (already ? 0 : 140), "goujiDrum", () => goujiDrum(m));
          t += 300;
        }
        t += already ? 0 : 150 + Math.min(event.cards.length, 6) * 45;
        if (event.left === 1 || event.left === 2) {
          cue(t + 100, "alarm", () => alarm(m, event.left!));
          t += 300;
        }
        break;
      }
      case "Passed":
        if (mine(event.seat) && now - early.pass < RECENT) {
          early.pass = 0;
          break;
        }
        play(t, "pass", mine(event.seat));
        t += 200;
        break;
      case "Rang":
        // 让牌：先让下家接，轻轻往下一声
        cue(t, "claim:rang", () => claim(false, mine(event.seat)));
        play(t + 120, "pass", mine(event.seat));
        t += 300;
        break;
      case "BurnStarted": {
        const m = mine(event.burner);
        cue(t, "fire", () => fire(m));
        t += 600;
        break;
      }
      case "BurnBroken":
        play(t, "hit", mine(event.by));
        play(t + 200, "bust", mine(event.burner));
        t += 500;
        break;
      case "BurnSucceeded": {
        const m = mine(event.burner);
        cue(t, "fire", () => fire(m, true));
        play(t + 450, "score", m, true);
        t += 800;
        break;
      }
      case "WentOut":
        // 走科：头科亮晶晶，其余一声得分
        if (event.order === 0) play(t + 150, "sparkle", mine(event.seat));
        else play(t + 150, "score", mine(event.seat));
        t += 500;
        break;
      case "RoundEnded":
        // 接风：轻轻一声，把出牌权交出去
        if (event.jiefeng) {
          play(t + 100, "turnPassed");
          t += 250;
        }
        break;
      case "Headless":
        // 自己的对头走了，自己没头了
        if (mySeat !== null && event.seats.includes(mySeat)) {
          play(t, "bust", true);
          t += 400;
        }
        break;
      case "ChaosStarted":
        // 四人乱缠
        play(t, "roundStart");
        t += 400;
        break;
      case "TimedOut":
        if (mine(event.seat)) {
          play(t, "timeout");
          t += 350;
        }
        break;
      case "HandEnded": {
        t += 500;
        const result = event.result;
        if (result.sweep) {
          play(t, "sparkle", myTeam !== null && result.sweepTeam === myTeam);
          t += 300;
        }
        const delta = mySeat === null ? null : result.deltas[mySeat] ?? 0;
        if (delta === null) play(t, "score", false);
        else if (delta > 0) play(t, "score", true, true);
        else if (delta < 0) play(t, "bust", true);
        else play(t, "reveal", true);
        t += 500;
        break;
      }
      case "GameEnded":
        play(t + 600, "gameOver", myTeam !== null && event.winnerTeam === myTeam);
        t += 1200;
        break;
      case "AutoChanged":
        break;
    }
  }
  return t;
}

/**
 * 牌桌上调用：对比前后两次对局，放刚发生的动作的声音；轮到自己时响一声。
 * mySeat：自己的座位（观战传 null）；myTurn：现在要自己做决定（出牌、吃贡免贡、还贡、革命表态）。
 */
export function useGameSfx(game: GoujiState, mySeat: number | null, myTurn: boolean) {
  const prev = useRef<{ game: GoujiState; myTurn: boolean } | null>(null);
  const early = useRef<Early>({ play: 0, pass: 0, tribute: 0, ret: 0 });
  useEffect(() => {
    const before = prev.current;
    prev.current = { game, myTurn };
    if (!before) return;
    const last = before.game;
    // 换了一局（教程「再练一局」）或者版本往回走了：当成重新进来，不出声
    if (game.version < last.version || game.players.some((player, seat) => player.id !== last.players[seat]?.id)) return;

    // 新来的事件；对不上（剧本跳到新的局面）就整个不出声，一下来了一大串（断线很久又回来）只放最后一步
    const changed = game.version !== last.version;
    const fresh = changed ? freshEvents(last.history, game.history) : [];
    const jumped = changed && fresh === null;

    // 只有自己看得到的变化：按下就响
    let t = 0;
    if (mySeat !== null && game.handNo === last.handNo && !jumped) {
      const pending = game.you?.pendingAction;
      if (pending && !last.you?.pendingAction) {
        if (pending.type === "PLAY") {
          early.current.play = Date.now();
          play(0, "card", true, pending.cards.length);
        } else {
          early.current.pass = Date.now();
          play(0, "pass", true);
        }
        t = 300;
      }
      if (game.you?.burnRequested && !last.you?.burnRequested) {
        cue(0, "claim:burn", () => claim(true, true, true));
        t = 300;
      }
      const choice = game.revolution?.choices[mySeat];
      if (choice !== null && choice !== undefined && (last.revolution?.choices[mySeat] ?? null) === null) {
        cue(0, choice ? "claim:revolt" : "claim:no", () => claim(choice, true, choice));
        t = 300;
      }
      const items = game.tribute?.items ?? [];
      const oldItems = last.tribute?.items ?? [];
      items.forEach((item, index) => {
        const old = oldItems[index];
        if (!old) return;
        if (item.receiver === mySeat && item.intra && item.eat !== null && old.eat === null) {
          early.current.tribute = Date.now();
          cue(0, item.eat ? "claim:eat" : "claim:no", () => claim(item.eat!, true));
          t = 300;
        }
        if (item.receiver === mySeat && item.returned !== null && old.returned === null) {
          early.current.ret = Date.now();
          play(0, "card", true, item.returned.length);
          t = 300;
        }
      });
    }

    if (changed && fresh !== null) {
      const events = fresh.length > 12 ? game.events : fresh;
      t = Math.max(t, playEvents(events, game, mySeat, early.current));
      // 没有事件的公开变化：别人点了「下一盘」
      const myId = mySeat === null ? null : game.players[mySeat]?.id;
      if (events.length === 0 && game.ready.some((id) => !last.ready.includes(id) && id !== myId)) cue(0, "tick", tick);
    }

    if (myTurn && !before.myTurn) play(t + 250, "yourTurn");
  }, [game, myTurn]);
}

/** 点选手牌：选上往上一声，放下往下一声。 */
export function selectSound(on: boolean) {
  play(0, "select", on);
}

/** 服务器拒绝了操作、房间出错。 */
export function errorSound() {
  play(0, "error");
}

/** 不能点的地方（教程里没按剧本走）。 */
export function denySound() {
  play(0, "deny");
}
