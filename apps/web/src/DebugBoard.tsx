/**
 * 调试牌桌（引擎阶段联调用，正式牌桌由界面阶段做）：把当前状态原样显示出来，每个合法操作一个按钮。
 * 手牌可以点选，配合「出选中的牌」「烧选中的牌」「还选中的牌」用。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  cardsText,
  legalCommands,
  parseSet,
  PLACE_NAMES,
  setLabel,
  TEAM_NAMES,
  type Card,
  type GameCommand,
  type GameState,
  type LobbyRoomSnapshot,
} from "@gouji/game";
import { CardView } from "./cards.js";
import { roomRole } from "./RoomExtras.js";
import { socket } from "./socket.js";

const STAGE_NAMES: Record<GameState["stage"], string> = { tribute: "进贡（队内吃 / 免）", return: "还贡", revolution: "革命", playing: "出牌", handEnd: "结算" };
const KIND_NAMES = { burn: "烧贡", luo: "落贡", chuan: "串贡" } as const;

function commandLabel(command: GameCommand): string {
  switch (command.type) {
    case "PLAY": {
      const set = parseSet(command.cards);
      return `出 ${cardsText(command.cards)}${set ? `（${setLabel(set)}${set.gouji ? "·够级" : ""}）` : ""}`;
    }
    case "PASS":
      return "过";
    case "RANG":
      return "让牌";
    case "BURN":
      return `烧！${cardsText(command.cards)}`;
    case "TRIBUTE":
      return command.eat ? "吃贡" : "免贡";
    case "RETURN":
      return `还 ${cardsText(command.cards)}`;
    case "REVOLT":
      return command.revolt ? "革命" : "不革命";
    case "READY":
      return "下一盘";
    case "AUTO":
      return command.on ? "托管" : "取消托管";
  }
}

function eventText(game: GameState, event: GameState["history"][number]): string {
  const name = (seat: number) => `${seat}号${game.players[seat]?.name ?? ""}`;
  switch (event.type) {
    case "HandStarted":
      return `第 ${event.handNo} 盘开始，该 ${name(event.firstLeader)} 先出`;
    case "Dealt":
      return event.redeal > 0 ? `重新发牌（第 ${event.redeal} 次）` : "发牌";
    case "AntiTribute":
      return `${name(event.seat)} 抗贡（4 张大王）`;
    case "TributeChosen":
      return `${name(event.receiver)} ${event.eat ? "吃" : "免"}了 ${name(event.giver)} 的${KIND_NAMES[event.kind]}`;
    case "TributePaid":
      return `${name(event.giver)} → ${name(event.receiver)} ${KIND_NAMES[event.kind]}：${cardsText(event.cards) || "（没有王和 2，欠着不补）"}`;
    case "TributeReturned":
      return `${name(event.from)} 还 ${name(event.to)}：${cardsText(event.cards)}`;
    case "Revolted":
      return `${name(event.seat)} 革命`;
    case "RevolutionRedeal":
      return `${event.seats.map(name).join("、")} 都革命：这盘作废重新发牌`;
    case "FirstLead":
      return `${name(event.seat)} 先出`;
    case "Played":
      return `${name(event.seat)} ${event.lead ? "发" : "上"} ${cardsText(event.cards)}（${event.label}${event.gouji ? "·够级" : ""}）${event.left === null ? "" : `，剩 ${event.left} 张`}${event.auto ? "（超时）" : ""}`;
    case "Passed":
      return `${name(event.seat)} 过${event.auto ? "（超时）" : ""}`;
    case "Rang":
      return `${name(event.seat)} 让牌`;
    case "BurnStarted":
      return `${name(event.burner)} 烧 ${name(event.victim)}！`;
    case "BurnBroken":
      return `${name(event.by)} ${event.counter ? "反烧" : "解烧"}，${name(event.burner)} 烧牌失败`;
    case "BurnSucceeded":
      return `${name(event.burner)} 烧牌成功（下盘 ${name(event.victim)} 进烧贡）`;
    case "WentOut":
      return `${name(event.seat)} 走科（第 ${event.order + 1} 个出完）`;
    case "RoundEnded":
      return `${name(event.winner)} 赢下这一轮${event.jiefeng ? `，${name(event.leader)} 接风` : ""}`;
    case "Headless":
      return `${event.seats.map(name).join("、")} 无头了`;
    case "ChaosStarted":
      return "四人乱缠开始";
    case "HandEnded":
      return `第 ${event.handNo} 盘结束：甲 ${event.result.teamDeltas[0]}，乙 ${event.result.teamDeltas[1]}${event.result.sweep ? "（串三户）" : ""}`;
    case "TimedOut":
      return `${name(event.seat)} 超时`;
    case "AutoChanged":
      return `${name(event.seat)} ${event.on ? "进入托管" : "取消托管"}`;
    case "GameEnded":
      return event.winnerTeam === null ? "一场结束：平局" : `一场结束：${TEAM_NAMES[event.winnerTeam]}联邦赢`;
  }
}

export default function DebugBoard({
  room,
  busy,
  error,
  notice,
  brand,
  themeToggle,
  chat,
  onCommand,
  onRematch,
  onDissolve,
  onLeave,
}: {
  room: LobbyRoomSnapshot;
  busy: boolean;
  error: string;
  notice: string;
  brand: ReactNode;
  themeToggle: ReactNode;
  chat: ReactNode;
  onCommand: (command: GameCommand) => void;
  onRematch: (accept: boolean) => void;
  onDissolve: () => void;
  onLeave: () => void;
}) {
  const game = room.game!;
  const { isHost, spectating } = roomRole(room);
  const meId = room.members.find((member) => member.id === socket.id)?.playerId ?? "";
  const mySeat = game.players.findIndex((player) => player.id === meId);
  const [selected, setSelected] = useState<Card[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => setSelected([]), [game.version, game.stage]);
  useEffect(() => {
    if (room.turnRemainingMs === undefined) {
      setRemaining(null);
      return;
    }
    const until = Date.now() + room.turnRemainingMs;
    const tick = () => setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [room]);

  const commands = useMemo(() => (spectating || mySeat < 0 ? [] : legalCommands(game, meId)), [game, meId, mySeat, spectating]);
  const plays = commands.filter((command) => command.type === "PLAY");
  const others = commands.filter((command) => command.type !== "PLAY");
  const me = mySeat >= 0 ? game.players[mySeat]! : null;
  const round = game.round;
  const toggle = (card: Card) => setSelected((current) => (current.includes(card) ? current.filter((other) => other !== card) : [...current, card]));
  const top = round?.top;

  return (
    <div className="debug-board" style={{ display: "grid", gap: 12, padding: 12 }}>
      <header className="topbar">
        {brand}
        <div className="topbar-right">
          <span>第 {game.handNo}/{game.config.hands} 盘 · {STAGE_NAMES[game.stage]}{game.redeals ? `（重发 ${game.redeals} 次）` : ""}</span>
          <span>甲 {game.teamScores[0]} : 乙 {game.teamScores[1]}</span>
          {remaining !== null && <span>⏱ {remaining}s</span>}
          {themeToggle}
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve}>解散</button>}
          {spectating && <button className="quiet-button" type="button" onClick={onLeave}>离开观战</button>}
        </div>
      </header>
      <p style={{ margin: 0 }}>调试牌桌（正式牌桌由界面阶段做）。{game.chaos ? "【四人乱缠】" : ""}{game.burn ? `【${game.burn.burner} 号烧 ${game.burn.victim} 号中】` : ""}{top && !top.ready ? "【烧牌窗口：等满 2 秒】" : ""}</p>

      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr><th>座位</th><th>名字</th><th>联邦</th><th>张数</th><th>状态</th><th>手牌（看得到的）</th></tr>
        </thead>
        <tbody>
          {game.players.map((player, seat) => {
            const member = room.members.find((candidate) => candidate.playerId === player.id);
            const place = game.finished.indexOf(seat);
            const flags = [
              seat === game.turn ? "▶轮到" : "",
              player.bot ? "人机" : "",
              player.auto ? "托管" : "",
              member && !member.connected ? "离线" : "",
              game.headless[seat] ? "无头" : "",
              place >= 0 ? `走科#${place + 1}` : "",
              game.revolutionary === seat ? "革命" : "",
              round?.passed.includes(seat) ? "过过" : "",
              round?.rang?.seat === seat ? "让牌" : "",
              seat === mySeat ? "你" : "",
              mySeat >= 0 && seat === (mySeat + 3) % 6 ? "对头" : "",
            ].filter(Boolean);
            return (
              <tr key={seat} style={{ outline: seat === game.turn ? "2px solid currentColor" : undefined }}>
                <td>{seat}</td>
                <td>{player.name}</td>
                <td>{TEAM_NAMES[player.team]}</td>
                <td>{game.revolutionary === seat ? "革命" : player.handCount === null ? "10+" : player.handCount}</td>
                <td>{flags.join(" ")}</td>
                <td>{seat === mySeat ? "" : cardsText(player.hand)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {round && game.stage === "playing" && (
        <section>
          <strong>这一轮（{round.leader} 号发牌）：</strong>
          {round.entries.map((entry, index) => (
            <span key={index} style={{ marginRight: 12 }}>
              {entry.seat}号{entry.kind === "play" ? `${entry.burn ? "烧" : ""}出 ${cardsText(entry.cards)}（${setLabel(entry.set)}${entry.set.gouji ? "·够级" : ""}）` : entry.kind === "pass" ? "过" : "让牌"}
            </span>
          ))}
          {game.lastRound && <div style={{ opacity: 0.7 }}>上一轮：{game.lastRound.winner} 号赢，{game.lastRound.entries.filter((entry) => entry.kind === "play").length} 手</div>}
        </section>
      )}

      {game.tribute && (game.stage === "tribute" || game.stage === "return") && (
        <section>
          <strong>进贡：</strong>
          {game.tribute.items.map((item, index) => (
            <div key={index}>
              {item.giver}号 → {item.receiver}号 {KIND_NAMES[item.kind]} {item.count} 张{item.intra ? `（队内：${item.eat === null ? "等收的人选" : item.eat ? "吃" : "免"}）` : ""} {item.cards.length ? cardsText(item.cards) : ""} {item.returned ? `还：${cardsText(item.returned)}` : ""}
            </div>
          ))}
          {game.tribute.antiTribute.length > 0 && <div>抗贡：{game.tribute.antiTribute.join("、")} 号</div>}
        </section>
      )}

      {game.result && game.stage === "handEnd" && (
        <section>
          <strong>第 {game.result.handNo} 盘结果{game.result.sweep ? `：${TEAM_NAMES[game.result.sweepTeam!]}联邦串三户` : ""}</strong>
          <div>{game.result.order.map((seat, place) => `${PLACE_NAMES[place]} ${seat}号${game.players[seat]!.name}`).join("，")}</div>
          <div>甲 {game.result.teamDeltas[0]}，乙 {game.result.teamDeltas[1]}{game.result.burns.length ? `；烧牌成功 ${game.result.burns.map((burn) => `${burn.burner}烧${burn.victim}`).join("、")}` : ""}</div>
          {game.finalResult && <div><strong>一场结束：{game.finalResult.draw ? "平局" : `${TEAM_NAMES[game.finalResult.winnerTeam!]}联邦赢`}（{game.finalResult.teamScores.join(" : ")}）</strong></div>}
        </section>
      )}

      {game.phase === "finished" && room.rematch && !spectating && (
        <section>
          再来一局？（{room.rematch.acceptedIds.length}/{room.members.length} 人同意）
          <button className="quiet-button" type="button" onClick={() => onRematch(true)}>再来一局</button>
          <button className="quiet-button" type="button" onClick={() => onRematch(false)}>不玩了</button>
        </section>
      )}

      {me && (
        <section>
          <strong>你的手牌（{me.hand.length} 张）</strong>
          {game.revolutionary === mySeat && <span>：你革命了，扣下的牌 {cardsText(game.revolutionHand)}</span>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 6 }}>
            {me.hand.map((card) => (
              <CardView key={card} card={card} scale={1} onClick={() => toggle(card)} style={{ cursor: "pointer", transform: selected.includes(card) ? "translateY(-10px)" : undefined }} />
            ))}
          </div>
          {game.you && (game.you.burnCandidates.length > 0 || game.you.burnRequested || game.you.pendingAction) && (
            <div>
              {game.you.burnCandidates.length > 0 && <span>你现在能烧（只有你看得到）。</span>}
              {game.you.burnRequested && <span>已按烧牌：{cardsText(game.you.burnRequested)}，满 2 秒生效。</span>}
              {game.you.pendingAction && <span>已选好：{commandLabel(game.you.pendingAction)}，满 2 秒生效。</span>}
            </div>
          )}
        </section>
      )}

      {!spectating && me && (
        <section style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {selected.length > 0 && game.stage === "playing" && <button type="button" className="primary-button" disabled={busy} onClick={() => onCommand({ type: "PLAY", cards: selected })}>出选中的牌（{cardsText(selected)}）</button>}
          {selected.length > 0 && game.stage === "playing" && (game.you?.burnCandidates.length ?? 0) > 0 && <button type="button" className="primary-button" disabled={busy} onClick={() => onCommand({ type: "BURN", cards: selected })}>烧选中的牌</button>}
          {selected.length > 0 && game.stage === "return" && <button type="button" className="primary-button" disabled={busy} onClick={() => onCommand({ type: "RETURN", cards: selected })}>还选中的牌</button>}
          {others.map((command, index) => (
            <button key={`o${index}`} type="button" className="quiet-button" disabled={busy} onClick={() => onCommand(command)}>{commandLabel(command)}</button>
          ))}
          {plays.slice(0, 40).map((command, index) => (
            <button key={`p${index}`} type="button" className="quiet-button" disabled={busy} onClick={() => onCommand(command)}>{commandLabel(command)}</button>
          ))}
          {plays.length > 40 && <span>……还有 {plays.length - 40} 种出法（点选手牌再「出选中的牌」）</span>}
          {me.auto && <button type="button" className="quiet-button" onClick={() => onCommand({ type: "AUTO", on: false })}>取消托管</button>}
        </section>
      )}

      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
      {notice && <p className="feedback feedback-success" role="status">{notice}</p>}

      <section style={{ maxHeight: 220, overflow: "auto", fontSize: 13 }}>
        {[...game.history].reverse().slice(0, 40).map((event, index) => <div key={index}>{eventText(game, event)}</div>)}
      </section>
      {chat}
    </div>
  );
}
