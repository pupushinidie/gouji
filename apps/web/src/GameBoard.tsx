/**
 * 够级牌桌。六个座位围一圈：自己在下方，对头在正上方，下家在右下，上家在左下（座位逆时针轮流）。
 * 桌面版：对手两排（每格名牌 + 这一轮出的牌），中间是桌面牌 / 进贡面板，下面是操作行和手牌；右栏（≥1280）放比分、记录、聊天。
 * 手机版：对手两排小名牌，中间一行桌面牌，下面是状态、按钮和两行手牌；记录和聊天在菜单里。
 * 动画只看 game.version 变没变；特效的计时器放在一张持久的表里，只在卸载时清掉。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  beatingMoves,
  botHint,
  canRang,
  legalBurnLead,
  oppOf,
  parseSet,
  PLACE_NAMES,
  rankOf,
  setLabel,
  TEAM_NAMES,
  teamOf,
  type Card,
  type GameCommand,
  type GameState,
  type LobbyRoomSnapshot,
  type TableEntry,
} from "@gouji/game";
import { art, coverSize, preloadArt, type StatusIcon } from "./art.js";
import { CardRow, preloadCards } from "./cards.js";
import GameRules from "./GameRules.js";
import Hand, { HAND_RANKS, isWildRank, picksOf, selectedCards, shortRank } from "./Hand.js";
import { eventText, KIND_NAMES, signed } from "./log.js";
import { GameRoomMenu, roomRole, SpectateBar } from "./RoomExtras.js";
import { socket } from "./socket.js";
import Sprite from "./Sprite.js";
import { pickLayout, useBox, useCountdown } from "./table.js";
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
  /** 教程：在操作行上方插一块（教练框由教程自己画）。 */
  readonly coach?: ReactNode;
  /** 教程 / 练习局：显示「提示」按钮。默认显示。 */
  readonly showHint?: boolean;
}

type Fx =
  | { key: string; kind: "gouji"; seat: number; duel: number | null }
  | { key: string; kind: "burn" | "douse" | "finish" | "jiefeng"; seat: number }
  | { key: string; kind: "chuan"; team: 0 | 1 }
  | { key: string; kind: "banner"; text: string; icon?: StatusIcon };

const FX_MS = { gouji: 1700, burn: 900, douse: 700, finish: 700, jiefeng: 1400, chuan: 2600, banner: 2600 } as const;

const STAGE_TITLES: Record<GameState["stage"], string> = { tribute: "进贡", return: "还贡", revolution: "革命表态", playing: "出牌", handEnd: "结算" };

/** 座位在桌上的位置：0 自己（下）、1 右下（下家）、2 右上、3 正上（对头）、4 左上、5 左下（上家）。 */
const POS = ["me", "br", "tr", "top", "tl", "bl"] as const;

export default function GameBoard({
  room,
  busy,
  error,
  notice,
  brand,
  connection,
  theme,
  themeToggle,
  chat,
  onCommand,
  onRematch,
  onDissolve,
  watchId,
  onWatch,
  onLeave,
  coach,
  showHint = true,
}: GameBoardProps) {
  const game = room.game!;
  const { isHost, spectating, member } = roomRole(room);
  const meId = member?.playerId ?? "";
  const mySeat = spectating ? -1 : game.players.findIndex((player) => player.id === meId);
  const watchSeat = Math.max(0, game.players.findIndex((player) => player.id === watchId));
  const viewSeat = mySeat >= 0 ? mySeat : watchSeat;
  const seatAt = (rel: number) => (viewSeat + rel) % 6;
  const me = mySeat >= 0 ? game.players[mySeat]! : null;
  const hand = me?.hand ?? [];
  const round = game.round;
  const top = round?.top ?? null;
  const you = game.you;
  const playing = game.phase === "playing";

  const nameOf = (seat: number) => (seat === mySeat ? "你" : game.players[seat]?.name ?? `${seat + 1} 号`);
  const offline = (seat: number) => room.members.some((m) => m.playerId === game.players[seat]?.id && !m.connected);

  // ---------- 尺寸 ----------
  const [tableRef, tableBox] = useBox<HTMLDivElement>();
  const columns = useMemo(() => new Set(hand.map(rankOf)).size, [hand]);
  const layout = pickLayout(tableBox.width, tableBox.height, columns);
  const mobile = layout.mobile;
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [sideTab, setSideTab] = useState<"log" | "chat">("log");
  const [wide, setWide] = useState(() => window.innerWidth >= 1280);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    preloadCards();
    preloadArt();
  }, []);

  // ---------- 选牌 ----------
  const [picks, setPicks] = useState<number[]>(() => new Array<number>(18).fill(0));
  const [hint, setHint] = useState("");
  const chosen = useMemo(() => selectedCards(hand, picks), [hand, picks]);
  const returnItem = game.stage === "return" && mySeat >= 0
    ? game.tribute?.items.find((item) => item.receiver === mySeat && item.kind !== "burn" && item.cards.length > 0 && item.returned === null) ?? null
    : null;
  const returnMode = returnItem !== null;
  // 换阶段、换一轮、自己的手牌变了就清掉选择
  const resetKey = `${game.handNo}:${game.stage}:${round?.top?.seq ?? "lead"}:${hand.length}`;
  useEffect(() => {
    setPicks(new Array<number>(18).fill(0));
    setHint("");
  }, [resetKey]);
  // 还贡：先按人机的推荐选好
  useEffect(() => {
    if (!returnMode || mySeat < 0) return;
    const suggestion = botHint(game, mySeat);
    if (suggestion?.command.type === "RETURN") setPicks(picksOf(suggestion.command.cards, rankOf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnMode, game.handNo]);

  const myTurn = playing && game.stage === "playing" && game.turn === mySeat && mySeat >= 0 && round?.pending?.seat !== mySeat && !you?.pendingAction;
  const inBurnLead = myTurn && !top && game.burn?.burner === mySeat;
  const pick = (rank: number) => {
    setHint("");
    setPicks((current) => {
      const next = [...current];
      const have = hand.filter((card) => rankOf(card) === rank).length;
      if (isWildRank(rank) || returnMode) {
        next[rank] = ((next[rank] ?? 0) + 1) % (have + 1);
        return next;
      }
      if ((next[rank] ?? 0) > 0) {
        next[rank] = 0;
        return next;
      }
      for (let other = 3; other <= 14; other += 1) next[other] = 0;
      const wilds = (next[15] ?? 0) + (next[16] ?? 0) + (next[17] ?? 0);
      next[rank] = top ? Math.max(1, Math.min(have, top.cards.length - wilds)) : have;
      return next;
    });
  };
  const naturalPicked = HAND_RANKS.find((rank) => rank <= 14 && (picks[rank] ?? 0) > 0);
  const adjust = (delta: number) => {
    if (naturalPicked === undefined) return;
    const have = hand.filter((card) => rankOf(card) === naturalPicked).length;
    setPicks((current) => {
      const next = [...current];
      next[naturalPicked] = Math.max(0, Math.min(have, (next[naturalPicked] ?? 0) + delta));
      return next;
    });
  };
  const clear = () => {
    setPicks(new Array<number>(18).fill(0));
    setHint("");
  };

  const chosenSet = chosen.length > 0 ? parseSet(chosen) : null;
  let playOk = false;
  let playNote = "";
  if (myTurn) {
    if (chosen.length === 0) playNote = top ? `选牌压住 ${setLabel(top.set)}，或者过` : inBurnLead ? "烧牌中：每套都要挂王，最后一套随便" : "选一种点数的牌发出去（可以挂 2 和王）";
    else if (!chosenSet) playNote = "一次只能出一种点数（可以挂 2 和王）";
    else if (top) {
      playOk = chosenSet.eff.length === top.set.eff.length && chosenSet.eff.every((rank, index) => rank > top.set.eff[index]!);
      playNote = chosenSet.eff.length !== top.set.eff.length ? `要出 ${top.set.eff.length} 张（现在 ${chosen.length} 张）` : playOk ? `${setLabel(chosenSet)}${chosenSet.gouji ? "（够级）" : ""}` : `${setLabel(chosenSet)} 压不住`;
    } else if (inBurnLead) {
      playOk = legalBurnLead(hand, chosen);
      playNote = playOk ? setLabel(chosenSet) : "烧牌中：这一套要挂王，而且剩下的还能一口气出完";
    } else {
      playOk = true;
      playNote = `${setLabel(chosenSet)}${chosenSet.gouji ? "（够级，只有对头能管）" : ""}`;
    }
  } else if (chosenSet && game.stage === "playing") playNote = `已选 ${setLabel(chosenSet)}`;

  // 接牌时用不上的点数变暗
  const dim = useMemo(() => {
    const out = new Set<number>();
    if (!myTurn || !top || returnMode) return out;
    const usable = new Set<number>();
    for (const cards of beatingMoves(hand, top.set)) for (const card of cards) usable.add(rankOf(card));
    for (const rank of HAND_RANKS) if (!usable.has(rank)) out.add(rank);
    return out;
  }, [myTurn, top, hand, returnMode]);

  const send = (command: GameCommand) => {
    setHint("");
    onCommand(command);
  };
  const showHintFor = () => {
    if (mySeat < 0) return;
    const decision = botHint(game, mySeat);
    if (!decision) return;
    const command = decision.command;
    if (command.type === "PLAY" || command.type === "BURN" || command.type === "RETURN") setPicks(picksOf(command.cards, rankOf));
    setHint(`提示：${decision.reason}`);
  };

  // ---------- 特效 ----------
  const [fx, setFx] = useState<Fx[]>([]);
  const timers = useRef(new Map<string, number>());
  const lastVersion = useRef(game.version);
  const lastHand = useRef(game.handNo);
  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
  }, []);
  useEffect(() => {
    if (game.version === lastVersion.current) return;
    const fresh = game.version > lastVersion.current || game.handNo !== lastHand.current;
    lastVersion.current = game.version;
    lastHand.current = game.handNo;
    if (!fresh) return;
    const add: Fx[] = [];
    const k = (suffix: string) => `${game.version}-${suffix}`;
    game.events.forEach((event, index) => {
      switch (event.type) {
        case "Played":
          if (event.gouji && !game.chaos && !game.headless[event.seat]) {
            const duel = oppOf(event.seat);
            add.push({ key: k(`g${index}`), kind: "gouji", seat: event.seat, duel: game.players[duel]!.handCount !== 0 ? duel : null });
          }
          break;
        case "BurnStarted":
          add.push({ key: k(`bs${index}`), kind: "banner", text: `${nameOf(event.burner)} 烧 ${nameOf(event.victim)}！`, icon: "shao" });
          break;
        case "BurnSucceeded":
          add.push({ key: k(`b${index}`), kind: "burn", seat: event.burner });
          add.push({ key: k(`bo${index}`), kind: "banner", text: `${nameOf(event.burner)} 烧牌成功！`, icon: "shao-ok" });
          break;
        case "BurnBroken":
          add.push({ key: k(`d${index}`), kind: "douse", seat: event.burner });
          add.push({ key: k(`db${index}`), kind: "banner", text: `${nameOf(event.by)} ${event.counter ? "反烧" : "解烧"}：${nameOf(event.burner)} 烧牌失败`, icon: "jieshao" });
          break;
        case "WentOut":
          add.push({ key: k(`f${index}`), kind: "finish", seat: event.seat });
          break;
        case "RoundEnded":
          if (event.jiefeng) {
            add.push({ key: k(`j${index}`), kind: "jiefeng", seat: event.leader });
            add.push({ key: k(`jb${index}`), kind: "banner", text: `${nameOf(event.leader)} 接风`, icon: "jiefeng" });
          }
          break;
        case "ChaosStarted":
          add.push({ key: k(`c${index}`), kind: "banner", text: "四人乱缠：不再有够级和烧牌", icon: "luanchan" });
          break;
        case "Headless":
          add.push({ key: k(`h${index}`), kind: "banner", text: `${event.seats.map(nameOf).join("、")} 无头了`, icon: "wutou" });
          break;
        case "Revolted":
          add.push({ key: k(`r${index}`), kind: "banner", text: `${nameOf(event.seat)} 革命！`, icon: "geming" });
          break;
        case "RevolutionRedeal":
          add.push({ key: k(`rr${index}`), kind: "banner", text: "两人以上革命：重新发牌", icon: "geming" });
          break;
        case "AntiTribute":
          add.push({ key: k(`a${index}`), kind: "banner", text: `${nameOf(event.seat)} 抗贡`, icon: "kanggong" });
          break;
        case "HandEnded":
          if (event.result.sweep) add.push({ key: k(`s${index}`), kind: "chuan", team: event.result.sweepTeam! });
          break;
        default:
      }
    });
    if (add.length === 0) return;
    setFx((current) => [...current.filter((item) => item.kind !== "banner" || !add.some((other) => other.kind === "banner")), ...add]);
    for (const item of add) {
      const timer = window.setTimeout(() => {
        timers.current.delete(item.key);
        setFx((current) => current.filter((other) => other.key !== item.key));
      }, FX_MS[item.kind]);
      timers.current.set(item.key, timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.version, game.handNo]);
  const banner = [...fx].reverse().find((item): item is Extract<Fx, { kind: "banner" }> => item.kind === "banner");

  // ---------- 倒计时、标题 ----------
  const secondsLeft = useCountdown(room);
  const turnSeat = game.stage === "playing" ? game.turn : -1;
  const waitingWindow = game.stage === "playing" && top !== null && !top.ready;
  const choiceDone = game.stage === "revolution" && mySeat >= 0 && game.revolution?.choices[mySeat] !== null;
  const tributeMine = game.stage === "tribute" && mySeat >= 0 && game.tribute?.items.some((item) => item.receiver === mySeat && item.intra && item.eat === null);

  let headline = "";
  if (game.phase === "finished") headline = "一场结束";
  else if (game.stage === "handEnd") headline = `第 ${game.handNo} 盘结束`;
  else if (game.stage === "tribute") headline = tributeMine ? "队友要给你进贡：吃还是免？" : "进贡：等收贡的人选吃贡还是免贡";
  else if (game.stage === "return") headline = returnItem ? `还贡：挑 ${returnItem.cards.length} 张还给 ${nameOf(returnItem.giver)}` : "还贡：等收了贡的人还牌";
  else if (game.stage === "revolution") headline = you?.canRevolt && !choiceDone ? "你手里没有王和 2：可以革命" : choiceDone ? "已表态，等大家表态" : "革命表态中";
  else if (you?.pendingAction) headline = you.pendingAction.type === "PASS" ? "已选过牌，2 秒后生效" : "已出牌，2 秒后生效（等有没有人烧）";
  else if (myTurn) headline = top ? `轮到你：压 ${nameOf(top.seat)} 的牌，或者过` : inBurnLead ? "轮到你发牌（烧牌中）" : "轮到你发牌";
  else if (turnSeat >= 0) headline = top ? `等 ${nameOf(turnSeat)} 接牌` : `等 ${nameOf(turnSeat)} 发牌`;
  else if (waitingWindow) headline = "够级牌：等 2 秒，看有没有人烧";
  const myAction = myTurn || tributeMine || (returnItem !== null) || (game.stage === "revolution" && !choiceDone && mySeat >= 0);

  // 页面在后台时标题提示
  useEffect(() => {
    const base = "够级 · 在线对战";
    document.title = myAction && document.hidden ? `【轮到你】${base}` : base;
    const onVisible = () => { if (!document.hidden) document.title = base; };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [myAction, game.version]);

  // ---------- 记录 ----------
  const log = useMemo(() => {
    const lines: { key: string; text: string }[] = [];
    game.history.forEach((event, index) => {
      const text = eventText(event, nameOf);
      if (text) lines.push({ key: `${index}`, text });
    });
    return lines.slice(-80).reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.history.length, mySeat]);
  const [seenChat, setSeenChat] = useState(room.chat.length);
  const chatOpen = (wide && sideTab === "chat") || (drawer && sideTab === "chat");
  useEffect(() => {
    if (chatOpen) setSeenChat(room.chat.length);
  }, [chatOpen, room.chat.length]);
  const unread = Math.max(0, room.chat.length - seenChat);

  // ---------- 结算弹窗 ----------
  const [hideSummary, setHideSummary] = useState(false);
  useEffect(() => setHideSummary(false), [game.handNo, game.phase]);

  // ---------- 座位 ----------
  const statusIcons = (seat: number): { icon: StatusIcon; title: string }[] => {
    const icons: { icon: StatusIcon; title: string }[] = [];
    if (game.revolutionary === seat) icons.push({ icon: "geming", title: "革命：这盘不出牌，算四科（队友拿头科二科时算三科）" });
    if (game.burn?.burner === seat) icons.push({ icon: "shao", title: `烧牌中：正在烧 ${nameOf(game.burn.victim)}，每一套都要挂王，被压住就烧牌失败` });
    if (game.burnsThisHand.some((burn) => burn.burner === seat)) icons.push({ icon: "shao-ok", title: "烧牌成功：下一盘被烧的人给他进 1 张烧贡" });
    if (game.headless[seat] && game.revolutionary !== seat) icons.push({ icon: "wutou", title: "无头：对头出完了。他的够级牌谁都能接，他也能接任何人的够级牌，但不能烧" });
    if (round?.rang?.seat === seat) icons.push({ icon: "rang", title: "让牌：先让下家和下下家接，没人上再回到他" });
    if (game.chaos && game.players[seat]!.handCount !== 0 && game.revolutionary !== seat) icons.push({ icon: "luanchan", title: "四人乱缠：没有够级和烧牌，过了还能再接" });
    return icons;
  };

  const plate = (seat: number, rel: number) => {
    const player = game.players[seat]!;
    const team = teamOf(seat);
    const place = game.finished.indexOf(seat);
    const active = seat === turnSeat;
    const count = game.revolutionary === seat ? "革命" : player.handCount === null ? "10+" : String(player.handCount);
    const tags: string[] = [];
    if (player.bot) tags.push("人机");
    if (player.auto) tags.push("托管");
    if (offline(seat)) tags.push("离线");
    const as = layout.as;
    const ring = fx.find((item) => item.kind === "gouji" && item.duel === seat);
    const finishing = fx.find((item) => item.kind === "finish" && item.seat === seat);
    const jiefeng = fx.find((item) => item.kind === "jiefeng" && item.seat === seat);
    const peek = seat !== mySeat && mySeat >= 0 && player.hand.length > 0 && game.stage !== "handEnd" ? player.hand : null;
    return (
      <div
        className={["gj-plate", `team-${team}`, active ? "active" : "", place >= 0 || game.revolutionary === seat ? "out" : ""].filter(Boolean).join(" ")}
        data-tutorial={rel === 0 ? "plate-me" : rel === 3 ? "plate-duitou" : `plate-${POS[rel]}`}
        style={{ "--as": as, borderImageSource: `url(${art.plate(team)})` } as CSSProperties}
      >
        <span className="gj-avatar" style={{ width: 48 * as, height: 48 * as, backgroundImage: `url(${art.frame(team)})` }}>
          <img src={art.avatar(seat)} alt="" width={40 * as} height={40 * as} style={{ left: 4 * as, top: 4 * as }} />
          {ring && <Sprite name="ring" scale={as} className="gj-ring" />}
          {finishing && <Sprite name="finish" scale={as} className="gj-finish" />}
          {jiefeng && <img className="gj-flash" src={art.status("jiefeng")} alt="" width={24 * as} height={24 * as} />}
        </span>
        <span className="gj-plate-text">
          <span className="gj-name-row">
            <span className="gj-name" title={player.name}>{seat === mySeat ? `${player.name}（你）` : player.name}</span>
            {rel === 3 && mySeat >= 0 && <img className="gj-duitou" src={art.duitou} alt="对头" title="对头：正对面的人，永远是对手；他出够级牌时只有你能管" width={24} height={24} />}
            {tags.map((tag) => <em key={tag} className={`gj-tag ${tag === "人机" ? "bot" : tag === "托管" ? "auto" : "off"}`}>{tag}</em>)}
          </span>
          <span className="gj-count-row">
            {place >= 0 ? (
              <img className="gj-rank" src={art.rank(place)} alt={PLACE_NAMES[place]} title={PLACE_NAMES[place]} width={mobile ? 36 : 72} height={mobile ? 20 : 40} />
            ) : (
              <b className="gj-count" title={player.handCount === null ? "超过 10 张不报张数" : "剩几张"}>{count}</b>
            )}
            {statusIcons(seat).map(({ icon, title }) => <img key={icon} className="gj-icon" src={art.status(icon)} alt={title.split("：")[0]} title={title} width={24 * as} height={24 * as} />)}
            {active && secondsLeft !== null && !player.bot && <b className={secondsLeft <= 5 ? "gj-clock low" : "gj-clock"}>{secondsLeft}s</b>}
          </span>
          {peek && <span className="gj-peek" title="看牌：队友剩 10 张以下，你能看到他的手牌">看牌 {peek.map((card) => shortRank(rankOf(card))).join(" ")}</span>}
        </span>
      </div>
    );
  };

  const lastEntry = (seat: number): TableEntry | null => {
    if (!round) return null;
    for (let index = round.entries.length - 1; index >= 0; index -= 1) if (round.entries[index]!.seat === seat) return round.entries[index]!;
    return null;
  };

  const playArea = (seat: number) => {
    const entry = lastEntry(seat);
    const gouji = fx.find((item) => item.kind === "gouji" && item.seat === seat);
    const burnFx = fx.find((item) => (item.kind === "burn" || item.kind === "douse") && item.seat === seat);
    const pendingMine = seat === mySeat && you?.pendingAction;
    const isTop = top?.seat === seat && entry?.kind === "play";
    return (
      <div className={["gj-play", isTop ? "top" : ""].filter(Boolean).join(" ")} data-tutorial={seat === mySeat ? "play-me" : undefined}>
        {pendingMine ? (
          <span className="gj-play-label pending">{you!.pendingAction!.type === "PASS" ? "过（2 秒后生效）" : `${setLabel(parseSet(you!.pendingAction!.type === "PLAY" ? you!.pendingAction!.cards : [])!)}（2 秒后生效）`}</span>
        ) : entry?.kind === "play" ? (
          <>
            {!mobile && <CardRow cards={entry.cards} scale={layout.ps} step={Math.min(14 * layout.ps, Math.floor((150 * layout.ps) / Math.max(1, entry.cards.length)))} />}
            <span className="gj-play-label">
              {entry.set.gouji && <img src={art.status("gouji")} alt="够级" title="够级牌：只有出牌人的对头能管（别人能烧）" width={24} height={24} />}
              {entry.burn && <img src={art.status("shao")} alt="烧" title="这一手是烧牌" width={24} height={24} />}
              {setLabel(entry.set)}
            </span>
          </>
        ) : entry?.kind === "pass" ? (
          <span className="gj-play-label pass">过</span>
        ) : entry?.kind === "rang" ? (
          <span className="gj-play-label pass">让牌</span>
        ) : null}
        {gouji && <Sprite name="gouji" scale={mobile ? 1 : 2} className="gj-gouji-fx" />}
        {gouji && mobile && <strong className="gj-gouji-text">够级！</strong>}
        {burnFx && <Sprite name={burnFx.kind === "burn" ? "burn" : "douse"} scale={mobile ? 1 : 2} className="gj-burn-fx" />}
      </div>
    );
  };

  const seatCell = (rel: number) => {
    const seat = seatAt(rel);
    return (
      <div key={rel} className={`gj-seat pos-${POS[rel]}${seat === turnSeat ? " turn" : ""}`} data-seat={seat}>
        {plate(seat, rel)}
        {playArea(seat)}
      </div>
    );
  };

  // ---------- 桌面中间 ----------
  const bannerNode = banner && (
    <div className="gj-banner" role="status" key={banner.key}>
      {banner.icon && <img src={art.status(banner.icon)} alt="" width={mobile ? 24 : 48} height={mobile ? 24 : 48} />}
      {banner.text}
    </div>
  );
  const centerInfo = (
    <div className="gj-center" data-tutorial="center">
      {!mobile && bannerNode}
      {game.stage === "playing" && (
        <>
          {top ? (
            <span className="gj-top-label">
              <small>{nameOf(top.seat)}{top.burn ? " 烧牌" : ""}</small>
              {top.set.gouji && !game.chaos && !game.headless[top.seat] && <img src={art.status("gouji")} alt="够级" width={24} height={24} />}
              {setLabel(top.set)}
            </span>
          ) : (
            <span className="gj-top-label"><small>新的一轮</small>{round ? `${nameOf(round.leader)} 发牌` : ""}</span>
          )}
          {game.burn && (
            <span className="gj-chip burn"><img src={art.status("shao")} alt="" width={24} height={24} />{nameOf(game.burn.burner)} 正在烧 {nameOf(game.burn.victim)}</span>
          )}
          {game.chaos && <span className="gj-chip"><img src={art.status("luanchan")} alt="" width={24} height={24} />四人乱缠</span>}
          {waitingWindow && <span className="gj-chip wait">够级牌：等 2 秒</span>}
        </>
      )}
      {game.stage === "revolution" && <span className="gj-top-label"><small>每盘都有</small>革命表态中</span>}
    </div>
  );

  const tributePanel = game.tribute && (game.stage === "tribute" || game.stage === "return" || game.stage === "revolution") && (game.tribute.items.length > 0 || game.tribute.antiTribute.length > 0) ? (
    <div className="gj-tribute" data-tutorial="tribute">
      <h3>进贡{game.stage === "return" ? " · 还贡" : ""}</h3>
      <ul>
        {game.tribute.items.map((item, index) => (
          <li key={index} className={item.giver === mySeat || item.receiver === mySeat ? "mine" : ""}>
            <span className="gj-tr-who"><i className={`team-${teamOf(item.giver)}`}>{nameOf(item.giver)}</i></span>
            <Sprite name="arrow" scale={1} />
            <span className="gj-tr-who"><i className={`team-${teamOf(item.receiver)}`}>{nameOf(item.receiver)}</i></span>
            <span className="gj-tr-kind">{KIND_NAMES[item.kind]} {item.count} 张{item.intra ? (item.eat === null ? " · 队内：等他选" : item.eat ? " · 吃" : " · 免") : ""}</span>
            <span className="gj-tr-cards">
              {game.tribute!.paid ? (item.cards.length > 0 ? item.cards.map((card) => shortRank(rankOf(card))).join(" ") : item.intra && item.eat === false ? "免了" : "没有王和 2") : "…"}
              {item.returned && <> · 还 {item.returned.map((card) => shortRank(rankOf(card))).join(" ")}</>}
            </span>
          </li>
        ))}
      </ul>
      {game.tribute.antiTribute.length > 0 && (
        <p><img src={art.status("kanggong")} alt="" width={24} height={24} /> {game.tribute.antiTribute.map(nameOf).join("、")} 发到 4 张大王：抗贡，不用进落贡</p>
      )}
    </div>
  ) : null;

  // ---------- 操作行 ----------
  const burnOptions = !spectating && you && game.stage === "playing" ? you.burnCandidates : [];
  const buttons: ReactNode[] = [];
  if (!spectating && me && playing) {
    if (game.stage === "tribute" && tributeMine) {
      buttons.push(<button key="eat" className="primary-button gj-btn" type="button" disabled={busy} onClick={() => send({ type: "TRIBUTE", eat: true })}>吃贡</button>);
      buttons.push(<button key="skip" className="quiet-button gj-btn" type="button" disabled={busy} onClick={() => send({ type: "TRIBUTE", eat: false })}>免贡</button>);
    }
    if (returnItem) {
      const ok = chosen.length === returnItem.cards.length;
      buttons.push(<button key="ret" className="primary-button gj-btn" type="button" disabled={busy || !ok} onClick={() => send({ type: "RETURN", cards: chosen })}>还这 {returnItem.cards.length} 张</button>);
    }
    if (game.stage === "revolution" && !choiceDone) {
      if (you?.canRevolt) {
        buttons.push(<button key="rev" className="primary-button gj-btn" type="button" disabled={busy} onClick={() => send({ type: "REVOLT", revolt: true })}>革命</button>);
        buttons.push(<button key="norev" className="quiet-button gj-btn" type="button" disabled={busy} onClick={() => send({ type: "REVOLT", revolt: false })}>不革命</button>);
      } else buttons.push(<button key="cont" className="primary-button gj-btn" type="button" disabled={busy} onClick={() => send({ type: "REVOLT", revolt: false })}>继续</button>);
    }
    if (myTurn) {
      buttons.push(<button key="play" className="primary-button gj-btn" type="button" data-tutorial="btn-play" disabled={busy || !playOk} onClick={() => send({ type: "PLAY", cards: chosen })}>{top ? "压上" : "出牌"}</button>);
      if (top) buttons.push(<button key="pass" className="quiet-button gj-btn" type="button" data-tutorial="btn-pass" disabled={busy} onClick={() => send({ type: "PASS" })}>过</button>);
      if (canRang(game, mySeat)) buttons.push(<button key="rang" className="quiet-button gj-btn" type="button" data-tutorial="btn-rang" disabled={busy} onClick={() => send({ type: "RANG" })} title="先让下家、下下家接；他们都不上会回到你">让牌</button>);
    }
    for (const [index, cards] of burnOptions.slice(0, 3).entries()) {
      buttons.push(
        <button key={`burn${index}`} className="primary-button gj-btn gj-burn" type="button" data-tutorial={index === 0 ? "btn-burn" : undefined} disabled={busy || !!you?.burnRequested} onClick={() => send({ type: "BURN", cards })} title="烧牌：用这套压住够级牌，剩下的牌每套挂王一口气出完">
          <Sprite name="flame" scale={1} />烧！{setLabel(parseSet(cards)!)}<Sprite name="flame" scale={1} />
        </button>,
      );
    }
    if (showHint && (myTurn || returnItem || burnOptions.length > 0)) buttons.push(<button key="hint" className="quiet-button gj-btn small" type="button" data-tutorial="btn-hint" onClick={showHintFor}>提示</button>);
  }

  const selectionTools = myTurn && naturalPicked !== undefined && (
    <span className="gj-adjust">
      <button className="quiet-button" type="button" onClick={() => adjust(-1)} aria-label="少选一张">−</button>
      <button className="quiet-button" type="button" onClick={() => adjust(1)} aria-label="多选一张">＋</button>
    </span>
  );
  const shownNote = error || hint || (you?.burnRequested ? "已按烧牌：2 秒后见分晓" : "") || playNote || notice;
  const controlRow = (
    <div className={["gj-control", myAction ? "my-action" : ""].filter(Boolean).join(" ")} data-tutorial="control">
      {!mobile && plate(viewSeat, 0)}
      <div className="gj-control-mid">
        <strong className="gj-headline" data-tutorial="headline">
          {headline}
          {(myAction || (turnSeat >= 0 && turnSeat === viewSeat)) && secondsLeft !== null && <b className={secondsLeft <= 5 ? "gj-clock low" : "gj-clock"}>{secondsLeft}s</b>}
        </strong>
        {shownNote && <span className={["gj-note", error ? "bad" : "", hint ? "hint" : "", myTurn && chosen.length > 0 && !playOk ? "bad" : ""].filter(Boolean).join(" ")} role={error ? "alert" : "status"}>{shownNote}</span>}
        {!myTurn && !mobile && game.stage === "playing" && playArea(viewSeat)}
      </div>
      <div className="gj-buttons" data-tutorial="buttons">
        {selectionTools}
        {buttons}
        {chosen.length > 0 && (myTurn || returnMode) && <button className="quiet-button gj-btn small" type="button" onClick={clear}>清空</button>}
      </div>
    </div>
  );

  const autoBanner = me?.auto && playing && game.stage !== "handEnd" && (
    <div className="gj-auto-banner" role="status" data-tutorial="auto">
      托管中：人机替你出牌
      <button className="primary-button gj-btn" type="button" onClick={() => send({ type: "AUTO", on: false })}>取消托管</button>
    </div>
  );

  const fxChuan = fx.filter((item): item is Extract<Fx, { kind: "chuan" }> => item.kind === "chuan");

  // ---------- 右栏 / 抽屉 ----------
  const scorePanel = (
    <section className="gjs-panel gjs-score" data-tutorial="score">
      <div className="gjs-score-head">第 <b>{game.handNo}</b>/{game.config.hands} 盘</div>
      {([0, 1] as const).map((team) => (
        <div key={team} className={`gjs-team team-${team}`}>
          <img src={art.team(team)} alt="" width={48} height={48} />
          <span>
            <strong>{TEAM_NAMES[team]}联邦{mySeat >= 0 && teamOf(mySeat) === team ? "（你方）" : ""}</strong>
            <small>{[0, 1, 2, 3, 4, 5].filter((seat) => teamOf(seat) === team).map(nameOf).join("、")}</small>
          </span>
          <b>{signed(game.teamScores[team])}</b>
        </div>
      ))}
      {!spectating && me && playing && game.stage !== "handEnd" && (
        <button className="quiet-button" type="button" onClick={() => send({ type: "AUTO", on: !me.auto })}>{me.auto ? "取消托管" : "托管（人机代打）"}</button>
      )}
    </section>
  );
  const tabs = (
    <section className="gjs-panel gjs-tabs">
      <div className="gjs-tab-bar" role="tablist">
        <button type="button" role="tab" aria-selected={sideTab === "log"} className={sideTab === "log" ? "active" : ""} onClick={() => setSideTab("log")}>动作记录</button>
        <button type="button" role="tab" aria-selected={sideTab === "chat"} className={sideTab === "chat" ? "active" : ""} onClick={() => setSideTab("chat")}>
          聊天{unread > 0 && <em>{unread}</em>}
        </button>
      </div>
      {sideTab === "log" ? <ul className="gjs-log">{log.map((line) => <li key={line.key}>{line.text}</li>)}</ul> : <div className="gjs-chat">{chat}</div>}
    </section>
  );
  const side = (
    <aside className={["gjs-side", wide && !mobile ? "docked" : "drawer", drawer ? "open" : ""].filter(Boolean).join(" ")}>
      {spectating && <SpectateBar room={room} watchId={game.players[viewSeat]!.id} onWatch={onWatch} onLeave={onLeave} />}
      {scorePanel}
      {tabs}
      {!wide && <button className="quiet-button gjs-close" type="button" onClick={() => setDrawer(false)}>收起</button>}
    </aside>
  );

  const summary = game.stage === "handEnd" && game.result && playing && !hideSummary;
  const scene = theme === "day" ? art.sceneDay : art.sceneNight;

  return (
    <div className={["gj-screen", mobile ? "mobile" : "", wide && !mobile ? "wide" : ""].filter(Boolean).join(" ")}>
      <header className="gjt-topbar">
        {brand}
        <div className="gjt-round" data-tutorial="topbar-score">
          <span className="gjt-round-no">第 <b>{game.handNo}</b>/{game.config.hands} 盘</span>
          <span className="gjt-round-score">
            <i className="team-0">甲 {signed(game.teamScores[0])}</i>
            <i className="team-1">乙 {signed(game.teamScores[1])}</i>
          </span>
          {!mobile && <span className="gjt-round-stage">{STAGE_TITLES[game.stage]}</span>}
        </div>
        {mobile && (
          <button className="quiet-button gjt-menu-toggle" type="button" aria-expanded={menu} onClick={() => setMenu(!menu)}>菜单{unread > 0 ? ` · ${unread}` : ""}</button>
        )}
        <div className={menu ? "gjt-right open" : "gjt-right"} onClick={() => mobile && setMenu(false)}>
          {themeToggle}
          <GameRules />
          <GameRoomMenu room={room} />
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve}>解散</button>}
          {spectating && <button className="quiet-button" type="button" onClick={onLeave}>离开观战</button>}
          {(!wide || mobile) && (
            <button className="quiet-button" type="button" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>记录 / 聊天{unread > 0 ? ` · ${unread}` : ""}</button>
          )}
          {connection}
        </div>
      </header>

      <div className="gj-layout">
        <div
          ref={tableRef}
          className={["gj-table", mobile ? "mobile" : "", `hs-${layout.hs}`, `ps-${layout.ps}`, `as-${layout.as}`].join(" ")}
          style={{ "--scene": `url(${scene})`, "--scene-size": coverSize(tableBox.width, tableBox.height) } as CSSProperties}
        >
          <div className="gj-arena">
            {[4, 3, 2].map(seatCell)}
            {seatCell(5)}
            {centerInfo}
            {seatCell(1)}
            {tributePanel}
          </div>
          {coach}
          {mobile && game.stage === "playing" && <div className="gj-mine-play">{playArea(viewSeat)}</div>}
          {controlRow}
          {me && game.stage !== "handEnd" ? (
            <Hand hand={hand} picks={picks} layout={layout} dim={dim} onPick={pick} disabled={game.revolutionary === mySeat} />
          ) : mySeat < 0 ? (
            <div className="gj-hand gj-spectate-note">{room.access.spectatorsSeeAll ? "观战：能看到所有人的手牌（在名牌下）" : "观战：只看公开信息"}</div>
          ) : (
            <div className="gj-hand" />
          )}
          {game.revolutionary === mySeat && mySeat >= 0 && <div className="gj-hand-veil">你革命了：这盘不出牌，扣下的牌不公开</div>}
          {banner && mobile && bannerNode}
          {fxChuan.map((item) => (
            <div key={item.key} className="gj-chuan" role="status">
              <span className="gj-chuan-row">
                {[0, 450, 900].map((delay) => <Sprite key={delay} name="chuan" scale={mobile ? 1 : 2} delay={delay} />)}
              </span>
              <strong className={`team-${item.team}`}>{TEAM_NAMES[item.team]}联邦 串三户！</strong>
            </div>
          ))}
          {autoBanner}
        </div>
        {side}
      </div>

      {summary && <HandSummary game={game} nameOf={nameOf} mySeat={mySeat} busy={busy} onReady={() => send({ type: "READY" })} onHide={() => setHideSummary(true)} secondsLeft={secondsLeft} mobile={mobile} />}
      {game.stage === "handEnd" && hideSummary && playing && (
        <button className="primary-button gjd-show-summary" type="button" onClick={() => setHideSummary(false)}>看结算</button>
      )}
      {game.phase === "finished" && (
        <FinalDialog game={game} room={room} nameOf={nameOf} mySeat={mySeat} spectating={spectating} onRematch={onRematch} onLeave={onLeave} />
      )}
    </div>
  );
}

/** 下一盘的进贡预告（规则书 3.3）。 */
function tributePreview(game: GameState, nameOf: (seat: number) => string): string[] {
  const result = game.result;
  if (!result || !game.config.tribute || game.handNo >= game.config.hands) return [];
  const lines: string[] = [];
  for (const burn of result.burns) lines.push(`${nameOf(burn.victim)} → ${nameOf(burn.burner)} 烧贡 1 张`);
  if (result.sweep) {
    for (const seat of [0, 1, 2, 3, 4, 5].filter((s) => teamOf(s) !== result.sweepTeam)) lines.push(`${nameOf(seat)} → ${nameOf(oppOf(seat))} 串贡 1 张（要还）`);
  } else {
    const [first, second] = result.order;
    const last = result.order[5];
    const second2 = result.order[4];
    if (last !== undefined && first !== undefined) lines.push(`大落 ${nameOf(last)} → 头科 ${nameOf(first)} 落贡 2 张（要还）`);
    if (second2 !== undefined && second !== undefined) lines.push(`二落 ${nameOf(second2)} → 二科 ${nameOf(second)} 落贡 1 张（要还）`);
  }
  return lines;
}

function HandSummary({ game, nameOf, mySeat, busy, onReady, onHide, secondsLeft, mobile }: {
  readonly game: GameState;
  readonly nameOf: (seat: number) => string;
  readonly mySeat: number;
  readonly busy: boolean;
  readonly onReady: () => void;
  readonly onHide: () => void;
  readonly secondsLeft: number | null;
  readonly mobile: boolean;
}) {
  const result = game.result!;
  const ready = mySeat >= 0 && game.ready.includes(game.players[mySeat]!.id);
  const preview = tributePreview(game, nameOf);
  const rows = result.sweep ? [...result.order, ...[0, 1, 2, 3, 4, 5].filter((seat) => !result.order.includes(seat))] : result.order;
  return (
    <div className="gjd-modal" role="dialog" aria-label="一盘结算">
      <div className="gjd-dialog gm-panel" data-tutorial="summary">
        <h2>第 {result.handNo} 盘结束{result.sweep ? `：${TEAM_NAMES[result.sweepTeam!]}联邦串三户！` : ""}</h2>
        <div className="gjd-ribbons">
          {([0, 1] as const).map((team) => (
            <span key={team} className="gjd-ribbon" style={{ backgroundImage: `url(${art.ribbon(team)})` }}>
              {TEAM_NAMES[team]}联邦 {signed(result.teamDeltas[team])}
            </span>
          ))}
        </div>
        <ol className="gjd-places">
          {rows.map((seat) => {
            const place = result.places[seat];
            return (
              <li key={seat} className={seat === mySeat ? "mine" : ""}>
                {place !== null && place !== undefined ? <img src={art.rank(place)} alt={PLACE_NAMES[place]} width={mobile ? 36 : 72} height={mobile ? 20 : 40} /> : <span className="gjd-noplace">—</span>}
                <img src={art.team(teamOf(seat))} alt="" width={24} height={24} />
                <span className="gjd-place-name">{nameOf(seat)}{result.revolutionary === seat ? "（革命）" : ""}</span>
                <b>{signed(result.deltas[seat]!)}</b>
              </li>
            );
          })}
        </ol>
        {result.burns.length > 0 && <p className="gjd-sub">烧牌成功：{result.burns.map((burn) => `${nameOf(burn.burner)} 烧 ${nameOf(burn.victim)}`).join("，")}</p>}
        {preview.length > 0 && (
          <div className="gjd-sub">
            <strong>下一盘进贡：</strong>
            {preview.map((line) => <span key={line}>{line}</span>)}
          </div>
        )}
        <div className="gjd-actions">
          {mySeat >= 0 && (
            <button className="primary-button gjd-btn" type="button" disabled={busy || ready} onClick={onReady}>
              {ready ? `等其他人（${game.ready.length}/6）` : "下一盘"}{secondsLeft !== null ? ` ${secondsLeft}s` : ""}
            </button>
          )}
          <button className="quiet-button gjd-btn" type="button" onClick={onHide}>看牌桌</button>
        </div>
      </div>
    </div>
  );
}

function FinalDialog({ game, room, nameOf, mySeat, spectating, onRematch, onLeave }: {
  readonly game: GameState;
  readonly room: LobbyRoomSnapshot;
  readonly nameOf: (seat: number) => string;
  readonly mySeat: number;
  readonly spectating: boolean;
  readonly onRematch: (accept: boolean) => void;
  readonly onLeave: () => void;
}) {
  const final = game.finalResult!;
  const myTeam = mySeat >= 0 ? teamOf(mySeat) : null;
  const title = final.draw ? "平局" : myTeam === null ? `${TEAM_NAMES[final.winnerTeam!]}联邦赢了` : final.winnerTeam === myTeam ? "你方联邦赢了！" : `${TEAM_NAMES[final.winnerTeam!]}联邦赢了`;
  const accepted = room.rematch?.acceptedIds.includes(socket.id ?? "") ?? false;
  const result = game.result;
  return (
    <div className="gjd-modal" role="dialog" aria-label="一场结束">
      <div className="gjd-dialog gm-panel final" data-tutorial="final">
        <h2>{title}</h2>
        <p className="gjd-sub">打了 {game.config.hands} 盘{result?.sweep ? `，最后一盘${TEAM_NAMES[result.sweepTeam!]}联邦串三户` : ""}</p>
        <div className="gjd-ribbons">
          {([0, 1] as const).map((team) => (
            <span key={team} className={["gjd-ribbon", final.winnerTeam === team ? "win" : ""].join(" ")} style={{ backgroundImage: `url(${art.ribbon(team)})` }}>
              {TEAM_NAMES[team]}联邦 {signed(final.teamScores[team])}
            </span>
          ))}
        </div>
        <p className="gjd-sub">
          甲联邦：{[0, 2, 4].map(nameOf).join("、")}<br />乙联邦：{[1, 3, 5].map(nameOf).join("、")}
        </p>
        <div className="gjd-actions">
          {!spectating && room.rematch && (
            <button className="primary-button gjd-btn" type="button" disabled={accepted} onClick={() => onRematch(true)}>
              {accepted ? `等其他人（${room.rematch.acceptedIds.length}/${room.members.length}）` : "再来一局"}
            </button>
          )}
          <button className="quiet-button gjd-btn" type="button" onClick={onLeave}>{spectating ? "离开观战" : "离开房间"}</button>
        </div>
      </div>
    </div>
  );
}
