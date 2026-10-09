import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  beats,
  classify,
  comboKey,
  comboLabel,
  hintMoves,
  multiplierOf,
  rankLabel,
  rankOf,
  sortCards,
  totalOfRank,
  type Card,
  type Combo,
  type DdzEvent,
  type DdzPlayer,
  type DdzState,
  type GameCommand,
  type LobbyRoomSnapshot,
} from "@gouji/game";
import { art, coverSize, seatColor } from "./art.js";
import { CARD_H, CARD_W, CardRow, CardView, preloadCards } from "./cards.js";
import GameRules from "./GameRules.js";
import { GameRoomMenu, SpectateBar } from "./RoomExtras.js";
import { socket } from "./socket.js";
import { useCountdown, useLayout } from "./table.js";
import type { Theme } from "./theme.js";

interface GameBoardProps {
  readonly room: LobbyRoomSnapshot;
  readonly busy: boolean;
  readonly error: string;
  readonly notice: string;
  readonly brand: ReactNode;
  readonly connection: ReactNode;
  readonly theme: Theme;
  readonly themeToggle: ReactNode;
  readonly chat: ReactNode;
  readonly onCommand: (command: GameCommand) => void;
  readonly onRematch: (accept: boolean) => void;
  readonly onDissolve: () => void;
  readonly watchId: string;
  readonly onWatch: (playerId: string) => void;
  readonly onLeave: () => void;
}

/** 座位相对自己的位置：0 自己（下）、1 下家（右）、2 上家（左）。 */
type Rel = 0 | 1 | 2;
const DOUBLE_TEXT: Record<number, string> = { 1: "不加倍", 2: "加倍", 4: "超级加倍" };
/** 记牌器从大到小：大王、小王、2、A … 3。 */
const TRACKER_RANKS = [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3];

const cardsText = (cards: readonly Card[]) => cards.map((card) => (rankOf(card) >= 16 ? rankLabel(rankOf(card)).slice(0, 1) : rankLabel(rankOf(card)))).join(" ");

// ---------------------------------------------------------------------------
// 文案

function describeEvent(event: DdzEvent, game: DdzState, name: (seat: number) => string): string | null {
  switch (event.type) {
    case "HandStarted":
      return `第 ${event.handNo} 盘开始`;
    case "ShowStart":
      return event.show ? `${name(event.seat)} 明牌开始（×5）` : null;
    case "Dealt":
      return `${event.redeal > 0 ? `重新发牌（第 ${event.redeal} 次）` : "发牌"}，${name(event.firstBidder)} 先叫`;
    case "Bid":
      return `${name(event.seat)} ${event.call ? "叫地主" : "不叫"}`;
    case "Rob":
      return `${name(event.seat)} ${event.rob ? `抢地主（×${2 ** event.robs}）` : "不抢"}`;
    case "Redeal":
      return "三家都不叫，重新洗牌发牌";
    case "LandlordChosen":
      return `${name(event.seat)} 当地主，底牌 ${cardsText(event.bottom)}`;
    case "DoublesRevealed":
      return `加倍：${event.doubles.map((factor, seat) => `${name(seat)}${DOUBLE_TEXT[factor]}`).join("，")}`;
    case "LandlordShow":
      return event.show ? `${name(event.seat)} 明牌（×2）` : null;
    case "Played":
      return `${name(event.seat)} 出 ${comboLabel(event.combo)}：${cardsText(event.cards)}${event.left > 0 && event.left <= 2 ? `（剩 ${event.left} 张）` : ""}`;
    case "Passed":
      return `${name(event.seat)} 不出`;
    case "TrickWon":
      return null;
    case "HandEnded": {
      const summary = event.summary;
      const spring = summary.multiplier.spring === "spring" ? "，春天" : summary.multiplier.spring === "antiSpring" ? "，反春" : "";
      return `第 ${event.handNo} 盘结束：${summary.landlordWon ? "地主" : "农民"}赢${spring}，倍数 ×${summary.multiplier.total}`;
    }
    case "TimedOut":
      return `${name(event.seat)} 超时，自动处理`;
    case "AutoChanged":
      return `${name(event.seat)} ${event.on ? "托管了" : "取消托管"}`;
    case "GameEnded":
      return `对局结束（共 ${game.config.hands} 盘）`;
  }
}

interface Fx {
  readonly key: string;
  readonly seat: number;
  readonly kind: "bomb" | "rocket" | "plane" | "straight" | "pairs" | "alert" | "landlord";
  readonly text: string;
}

function fxFrom(events: readonly DdzEvent[], version: number): Fx[] {
  const list: Fx[] = [];
  events.forEach((event, index) => {
    const key = `${version}-${index}`;
    if (event.type === "Played") {
      const type = event.combo.type;
      if (type === "bomb") list.push({ key, seat: event.seat, kind: "bomb", text: "炸弹" });
      else if (type === "rocket") list.push({ key, seat: event.seat, kind: "rocket", text: "王炸" });
      else if (type === "plane" || type === "plane1" || type === "plane2") list.push({ key, seat: event.seat, kind: "plane", text: "飞机" });
      else if (type === "straight") list.push({ key, seat: event.seat, kind: "straight", text: "顺子" });
      else if (type === "pairs") list.push({ key, seat: event.seat, kind: "pairs", text: "连对" });
      if (event.left === 1 || event.left === 2) list.push({ key: `${key}-a`, seat: event.seat, kind: "alert", text: event.left === 1 ? "报单！" : "报双！" });
    }
  });
  return list;
}

// ---------------------------------------------------------------------------

function GameBoard({ room, busy, error, notice, brand, connection, theme, themeToggle, chat, onCommand, onRematch, onDissolve, watchId, onWatch, onLeave }: GameBoardProps) {
  const game = room.game as DdzState;
  const member = room.members.find((candidate) => candidate.id === socket.id);
  const spectating = !member;
  const myId = member?.playerId ?? watchId;
  const mySeat = Math.max(0, game.players.findIndex((player) => player.id === myId));
  const me = game.players[mySeat]!;
  const isHost = member?.isHost ?? false;
  const playing = game.phase === "playing";
  const stage = game.stage;
  const landlord = game.landlord;
  const secondsLeft = useCountdown(room);
  const relOf = (seat: number) => ((seat - mySeat + 3) % 3) as Rel;
  const seatAt = (rel: number) => (mySeat + rel) % 3;
  const nameOf = (seat: number) => (seat === mySeat && !spectating ? "你" : game.players[seat]?.name ?? "?");
  const online = (player: DdzPlayer) => player.bot || (room.members.find((candidate) => candidate.playerId === player.id)?.connected ?? false);
  const send = (command: GameCommand) => { if (!busy) onCommand(command); };
  const firstVersion = useRef(game.version);
  const shownNotice = game.version === firstVersion.current ? notice : "";
  const myCards = me.hand.length > 0 ? me.hand : Array.from({ length: me.handCount }, () => -1);
  const [tableRef, layout, tableBox] = useLayout(myCards.length);
  const { hs, ps } = layout;

  useEffect(() => { preloadCards(); }, []);

  const pending = useMemo(() => {
    if (!playing) return false;
    if (stage === "showStart") return !me.showStartChosen;
    if (stage === "doubling") return !me.doubleChosen;
    if (stage === "handEnd") return false;
    return game.turn === mySeat;
  }, [game.version, mySeat]);
  const myTurn = !spectating && pending;
  const myPlay = myTurn && stage === "playing";
  const following = game.lastPlay !== null;

  // ---------- 选牌（点选、拖选）----------
  const [selected, setSelected] = useState<Card[]>([]);
  // 手里的牌变了（出掉了、拿到底牌）就把选中里已经不在手里的去掉
  useEffect(() => {
    setSelected((current) => current.filter((card) => me.hand.includes(card)));
  }, [game.version, mySeat]);
  useEffect(() => setSelected([]), [game.handNo, stage === "playing"]);
  const canSelect = !spectating && playing && stage === "playing" && me.hand.length > 0;
  const handOrder = myCards;
  const drag = useRef<{ mode: boolean; start: number; base: Set<Card> } | null>(null);
  const applyRange = (from: number, to: number) => {
    const state = drag.current;
    if (!state) return;
    const next = new Set(state.base);
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    for (let index = lo; index <= hi; index += 1) {
      const card = handOrder[index]!;
      if (state.mode) next.add(card);
      else next.delete(card);
    }
    setSelected([...next]);
  };
  const cardIndexAt = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y)?.closest("[data-card]") as HTMLElement | null;
    return element ? handOrder.indexOf(Number(element.dataset.card)) : -1;
  };
  const onHandDown = (event: ReactPointerEvent) => {
    if (!canSelect || event.button !== 0) return;
    const index = cardIndexAt(event.clientX, event.clientY);
    if (index < 0) return;
    const card = handOrder[index]!;
    drag.current = { mode: !selected.includes(card), start: index, base: new Set(selected) };
    applyRange(index, index);
  };
  const onHandMove = (event: ReactPointerEvent) => {
    if (!drag.current) return;
    if (event.buttons === 0) {
      drag.current = null;
      return;
    }
    const index = cardIndexAt(event.clientX, event.clientY);
    if (index >= 0) applyRange(drag.current.start, index);
  };
  const endDrag = () => { drag.current = null; };
  useEffect(() => {
    window.addEventListener("pointerup", endDrag);
    return () => window.removeEventListener("pointerup", endDrag);
  }, []);

  // ---------- 选中的牌是什么牌型、能不能压 ----------
  const chosen = useMemo(() => sortCards(selected), [selected]);
  const readings = useMemo(() => classify(chosen), [chosen]);
  const candidates: Combo[] = useMemo(
    () => readings.filter((reading) => !game.lastPlay || beats(game.lastPlay.combo, reading)),
    [readings, game.version],
  );
  const hints = useMemo(() => (myPlay ? hintMoves(me.hand, game.lastPlay?.combo ?? null) : []), [game.version, myPlay]);
  const [hintIndex, setHintIndex] = useState(0);
  useEffect(() => setHintIndex(0), [game.version]);
  const noBeat = myPlay && following && hints.length === 0;
  const hint = () => {
    if (hints.length === 0) return;
    setSelected(hints[hintIndex % hints.length]!.cards);
    setHintIndex(hintIndex + 1);
  };
  const playAs = (combo: Combo) => send({ type: "PLAY", cards: chosen, as: comboKey(combo) });
  const selectionNote = (() => {
    if (!myPlay) return "";
    if (chosen.length === 0) return following ? "选能压过上家的牌，或者点「提示」" : "该你出牌：任意牌型都可以";
    if (readings.length === 0) return "不是合法的牌型";
    if (candidates.length === 0) return `${comboLabel(readings[0]!)}：压不过`;
    return comboLabel(candidates[0]!);
  })();

  // ---------- 动画：只看 version 变没变 ----------
  const fresh = game.version !== firstVersion.current;
  const fx = useMemo(() => (fresh ? fxFrom(game.events, game.version) : []), [game.version]);
  // 临时显示的东西（特效、横幅、结算前的停顿）各用一个计时器；下一次状态更新不会把它们的计时取消掉
  const timers = useRef(new Map<string, number>());
  const later = (name: string, ms: number, run: () => void) => {
    window.clearTimeout(timers.current.get(name));
    timers.current.set(name, window.setTimeout(run, ms));
  };
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const [activeFx, setActiveFx] = useState<Fx[]>([]);
  useEffect(() => {
    if (fx.length === 0) return;
    setActiveFx(fx);
    later("fx", 1800, () => setActiveFx([]));
  }, [fx]);
  const [banner, setBanner] = useState<{ text: string; kind: string } | null>(null);
  useEffect(() => {
    if (!fresh) return;
    let next: { text: string; kind: string } | null = null;
    for (const event of game.events) {
      if (event.type === "Redeal") next = { text: "三家都不叫，重新发牌", kind: "info" };
      if (event.type === "LandlordChosen") next = { text: `${nameOf(event.seat)} 当地主`, kind: "landlord" };
      if (event.type === "HandEnded") {
        const spring = event.summary.multiplier.spring;
        if (spring) next = { text: spring === "spring" ? "春天！" : "反春！", kind: "spring" };
      }
    }
    if (!next) return;
    setBanner(next);
    later("banner", 2200, () => setBanner(null));
  }, [game.version]);
  const shake = activeFx.some((item) => item.kind === "bomb" || item.kind === "rocket");
  // 一盘刚结束：先让大家看清最后一手和春天的特效，2 秒后再弹结算
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!fresh || !game.events.some((event) => event.type === "HandEnded")) return;
    setSettling(true);
    later("settle", 2000, () => setSettling(false));
  }, [game.version]);
  const bottomFlip = fresh && game.events.some((event) => event.type === "LandlordChosen");

  // ---------- 键盘 ----------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!myTurn) {
        if (stage === "handEnd" && playing && !spectating && key === "n" && !game.ready.includes(myId)) send({ type: "READY" });
        if (key === "escape") setSelected([]);
        return;
      }
      const yes = key === "y";
      const no = key === "n";
      switch (stage) {
        case "showStart":
          if (yes || no) send({ type: "SHOW_START", show: yes });
          break;
        case "bidding":
          if (yes || no) send({ type: "BID", call: yes });
          break;
        case "robbing":
          if (yes || no) send({ type: "ROB", rob: yes });
          break;
        case "doubling":
          if (yes || no) send({ type: "DOUBLE", factor: yes ? 2 : 1 });
          else if (key === "s" && game.config.superDouble) send({ type: "DOUBLE", factor: 4 });
          break;
        case "landlordShow":
          if (yes || no) send({ type: "LANDLORD_SHOW", show: yes });
          break;
        case "playing":
          if ((key === " " || key === "enter") && candidates.length > 0) {
            event.preventDefault();
            playAs(candidates[0]!);
          } else if (key === "p" && following) send({ type: "PASS" });
          else if (key === "h") hint();
          else if (key === "escape") setSelected([]);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 在后台时标题提示轮到你
  useEffect(() => {
    const base = "斗地主 · 在线对战";
    const update = () => { document.title = myTurn && document.hidden ? `【轮到你】${base}` : base; };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      document.title = base;
    };
  }, [myTurn, game.version]);

  // ---------- 动作记录 ----------
  const log = useMemo(() => {
    const lines: { key: string; text: string }[] = [];
    game.history.forEach((event, index) => {
      const text = describeEvent(event, game, nameOf);
      if (text) lines.push({ key: `${game.version}-${index}`, text });
    });
    return lines.reverse();
  }, [game.version]);
  const [sideTab, setSideTab] = useState<"log" | "chat">("log");
  const [chatSeen, setChatSeen] = useState(room.chat.length);
  useEffect(() => { if (sideTab === "chat") setChatSeen(room.chat.length); }, [sideTab, room.chat.length]);
  const unread = sideTab === "chat" ? 0 : Math.max(0, room.chat.length - chatSeen);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [hideSummary, setHideSummary] = useState(false);
  useEffect(() => setHideSummary(false), [game.handNo, stage]);
  const [trackerOpen, setTrackerOpen] = useState(false);

  // ---------- 现在该谁做什么 ----------
  const waitingFor = (seats: number[]) => seats.map((seat) => nameOf(seat)).join("、");
  const undecided = (test: (player: DdzPlayer) => boolean) => game.players.map((_, seat) => seat).filter((seat) => !test(game.players[seat]!));
  let headline = "";
  let detail = "";
  if (game.phase === "finished") headline = "对局结束";
  else if (stage === "showStart") {
    headline = myTurn ? "要明牌开始吗？" : "发牌前：等其他人";
    detail = myTurn ? "不看牌就把手牌亮给所有人，这一盘倍数 ×5，而且你第一个叫地主。" : `还在选：${waitingFor(undecided((player) => player.showStartChosen))}`;
  } else if (stage === "bidding") {
    headline = myTurn ? "要叫地主吗？" : `${nameOf(game.turn)} 叫地主中`;
    detail = game.redeals >= 3 ? `已经连续 ${game.redeals} 次没人叫了。` : "叫了就拿 3 张底牌，一个人打两个农民。";
  } else if (stage === "robbing") {
    headline = myTurn ? "要抢地主吗？" : `${nameOf(game.turn)} 抢地主中`;
    detail = `每抢一次倍数 ×2，现在抢了 ${game.robs} 次。`;
  } else if (stage === "doubling") {
    headline = myTurn ? "要加倍吗？" : "加倍：等其他人";
    detail = myTurn ? "加倍只翻你和对手之间的那份输赢；3 人选完一起公布。" : `还在选：${waitingFor(undecided((player) => player.doubleChosen))}`;
  } else if (stage === "landlordShow") {
    headline = myTurn ? "要明牌吗？" : `${nameOf(game.turn)} 考虑明牌`;
    detail = "地主把手牌亮给大家看，这一盘倍数 ×2。";
  } else if (stage === "playing") {
    headline = myPlay ? (following ? "轮到你：压上家，或者不出" : "轮到你出牌") : `${nameOf(game.turn)} 出牌中`;
    detail = game.lastPlay ? `桌上最大：${nameOf(game.lastPlay.seat)} 的 ${comboLabel(game.lastPlay.combo)}` : `${nameOf(game.turn)} 引牌，可以出任意牌型`;
  } else if (stage === "handEnd") {
    headline = `第 ${game.handNo} 盘结算`;
    detail = spectating ? `等玩家点「下一盘」（${game.ready.length}/3）` : game.ready.includes(myId) ? `等其他人（${game.ready.length}/3）` : "看完结算点「下一盘」";
  }
  const showTimer = secondsLeft !== null && playing && (myTurn || stage === "handEnd");

  // ---------- 每个人头上的话（叫抢加倍）、身份 ----------
  const bubbleOf = (seat: number): string | null => {
    const player = game.players[seat]!;
    if (stage === "showStart") return player.shown ? "明牌开始" : player.showStartChosen ? "不明牌" : null;
    if (stage === "bidding" || stage === "robbing") {
      if (player.rob) return player.rob === "rob" ? "抢地主" : "不抢";
      if (player.bid) return player.bid === "call" ? "叫地主" : "不叫";
      return null;
    }
    if (stage === "doubling") return player.doubleChosen ? (player.double === null ? "已选" : DOUBLE_TEXT[player.double]!) : null;
    return null;
  };
  const roleOf = (seat: number) => (landlord === null ? null : seat === landlord ? "landlord" : "farmer");
  const multiplier = multiplierOf(game);

  const plate = (seat: number) => {
    const player = game.players[seat]!;
    const rel = relOf(seat);
    const role = roleOf(seat);
    const active = playing && stage !== "handEnd" && stage !== "showStart" && stage !== "doubling" && game.turn === seat;
    const waiting = playing && ((stage === "showStart" && !player.showStartChosen) || (stage === "doubling" && !player.doubleChosen));
    const bubble = bubbleOf(seat);
    const alert = stage === "playing" && player.handCount > 0 && player.handCount <= 2;
    const clock = secondsLeft !== null && (active || (waiting && seat === mySeat)) && seat !== mySeat ? secondsLeft : null;
    return (
      <div className={["dz-plate", `p${rel}`, active ? "active" : "", role ?? ""].join(" ")} style={{ "--seat": seatColor(rel) } as CSSProperties}>
        <div className="dz-avatar-box">
          <img className="dz-avatar" src={art.avatar(seat)} alt="" />
          {role && <img className="dz-hat" src={role === "landlord" ? art.hatLandlord : art.hatFarmer} alt="" />}
        </div>
        <div className="dz-plate-info">
          <strong title={player.name}>{nameOf(seat)}{seat === mySeat && spectating ? "（观战视角）" : ""}</strong>
          <span className="dz-plate-score">
            <b>{player.score}</b>
            {player.handDelta !== 0 && <small className={player.handDelta > 0 ? "up" : "down"}>{player.handDelta > 0 ? "+" : ""}{player.handDelta}</small>}
          </span>
          <span className="dz-plate-tags">
            {role && <em className={`dz-role ${role}`}>{role === "landlord" ? "地主" : "农民"}</em>}
            {player.double !== null && player.double > 1 && stage !== "doubling" && <em className="dz-chip warn">{DOUBLE_TEXT[player.double]}</em>}
            {player.shown && <em className="dz-chip warn">明牌</em>}
            {player.bot && <em className="dz-chip">人机</em>}
            {!player.bot && player.auto && <em className="dz-chip warn">托管</em>}
            {!online(player) && <em className="dz-chip bad">离线</em>}
          </span>
        </div>
        {rel !== 0 && stage !== "showStart" && (
          <div className={alert ? "dz-count alert" : "dz-count"} title={`还剩 ${player.handCount} 张`}>
            <CardView card={-1} scale={1} />
            <b>{player.handCount}</b>
          </div>
        )}
        {clock !== null && <span className={clock <= 5 ? "dz-clock low" : "dz-clock"}>{clock}</span>}
        {alert && rel !== 0 && <em className="dz-alert">{player.handCount === 1 ? "报单" : "报双"}</em>}
        {bubble && rel !== 0 && <span className={`dz-bubble b${rel}`} key={`${stage}-${bubble}`}>{bubble}</span>}
      </div>
    );
  };

  /** 每个座位这一轮出的牌（或「不出」）。 */
  const playArea = (seat: number) => {
    const entry = game.table[seat];
    const rel = relOf(seat);
    const latest = game.lastPlay?.seat === seat;
    const align = rel === 1 ? "end" : rel === 2 ? "start" : "center";
    return (
      <div className={`dz-play r${rel}`} key={`play-${seat}`}>
        {(stage === "playing" || stage === "handEnd") && entry?.kind === "play" && (
          <div className={latest ? "dz-play-cards latest" : "dz-play-cards"} key={`${game.handNo}-${entry.cards.join(".")}`}>
            <CardRow cards={entry.cards} scale={ps} step={Math.round(CARD_W * ps * 0.45)} perRow={layout.mobile ? 8 : 10} align={align} />
            <small className="dz-play-label">{comboLabel(entry.combo)}</small>
          </div>
        )}
        {(stage === "playing" || stage === "handEnd") && entry?.kind === "pass" && <span className="dz-pass">不出</span>}
        {activeFx.filter((item) => item.seat === seat && item.kind !== "alert").map((item) => (
          <span key={item.key} className={`dz-fx ${item.kind}`}>
            {item.kind === "bomb" && <><img className="fx-bomb" src={art.bomb} alt="" /><img className="fx-boom" src={art.boom} alt="" /></>}
            {item.kind === "rocket" && <img className="fx-rocket" src={art.rocket} alt="" />}
            <b>{item.text}</b>
          </span>
        ))}
      </div>
    );
  };

  /** 别人：名牌 + 明牌时的手牌（1 倍，每行 10 张）。 */
  const opponent = (seat: number) => {
    const player = game.players[seat]!;
    const rel = relOf(seat);
    return (
      <div className={`dz-opp r${rel}`} key={`opp-${seat}`}>
        {plate(seat)}
        {player.hand.length > 0 && (layout.mobile ? (
          // 手机上放不下两排牌：明牌的手牌写成一行点数
          <div className="dz-open-text" title={`${player.name} 的手牌`}>{cardsText(player.hand)}</div>
        ) : (
          <div className="dz-open-hand" title={`${player.name} 的手牌`}>
            <CardRow cards={player.hand} scale={1} step={14} perRow={10} align={rel === 1 ? "end" : "start"} />
          </div>
        ))}
        {activeFx.filter((item) => item.seat === seat && item.kind === "alert").map((item) => <span key={item.key} className="dz-fx alert">{item.text}</span>)}
      </div>
    );
  };

  // ---------- 记牌器：外面（不在自己手里、也没出过）还有几张 ----------
  const tracker = useMemo(() => {
    const counts = new Map<number, number>();
    for (const rank of TRACKER_RANKS) counts.set(rank, totalOfRank(rank));
    for (const card of [...game.played, ...me.hand]) if (card >= 0) counts.set(rankOf(card), counts.get(rankOf(card))! - 1);
    return counts;
  }, [game.version, mySeat]);
  const trackerOn = game.config.tracker && (stage === "playing" || stage === "landlordShow" || stage === "doubling") && (!spectating || room.access.spectatorsSeeAll);
  const trackerNode = trackerOn ? (
    <div className="dz-tracker" aria-label="记牌器：外面还有几张">
      {TRACKER_RANKS.map((rank) => (
        <span key={rank} className={tracker.get(rank) === 0 ? "none" : tracker.get(rank) === totalOfRank(rank) && rank < 16 ? "all" : ""}>
          <small>{rank === 17 ? "大" : rank === 16 ? "小" : rankLabel(rank)}</small>
          <b>{tracker.get(rank)}</b>
        </span>
      ))}
    </div>
  ) : null;

  // ---------- 上面：底牌、倍数、盘数 ----------
  const bottomCards = game.bottom.length > 0 ? game.bottom : [-1, -1, -1];
  const topInfo = (
    <div className="dz-top">
      <div className={bottomFlip ? "dz-bottom flip" : "dz-bottom"} aria-label="底牌">
        <small>底牌</small>
        {bottomCards.map((card, index) => <CardView key={`${index}-${card}`} card={card} scale={layout.mobile ? 1 : Math.min(ps, 2)} style={{ animationDelay: `${index * 120}ms` }} />)}
      </div>
      <div className="dz-multi" title={`抢地主 ×${2 ** multiplier.robs} · 明牌 ×${multiplier.show} · 炸弹 ×${2 ** multiplier.bombs}`}>
        <small>倍数</small>
        <b key={multiplier.total} className={fresh ? "bump" : ""}>×{multiplier.total}</b>
        <small>底分 {game.config.base}</small>
      </div>
      <div className="dz-hand-no">
        <small>第</small><b>{game.handNo}</b><small>/{game.config.hands} 盘</small>
      </div>
      {trackerOn && <button className="quiet-button dz-tracker-toggle" type="button" aria-expanded={trackerOpen} onClick={() => setTrackerOpen(!trackerOpen)}>记牌器</button>}
      {trackerOn && trackerOpen && <div className="dz-tracker-pop">{trackerNode}</div>}
    </div>
  );

  // ---------- 操作条 ----------
  const timeChip = secondsLeft !== null && myTurn ? <span className={secondsLeft <= 5 ? "dz-actions-time low" : "dz-actions-time"}>{secondsLeft}s</span> : null;
  const actionBar = (() => {
    if (!myTurn) return null;
    const button = (label: string, onClick: () => void, primary = false, key?: string, extra = "") => (
      <button className={`${primary ? "primary-button" : "quiet-button"} ${extra}`} type="button" disabled={busy} onClick={onClick}>
        {label}{key && <small>{key}</small>}
      </button>
    );
    switch (stage) {
      case "showStart":
        return <div className="dz-actions">{button("不明牌", () => send({ type: "SHOW_START", show: false }), false, "N")}{button("明牌开始 ×5", () => send({ type: "SHOW_START", show: true }), true, "Y", "dz-hot")}{timeChip}</div>;
      case "bidding":
        return <div className="dz-actions">{button("不叫", () => send({ type: "BID", call: false }), false, "N")}{button("叫地主", () => send({ type: "BID", call: true }), true, "Y")}{timeChip}</div>;
      case "robbing":
        return <div className="dz-actions">{button("不抢", () => send({ type: "ROB", rob: false }), false, "N")}{button("抢地主 ×2", () => send({ type: "ROB", rob: true }), true, "Y", "dz-hot")}{timeChip}</div>;
      case "doubling":
        return (
          <div className="dz-actions">
            {button("不加倍", () => send({ type: "DOUBLE", factor: 1 }), false, "N")}
            {button("加倍 ×2", () => send({ type: "DOUBLE", factor: 2 }), true, "Y")}
            {game.config.superDouble && button("超级加倍 ×4", () => send({ type: "DOUBLE", factor: 4 }), true, "S", "dz-hot")}
            {timeChip}
          </div>
        );
      case "landlordShow":
        return <div className="dz-actions">{button("不明牌", () => send({ type: "LANDLORD_SHOW", show: false }), false, "N")}{button("明牌 ×2", () => send({ type: "LANDLORD_SHOW", show: true }), true, "Y", "dz-hot")}{timeChip}</div>;
      case "playing":
        return (
          <div className="dz-actions">
            {following && button(noBeat ? "要不起" : "不出", () => send({ type: "PASS" }), noBeat, "P")}
            {!noBeat && button("提示", hint, false, "H")}
            {!noBeat && (candidates.length > 1
              ? candidates.map((combo) => (
                <button key={comboKey(combo)} className="primary-button dz-as" type="button" disabled={busy} onClick={() => playAs(combo)}>
                  按 {comboLabel(combo)} 出
                </button>
              ))
              : (
                <button className="primary-button" type="button" disabled={busy || candidates.length === 0} onClick={() => candidates[0] && playAs(candidates[0])}>
                  出牌<small>空格</small>
                </button>
              ))}
            {timeChip}
          </div>
        );
      default:
        return null;
    }
  })();

  // ---------- 自己的手牌 ----------
  const handRows: Card[][] = [];
  for (let index = 0; index < handOrder.length; index += layout.perRow) handRows.push(handOrder.slice(index, index + layout.perRow));
  const selectedSet = new Set(selected);
  const handNode = (
    <div
      className={["dz-hand", canSelect ? "selectable" : "", myPlay ? "my-turn" : ""].join(" ")}
      style={{ "--hs": hs, "--lift": `${hs * 8}px` } as CSSProperties}
      onPointerDown={onHandDown}
      onPointerMove={onHandMove}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onContextMenu={(event) => {
        if (!canSelect) return;
        event.preventDefault();
        setSelected([]);
      }}
    >
      {handRows.map((row, r) => (
        <div className="dz-hand-row" key={r} style={r > 0 ? { marginTop: -Math.round(CARD_H * hs * 0.5) } : undefined}>
          {row.map((card, index) => (
            <CardView
              key={card >= 0 ? card : `b${r}-${index}`}
              card={card}
              scale={hs}
              data-card={card}
              className={[selectedSet.has(card) ? "picked" : "", bottomFlip && landlord === mySeat && game.bottom.includes(card) ? "fresh" : ""].join(" ")}
              style={index > 0 ? { marginLeft: layout.step - CARD_W * hs } : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );

  const showSummary = stage === "handEnd" && game.summary && !hideSummary && !settling;
  const statusMini = (
    <div className="dz-status-mini">
      <strong>{headline}</strong>
      {showTimer && <b className={secondsLeft! <= 5 ? "low" : ""}>{secondsLeft}s</b>}
      {(error || shownNotice) && <small className={error ? "error" : ""}>{error || shownNotice}</small>}
    </div>
  );

  return (
    <div className={layout.mobile ? "dz-screen mobile" : "dz-screen"}>
      <header className="dz-topbar">
        {brand}
        {layout.mobile && (
          <button className="quiet-button dz-menu-toggle" type="button" aria-expanded={menu} onClick={() => setMenu(!menu)}>菜单{unread > 0 ? ` · ${unread}` : ""}</button>
        )}
        <div className="dz-round">
          <span>斗地主</span>
          <span>第 <b>{game.handNo}</b>/{game.config.hands} 盘</span>
          <span>倍数 <b>×{multiplier.total}</b></span>
        </div>
        <div className={menu ? "dz-topbar-right open" : "dz-topbar-right"} onClick={() => layout.mobile && setMenu(false)}>
          {themeToggle}
          <GameRules />
          <GameRoomMenu room={room} />
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve}>解散</button>}
          <button className="quiet-button dz-drawer-toggle" type="button" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
            记录 / 聊天{unread > 0 ? ` · ${unread}` : ""}
          </button>
          {connection}
        </div>
      </header>

      <div className={drawer ? "dz-layout drawer-open" : "dz-layout"}>
        <div
          className={["dz-table", shake ? "shake" : "", layout.mobile ? "mobile" : ""].join(" ")}
          ref={tableRef}
          style={{ "--scene": `url(${theme === "day" ? art.sceneDay : art.sceneNight})`, "--scene-size": coverSize(tableBox.width, tableBox.height), "--ps": ps, "--hs": hs } as CSSProperties}
        >
          {topInfo}
          <div className="dz-mid">
            {opponent(seatAt(2))}
            <div className="dz-plays">
              {playArea(seatAt(2))}
              {playArea(seatAt(1))}
            </div>
            {opponent(seatAt(1))}
          </div>
          <div className="dz-center">
            {actionBar ?? playArea(mySeat)}
            {myPlay && <span className={candidates.length > 0 || chosen.length === 0 ? "dz-note" : "dz-note bad"}>{selectionNote}</span>}
            {!myTurn && bubbleOf(mySeat) && <span className="dz-bubble b0">{bubbleOf(mySeat)}</span>}
            {activeFx.filter((item) => item.seat === mySeat && item.kind === "alert").map((item) => <span key={item.key} className="dz-fx alert">{item.text}</span>)}
          </div>
          <div className="dz-mine">
            {plate(mySeat)}
            {handNode}
          </div>
          {banner && <div className={`dz-banner ${banner.kind}`} role="status">{banner.kind === "spring" && <img src={art.spring} alt="" />}{banner.text}</div>}
          {statusMini}
          {me.auto && !spectating && playing && (
            <div className="dz-auto-banner">
              托管中：人机替你出牌
              <button className="primary-button" type="button" onClick={() => send({ type: "AUTO", on: false })}>取消托管</button>
            </div>
          )}
        </div>

        <aside className="dz-side">
          {spectating && <SpectateBar room={room} watchId={myId} onWatch={onWatch} onLeave={onLeave} />}
          <section className="dz-panel dz-status">
            <h2>{headline}</h2>
            {detail && <p>{detail}</p>}
            {showTimer && <span className={secondsLeft! <= 5 ? "dz-timer low" : "dz-timer"}>{secondsLeft}s</span>}
            {!spectating && playing && stage !== "handEnd" && (
              <button className="quiet-button dz-auto-toggle" type="button" onClick={() => send({ type: "AUTO", on: !me.auto })}>{me.auto ? "取消托管" : "托管"}</button>
            )}
            {stage === "handEnd" && playing && hideSummary && <button className="primary-button" type="button" onClick={() => setHideSummary(false)}>看结算</button>}
            {(error || shownNotice) && <p className={error ? "dz-feedback error" : "dz-feedback"} role={error ? "alert" : "status"}>{error || shownNotice}</p>}
          </section>
          {trackerOn && <section className="dz-panel dz-tracker-panel"><h3>记牌器 <small>外面还有</small></h3>{trackerNode}</section>}
          <section className="dz-panel dz-scores">
            {game.players.map((player, seat) => (
              <div key={player.id} className={seat === mySeat ? "mine" : ""}>
                <i style={{ background: seatColor(relOf(seat)) }} />
                <span>{nameOf(seat)}{seat === landlord ? " · 地主" : ""}</span>
                <b>{player.score}</b>
              </div>
            ))}
          </section>
          <section className="dz-panel dz-tabs">
            <div className="dz-tab-bar" role="tablist">
              <button type="button" role="tab" aria-selected={sideTab === "log"} className={sideTab === "log" ? "active" : ""} onClick={() => setSideTab("log")}>动作记录</button>
              <button type="button" role="tab" aria-selected={sideTab === "chat"} className={sideTab === "chat" ? "active" : ""} onClick={() => setSideTab("chat")}>
                聊天{unread > 0 && <em>{unread}</em>}
              </button>
            </div>
            {sideTab === "log" ? <ul className="dz-log">{log.map((line) => <li key={line.key}>{line.text}</li>)}</ul> : <div className="dz-chat">{chat}</div>}
          </section>
        </aside>
      </div>
      {showSummary && game.phase === "playing" && (
        <HandSummaryDialog game={game} mySeat={mySeat} spectating={spectating} nameOf={nameOf} secondsLeft={secondsLeft} busy={busy} onReady={() => send({ type: "READY" })} onHide={() => setHideSummary(true)} />
      )}
      {game.phase === "finished" && !settling && (
        <FinalDialog game={game} room={room} mySeat={mySeat} spectating={spectating} nameOf={nameOf} onRematch={onRematch} onLeave={onLeave} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 一盘结算

function HandSummaryDialog({ game, mySeat, spectating, nameOf, secondsLeft, busy, onReady, onHide }: {
  game: DdzState;
  mySeat: number;
  spectating: boolean;
  nameOf: (seat: number) => string;
  secondsLeft: number | null;
  busy: boolean;
  onReady: () => void;
  onHide: () => void;
}) {
  const summary = game.summary!;
  const me = game.players[mySeat]!;
  const ready = game.ready.includes(me.id);
  const iWon = summary.landlordWon === (mySeat === summary.landlord);
  const m = summary.multiplier;
  const title = spectating ? (summary.landlordWon ? "地主赢了" : "农民赢了") : iWon ? "你赢了！" : "你输了";
  const parts = [
    { label: `抢地主 ${m.robs} 次`, value: 2 ** m.robs, show: m.robs > 0 },
    { label: m.show === 5 ? "明牌开始" : "地主明牌", value: m.show, show: m.show > 1 },
    { label: `炸弹 / 王炸 ${m.bombs} 个`, value: 2 ** m.bombs, show: m.bombs > 0 },
    { label: m.spring === "spring" ? "春天" : "反春", value: 2, show: m.spring !== null },
  ].filter((part) => part.show);
  return (
    <div className="gm-modal-backdrop" role="presentation">
      <section className={`gm-panel dz-summary ${spectating ? (summary.landlordWon ? "landlord-won" : "farmers-won") : iWon ? "won" : "lost"}`} role="dialog" aria-modal="true" aria-label={`第 ${game.handNo} 盘结算`}>
        <header>
          <h2>{title}<small>第 {game.handNo} 盘 · {summary.landlordWon ? "地主" : "农民"}先出完{m.spring === "spring" ? " · 春天" : m.spring === "antiSpring" ? " · 反春" : ""}</small></h2>
          <button className="quiet-button" type="button" onClick={onHide}>看牌桌</button>
        </header>
        <div className="dz-sum-multi">
          <span>底分 <b>{summary.base}</b></span>
          {parts.map((part) => <span key={part.label}>{part.label} <b>×{part.value}</b></span>)}
          <span className="total">倍数 <b>×{m.total}</b></span>
        </div>
        <ol className="dz-sum-players">
          {game.players.map((player, seat) => (
            <li key={player.id} className={[seat === mySeat ? "mine" : "", seat === summary.winner ? "winner" : ""].join(" ")}>
              <div className="dz-sum-who">
                <strong>{nameOf(seat)}</strong>
                <small>{seat === summary.landlord ? "地主" : "农民"}{summary.doubles[seat]! > 1 ? ` · ${DOUBLE_TEXT[summary.doubles[seat]!]}` : ""}{seat === summary.winner ? " · 先出完" : ""}</small>
              </div>
              <span className="dz-sum-cards">
                {player.hand.length > 0 ? <CardRow cards={player.hand} scale={1} step={14} perRow={20} /> : <em>出完了</em>}
              </span>
              <b className={summary.deltas[seat]! > 0 ? "up" : summary.deltas[seat]! < 0 ? "down" : ""}>{summary.deltas[seat]! > 0 ? "+" : ""}{summary.deltas[seat]}</b>
              <span className="dz-sum-total">{player.score}</span>
            </li>
          ))}
        </ol>
        <div className="dz-sum-bottom">
          <small>底牌</small>
          <CardRow cards={summary.bottom} scale={1} step={44} />
          <small className="dz-muted">每个农民和地主之间：底分 × 倍数 × 农民加倍 × 地主加倍</small>
        </div>
        <footer>
          <span className="dz-muted">{game.handNo < game.config.hands ? `还剩 ${game.config.hands - game.handNo} 盘` : "最后一盘"}</span>
          {!spectating ? (
            <button className="primary-button" type="button" disabled={busy || ready} onClick={onReady}>
              {ready ? `等其他人 ${game.ready.length}/3` : "下一盘"}{secondsLeft !== null && <small>{secondsLeft}s</small>}
            </button>
          ) : (
            <span className="dz-muted">等玩家点「下一盘」 {game.ready.length}/3</span>
          )}
        </footer>
      </section>
    </div>
  );
}

function FinalDialog({ game, room, mySeat, spectating, nameOf, onRematch, onLeave }: {
  game: DdzState;
  room: LobbyRoomSnapshot;
  mySeat: number;
  spectating: boolean;
  nameOf: (seat: number) => string;
  onRematch: (accept: boolean) => void;
  onLeave: () => void;
}) {
  const result = game.finalResult!;
  const [showLast, setShowLast] = useState(false);
  const accepted = room.rematch?.acceptedIds.includes(socket.id ?? "") ?? false;
  const order = game.players.map((_, seat) => seat).sort((a, b) => result.ranks[a]! - result.ranks[b]!);
  const myId = game.players[mySeat]!.id;
  const won = result.winners.includes(myId) && !spectating;
  const title = won ? (result.winners.length > 1 ? "并列第一！" : "你赢了！") : `${result.winners.map((id) => nameOf(game.players.findIndex((player) => player.id === id))).join("、")} 获胜`;
  if (showLast && game.summary) {
    return <HandSummaryDialog game={game} mySeat={mySeat} spectating nameOf={nameOf} secondsLeft={null} busy={false} onReady={() => undefined} onHide={() => setShowLast(false)} />;
  }
  return (
    <div className="gm-modal-backdrop" role="presentation">
      <section className="gm-panel dz-final" role="dialog" aria-modal="true" aria-labelledby="dz-final-title">
        <h2 id="dz-final-title">{title}</h2>
        <p className="dz-muted">打满 {game.config.hands} 盘，累计积分最高的人获胜（积分一样并列）。</p>
        <ol className="dz-standings">
          {order.map((seat) => (
            <li key={seat} className={result.winners.includes(game.players[seat]!.id) ? "winner" : ""}>
              <span className="dz-rank">{result.ranks[seat]}</span>
              <strong>{nameOf(seat)}</strong>
              <small>最后一盘 {game.players[seat]!.handDelta > 0 ? "+" : ""}{game.players[seat]!.handDelta}</small>
              <b>{game.players[seat]!.score}</b>
            </li>
          ))}
        </ol>
        {game.summary && <button className="quiet-button" type="button" onClick={() => setShowLast(true)}>看最后一盘结算</button>}
        {spectating ? (
          <div className="dz-rematch">
            <span>{room.rematch ? `等玩家决定要不要再来一局（${room.rematch.acceptedIds.length}/${room.members.length}）` : "对局结束"}</span>
            <div className="gm-panel-actions"><button className="quiet-button" type="button" onClick={onLeave}>离开观战</button></div>
          </div>
        ) : room.rematch && (
          <div className="dz-rematch">
            <span>再来一局？还剩 {Math.ceil(room.rematch.remainingMs / 1000)} 秒（{room.rematch.acceptedIds.length}/{room.members.length} 人同意）</span>
            <div className="gm-panel-actions">
              <button className="quiet-button" type="button" onClick={() => onRematch(false)}>离开</button>
              <button className="primary-button" type="button" disabled={accepted} onClick={() => onRematch(true)}>{accepted ? "等待其他人" : "再来一局"}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default GameBoard;
