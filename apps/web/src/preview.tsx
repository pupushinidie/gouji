/**
 * 预览页（开发时打开 http://localhost:5292/preview.html?s=场景）：用 packages/game 的预览局面工厂造局面，渲染牌桌。
 * 参数：s=场景名（见 SCENE_NAMES）、seat=从哪个座位看（默认 0，-1 观战）、all=1 观战看全部手牌、offline=3,4 离线的座位、remaining=毫秒（倒计时）。
 * 操作在本地直接跑 applyCommand（和服务器同一套规则），另有「满 2 秒」（TICK）和「超时」按钮。
 * 引擎阶段先接调试牌桌；界面阶段换成正式的 GameBoard 并维护这里的场景（教程、验收要加场景就往里加，不要删别人的）。
 */
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { applyCommand, createScene, previewRoom, SCENE_NAMES, tickBurnWindow, timeoutTurn, type GameCommand, type GameState, type SceneName } from "@gouji/game";
import DebugBoard from "./DebugBoard.js";
import { socket } from "./socket.js";
import { applyTheme, readTheme } from "./theme.js";
import "./styles.css";
import "./app-pixel.css";
import "./ddz.css";
import "./theme-day.css";

applyTheme(readTheme());
// 冒充自己：previewRoom 里自己的连接 id 是 "me"
Object.defineProperty(socket, "id", { get: () => "me" });

const params = new URLSearchParams(window.location.search);
const sceneName = (SCENE_NAMES as readonly string[]).includes(params.get("s") ?? "") ? (params.get("s") as SceneName) : "opening";
const seat = Number(params.get("seat") ?? 0);
const offline = (params.get("offline") ?? "").split(",").filter(Boolean).map(Number);
const remaining = params.get("remaining");

function Preview() {
  const [state, setState] = useState<GameState>(() => createScene(sceneName));
  const [error, setError] = useState("");
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
  return (
    <main className="app-shell dz-game">
      <nav style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 8 }}>
        {SCENE_NAMES.map((name) => (
          <a key={name} href={`?s=${name}&seat=${seat}`} style={{ fontWeight: name === sceneName ? "bold" : undefined }}>{name}</a>
        ))}
        <button type="button" onClick={() => run(() => tickBurnWindow(state))}>满 2 秒（TICK）</button>
        <button type="button" onClick={() => run(() => timeoutTurn(state))}>超时</button>
      </nav>
      <DebugBoard
        room={room}
        busy={false}
        error={error}
        notice=""
        brand={<strong>够级 · 预览「{sceneName}」</strong>}
        themeToggle={null}
        chat={null}
        onCommand={onCommand}
        onRematch={() => {}}
        onDissolve={() => {}}
        onLeave={() => {}}
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
