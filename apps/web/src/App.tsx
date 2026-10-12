import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { DEFAULT_OPTIONS, SEAT_COUNT, TEAM_NAMES, teamOf, type Card, type GameCommand, type GameOptions, type LobbyRoomSnapshot, type PublicRoomSummary } from "@gouji/game";
import { art, bgArt, seatColor } from "./art.js";
import { CardView } from "./cards.js";
import { useConfirm } from "./confirm.js";
import GameBoard from "./GameBoard.js";
import { TutorialInvite } from "./tutorial/Invite.js";
import { readTutorial } from "./tutorial/storage.js";
import { GAME_ID } from "./tutorialGame.js";
import TutorialMode from "./TutorialMode.js";
import GameRules from "./GameRules.js";
import OnlineRooms from "./OnlineRooms.js";
import RoomChat from "./RoomChat.js";
import { roomRole, RoomSettingsPanel, SeatSwitch } from "./RoomExtras.js";
import { socket } from "./socket.js";
import { ThemeToggle, useTheme } from "./theme.js";
import { type BgmTrack, SoundToggle, useBgm, useRoomSfx } from "./gm-sound.js";
import { errorSound } from "./game-sfx.js";
import { useVoice } from "./voice.js";

type EntryMode = "create" | "join";

const validRoomCode = /^[A-HJ-NP-Z2-9]{6}$/;

/** 首页主图上摆的一手牌：大王、小王、四个 2、A。 */
const SHOWCASE: Card[] = [53, 52, 48, 49, 50, 51, 44];

// 线上游戏中心在站点根路径；本地开发时跑在 5175 端口。
const CENTER_URL = import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:5175/` : "/";

function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 6);
}

// 背景音乐：进了房间（等候房间、对局、观战）和新手教程里放，首页和房间列表不放。gain / start / end 按这首曲子量（见 gm-sound.tsx）。
const BGM: BgmTrack = { src: `${import.meta.env.BASE_URL}bgm/gouji.mp3`, gain: 0.84, start: 0.0, end: 92.2 };

function App() {
  const [mode, setMode] = useState<EntryMode>("create");
  const [name, setName] = useState("");
  const [hands, setHands] = useState<GameOptions["hands"]>(DEFAULT_OPTIONS.hands);
  const options: GameOptions = { ...DEFAULT_OPTIONS, hands };
  const [confirmAction, confirmDialog] = useConfirm();
  // 白天 / 夜间画面：首页、等候房间、牌桌共用，顶栏按钮随时切换；和游戏中心、其他游戏共用同一个选择。
  const [theme, toggleTheme] = useTheme();
  const themeToggle = <><ThemeToggle theme={theme} onToggle={toggleTheme} /><SoundToggle /></>;
  const [roomCode, setRoomCode] = useState("");
  const [room, setRoom] = useState<LobbyRoomSnapshot | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [busy, setBusy] = useState(false);
  const [error, setErrorText] = useState("");
  // 出错（服务器拒绝了操作、房间出错、输入不对）时响一声
  const setError = (message: string) => {
    if (message) errorSound();
    setErrorText(message);
  };
  const [notice, setNotice] = useState("");
  const [lobbyRooms, setLobbyRooms] = useState<PublicRoomSummary[]>([]);
  // 观战时从谁的座位看（默认第一位玩家）。
  const [watchId, setWatchId] = useState("");
  const voice = useVoice(room);
  // 新手教程：首页或等候房间点进来（地址带 ?tutorial 时直接打开，游戏中心可以直接链过来）
  const [tutorialOpen, setTutorialOpen] = useState(() => new URLSearchParams(window.location.search).has("tutorial"));
  // 声音：进了房间（等候房间、对局、观战）和新手教程里顶栏有 ♪ 面板（音效、语音音量）；这款还没有背景音乐。
  useBgm(room || tutorialOpen ? BGM : null);
  // 房间里的提示音：有人进出、开局、收到聊天（gm-sound.tsx）
  const lastChat = room?.chat[room.chat.length - 1];
  useRoomSfx(room ? { members: room.members.length + room.spectators.length, playing: room.status === "playing", chatCount: room.chat.length, lastChatMine: lastChat?.senderId === socket.id } : null);

  function closeTutorial() {
    setTutorialOpen(false);
    const params = new URLSearchParams(window.location.search);
    if (params.has("tutorial")) {
      params.delete("tutorial");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
  }

  // 在等候房间里看教程时，房主一开局就回到牌桌（不然这一步会超时、转成托管）
  useEffect(() => {
    if (tutorialOpen && room?.status === "playing") {
      closeTutorial();
      setNotice("对局开始了，教程先停在这里。");
    }
  }, [tutorialOpen, room?.status]);

  // 「房间已创建」「房间码已复制」这类临时提示 4 秒后自动消失，不一直挂在页面上。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 在房间里时服务端不推送在线牌桌列表；回到首页时主动拉一次最新的。
  useEffect(() => {
    if (room || !socket.connected) return;
    socket.emit("lobby:get", (response) => {
      if (response.ok) setLobbyRooms(response.data);
    });
  }, [room === null]);

  useEffect(() => {
    const handleConnect = () => {
      setConnected(true);
      socket.emit("lobby:get", (response) => {
        if (response.ok) setLobbyRooms(response.data);
      });
    };
    const handleDisconnect = () => setConnected(false);
    const handleRoomUpdate = (snapshot: LobbyRoomSnapshot) => setRoom(snapshot);
    const handleRoomError = (message: string) => setError(message);
    const handleLobbyUpdate = (rooms: PublicRoomSummary[]) => setLobbyRooms(rooms);
    const handleRoomClosed = ({ reason }: { reason: string }) => {
      setRoom(null);
      setBusy(false);
      setError("");
      setNotice(reason);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("room:updated", handleRoomUpdate);
    socket.on("room:error", handleRoomError);
    socket.on("lobby:updated", handleLobbyUpdate);
    socket.on("room:closed", handleRoomClosed);
    socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("room:updated", handleRoomUpdate);
      socket.off("room:error", handleRoomError);
      socket.off("lobby:updated", handleLobbyUpdate);
      socket.off("room:closed", handleRoomClosed);
      socket.disconnect();
    };
  }, []);

  // 首页 → 等候房间 → 牌桌换页面时回到顶部（不然手机上会停在上一页滚到的位置）
  const view = room?.status === "playing" && room.game ? "game" : room ? "room" : "home";
  useEffect(() => { window.scrollTo(0, 0); }, [view]);

  const canSubmit = useMemo(() => {
    if (!connected || busy || name.trim().length < 2 || name.trim().length > 18) return false;
    return mode === "create" || validRoomCode.test(roomCode);
  }, [busy, connected, mode, name, roomCode]);

  /** 从首页列表加入空座位或进去观战（用上面填的昵称）。 */
  function joinListed(roomId: string, spectate: boolean) {
    const nickname = name.trim();
    if (nickname.length < 2 || nickname.length > 18) {
      setNotice("");
      setError("先在上面填好你的昵称（2–18 个字符）。");
      document.getElementById("player-name")?.focus();
      return;
    }
    setError("");
    setNotice("");
    setBusy(true);
    socket.emit("room:join", { name: nickname, roomId, spectate }, (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice(spectate ? "正在观战。" : "已加入房间。");
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    const nickname = name.trim();

    const complete = (response: { ok: true; data: LobbyRoomSnapshot } | { ok: false; error: string }) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice(mode === "create"
        ? "房间已创建，可以邀请朋友加入。"
        : response.data.status === "playing" ? "已回到对局，继续游戏吧。" : "已加入房间。");
    };

    if (mode === "create") {
      socket.emit("room:create", { name: nickname, options }, complete);
    } else {
      socket.emit("room:join", { name: nickname, code: roomCode }, complete);
    }
  }

  function startGame() {
    setError("");
    setBusy(true);
    socket.emit("room:start", (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice("对局已开始，祝你好运。" );
    });
  }

  function leaveRoom() {
    setBusy(true);
    socket.emit("room:leave", (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(null);
      setError("");
      setNotice("已离开房间。" );
    });
  }

  function submitGameCommand(command: GameCommand) {
    setBusy(true);
    setError("");
    setNotice("");
    socket.emit("game:command", command, (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
    });
  }

  /** 房间管理类操作：只关心成败，界面更新由服务端广播。 */
  function roomCommand(send: (ack: (response: { ok: true; data: void } | { ok: false; error: string }) => void) => void) {
    setError("");
    send((response) => {
      if (!response.ok) setError(response.error);
    });
  }

  const kickMember = (memberId: string) => roomCommand((ack) => socket.emit("room:kick", memberId, ack));
  const voteRematch = (accept: boolean) => roomCommand((ack) => socket.emit("room:rematch", accept, ack));
  async function dissolveRoom() {
    const ok = await confirmAction({
      title: "解散房间？",
      detail: "所有玩家都会被移出，当前对局也会结束。",
      confirmLabel: "解散",
    });
    if (ok) roomCommand((ack) => socket.emit("room:dissolve", ack));
  }

  async function copyRoomCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setNotice("房间码已复制。" );
    } catch {
      setNotice("请手动复制房间码。" );
    }
  }

  if (tutorialOpen && room?.status !== "playing") {
    return (
      <main data-gc-table className="app-shell gj-game tut-on">
        <GjBackdrop theme={theme} />
        <TutorialMode name={name} brand={<Brand />} themeToggle={themeToggle} theme={theme} waitingRoom={room?.code} onExit={closeTutorial} />
        {confirmDialog}
      </main>
    );
  }

  if (room?.status === "playing" && room.game) {
    const watched = room.game.players.some((player) => player.id === watchId) ? watchId : room.game.players[0]!.id;
    return (
      <main data-gc-table className="app-shell gj-game">
        <GjBackdrop theme={theme} />
        <GameBoard
          room={room}
          busy={busy}
          error={error}
          notice={notice}
          brand={<Brand />}
          connection={<ConnectionStatus connected={connected} />}
          theme={theme}
          themeToggle={themeToggle}
          chat={<RoomChat room={room} voice={voice} />}
          onCommand={submitGameCommand}
          onRematch={voteRematch}
          onDissolve={dissolveRoom}
          watchId={watched}
          onWatch={setWatchId}
          onLeave={leaveRoom}
        />
        {confirmDialog}
      </main>
    );
  }

  if (room) {
    return (
      <main className="app-shell dz-room">
        <GjBackdrop theme={theme} />
        <header className="topbar">
          <Brand />
          <div className="topbar-right">
            {themeToggle}
            <GameRules />
            <ConnectionStatus connected={connected} />
          </div>
        </header>
        <RoomView
          room={room}
          busy={busy}
          error={error}
          notice={notice}
          onCopyCode={copyRoomCode}
          onLeave={leaveRoom}
          onStart={startGame}
          onKick={kickMember}
          onDissolve={dissolveRoom}
          chat={<RoomChat room={room} voice={voice} />}
          tutorial={
            <TutorialInvite
              record={readTutorial(GAME_ID)}
              title="等人的时候，先学一下？"
              text="咕噜嘎带你在真牌桌上走几手，5 分钟。不会离开房间，房主一开局就自动回来。"
              again="新手教程（不离开房间）"
              onOpen={() => setTutorialOpen(true)}
            />
          }
        />
        {confirmDialog}
      </main>
    );
  }

  return (
    <main className="app-shell dz-home">
      <GjBackdrop theme={theme} />
      <header className="topbar">
        <Brand />
        <div className="topbar-right">
          <a className="center-link" href={CENTER_URL}>← 游戏中心</a>
          {themeToggle}
          <GameRules />
          <ConnectionStatus connected={connected} />
        </div>
      </header>

      <section className="welcome-grid">
        <div className="welcome-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> 在线对战 · 6 座 3 对 3 · 空座人机补位</div>
          <h1>够级</h1>
          <p className="welcome-description">
            青岛的四副牌扑克。六个人隔座组成两个联邦，正对面是你的对头；比谁先出完。
            够大的牌只有对头能管，牌好时还能抢着「烧」。人不够时人机坐空座，一个人也能练手。
          </p>
          <TutorialInvite
            record={readTutorial(GAME_ID)}
            title="第一次玩？5 分钟学会"
            text="咕噜嘎在真牌桌上带你走几手：够级、烧牌、乱缠、进贡，学完和人机练一盘。"
            again="再看一遍新手教程"
            onOpen={() => setTutorialOpen(true)}
          />
          <ul className="dz-home-points">
            <li><b>够级</b>2 张 K、3 张 Q……只有对头能管</li>
            <li><b>烧牌</b>能一口气出完时抢着压别人的够级牌</li>
            <li><b>进贡</b>大落、二落把王和 2 送给头科、二科</li>
          </ul>
          <div className="dz-showcase gjh-showcase" aria-hidden="true">
            {SHOWCASE.map((card, index) => <CardView key={card} card={card} scale={2} style={{ "--i": index } as CSSProperties} />)}
          </div>
        </div>

        <div className="dz-home-side">
          <section className="entry-card" aria-labelledby="entry-title">
            <div className="entry-card-heading">
              <div>
                <span className="section-kicker">准备开始</span>
                <h2 id="entry-title">进入牌桌</h2>
              </div>
              <span className="step-indicator">01 <i /> 02</span>
            </div>

            <div className="mode-switch" role="tablist" aria-label="选择房间操作">
              <button
                className={mode === "create" ? "mode-tab active" : "mode-tab"}
                type="button"
                role="tab"
                aria-selected={mode === "create"}
                onClick={() => { setMode("create"); setError(""); }}
              >
                创建房间
              </button>
              <button
                className={mode === "join" ? "mode-tab active" : "mode-tab"}
                type="button"
                role="tab"
                aria-selected={mode === "join"}
                onClick={() => { setMode("join"); setError(""); }}
              >
                加入房间
              </button>
            </div>

            <form className="entry-form" onSubmit={handleSubmit}>
              <label className="field-label" htmlFor="player-name">你的昵称</label>
              <input
                id="player-name"
                className="text-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="输入 2–18 个字符"
                minLength={2}
                maxLength={18}
                autoComplete="nickname"
                required
              />

              {mode === "create" ? (
                <>
                  <label className="field-label field-label-spaced" htmlFor="room-hands">打几盘</label>
                  <div className="capacity-options dz-hands-pick" id="room-hands" role="group" aria-label="选择盘数">
                    {([1, 3, 5, 8] as const).map((count) => (
                      <button
                        key={count}
                        type="button"
                        className={hands === count ? "capacity-option selected" : "capacity-option"}
                        aria-pressed={hands === count}
                        onClick={() => setHands(count)}
                      >
                        {count} 盘
                      </button>
                    ))}
                  </div>
                  <p className="field-hint">一盘约 15–25 分钟。进贡、让牌、看牌进房间后房主可以改；空座位开局时由人机补上。</p>
                </>
              ) : (
                <>
                  <label className="field-label field-label-spaced" htmlFor="room-code">房间码</label>
                  <input
                    id="room-code"
                    className="text-input room-code-input"
                    value={roomCode}
                    onChange={(event) => setRoomCode(normalizeRoomCode(event.target.value))}
                    placeholder="例如：7KQ2TX"
                    autoComplete="off"
                    maxLength={6}
                    required
                  />
                  <p className="field-hint">房间码为 6 位字母或数字，不含易混淆字符。掉线后用原昵称和房间码可回到进行中的对局。</p>
                </>
              )}

              {error && <p className="feedback feedback-error" role="alert">{error}</p>}
              {notice && <p className="feedback feedback-success" role="status">{notice}</p>}

              <button className="primary-button" type="submit" disabled={!canSubmit}>
                {busy ? <><span className="spinner" /> 正在连接</> : mode === "create" ? "创建私人房间" : "加入牌桌"}
                {!busy && <span aria-hidden="true">↗</span>}
              </button>
            </form>
            <div className="entry-footnote"><span className="lock-icon">◇</span> 默认邀请制 · 房主可以设为公开</div>
          </section>
          <OnlineRooms rooms={lobbyRooms} connected={connected} busy={busy} onJoin={joinListed} />
        </div>
      </section>
    </main>
  );
}

function Brand() {
  return (
    <a className="brand" href={import.meta.env.BASE_URL} aria-label="够级首页">
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
      <span className="brand-name">够级<span> GOU JI</span></span>
    </a>
  );
}

function ConnectionStatus({ connected }: { connected: boolean }) {
  return (
    <div className={connected ? "connection-status online" : "connection-status"}>
      <span className="connection-dot" />
      {connected ? "服务已连接" : "连接中…"}
    </div>
  );
}

type Ack = { ok: true; data: void } | { ok: false; error: string };

/** 开房选项（规则书 8.1）：房主在等候房间里改，其他人只看。 */
function OptionsPanel({ room }: { room: LobbyRoomSnapshot }) {
  const { isHost } = roomRole(room);
  const [error, setErrorText] = useState("");
  // 出错（服务器拒绝了操作、房间出错、输入不对）时响一声
  const setError = (message: string) => {
    if (message) errorSound();
    setErrorText(message);
  };
  const options = room.options as GameOptions & Record<string, unknown>;
  const change = (patch: Partial<GameOptions>) => socket.emit("room:options", patch, (response: Ack) => setError(response.ok ? "" : response.error));
  const row = <T extends string | number | boolean>(label: string, key: keyof GameOptions, values: readonly { value: T; text: string }[], disabled = false) => (
    <div className="dz-option-row">
      <span>{label}</span>
      <div className="dz-option-values">
        {values.map((item) => (
          <button
            key={String(item.value)}
            type="button"
            className={options[key] === item.value ? "room-setting on" : "room-setting"}
            aria-pressed={options[key] === item.value}
            disabled={!isHost || disabled}
            onClick={() => change({ [key]: item.value } as Partial<GameOptions>)}
          >
            <i aria-hidden="true" />{item.text}
          </button>
        ))}
      </div>
    </div>
  );
  const onOff = [{ value: true, text: "开" }, { value: false, text: "关" }] as const;
  return (
    <div className="dz-options">
      <div className="panel-label">开房选项 <span>{isHost ? "房主可以改" : "只有房主能改"}</span></div>
      {row("盘数", "hands", [{ value: 1, text: "1 盘" }, { value: 3, text: "3 盘" }, { value: 5, text: "5 盘" }, { value: 8, text: "8 盘" }])}
      {row("进贡", "tribute", onOff)}
      {row("让牌", "rang", onOff)}
      {row("看牌", "peek", onOff)}
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
    </div>
  );
}

function RoomView({
  room,
  busy,
  error,
  notice,
  onCopyCode,
  onLeave,
  onStart,
  onKick,
  onDissolve,
  chat,
  tutorial,
}: {
  room: LobbyRoomSnapshot;
  busy: boolean;
  error: string;
  notice: string;
  onCopyCode: () => void;
  onLeave: () => void;
  onStart: () => void;
  onKick: (memberId: string) => void;
  onDissolve: () => void;
  chat: ReactNode;
  tutorial?: ReactNode;
}) {
  const { isHost, spectating } = roomRole(room);
  const openSeats = Math.max(0, SEAT_COUNT - room.members.length);

  return (
    <section className="room-layout">
      <div className="room-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> {room.status === "waiting" ? "等待大厅" : "对局已创建"} · 够级</div>
          <h1>{spectating ? "你在观战。" : room.status === "waiting" ? "牌桌准备中。" : "好戏即将开始。"}</h1>
          <p>{spectating ? "等房主开始对局；有空座位时可以坐下一起玩。" : "把房间码分享给朋友；人没到齐也能开始，空座位由人机补上。"}</p>
        </div>
        <div className="room-heading-actions">
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve} disabled={busy}>解散房间</button>}
          <button className="quiet-button" type="button" onClick={onLeave} disabled={busy || (room.status === "playing" && !spectating)}>
            {spectating ? "离开观战" : "离开房间"}
          </button>
        </div>
      </div>

      {room.status === "waiting" ? (
        <div className="room-grid">
          <section className="room-panel room-code-panel">
            <div className="panel-label">房间码 <span>仅分享给朋友</span></div>
            {room.code ? (
              <>
                <button className="room-code-display" type="button" onClick={onCopyCode} title="复制房间码">
                  {room.code}<span aria-hidden="true">⧉</span>
                </button>
                <div className="room-code-caption">点击复制 · 6 位邀请代码</div>
              </>
            ) : (
              <div className="room-code-caption">从首页列表进来观战，看不到房间码</div>
            )}
            <OptionsPanel room={room} />
            {tutorial && !spectating && <div className="gjr-tut">{tutorial}</div>}
          </section>

          <section className="room-panel player-panel">
            <div className="panel-topline">
              <div className="panel-label">座位 <span>{room.members.length} 人 · {openSeats} 个空座</span></div>
              <span className="waiting-pill"><i /> 等待中</span>
            </div>
            <SeatGrid room={room} onKick={onKick} />
            <p className="field-hint gjr-hint">
              选座就是选队，正对面是对头（永远是对手）。空座开局时由人机（咕噜一号…）补上。打 {room.options.hands} 盘，累计分高的联邦赢。
            </p>
            <RoomSettingsPanel room={room} />
            <SeatSwitch room={room} />
            <div className="room-actions">
              {isHost ? (
                <button className="primary-button" type="button" onClick={onStart} disabled={busy}>
                  {busy ? <><span className="spinner" /> 正在开始</> : openSeats > 0 ? `开始（${openSeats} 个人机补位）` : "开始对局"}<span aria-hidden="true">↗</span>
                </button>
              ) : (
                <div className="host-wait-note"><span className="pulse-dot" /> {spectating ? "等房主开始，开始后在这里观战" : "等待房主开始对局"}</div>
              )}
            </div>
          </section>
          <div className="dz-room-chat">{chat}</div>
        </div>
      ) : null}

      {error && <p className="feedback feedback-error room-feedback" role="alert">{error}</p>}
      {notice && <p className="feedback feedback-success room-feedback" role="status">{notice}</p>}
      <div className="room-secure-note"><span>◇</span> {room.access.open ? "公开房间：首页列表里的人可以直接加入空座位。" : "邀请制：要有房间码才能加入；首页列表不显示房间码。"}</div>
    </section>
  );
}

/** 等候房间的座位：甲、乙两个联邦各一列（座位 0、2、4 / 1、3、5），对头排在同一行。房主可以对调两个座位。 */
function SeatGrid({ room, onKick }: { room: LobbyRoomSnapshot; onKick: (memberId: string) => void }) {
  const { isHost } = roomRole(room);
  const mine = room.members.find((candidate) => candidate.id === socket.id);
  const [swapFrom, setSwapFrom] = useState<number | null>(null);
  const [swapError, setSwapError] = useState("");
  const swap = (a: number, b: number) => {
    socket.emit("room:swap-seats", { a, b }, (response) => setSwapError(response.ok ? "" : response.error));
    setSwapFrom(null);
  };
  const cell = (seat: number) => {
    const member = room.members.find((candidate) => candidate.seat === seat);
    const team = teamOf(seat);
    const relation = mine && mine.seat !== seat ? ((mine.seat + 3) % 6 === seat ? "你的对头" : teamOf(mine.seat) === team ? "你的队友" : "") : "";
    return (
      <div key={seat} className={["gjr-seat", member ? "" : "open", member?.id === socket.id ? "mine" : "", swapFrom === seat ? "picked" : ""].filter(Boolean).join(" ")}>
        <span className="gjr-avatar" style={{ backgroundImage: `url(${art.frame(team)})` }}>
          {member ? <img src={art.avatar(seat)} alt="" width={40} height={40} /> : <b>+</b>}
        </span>
        <span className="gjr-info">
          <strong>{member ? member.name : "空座"}{member?.id === socket.id ? <small>你</small> : null}{member?.isHost ? <small className="host">房主</small> : null}</strong>
          <span>{seat} 号座{relation ? ` · ${relation}` : member ? "" : " · 开局人机补位"}</span>
        </span>
        <span className="gjr-actions">
          {!member && mine && <button className="quiet-button" type="button" onClick={() => socket.emit("room:seat", seat, () => {})}>坐这里</button>}
          {isHost && swapFrom === null && <button className="quiet-button" type="button" onClick={() => setSwapFrom(seat)} title="和另一个座位对调">对调</button>}
          {isHost && swapFrom !== null && swapFrom !== seat && <button className="primary-button" type="button" onClick={() => swap(swapFrom, seat)}>和 {swapFrom} 号换</button>}
          {isHost && swapFrom === seat && <button className="quiet-button" type="button" onClick={() => setSwapFrom(null)}>取消</button>}
          {isHost && member && !member.isHost && swapFrom === null && <button className="kick-button" type="button" onClick={() => onKick(member.id)} title={`把 ${member.name} 移出房间`}>移出</button>}
        </span>
      </div>
    );
  };
  return (
    <div className="gjr-teams" data-tutorial="room-seats">
      {([0, 1] as const).map((team) => (
        <div key={team} className={`gjr-team team-${team}`}>
          <h4><img src={art.team(team)} alt="" width={24} height={24} />{TEAM_NAMES[team]}联邦</h4>
          {[team, team + 2, team + 4].map(cell)}
        </div>
      ))}
      {swapError && <p className="feedback feedback-error" role="alert">{swapError}</p>}
    </div>
  );
}

/** 铺满窗口的海边露台场景：首页、等候房间、牌桌、教程的第一个子元素，面板都叠在它上面（gouji.css「背景」一节）。 */
function GjBackdrop({ theme }: { theme: "day" | "night" }) {
  return (
    <div className="gj-backdrop" aria-hidden="true">
      <div className="gj-backdrop-art" style={{ backgroundImage: `url(${theme === "day" ? bgArt.day : bgArt.night})` }} />
      <div className="gj-backdrop-veil" />
    </div>
  );
}

export default App;
