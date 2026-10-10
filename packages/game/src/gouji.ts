/**
 * 够级规则引擎。规则书：~/Desktop/游戏规则/够级.md；补充和勘误：够级-补充.md（第三节勘误 7 条照做）。
 *
 * 纯函数：applyGouji(state, playerId, command, rng?) 不改输入，返回新状态和事件。所有随机（首出、洗牌）都用状态里的种子随机数
 * （也可以从参数传 rng 进来，教程按剧本出数用）。
 * 一盘：洗牌发牌 → 进贡（第 2 盘起：队内贡吃 / 免 → 进贡到账 → 还贡）→ 革命 → 出牌 → 结算。一场打满 config.hands 盘。
 *
 * 烧牌是「轮外操作」：不用轮到自己。有头的人打出够级牌后（可能被烧），接下来的出牌、过牌生效、本轮结束都要等满
 * config.burnWindowMs（勘误 #3）。引擎没有时钟：这段时间里收到的出牌 / 过牌 / 烧牌先收下（只有本人看得到，不加 version），
 * 服务器在够级牌打出满 2 秒时发 TICK，引擎再按「烧牌优先、多人按从被烧的人下家起最近」结算。
 */
import { DECK_SIZE, isWild, rankOf, sortCards, BIG_JOKER, type Card } from "./cards.js";
import { createRng, type Rng } from "./rng.js";
import { beats, canBurnTail, leadMoves, beatingMoves, legalBurnLead, parseSet, setLabel, type PlaySet } from "./sets.js";
import {
  activeCount,
  burnOptions,
  canBurn,
  canRang,
  canRespond,
  isActive,
  nextActive,
  nextResponder,
  nextSeat,
  oppOf,
  SEAT_COUNT,
  SEATS,
  teamOf,
} from "./turn.js";
import {
  PLACE_POINTS,
  type GoujiCommand,
  type GoujiConfig,
  type GoujiEvent,
  type GoujiOptions,
  type GoujiPlayer,
  type GoujiState,
  type HandResult,
  type Place,
  type PlayOrPass,
  type PrivateView,
  type SystemCommand,
  type TributeItem,
} from "./types.js";

export const HISTORY_LIMIT = 120;
export const HAND_SIZE = 36;
/** 报牌、看牌的门槛：剩 10 张或以下（待确认 #8）。 */
export const REPORT_LIMIT = 10;

export const DEFAULT_OPTIONS: GoujiOptions = { hands: 5, tribute: true, rang: true, peek: true };

export function goujiConfig(options: Partial<GoujiOptions> = {}, overrides: Partial<GoujiConfig> = {}): GoujiConfig {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    playSec: 30,
    rangSec: 15,
    tributeSec: 10,
    returnSec: 20,
    revolutionSec: 10,
    handEndSec: 20,
    burnWindowMs: 2000,
    ...overrides,
  };
}

export interface NewPlayer {
  readonly id: string;
  readonly name: string;
  readonly bot?: boolean;
}

interface Ctx {
  readonly state: GoujiState;
  readonly rng: Rng;
  readonly events: GoujiEvent[];
  /** 这次操作只是先收下（烧牌窗口里的动作、同时决定阶段里的选择），别人看不到任何变化。 */
  queued: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}


/**
 * 复制一份状态用来改（applyGouji 不改输入）。事件、桌面上的每个动作、PlaySet、一盘的结果建好以后就不再改，
 * 所以直接共用；会改的部分（手牌、轮次、进贡、革命……）都复制一份。比 structuredClone 快十几倍（一盘几百步）。
 */
export function cloneState(source: GoujiState): GoujiState {
  const round = source.round;
  const tribute = source.tribute;
  const revolution = source.revolution;
  return {
    ...source,
    players: source.players.map((player) => ({ ...player, hand: [...player.hand] })),
    teamScores: [source.teamScores[0], source.teamScores[1]],
    revolutionHand: [...source.revolutionHand],
    finished: [...source.finished],
    goneThisRound: [...source.goneThisRound],
    headless: [...source.headless],
    round: round
      ? {
          ...round,
          top: round.top ? { ...round.top } : null,
          passed: [...round.passed],
          rang: round.rang ? { ...round.rang } : null,
          entries: [...round.entries],
          burnRequests: [...round.burnRequests],
        }
      : null,
    burn: source.burn ? { ...source.burn } : null,
    burnsThisHand: [...source.burnsThisHand],
    tribute: tribute
      ? {
          ...tribute,
          items: tribute.items.map((item) => ({ ...item, cards: [...item.cards], returned: item.returned ? [...item.returned] : null })),
          antiTribute: [...tribute.antiTribute],
        }
      : null,
    revolution: revolution ? { eligible: [...revolution.eligible], choices: [...revolution.choices] } : null,
    discard: [...source.discard],
    ready: [...source.ready],
    events: [...source.events],
    history: [...source.history],
  };
}

// ---------------------------------------------------------------------------
// 查询

/** 现在要做决定的座位（烧牌不算：它不用轮到）。 */
export function pendingSeats(state: GoujiState): number[] {
  if (state.phase === "finished") return [];
  switch (state.stage) {
    case "tribute":
      return [...new Set(state.tribute!.items.filter((item) => item.intra && item.eat === null).map((item) => item.receiver))];
    case "return":
      return [...new Set(state.tribute!.items.filter((item) => needsReturn(item) && item.returned === null).map((item) => item.receiver))];
    case "revolution":
      return SEATS.filter((seat) => state.revolution!.choices[seat] === null);
    case "handEnd":
      return SEATS.filter((seat) => !state.ready.includes(state.players[seat]!.id));
    case "playing":
      return state.turn >= 0 && state.round?.pending?.seat !== state.turn ? [state.turn] : [];
  }
}

/** 当前这一步的限时（秒）。 */
export function stepSeconds(state: GoujiState): number {
  const config = state.config;
  switch (state.stage) {
    case "tribute":
      return config.tributeSec;
    case "return":
      return config.returnSec;
    case "revolution":
      return config.revolutionSec;
    case "handEnd":
      return config.handEndSec;
    case "playing":
      return state.round?.rang?.returned && state.round.rang.seat === state.turn ? config.rangSec : config.playSec;
  }
}

/** 收了落贡 / 串贡（实际收到 ≥1 张）的人要还贡。 */
export const needsReturn = (item: TributeItem): boolean => item.kind !== "burn" && item.cards.length > 0;

/** 烧牌窗口的标识：有头的人打出的够级牌还没满 2 秒时有值，服务器据此发 TICK。 */
export function burnWindowKey(state: GoujiState): string | null {
  const top = state.round?.top;
  if (state.phase !== "playing" || state.stage !== "playing" || !top || !top.burnable || top.ready) return null;
  return `${state.handNo}:${state.redeals}:${top.seq}`;
}

/** 当前桌面牌的标识（人机按它决定每套牌只考虑一次烧不烧）。 */
export function topKey(state: GoujiState): string | null {
  const top = state.round?.top;
  return state.stage === "playing" && top ? `${state.handNo}:${state.redeals}:${top.seq}` : null;
}

// ---------------------------------------------------------------------------
// 开局

function blankPlayer(player: NewPlayer, seat: number): GoujiPlayer {
  return { id: player.id, name: player.name, bot: player.bot === true, team: teamOf(seat), auto: false, timeouts: 0, score: 0, handDelta: 0, hand: [], handCount: 0 };
}

/** players 按座位顺序给 6 个（下标就是座位：选座就是选队）。 */
export function createGouji(players: readonly NewPlayer[], seed: number, options: Partial<GoujiOptions> = {}, overrides: Partial<GoujiConfig> = {}): GoujiState {
  if (players.length !== SEAT_COUNT) throw new Error("够级需要 6 个座位。");
  const state: GoujiState = {
    config: goujiConfig(options, overrides),
    phase: "playing",
    stage: "playing",
    handNo: 0,
    redeals: 0,
    players: players.map(blankPlayer),
    teamScores: [0, 0],
    turn: -1,
    firstLeader: 0,
    revolutionary: null,
    revolutionHand: [],
    finished: [],
    goneThisRound: [],
    headless: [false, false, false, false, false, false],
    chaos: false,
    round: null,
    lastRound: null,
    burn: null,
    burnsThisHand: [],
    tribute: null,
    revolution: null,
    prevResult: null,
    result: null,
    discard: [],
    ready: [],
    playSeq: 0,
    events: [],
    history: [],
    version: 0,
    step: 0,
    seed,
  };
  const ctx: Ctx = { state, rng: createRng(seed), events: [], queued: false };
  startHand(ctx);
  return finish(ctx, null);
}

function startHand(ctx: Ctx): void {
  const { state, rng } = ctx;
  state.handNo += 1;
  state.redeals = 0;
  state.ready = [];
  state.result = null;
  for (const player of state.players) player.handDelta = 0;
  const prev = state.prevResult;
  // 3.5：第 1 盘随机；之后上一盘的大落先出，串三户时头科的对头先出（待确认 #6）。
  state.firstLeader = !prev ? rng.int(SEAT_COUNT) : prev.sweep ? oppOf(prev.order[0]!) : prev.order[5]!;
  ctx.events.push({ type: "HandStarted", handNo: state.handNo, firstLeader: state.firstLeader });
  deal(ctx, state.config.tribute && prev !== null);
}

function resetHand(state: GoujiState): void {
  state.revolutionary = null;
  state.revolutionHand = [];
  state.finished = [];
  state.goneThisRound = [];
  state.headless = [false, false, false, false, false, false];
  state.chaos = false;
  state.round = null;
  state.lastRound = null;
  state.burn = null;
  state.burnsThisHand = [];
  state.tribute = null;
  state.revolution = null;
  state.discard = [];
  state.playSeq = 0;
  state.turn = -1;
}

/** 洗牌发牌（每人 36 张），然后进贡或直接看革命。deck 给了就按它发（前 36 张给座位 0，依次类推）。 */
function deal(ctx: Ctx, withTribute: boolean, deck?: readonly Card[]): void {
  const { state, rng } = ctx;
  resetHand(state);
  const cards = deck ? [...deck] : rng.shuffle(Array.from({ length: DECK_SIZE }, (_, card) => card));
  SEATS.forEach((seat) => {
    state.players[seat]!.hand = sortCards(cards.slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE));
  });
  ctx.events.push({ type: "Dealt", redeal: state.redeals });
  if (withTribute) setupTribute(ctx);
  else afterTribute(ctx);
}

/**
 * 测试和预览用：按指定牌序重新发这一盘（前 36 张给座位 0，接着 1…5），然后照常进贡 / 革命。
 * 要在这一盘还没开始出牌时调用（刚开局或刚进入下一盘）。
 */
export function stackDeal(state: GoujiState, deck: readonly Card[]): GoujiState {
  if (deck.length !== DECK_SIZE || new Set(deck).size !== DECK_SIZE || deck.some((card) => card < 0 || card >= DECK_SIZE)) {
    throw new Error("牌序要正好 216 张不重复的牌。");
  }
  const next = cloneState(state);
  delete next.you;
  const ctx: Ctx = { state: next, rng: createRng(next.rng ?? 1), events: [], queued: false };
  deal(ctx, next.config.tribute && next.prevResult !== null && next.redeals === 0, deck);
  return finish(ctx, null);
}

// ---------------------------------------------------------------------------
// 进贡（3.3，勘误 #2：先定下所有队内贡的吃 / 免，再算每个人具体进哪几张）

function setupTribute(ctx: Ctx): void {
  const { state } = ctx;
  const prev = state.prevResult!;
  type Draft = Omit<TributeItem, "intra" | "eat" | "cards" | "returned">;
  const drafts: Draft[] = prev.burns.map((burn) => ({ kind: "burn", giver: burn.victim, receiver: burn.burner, count: 1 }));
  const main: Draft[] = prev.sweep
    ? SEATS.filter((seat) => teamOf(seat) !== prev.sweepTeam).map((seat) => ({ kind: "chuan", giver: seat, receiver: oppOf(seat), count: 1 }))
    : [
        { kind: "luo", giver: prev.order[5]!, receiver: prev.order[0]!, count: 2 },
        { kind: "luo", giver: prev.order[4]!, receiver: prev.order[1]!, count: 1 },
      ];
  // 抗贡：发到全部 4 张大王的人不进落贡和串贡（烧贡照进）。
  const antiTribute: number[] = [];
  for (const draft of main) {
    const bigs = state.players[draft.giver]!.hand.filter((card) => rankOf(card) === BIG_JOKER).length;
    if (bigs >= 4) {
      if (!antiTribute.includes(draft.giver)) antiTribute.push(draft.giver);
      continue;
    }
    drafts.push(draft);
  }
  for (const seat of antiTribute) ctx.events.push({ type: "AntiTribute", seat });
  const items: TributeItem[] = drafts.map((draft) => {
    const intra = teamOf(draft.giver) === teamOf(draft.receiver);
    return { ...draft, intra, eat: intra ? null : true, cards: [], returned: null };
  });
  state.tribute = { items, antiTribute, paid: false };
  if (items.some((item) => item.eat === null)) {
    state.stage = "tribute";
    state.turn = -1;
    state.step += 1;
    return;
  }
  payTribute(ctx);
}

/** 队内贡：收的人选吃贡或免贡。 */
function chooseTribute(ctx: Ctx, seat: number, eat: boolean, index: number | undefined): void {
  const { state } = ctx;
  if (state.stage !== "tribute" || !state.tribute) fail("现在不是选吃贡、免贡的时候。");
  const items = state.tribute.items;
  const position = index === undefined ? items.findIndex((item) => item.receiver === seat && item.intra && item.eat === null) : index;
  const item = items[position];
  if (!item || item.receiver !== seat || !item.intra || item.eat !== null) fail("没有要你选吃贡、免贡的贡。");
  item.eat = eat === true;
  ctx.queued = true;
  if (items.some((other) => other.eat === null)) return;
  payTribute(ctx);
}

/** 所有吃 / 免都定了：每个进贡的人从自己发到的牌里，按大王 → 小王 → 2 的顺序进，牌同时到账。 */
function payTribute(ctx: Ctx): void {
  const { state } = ctx;
  const tribute = state.tribute!;
  const pools = new Map<number, Card[]>();
  const poolOf = (seat: number) => {
    if (!pools.has(seat)) pools.set(seat, sortCards(state.players[seat]!.hand.filter(isWild)));
    return pools.get(seat)!;
  };
  for (const item of tribute.items) {
    if (item.intra) ctx.events.push({ type: "TributeChosen", giver: item.giver, receiver: item.receiver, kind: item.kind, eat: item.eat === true });
    item.cards = item.eat ? poolOf(item.giver).splice(0, item.count) : [];
  }
  for (const item of tribute.items) {
    if (!item.eat) continue;
    const moving = new Set(item.cards);
    const giver = state.players[item.giver]!;
    giver.hand = giver.hand.filter((card) => !moving.has(card));
    const receiver = state.players[item.receiver]!;
    receiver.hand = sortCards([...receiver.hand, ...item.cards]);
    ctx.events.push({ type: "TributePaid", giver: item.giver, receiver: item.receiver, kind: item.kind, count: item.count, cards: [...item.cards] });
  }
  tribute.paid = true;
  if (tribute.items.some(needsReturn)) {
    state.stage = "return";
    state.turn = -1;
    state.step += 1;
    return;
  }
  afterTribute(ctx);
}

/** 还贡：从手里挑实际收到的张数的任意牌（包括刚收到的贡牌，待确认 #5）。大家都选好了同时到账、公开。 */
function returnTribute(ctx: Ctx, seat: number, cards: readonly Card[]): void {
  const { state } = ctx;
  if (state.stage !== "return" || !state.tribute) fail("现在不是还贡的时候。");
  const item = state.tribute.items.find((candidate) => candidate.receiver === seat && needsReturn(candidate) && candidate.returned === null);
  if (!item) fail("你不用还贡，或者已经还过了。");
  const chosen = checkOwned(state.players[seat]!.hand, cards);
  if (chosen.length !== item.cards.length) fail(`要还 ${item.cards.length} 张牌。`);
  item.returned = sortCards(chosen);
  ctx.queued = true;
  if (state.tribute.items.some((other) => needsReturn(other) && other.returned === null)) return;
  for (const other of state.tribute.items) {
    if (!needsReturn(other)) continue;
    const moving = new Set(other.returned!);
    const receiver = state.players[other.receiver]!;
    receiver.hand = receiver.hand.filter((card) => !moving.has(card));
    const giver = state.players[other.giver]!;
    giver.hand = sortCards([...giver.hand, ...other.returned!]);
    ctx.events.push({ type: "TributeReturned", from: other.receiver, to: other.giver, cards: [...other.returned!] });
  }
  afterTribute(ctx);
}

// ---------------------------------------------------------------------------
// 革命（3.4）

/**
 * 进贡还贡完成后**每盘都进革命阶段**，6 个座位都要表态：手里没王没 2 的人选革命 / 不革命，其他人只能选「不革命」（界面上是「继续」）。
 * 所有人都表态了（或者超时）才结束——阶段出不出现、什么时候结束都和谁能革命无关，不然一出现革命阶段大家就知道有人一张配牌都没有。
 */
function afterTribute(ctx: Ctx): void {
  const { state } = ctx;
  const eligible = SEATS.filter((seat) => state.players[seat]!.hand.length > 0 && !state.players[seat]!.hand.some(isWild));
  state.revolution = { eligible, choices: [null, null, null, null, null, null] };
  state.stage = "revolution";
  state.turn = -1;
  state.step += 1;
}

function chooseRevolt(ctx: Ctx, seat: number, revolt: boolean): void {
  const { state } = ctx;
  const revolution = state.revolution;
  if (state.stage !== "revolution" || !revolution) fail("现在不是选革命的时候。");
  if (revolt === true && !revolution.eligible.includes(seat)) fail("手里有王或 2，不能革命。");
  if (revolution.choices[seat] !== null) fail("你已经选过了。");
  revolution.choices[seat] = revolt === true;
  ctx.queued = true;
  if (revolution.choices.some((choice) => choice === null)) return;
  const revolters = revolution.eligible.filter((other) => revolution.choices[other] === true);
  state.revolution = null;
  if (revolters.length >= 2) {
    // 这盘作废：重新洗牌发牌，不进贡，盘数不加，首出的人不变。
    ctx.events.push({ type: "RevolutionRedeal", seats: revolters });
    state.redeals += 1;
    deal(ctx, false);
    return;
  }
  if (revolters.length === 1) {
    const rebel = revolters[0]!;
    state.revolutionary = rebel;
    state.revolutionHand = state.players[rebel]!.hand;
    state.players[rebel]!.hand = [];
    state.headless[oppOf(rebel)] = true;
    ctx.events.push({ type: "Revolted", seat: rebel }, { type: "Headless", seats: [oppOf(rebel)] });
  }
  startPlay(ctx);
}

// ---------------------------------------------------------------------------
// 出牌

function startPlay(ctx: Ctx): void {
  const { state } = ctx;
  const leader = isActive(state, state.firstLeader) ? state.firstLeader : nextActive(state, state.firstLeader);
  state.stage = "playing";
  ctx.events.push({ type: "FirstLead", seat: leader });
  newRound(ctx, leader);
}

function newRound(ctx: Ctx, leader: number): void {
  ctx.state.round = { leader, top: null, passed: [], rang: null, entries: [], pending: null, burnRequests: [] };
  setTurn(ctx, leader);
}

function setTurn(ctx: Ctx, seat: number): void {
  ctx.state.turn = seat;
  ctx.state.step += 1;
}

/** 牌都在手里、不重复，返回排好的牌。 */
function checkOwned(hand: readonly Card[], cards: readonly Card[]): Card[] {
  if (!Array.isArray(cards) || cards.length === 0) fail("请选要出的牌。");
  if (cards.some((card) => !Number.isInteger(card)) || new Set(cards).size !== cards.length) fail("这些牌不对。");
  const own = new Set(hand);
  if (cards.some((card) => !own.has(card))) fail("这些牌不在你手里。");
  return sortCards(cards);
}

function requirePlayTurn(state: GoujiState, seat: number): void {
  if (state.stage !== "playing" || !state.round) fail("现在不是出牌的时候。");
  if (state.turn !== seat) fail("还没轮到你。");
  if (state.round.pending?.seat === seat) fail("已经选好了，等够级牌满 2 秒后生效。");
}

function playCommand(ctx: Ctx, seat: number, raw: readonly Card[], auto: boolean): void {
  const { state } = ctx;
  requirePlayTurn(state, seat);
  const round = state.round!;
  const hand = state.players[seat]!.hand;
  const cards = checkOwned(hand, raw);
  const set = parseSet(cards);
  if (!set) fail("这几张牌不是合法的一套：只能出同点数的牌加 2 和王，或者纯 2 加王，或者纯王。");
  const top = round.top;
  if (top) {
    if (set.eff.length !== top.set.eff.length) fail(`张数要和桌面上的一样（${top.set.eff.length} 张）。`);
    if (!beats(set, top.set)) fail("压不住：两套牌从大到小逐张比，每一张都要更大。");
  } else if (state.burn?.burner === seat && !legalBurnLead(hand, cards)) {
    fail("烧牌中发牌：要么一次出完，要么挂王、并且剩下的牌还能每套都挂王出完。");
  }
  if (top && top.burnable && !top.ready) {
    round.pending = { seat, command: { type: "PLAY", cards }, ...(auto ? { auto: true } : {}) };
    ctx.queued = true;
    return;
  }
  doPlay(ctx, seat, cards, set, false, auto);
}

function passCommand(ctx: Ctx, seat: number, auto: boolean): void {
  const { state } = ctx;
  requirePlayTurn(state, seat);
  const round = state.round!;
  const top = round.top;
  if (!top) fail("该你发牌了，发牌不能过。");
  if (top.burnable && !top.ready) {
    round.pending = { seat, command: { type: "PASS" }, ...(auto ? { auto: true } : {}) };
    ctx.queued = true;
    return;
  }
  doPass(ctx, seat, auto);
}

function rangCommand(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  if (!canRang(state, seat)) fail("现在不能让牌：只有对头出的不是够级牌、轮到你时才能让。");
  const round = state.round!;
  round.rang = { seat, returned: false };
  round.entries.push({ seat, kind: "rang" });
  ctx.events.push({ type: "Rang", seat });
  rangAdvance(ctx, seat);
}

/** 让牌后先轮让牌人的下家、下下家（有资格的才轮到），他们都没上牌就回到让牌的人。 */
function rangAdvance(ctx: Ctx, from: number): void {
  const { state } = ctx;
  const rang = state.round!.rang!;
  const order = [nextSeat(rang.seat), nextSeat(nextSeat(rang.seat))];
  const start = from === rang.seat ? 0 : order.indexOf(from) + 1;
  for (const seat of order.slice(start)) {
    if (canRespond(state, seat)) {
      setTurn(ctx, seat);
      return;
    }
  }
  rang.returned = true;
  setTurn(ctx, rang.seat);
}

function doPass(ctx: Ctx, seat: number, auto: boolean): void {
  const { state } = ctx;
  const round = state.round!;
  round.entries.push({ seat, kind: "pass" });
  ctx.events.push({ type: "Passed", seat, ...(auto ? { auto } : {}) });
  if (!round.passed.includes(seat)) round.passed.push(seat);
  const rang = round.rang;
  if (rang) {
    if (seat !== rang.seat) {
      rangAdvance(ctx, seat);
      return;
    }
    round.rang = null;
  }
  advance(ctx, seat);
}

function doPlay(ctx: Ctx, seat: number, cards: Card[], set: PlaySet, burn: boolean, auto: boolean): void {
  const { state } = ctx;
  const round = state.round!;
  const player = state.players[seat]!;
  const used = new Set(cards);
  player.hand = player.hand.filter((card) => !used.has(card));
  state.discard.push(...cards);
  const prevTop = round.top;
  // 4.6 (4) 第 2 条：烧牌的人的任何一套牌被压住，烧牌就失败（解烧；被烧的人反过来烧住是反烧）。
  if (state.burn && prevTop && prevTop.seat === state.burn.burner && seat !== state.burn.burner) {
    ctx.events.push({ type: "BurnBroken", burner: state.burn.burner, victim: state.burn.victim, by: seat, counter: seat === state.burn.victim });
    state.burn = null;
  }
  if (burn) {
    state.burn = { burner: seat, victim: prevTop!.seat };
    ctx.events.push({ type: "BurnStarted", burner: seat, victim: prevTop!.seat });
  }
  if (round.rang) {
    // 4.7：让牌后下家或下下家上了牌，让牌的人算过牌（待确认 #2）。
    if (round.rang.seat !== seat && !round.passed.includes(round.rang.seat)) round.passed.push(round.rang.seat);
    round.rang = null;
  }
  // 4.10：四人乱缠里过牌不锁，有人上牌后大家又能接。
  if (state.chaos) round.passed = [];
  const burnable = set.gouji && !state.chaos && !state.headless[seat];
  state.playSeq += 1;
  round.top = { seq: state.playSeq, seat, cards, set, burnable, ready: !burnable, burn };
  round.pending = null;
  round.burnRequests = [];
  round.entries.push({ seat, kind: "play", cards, set, burn });
  const left = player.hand.length;
  ctx.events.push({ type: "Played", seat, cards: [...cards], label: setLabel(set), gouji: set.gouji, lead: prevTop === null, left: left <= REPORT_LIMIT ? left : null, ...(auto ? { auto } : {}) });
  if (left === 0 && goOut(ctx, seat)) return;
  advance(ctx, seat);
}

/** 轮到下一个有资格接牌的人；没人了就结束这一轮（够级牌没满 2 秒时先等 TICK）。 */
function advance(ctx: Ctx, from: number): void {
  const { state } = ctx;
  const next = nextResponder(state, from);
  if (next !== null) {
    setTurn(ctx, next);
    return;
  }
  const top = state.round!.top!;
  if (top.burnable && !top.ready) {
    state.turn = -1;
    state.step += 1;
    return;
  }
  endRound(ctx);
}

/** 4.8、4.9、4.10：一轮结束。这一轮走科的人的对头变成无头；累计走科 ≥2 人进入四人乱缠；赢的人走科了由下一个在打的人接风。 */
function endRound(ctx: Ctx): void {
  const { state } = ctx;
  const round = state.round!;
  const winner = round.top!.seat;
  state.lastRound = { entries: round.entries, winner };
  const newlyHeadless: number[] = [];
  for (const gone of state.goneThisRound) {
    const opp = oppOf(gone);
    if (!state.headless[opp]) {
      state.headless[opp] = true;
      if (isActive(state, opp)) newlyHeadless.push(opp);
    }
  }
  state.goneThisRound = [];
  if (newlyHeadless.length > 0) ctx.events.push({ type: "Headless", seats: newlyHeadless });
  if (!state.chaos && state.finished.length >= 2) {
    state.chaos = true;
    ctx.events.push({ type: "ChaosStarted" });
  }
  const leader = isActive(state, winner) ? winner : nextActive(state, winner);
  ctx.events.push({ type: "RoundEnded", winner, leader, jiefeng: leader !== winner });
  newRound(ctx, leader);
}

/** 走科。返回这一盘是否就此结束（串三户，或者只剩 1 个人在打）。 */
function goOut(ctx: Ctx, seat: number): boolean {
  const { state } = ctx;
  state.finished.push(seat);
  state.goneThisRound.push(seat);
  ctx.events.push({ type: "WentOut", seat, order: state.finished.length - 1 });
  if (state.burn?.burner === seat) {
    ctx.events.push({ type: "BurnSucceeded", burner: seat, victim: state.burn.victim });
    state.burnsThisHand.push(state.burn);
    state.burn = null;
  }
  const sweep = sweepTeam(state);
  if (sweep !== null) {
    endHand(ctx, sweep);
    return true;
  }
  if (activeCount(state) <= 1) {
    endHand(ctx, null);
    return true;
  }
  return false;
}

/** 7.1：一队拿下头科、二科、三科（革命者的两个队友拿了头科、二科时他补成三科）。 */
function sweepTeam(state: GoujiState): 0 | 1 | null {
  const [first, second, third] = state.finished;
  const rebel = state.revolutionary;
  if (first === undefined || second === undefined) return null;
  if (rebel !== null && teamOf(first) === teamOf(rebel) && teamOf(second) === teamOf(rebel)) return teamOf(rebel);
  if (third !== undefined && teamOf(first) === teamOf(second) && teamOf(second) === teamOf(third)) return teamOf(first);
  return null;
}

/** 名次顺序：串三户只有前三名；否则走科顺序 + 革命者（四科）+ 最后剩下的人（大落）。 */
function placeOrder(state: GoujiState, sweep: 0 | 1 | null): number[] {
  const finished = state.finished;
  const rebel = state.revolutionary;
  if (sweep !== null) {
    return rebel !== null && teamOf(rebel) === sweep && finished.length === 2 ? [finished[0]!, finished[1]!, rebel] : finished.slice(0, 3);
  }
  const last = SEATS.filter((seat) => isActive(state, seat));
  if (rebel === null) return [...finished, ...last];
  return [...finished.slice(0, 3), rebel, ...finished.slice(3), ...last];
}

function endHand(ctx: Ctx, sweep: 0 | 1 | null): void {
  const { state } = ctx;
  const order = placeOrder(state, sweep);
  const places: (Place | null)[] = [null, null, null, null, null, null];
  order.forEach((seat, place) => {
    places[seat] = place as Place;
  });
  const teamDeltas: [number, number] = [0, 0];
  if (sweep !== null) {
    teamDeltas[sweep] = 12;
    teamDeltas[1 - sweep] = -12;
  } else {
    order.forEach((seat, place) => {
      teamDeltas[teamOf(seat)] += PLACE_POINTS[place]!;
    });
  }
  const deltas = SEATS.map((seat) => teamDeltas[teamOf(seat)]);
  SEATS.forEach((seat) => {
    const player = state.players[seat]!;
    player.handDelta = deltas[seat]!;
    player.score += deltas[seat]!;
  });
  state.teamScores = [state.teamScores[0] + teamDeltas[0], state.teamScores[1] + teamDeltas[1]];
  const result: HandResult = {
    handNo: state.handNo,
    sweep: sweep !== null,
    sweepTeam: sweep,
    order,
    places,
    revolutionary: state.revolutionary,
    burns: [...state.burnsThisHand],
    teamDeltas,
    deltas,
  };
  state.result = result;
  state.prevResult = result;
  state.burn = null;
  if (state.round) {
    state.round.pending = null;
    state.round.burnRequests = [];
  }
  state.stage = "handEnd";
  state.turn = -1;
  state.ready = [];
  state.step += 1;
  ctx.events.push({ type: "HandEnded", handNo: state.handNo, result });
  if (state.handNo >= state.config.hands) finishGame(ctx);
}

function finishGame(ctx: Ctx): void {
  const { state } = ctx;
  const [a, b] = state.teamScores;
  const winnerTeam: 0 | 1 | null = a > b ? 0 : b > a ? 1 : null;
  const winners = state.players.filter((_, seat) => winnerTeam === null || teamOf(seat) === winnerTeam).map((player) => player.id);
  state.phase = "finished";
  state.finalResult = { winnerTeam, winners, draw: winnerTeam === null, teamScores: [a, b] };
  ctx.events.push({ type: "GameEnded", winnerTeam });
}

function markReady(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  if (state.stage !== "handEnd") fail("现在不是结算画面。");
  if (state.phase === "finished") fail("这一场已经结束了。");
  const id = state.players[seat]!.id;
  if (!state.ready.includes(id)) state.ready.push(id);
  if (state.ready.length === SEAT_COUNT) startHand(ctx);
}

// ---------------------------------------------------------------------------
// 烧牌（4.6）

/** 检查 cards 是合法的 S₁：在手里、是一套牌、压得住桌面牌、剩下的牌能步步带王。 */
function checkBurnCards(state: GoujiState, seat: number, raw: readonly Card[]): { cards: Card[]; set: PlaySet } {
  const hand = state.players[seat]!.hand;
  const cards = checkOwned(hand, raw);
  const set = parseSet(cards);
  const top = state.round!.top!;
  if (!set || !beats(set, top.set)) fail("烧牌的第一套要压得住桌面上的够级牌。");
  const used = new Set(cards);
  if (!canBurnTail(hand.filter((card) => !used.has(card)))) fail("这样烧，剩下的牌没法每套都挂王出完。");
  return { cards, set };
}

function burnCommand(ctx: Ctx, seat: number, raw: readonly Card[]): void {
  const { state } = ctx;
  if (state.stage !== "playing" || !state.round?.top) fail("现在没有可以烧的牌。");
  if (!canBurn(state, seat)) fail("现在不能烧牌。");
  const round = state.round;
  const { cards, set } = checkBurnCards(state, seat, raw);
  if (!round.top!.ready) {
    round.burnRequests = [...round.burnRequests.filter((request) => request.seat !== seat), { seat, cards }];
    ctx.queued = true;
    return;
  }
  doPlay(ctx, seat, cards, set, true, false);
}

/** 烧牌窗口满 2 秒：先结算烧牌（多人按从被烧的人下家起最近），再让先收下的出牌 / 过牌生效，没人能接就结束这一轮。 */
function tick(ctx: Ctx): void {
  const { state } = ctx;
  const round = state.round;
  const top = round?.top;
  if (state.stage !== "playing" || !round || !top || !top.burnable || top.ready) {
    ctx.queued = true; // 没有等着的窗口：什么都不变
    return;
  }
  top.ready = true;
  const requests = [...round.burnRequests].sort((a, b) => (a.seat - top.seat + SEAT_COUNT) % SEAT_COUNT - (b.seat - top.seat + SEAT_COUNT) % SEAT_COUNT);
  round.burnRequests = [];
  for (const request of requests) {
    if (!canBurn(state, request.seat)) continue;
    try {
      const { cards, set } = checkBurnCards(state, request.seat, request.cards);
      doPlay(ctx, request.seat, cards, set, true, false);
      return;
    } catch {
      // 这份请求已经不合法了，看下一个。
    }
  }
  const pending = round.pending;
  round.pending = null;
  if (pending) {
    if (pending.auto) ctx.events.push({ type: "TimedOut", seat: pending.seat });
    if (pending.command.type === "PLAY") doPlay(ctx, pending.seat, [...pending.command.cards], parseSet(pending.command.cards)!, false, pending.auto === true);
    else doPass(ctx, pending.seat, pending.auto === true);
    return;
  }
  if (state.turn === -1) endRound(ctx);
}

// ---------------------------------------------------------------------------
// 操作入口

export function applyGouji(
  input: GoujiState,
  playerId: string,
  command: GoujiCommand | SystemCommand,
  rng?: Rng,
): { state: GoujiState; events: GoujiEvent[] } {
  if (!command || typeof command !== "object" || typeof command.type !== "string") fail("不认识的操作。");
  if (input.phase === "finished" && command.type !== "AUTO") fail("对局已经结束。");
  const state = cloneState(input);
  delete state.you;
  const ctx: Ctx = { state, rng: rng ?? createRng(state.rng ?? 1), events: [], queued: false };
  if (command.type === "TIMEOUT") {
    timeoutAll(ctx, command.seats);
    return { state: finish(ctx, input), events: ctx.events };
  }
  if (command.type === "TICK") {
    tick(ctx);
    return { state: finish(ctx, input), events: ctx.events };
  }
  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat < 0) fail("你不在这局里。");
  act(ctx, seat, command, false);
  // 烧牌、革命表态不清零连续超时（革命阶段人人都要表态，清不清零都不能和谁能革命扯上关系）
  if (command.type !== "AUTO" && command.type !== "BURN" && command.type !== "REVOLT") state.players[seat]!.timeouts = 0;
  return { state: finish(ctx, input), events: ctx.events };
}

function act(ctx: Ctx, seat: number, command: GoujiCommand, auto: boolean): void {
  switch (command?.type) {
    case "PLAY":
      return playCommand(ctx, seat, command.cards, auto);
    case "PASS":
      return passCommand(ctx, seat, auto);
    case "RANG":
      return rangCommand(ctx, seat);
    case "BURN":
      return burnCommand(ctx, seat, command.cards);
    case "TRIBUTE":
      return chooseTribute(ctx, seat, command.eat, command.item);
    case "RETURN":
      return returnTribute(ctx, seat, command.cards);
    case "REVOLT":
      return chooseRevolt(ctx, seat, command.revolt);
    case "READY":
      return markReady(ctx, seat);
    case "AUTO":
      return setAuto(ctx, seat, command.on === true);
    default:
      fail("不认识的操作。");
  }
}

function setAuto(ctx: Ctx, seat: number, on: boolean): void {
  const player = ctx.state.players[seat]!;
  if (player.auto === on) return;
  player.auto = on;
  player.timeouts = 0;
  ctx.events.push({ type: "AutoChanged", seat, on });
}

// ---------------------------------------------------------------------------
// 超时（9.5）

/** 最小的一张普通牌；没有普通牌就出最小的一张。 */
function smallestSingle(hand: readonly Card[]): Card {
  return hand[hand.length - 1]!; // 手牌从大到小排，最后一张就是最小的（普通牌都比配牌小）
}

/** 烧牌状态下发牌超时：出程序找到的一个合法出法，优先挂王最少的一套（整手是一套就全出）。 */
export function burnLeadDefault(hand: readonly Card[]): Card[] {
  if (parseSet(hand)) return sortCards(hand);
  // 最小的一整组普通牌 + 1 张王（优先小王）：剩下的牌少一种点数、少一张王，仍然满足 J ≥ m − 1
  const lowest = Math.min(...hand.map(rankOf).filter((rank) => rank <= 14));
  const joker = hand.find((card) => rankOf(card) === 16) ?? hand.find((card) => rankOf(card) === 17);
  if (Number.isFinite(lowest) && joker !== undefined) {
    const cards = sortCards([...hand.filter((card) => rankOf(card) === lowest), joker]);
    if (legalBurnLead(hand, cards)) return cards;
  }
  const moves = leadMoves(hand, true);
  const jokers = (cards: Card[]) => cards.filter((card) => rankOf(card) >= 16).length;
  moves.sort((a, b) => jokers(a) - jokers(b) || rankOf(a[a.length - 1]!) - rankOf(b[b.length - 1]!));
  return moves[0] ?? [smallestSingle(hand)];
}

export function timeoutCommand(state: GoujiState, seat: number): GoujiCommand {
  const hand = state.players[seat]!.hand;
  switch (state.stage) {
    case "tribute":
      return { type: "TRIBUTE", eat: true };
    case "return": {
      const item = state.tribute!.items.find((candidate) => candidate.receiver === seat && needsReturn(candidate) && candidate.returned === null);
      return { type: "RETURN", cards: hand.slice(hand.length - (item?.cards.length ?? 1)) };
    }
    case "revolution":
      return { type: "REVOLT", revolt: false };
    case "handEnd":
      return { type: "READY" };
    case "playing":
      if (state.round?.top) return { type: "PASS" };
      if (state.burn?.burner === seat) return { type: "PLAY", cards: burnLeadDefault(hand) };
      return { type: "PLAY", cards: [smallestSingle(hand)] };
  }
}

/** 给 seats（不给就是所有还没决定的人）套用默认动作；连续超时 2 次转托管（革命、结算不算，免得暴露谁能革命）。 */
function timeoutAll(ctx: Ctx, seats?: readonly number[]): void {
  const { state } = ctx;
  let anyQueued = false;
  for (const seat of seats ?? pendingSeats(state)) {
    if (state.phase === "finished") return;
    if (!pendingSeats(state).includes(seat)) continue;
    const stage = state.stage;
    const command = timeoutCommand(state, seat);
    const hidden = stage === "revolution";
    const eventsBefore = ctx.events.length;
    ctx.queued = false;
    act(ctx, seat, command, true);
    // 一个人有两份队内贡要选时，超时一次把他的都定成吃贡
    for (let guard = 0; stage === "tribute" && state.stage === "tribute" && pendingSeats(state).includes(seat) && guard < 4; guard += 1) {
      act(ctx, seat, timeoutCommand(state, seat), true);
    }
    const queuedOnly = ctx.queued && ctx.events.length === eventsBefore;
    anyQueued ||= ctx.queued;
    // 先收下的动作（烧牌窗口里、同时决定的阶段）生效时才公开；革命的超时不公开。
    if (!hidden && !queuedOnly) ctx.events.splice(eventsBefore, 0, { type: "TimedOut", seat });
    if (stage !== "handEnd" && stage !== "revolution") {
      const player = state.players[seat]!;
      player.timeouts += 1;
      if (player.timeouts >= 2 && !player.auto && !player.bot) setAuto(ctx, seat, true);
    }
  }
  ctx.queued = anyQueued;
}

// ---------------------------------------------------------------------------

/**
 * 这位玩家现在能发的操作（测试、随机对局、调试牌桌、占位人机用）。出牌每种形状给一种出法；
 * 还贡只给两种代表性的选法（最小的几张、最大的几张）；烧牌给每个候选 S₁。
 * 可以用在 redactGameForViewer 之后的视图上（只用到自己的手牌和公开信息）。
 */
export function legalCommands(state: GoujiState, playerId: string): GoujiCommand[] {
  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat < 0 || state.phase === "finished") return [];
  const hand = state.players[seat]!.hand;
  switch (state.stage) {
    case "tribute": {
      const index = state.tribute!.items.findIndex((item) => item.receiver === seat && item.intra && item.eat === null);
      return index < 0 ? [] : [{ type: "TRIBUTE", eat: true, item: index }, { type: "TRIBUTE", eat: false, item: index }];
    }
    case "return": {
      const item = state.tribute!.items.find((candidate) => candidate.receiver === seat && needsReturn(candidate) && candidate.returned === null);
      if (!item) return [];
      const n = item.cards.length;
      const options: GoujiCommand[] = [{ type: "RETURN", cards: hand.slice(hand.length - n) }];
      if (hand.length > n) options.push({ type: "RETURN", cards: hand.slice(0, n) });
      return options;
    }
    case "revolution": {
      const revolution = state.revolution!;
      if (revolution.choices[seat] !== null) return [];
      return revolution.eligible.includes(seat) ? [{ type: "REVOLT", revolt: true }, { type: "REVOLT", revolt: false }] : [{ type: "REVOLT", revolt: false }];
    }
    case "handEnd":
      return state.ready.includes(playerId) ? [] : [{ type: "READY" }];
    case "playing": {
      const round = state.round;
      if (!round) return [];
      const commands: GoujiCommand[] = [];
      if (state.turn === seat && round.pending?.seat !== seat) {
        if (round.top) {
          commands.push({ type: "PASS" });
          for (const cards of beatingMoves(hand, round.top.set)) commands.push({ type: "PLAY", cards });
          if (canRang(state, seat)) commands.push({ type: "RANG" });
        } else {
          for (const cards of leadMoves(hand, state.burn?.burner === seat)) commands.push({ type: "PLAY", cards });
        }
      }
      if (!round.burnRequests.some((request) => request.seat === seat)) {
        for (const cards of burnOptions(state, seat)) commands.push({ type: "BURN", cards });
      }
      return commands;
    }
  }
}

function finish(ctx: Ctx, input: GoujiState | null): GoujiState {
  const { state } = ctx;
  for (const player of state.players) player.handCount = player.hand.length;
  state.rng = ctx.rng.state;
  if (input && ctx.queued && ctx.events.length === 0) {
    // 只是先收下：别人看到的东西一点都不变（事件、version、step 都不动）。
    state.events = input.events;
    state.history = input.history;
    state.version = input.version;
    return state;
  }
  state.events = ctx.events;
  state.history = [...state.history, ...ctx.events].slice(-HISTORY_LIMIT);
  state.version += 1;
  return state;
}

// ---------------------------------------------------------------------------
// 隐藏信息（4.12、9.4）

/**
 * 给某位玩家看的状态：自己的手牌完整；看牌打开时剩 10 张以下的队友给手牌；其他人只给张数（超过 10 张是 null）；
 * 革命者扣下的牌谁都看不到（除了他自己）；烧牌窗口里别人先收下的动作、同时决定阶段里别人的选择都去掉；
 * 烧牌资格和候选 S₁ 只放进本人的 you 字段。种子、随机数状态不下发。viewerId 为空串时只有公开信息（观战）。
 */
export function redactGouji(state: GoujiState, viewerId: string): GoujiState {
  const view = cloneState(state);
  delete view.rng;
  delete view.seed;
  delete view.you;
  const viewer = view.players.findIndex((player) => player.id === viewerId);
  const showAll = view.stage === "handEnd" || view.phase === "finished";
  view.players.forEach((player, seat) => {
    const count = state.players[seat]!.hand.length;
    if (seat === viewer) return;
    const teammateVisible = viewer >= 0 && view.config.peek && teamOf(seat) === teamOf(viewer) && count <= REPORT_LIMIT;
    if (!showAll && !teammateVisible) player.hand = [];
    player.handCount = showAll || count <= REPORT_LIMIT ? count : null;
    player.timeouts = 0;
  });
  if (viewer !== view.revolutionary) view.revolutionHand = [];
  if (view.tribute) {
    for (const item of view.tribute.items) {
      if (view.stage === "tribute" && item.intra && item.receiver !== viewer) item.eat = null;
      if (view.stage === "return" && item.receiver !== viewer) item.returned = null;
    }
  }
  if (view.revolution) {
    view.revolution.eligible = view.revolution.eligible.filter((seat) => seat === viewer);
    view.revolution.choices = view.revolution.choices.map((choice, seat) => (seat === viewer ? choice : null));
  }
  if (view.round) {
    if (view.round.pending?.seat !== viewer) view.round.pending = null;
    view.round.burnRequests = view.round.burnRequests.filter((request) => request.seat === viewer);
  }
  if (viewer >= 0) {
    const you: PrivateView = {
      seat: viewer,
      burnCandidates: state.stage === "playing" ? burnOptions(state, viewer) : [],
      burnRequested: state.round?.burnRequests.find((request) => request.seat === viewer)?.cards ?? null,
      pendingAction: state.round?.pending?.seat === viewer ? (state.round.pending.command as PlayOrPass) : null,
      canRevolt: state.stage === "revolution" && state.revolution!.eligible.includes(viewer) && state.revolution!.choices[viewer] === null,
    };
    view.you = you;
  }
  return view;
}

/**
 * 观战的人看到的对局：默认只有公开信息；房主打开「观战看手牌」后能看到每个人的手牌（革命者扣下的牌、
 * 别人先收下的动作、烧牌资格仍然看不到）。牌序、种子永远不下发。
 */
export function spectatorView(state: GoujiState, seeAll: boolean): GoujiState {
  const view = redactGouji(state, "");
  if (!seeAll) return view;
  view.players.forEach((player, seat) => {
    player.hand = [...state.players[seat]!.hand];
    player.handCount = player.hand.length;
  });
  return view;
}
