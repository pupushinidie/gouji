/**
 * 预览页（开发时打开 http://localhost:5292/preview.html?s=场景）：用 packages/game 的预览局面工厂造局面，渲染正式牌桌 GameBoard。
 * 参数：s=场景名（见 SCENE_NAMES）、seat=从哪个座位看（默认 0，-1 观战）、all=1 观战看全部手牌、offline=3,4 离线的座位、
 * remaining=毫秒（倒计时）、nav=1 底下显示场景列表和「满 2 秒」「超时」按钮、debug=1 换成调试牌桌、
 * then=bot,burn,tick 打开后每隔 0.7 秒依次做：bot = 该行动的人按人机出、burn = 能烧的人按人机烧、tick = 烧牌窗口满 2 秒（看特效用）。
 * 操作在本地直接跑 applyCommand（和服务器同一套规则）。
 * 界面阶段维护这里的场景（教程、验收要加场景就往里加，不要删别人的）。
 */
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { applyCommand, botBurn, botCommand, burnEligibleSeats, burnWindowKey, createScene, pendingSeats, previewRoom, redactGameForViewer, SCENE_NAMES, tickBurnWindow, timeoutTurn, type GameCommand, type GameState, type SceneName } from "@gouji/game";
import DebugBoard from "./DebugBoard.js";
import GameBoard from "./GameBoard.js";
import { socket } from "./socket.js";
import { applyTheme, readTheme, ThemeToggle, useTheme } from "./theme.js";
import "./styles.css";
import "./app-pixel.css";
import "./ddz.css";
import "./gouji.css";
import "./theme-day.css";

applyTheme(readTheme());
// 冒充自己：previewRoom 里自己的连接 id 是 "me"
Object.defineProperty(socket, "id", { get: () => "me" });

const params = new URLSearchParams(window.location.search);
const sceneName = (SCENE_NAMES as readonly string[]).includes(params.get("s") ?? "") ? (params.get("s") as SceneName) : "opening";
const seat = Number(params.get("seat") ?? 0);
const offline = (params.get("offline") ?? "").split(",").filter(Boolean).map(Number);
const remaining = params.get("remaining");
const showNav = params.get("nav") === "1";

function Preview() {
  const [state, setState] = useState<GameState>(() => createScene(sceneName));
  const [error, setError] = useState("");
  const [theme, toggleTheme] = useTheme();
  const [watchId, setWatchId] = useState(state.players[0]!.id);
  const room = previewRoom(state, { viewerSeat: seat, offline, spectatorsSeeAll: params.get("all") === "1", ...(remaining !== null ? { turnRemainingMs: Number(remaining) } : {}) });
  const run = (next: () => GameState) => {
    try {
      setState(next());
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  const onCommand = (command: GameCommand) => run(() => applyCommand(state, state.players[seat]!.id, command));
  // then=…：一步步往下走，看特效
  useEffect(() => {
    const steps = (params.get("then") ?? "").split(",").filter(Boolean);
    const timers = steps.map((step, index) => window.setTimeout(() => setState((current) => {
      try {
        if (step === "tick") return burnWindowKey(current) ? tickBurnWindow(current) : current;
        if (step === "burn") {
          let next = current;
          for (const s of burnEligibleSeats(next)) {
            const command = botBurn(redactGameForViewer(next, next.players[s]!.id), s);
            if (command) next = applyCommand(next, next.players[s]!.id, command);
          }
          return next;
        }
        const s = current.turn >= 0 ? current.turn : pendingSeats(current)[0];
        if (s === undefined) return burnWindowKey(current) ? tickBurnWindow(current) : current;
        const id = current.players[s]!.id;
        return applyCommand(current, id, botCommand(redactGameForViewer(current, id), s));
      } catch {
        return current;
      }
    }), 600 + index * 700));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);
  const nav = showNav && (
    <nav style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 99, display: "flex", flexWrap: "wrap", gap: 6, padding: 4, background: "#000a", fontSize: 12 }}>
      {SCENE_NAMES.map((name) => (
        <a key={name} href={`?s=${name}&seat=${seat}&nav=1`} style={{ color: "#fff", fontWeight: name === sceneName ? "bold" : undefined }}>{name}</a>
      ))}
      <button type="button" onClick={() => run(() => tickBurnWindow(state))}>满 2 秒（TICK）</button>
      <button type="button" onClick={() => run(() => timeoutTurn(state))}>超时</button>
    </nav>
  );
  if (params.get("debug") === "1") {
    return (
      <main className="app-shell dz-game">
        {nav}
        <DebugBoard room={room} busy={false} error={error} notice="" brand={<strong>够级 · 预览「{sceneName}」</strong>} themeToggle={null} chat={null} onCommand={onCommand} onRematch={() => {}} onDissolve={() => {}} onLeave={() => {}} />
      </main>
    );
  }
  return (
    <main className="app-shell gj-game">
      <GameBoard
        room={room}
        busy={false}
        error={error}
        notice=""
        brand={<a className="brand" href="?nav=1"><span className="brand-name">够级<span> 预览 {sceneName}</span></span></a>}
        connection={null}
        theme={theme}
        themeToggle={<ThemeToggle theme={theme} onToggle={toggleTheme} />}
        chat={<div className="room-chat light"><div className="room-chat-list">（预览页没有聊天）</div></div>}
        onCommand={onCommand}
        onRematch={() => {}}
        onDissolve={() => {}}
        watchId={watchId}
        onWatch={setWatchId}
        onLeave={() => {}}
      />
      {nav}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
