/**
 * 斗地主规则引擎。规则书：~/Desktop/游戏规则/斗地主.md（叫抢明牌加倍按欢乐斗地主习惯，牌型按竞技规则）。
 *
 * 纯函数：applyDdz 不改输入，返回新状态和事件。所有随机（座位、洗牌、第一个叫的人）都用状态里的种子随机数。
 * 一盘：明牌开始（可选）→ 发牌 → 叫地主 → 抢地主 → 亮底牌 → 加倍（可选）→ 地主明牌（可选）→ 出牌 → 结算。
 */
import { DECK_SIZE, sortCards, type Card } from "./cards.js";
import { allLeadMoves, beatingMoves, beats, classify, comboKey, type Combo } from "./combos.js";
import { createRng, type Rng } from "./rng.js";
import type { DdzCommand, DdzConfig, DdzEvent, DdzOptions, DdzPlayer, DdzState, HandSummary, MultiplierParts } from "./types.js";

export const HISTORY_LIMIT = 150;
export const SEAT_COUNT = 3;
export const HAND_SIZE = 17;

export const DEFAULT_OPTIONS: DdzOptions = { base: 1, hands: 6, mingpai: true, doubling: true, superDouble: false, tracker: true };

export function ddzConfig(options: Partial<DdzOptions> = {}, overrides: Partial<DdzConfig> = {}): DdzConfig {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    showStartSec: 5,
    bidSec: 10,
    doubleSec: 10,
    landlordShowSec: 5,
    playSec: 25,
    handEndSec: 20,
    ...overrides,
  };
}

export interface NewPlayer {
  readonly id: string;
  readonly name: string;
  readonly bot?: boolean;
}

interface Ctx {
  readonly state: DdzState;
  readonly rng: Rng;
  readonly events: DdzEvent[];
}

const SEATS = [0, 1, 2] as const;
/** 下家（下一个行动的人）。 */
export const nextSeat = (seat: number) => (seat + 1) % SEAT_COUNT;

function fail(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// 查询

/** 现在要做决定的座位。 */
export function pendingSeats(state: DdzState): number[] {
  if (state.phase === "finished") return [];
  switch (state.stage) {
    case "showStart":
      return SEATS.filter((seat) => !state.players[seat]!.showStartChosen);
    case "doubling":
      return SEATS.filter((seat) => !state.players[seat]!.doubleChosen);
    case "handEnd":
      return SEATS.filter((seat) => !state.ready.includes(state.players[seat]!.id));
    default:
      return state.turn >= 0 ? [state.turn] : [];
  }
}

/** 当前这一步的限时（秒）。 */
export function stepSeconds(state: DdzState): number {
  const config = state.config;
  switch (state.stage) {
    case "showStart":
      return config.showStartSec;
    case "bidding":
    case "robbing":
      return config.bidSec;
    case "doubling":
      return config.doubleSec;
    case "landlordShow":
      return config.landlordShowSec;
    case "playing":
      return config.playSec;
    case "handEnd":
      return config.handEndSec;
  }
}

/** 本盘的倍数构成（6.1）。spring 在一盘结束时才知道，进行中按 null 算。 */
export function multiplierOf(state: Pick<DdzState, "robs" | "showStarts" | "landlordShown" | "bombs">, spring: MultiplierParts["spring"] = null): MultiplierParts {
  const show = state.showStarts.length > 0 ? 5 : state.landlordShown ? 2 : 1;
  const total = 2 ** state.robs * show * 2 ** state.bombs * (spring ? 2 : 1);
  return { robs: state.robs, show, bombs: state.bombs, spring, total };
}

// ---------------------------------------------------------------------------
// 开局

function blankHandFields(): Omit<DdzPlayer, "id" | "name" | "bot" | "auto" | "timeouts" | "score"> {
  return {
    handDelta: 0,
    hand: [],
    handCount: 0,
    shown: false,
    showStartChosen: false,
    bid: null,
    rob: null,
    double: null,
    doubleChosen: false,
    plays: 0,
  };
}

export function createDdz(players: readonly NewPlayer[], seed: number, options: Partial<DdzOptions> = {}, overrides: Partial<DdzConfig> = {}): DdzState {
  if (players.length !== SEAT_COUNT) throw new Error("斗地主需要 3 个座位。");
  const rng = createRng(seed);
  const seated = rng.shuffle(players);
  const state: DdzState = {
    config: ddzConfig(options, overrides),
    phase: "playing",
    players: seated.map((player) => ({ id: player.id, name: player.name, bot: player.bot === true, auto: false, timeouts: 0, score: 0, ...blankHandFields() })),
    handNo: 0,
    redeals: 0,
    stage: "showStart",
    turn: -1,
    firstBidder: 0,
    caller: null,
    landlord: null,
    robs: 0,
    robber: null,
    robQueue: [],
    showStarts: [],
    landlordShown: false,
    bottom: [],
    lastPlay: null,
    passes: 0,
    table: [null, null, null],
    played: [],
    bombs: 0,
    summary: null,
    ready: [],
    events: [],
    history: [],
    version: 0,
    step: 0,
    seed,
    log: [],
  };
  const ctx: Ctx = { state, rng, events: [] };
  startHand(ctx);
  return finish(ctx);
}

function startHand(ctx: Ctx): void {
  const { state } = ctx;
  state.handNo += 1;
  state.redeals = 0;
  for (const player of state.players) Object.assign(player, blankHandFields());
  state.showStarts = [];
  state.landlordShown = false;
  state.summary = null;
  state.ready = [];
  ctx.events.push({ type: "HandStarted", handNo: state.handNo });
  if (state.config.mingpai) {
    resetDeal(state);
    state.stage = "showStart";
    state.turn = -1;
    state.step += 1;
    return;
  }
  deal(ctx);
}

/** 清掉上一次发牌留下的东西（重新发牌时也用）。 */
function resetDeal(state: DdzState): void {
  for (const player of state.players) {
    player.hand = [];
    player.bid = null;
    player.rob = null;
    player.double = null;
    player.doubleChosen = false;
    player.plays = 0;
  }
  state.bottom = [];
  state.caller = null;
  state.landlord = null;
  state.robs = 0;
  state.robber = null;
  state.robQueue = [];
  state.lastPlay = null;
  state.passes = 0;
  state.table = [null, null, null];
  state.played = [];
  state.bombs = 0;
}

/** 洗牌发牌：每人 17 张，底牌 3 张；有人明牌开始时最先点的人第一个叫，否则随机。 */
function deal(ctx: Ctx, deck?: readonly Card[]): void {
  const { state, rng } = ctx;
  resetDeal(state);
  const cards = deck ? [...deck] : rng.shuffle(Array.from({ length: DECK_SIZE }, (_, card) => card));
  SEATS.forEach((seat) => {
    state.players[seat]!.hand = sortCards(cards.slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE));
  });
  state.bottom = sortCards(cards.slice(SEAT_COUNT * HAND_SIZE));
  state.firstBidder = state.showStarts.length > 0 ? state.showStarts[0]! : rng.int(SEAT_COUNT);
  state.stage = "bidding";
  state.turn = state.firstBidder;
  state.step += 1;
  ctx.events.push({ type: "Dealt", firstBidder: state.firstBidder, redeal: state.redeals });
}

/**
 * 测试用：用指定的牌序重新发这一盘（前 17 张给座位 0，接着座位 1、2，最后 3 张是底牌），
 * 可以指定第一个叫的人。要在叫地主开始前（明牌开始或叫地主阶段第一个人还没表态）调用。
 */
export function stackDeal(state: DdzState, deck: readonly Card[], firstBidder?: number): DdzState {
  if (deck.length !== DECK_SIZE || new Set(deck).size !== DECK_SIZE) throw new Error("牌序要正好 54 张不重复的牌。");
  const next = structuredClone(state);
  delete (next as { events?: unknown }).events;
  next.events = [];
  for (const player of next.players) player.showStartChosen = true;
  const ctx: Ctx = { state: next, rng: createRng(next.rng ?? 1), events: [] };
  deal(ctx, deck);
  if (firstBidder !== undefined) {
    next.firstBidder = firstBidder;
    next.turn = firstBidder;
  }
  return finish(ctx);
}

// ---------------------------------------------------------------------------
// 动作

export function applyDdz(input: DdzState, playerId: string, command: DdzCommand | { type: "TIMEOUT"; seats?: readonly number[] }): { state: DdzState; events: DdzEvent[] } {
  if (input.phase === "finished" && command.type !== "AUTO") fail("对局已经结束。");
  const state = structuredClone(input);
  delete (state as { events?: unknown }).events;
  state.events = [];
  const ctx: Ctx = { state, rng: createRng(state.rng ?? 1), events: [] };

  if (command.type === "TIMEOUT") {
    timeoutAll(ctx, command.seats);
    return { state: finish(ctx), events: ctx.events };
  }
  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat < 0) fail("你不在这局里。");
  state.log?.push({ seat, command });
  if (command.type === "AUTO") {
    setAuto(ctx, seat, command.on === true);
    return { state: finish(ctx), events: ctx.events };
  }
  act(ctx, seat, command);
  state.players[seat]!.timeouts = 0;
  return { state: finish(ctx), events: ctx.events };
}

function setAuto(ctx: Ctx, seat: number, on: boolean): void {
  const player = ctx.state.players[seat]!;
  if (player.auto === on) return;
  player.auto = on;
  player.timeouts = 0;
  ctx.events.push({ type: "AutoChanged", seat, on });
}

function act(ctx: Ctx, seat: number, command: DdzCommand, auto = false): void {
  switch (command.type) {
    case "SHOW_START":
      return chooseShowStart(ctx, seat, command.show === true);
    case "BID":
      return bid(ctx, seat, command.call === true);
    case "ROB":
      return rob(ctx, seat, command.rob === true);
    case "DOUBLE":
      return chooseDouble(ctx, seat, command.factor);
    case "LANDLORD_SHOW":
      return landlordShow(ctx, seat, command.show === true);
    case "PLAY":
      return play(ctx, seat, command.cards, command.as, auto);
    case "PASS":
      return pass(ctx, seat, auto);
    case "READY":
      return markReady(ctx, seat);
    case "AUTO":
      return setAuto(ctx, seat, command.on);
    default:
      fail("不认识的操作。");
  }
}

function chooseShowStart(ctx: Ctx, seat: number, show: boolean): void {
  const { state } = ctx;
  if (state.stage !== "showStart") fail("现在不是明牌开始的时候。");
  const player = state.players[seat]!;
  if (player.showStartChosen) fail("你已经选过了。");
  player.showStartChosen = true;
  if (show) {
    player.shown = true;
    state.showStarts.push(seat);
  }
  ctx.events.push({ type: "ShowStart", seat, show });
  if (state.players.every((candidate) => candidate.showStartChosen)) deal(ctx);
}

function requireTurn(state: DdzState, seat: number, stage: DdzState["stage"], message: string): void {
  if (state.stage !== stage) fail(message);
  if (state.turn !== seat) fail("还没轮到你。");
}

function bid(ctx: Ctx, seat: number, call: boolean): void {
  const { state } = ctx;
  requireTurn(state, seat, "bidding", "现在不是叫地主的时候。");
  state.players[seat]!.bid = call ? "call" : "noCall";
  ctx.events.push({ type: "Bid", seat, call });
  if (call) {
    state.caller = seat;
    // 从叫地主的人的下家开始，没说过「不叫」的人各有一次抢的机会。
    state.robQueue = [nextSeat(seat), nextSeat(nextSeat(seat))].filter((other) => state.players[other]!.bid !== "noCall");
    if (state.robQueue.length === 0) return chooseLandlord(ctx, seat);
    state.stage = "robbing";
    state.turn = state.robQueue[0]!;
    state.step += 1;
    return;
  }
  if (state.players.every((player) => player.bid === "noCall")) {
    if (state.showStarts.length > 0) return chooseLandlord(ctx, state.showStarts[0]!);
    state.redeals += 1;
    ctx.events.push({ type: "Redeal", count: state.redeals });
    return deal(ctx);
  }
  state.turn = nextSeat(seat);
  state.step += 1;
}

function rob(ctx: Ctx, seat: number, robbing: boolean): void {
  const { state } = ctx;
  requireTurn(state, seat, "robbing", "现在不是抢地主的时候。");
  state.robQueue.shift();
  state.players[seat]!.rob = robbing ? "rob" : "noRob";
  if (robbing) {
    state.robs += 1;
    state.robber = seat;
  }
  ctx.events.push({ type: "Rob", seat, rob: robbing, robs: state.robs });
  if (state.robQueue.length === 0 && seat !== state.caller && state.robs > 0) {
    // 有人抢过：叫地主的人还有最后一次表态。
    state.robQueue.push(state.caller!);
  }
  if (state.robQueue.length > 0) {
    state.turn = state.robQueue[0]!;
    state.step += 1;
    return;
  }
  chooseLandlord(ctx, state.robber ?? state.caller!);
}

/** 确定地主：亮底牌、底牌加进地主手里，然后加倍 / 地主明牌 / 出牌。 */
function chooseLandlord(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  state.landlord = seat;
  state.robQueue = [];
  const landlord = state.players[seat]!;
  landlord.hand = sortCards([...landlord.hand, ...state.bottom]);
  ctx.events.push({ type: "LandlordChosen", seat, bottom: [...state.bottom] });
  if (state.config.doubling) {
    state.stage = "doubling";
    state.turn = -1;
    state.step += 1;
    return;
  }
  afterDoubling(ctx);
}

function chooseDouble(ctx: Ctx, seat: number, factor: number): void {
  const { state } = ctx;
  if (state.stage !== "doubling") fail("现在不是加倍的时候。");
  const allowed = state.config.superDouble ? [1, 2, 4] : [1, 2];
  if (!allowed.includes(factor)) fail("不能这样加倍。");
  const player = state.players[seat]!;
  if (player.doubleChosen) fail("你已经选过了。");
  player.double = factor as 1 | 2 | 4;
  player.doubleChosen = true;
  if (!state.players.every((candidate) => candidate.doubleChosen)) return;
  ctx.events.push({ type: "DoublesRevealed", doubles: state.players.map((candidate) => candidate.double ?? 1) });
  afterDoubling(ctx);
}

function afterDoubling(ctx: Ctx): void {
  const { state } = ctx;
  if (state.config.mingpai && !state.players[state.landlord!]!.shown) {
    state.stage = "landlordShow";
    state.turn = state.landlord!;
    state.step += 1;
    return;
  }
  startPlay(ctx);
}

function landlordShow(ctx: Ctx, seat: number, show: boolean): void {
  const { state } = ctx;
  requireTurn(state, seat, "landlordShow", "现在不是地主明牌的时候。");
  if (show) {
    state.landlordShown = true;
    state.players[seat]!.shown = true;
  }
  ctx.events.push({ type: "LandlordShow", seat, show });
  startPlay(ctx);
}

function startPlay(ctx: Ctx): void {
  const { state } = ctx;
  state.stage = "playing";
  state.turn = state.landlord!;
  state.lastPlay = null;
  state.passes = 0;
  state.table = [null, null, null];
  state.step += 1;
}

/** 出牌的多种认法里选哪种：跟牌只留能压过的；as 指定就用它，否则取比较点数最大的。 */
export function resolvePlay(readings: readonly Combo[], lastPlay: DdzState["lastPlay"], as?: string): Combo | string {
  if (readings.length === 0) return "这几张牌不是合法的牌型。";
  const candidates = lastPlay ? readings.filter((reading) => beats(lastPlay.combo, reading)) : [...readings];
  if (candidates.length === 0) return "压不过上一手。";
  if (as !== undefined) return candidates.find((reading) => comboKey(reading) === as) ?? "没有这种认法。";
  return candidates[0]!;
}

function play(ctx: Ctx, seat: number, cards: readonly Card[], as: string | undefined, auto: boolean): void {
  const { state } = ctx;
  requireTurn(state, seat, "playing", "现在不是出牌的时候。");
  if (!Array.isArray(cards) || cards.length === 0) fail("请选要出的牌。");
  const player = state.players[seat]!;
  const hand = new Set(player.hand);
  if (new Set(cards).size !== cards.length || cards.some((card) => !hand.has(card))) fail("这些牌不在你手里。");
  const combo = resolvePlay(classify(cards), state.lastPlay, as);
  if (typeof combo === "string") fail(combo);
  const sorted = sortCards(cards);
  const used = new Set(cards);
  player.hand = player.hand.filter((card) => !used.has(card));
  player.plays += 1;
  state.played.push(...sorted);
  if (combo.type === "bomb" || combo.type === "rocket") state.bombs += 1;
  if (!state.lastPlay) state.table = [null, null, null];
  state.table[seat] = { kind: "play", cards: sorted, combo };
  state.lastPlay = { seat, cards: sorted, combo };
  state.passes = 0;
  ctx.events.push({ type: "Played", seat, cards: sorted, combo, left: player.hand.length, ...(auto ? { auto } : {}) });
  if (player.hand.length === 0) return endHand(ctx, seat);
  state.turn = nextSeat(seat);
  state.step += 1;
}

function pass(ctx: Ctx, seat: number, auto: boolean): void {
  const { state } = ctx;
  requireTurn(state, seat, "playing", "现在不是出牌的时候。");
  if (!state.lastPlay) fail("该你出牌了，引牌不能不出。");
  state.table[seat] = { kind: "pass" };
  state.passes += 1;
  ctx.events.push({ type: "Passed", seat, ...(auto ? { auto } : {}) });
  if (state.passes >= SEAT_COUNT - 1) {
    const leader = state.lastPlay.seat;
    ctx.events.push({ type: "TrickWon", leader });
    state.turn = leader;
    state.lastPlay = null;
    state.passes = 0;
  } else {
    state.turn = nextSeat(seat);
  }
  state.step += 1;
}

// ---------------------------------------------------------------------------
// 结算（第 6 节）

function endHand(ctx: Ctx, winner: number): void {
  const { state } = ctx;
  const landlord = state.landlord!;
  const landlordWon = winner === landlord;
  const farmers = SEATS.filter((seat) => seat !== landlord);
  const spring: MultiplierParts["spring"] = landlordWon && farmers.every((seat) => state.players[seat]!.plays === 0)
    ? "spring"
    : !landlordWon && state.players[landlord]!.plays === 1
      ? "antiSpring"
      : null;
  const multiplier = multiplierOf(state, spring);
  const doubles = state.players.map((player) => player.double ?? 1) as [number, number, number];
  const deltas: [number, number, number] = [0, 0, 0];
  for (const farmer of farmers) {
    const share = state.config.base * multiplier.total * doubles[farmer]! * doubles[landlord]!;
    const sign = landlordWon ? 1 : -1;
    deltas[landlord]! += sign * share;
    deltas[farmer]! -= sign * share;
  }
  SEATS.forEach((seat) => {
    const player = state.players[seat]!;
    player.handDelta = deltas[seat]!;
    player.score += deltas[seat]!;
  });
  const summary: HandSummary = {
    landlord,
    landlordWon,
    winner,
    multiplier,
    base: state.config.base,
    doubles,
    deltas,
    bottom: [...state.bottom],
  };
  state.summary = summary;
  state.stage = "handEnd";
  state.turn = -1;
  state.lastPlay = null;
  state.ready = [];
  state.step += 1;
  ctx.events.push({ type: "HandEnded", handNo: state.handNo, summary });
  if (state.handNo >= state.config.hands) finishGame(ctx);
}

function finishGame(ctx: Ctx): void {
  const { state } = ctx;
  const scores = state.players.map((player) => player.score);
  const ranks = scores.map((score) => 1 + scores.filter((other) => other > score).length);
  const top = Math.max(...scores);
  const winners = state.players.filter((player) => player.score === top).map((player) => player.id);
  state.phase = "finished";
  state.finalResult = { winners, ranks };
  ctx.events.push({ type: "GameEnded", winners });
}

function markReady(ctx: Ctx, seat: number): void {
  const { state } = ctx;
  if (state.stage !== "handEnd") fail("现在不是结算画面。");
  const id = state.players[seat]!.id;
  if (!state.ready.includes(id)) state.ready.push(id);
  if (state.ready.length === SEAT_COUNT) startHand(ctx);
}

// ---------------------------------------------------------------------------
// 超时（9.4）：叫 → 不叫，抢 → 不抢，加倍 → 不加倍，明牌 → 不明，引牌 → 最小的一张单牌，跟牌 → 不出。

export function timeoutCommand(state: DdzState, seat: number): DdzCommand {
  const player = state.players[seat]!;
  switch (state.stage) {
    case "showStart":
      return { type: "SHOW_START", show: false };
    case "bidding":
      return { type: "BID", call: false };
    case "robbing":
      return { type: "ROB", rob: false };
    case "doubling":
      return { type: "DOUBLE", factor: 1 };
    case "landlordShow":
      return { type: "LANDLORD_SHOW", show: false };
    case "playing":
      if (state.lastPlay) return { type: "PASS" };
      return { type: "PLAY", cards: [player.hand[player.hand.length - 1]!] };
    case "handEnd":
      return { type: "READY" };
  }
}

/** 给 seats（不给就是所有还没决定的人）套用默认动作；连续超时 2 次转托管（结算画面不算）。 */
function timeoutAll(ctx: Ctx, seats?: readonly number[]): void {
  const { state } = ctx;
  for (const seat of seats ?? pendingSeats(state)) {
    if (state.phase === "finished") return;
    // 前一个人的超时动作可能已经让局面往前走了。
    if (!pendingSeats(state).includes(seat)) continue;
    const command = timeoutCommand(state, seat);
    const stage = state.stage;
    state.log?.push({ seat, command: { type: "TIMEOUT" } });
    ctx.events.push({ type: "TimedOut", seat });
    act(ctx, seat, command, true);
    const player = state.players[seat]!;
    if (stage !== "handEnd" && stage !== "showStart") {
      player.timeouts += 1;
      if (player.timeouts >= 2 && !player.auto && !player.bot) setAuto(ctx, seat, true);
    }
  }
}

// ---------------------------------------------------------------------------

/** 这位玩家现在能发的操作（测试、随机对局用）。出牌给出每种牌型每个点数一种出法。 */
export function legalCommands(state: DdzState, playerId: string): DdzCommand[] {
  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat < 0 || state.phase === "finished" || !pendingSeats(state).includes(seat)) return [];
  switch (state.stage) {
    case "showStart":
      return [{ type: "SHOW_START", show: true }, { type: "SHOW_START", show: false }];
    case "bidding":
      return [{ type: "BID", call: true }, { type: "BID", call: false }];
    case "robbing":
      return [{ type: "ROB", rob: true }, { type: "ROB", rob: false }];
    case "doubling":
      return (state.config.superDouble ? [1, 2, 4] as const : [1, 2] as const).map((factor) => ({ type: "DOUBLE", factor }));
    case "landlordShow":
      return [{ type: "LANDLORD_SHOW", show: true }, { type: "LANDLORD_SHOW", show: false }];
    case "playing": {
      const hand = state.players[seat]!.hand;
      if (!state.lastPlay) return allLeadMoves(hand).map((move) => ({ type: "PLAY", cards: move.cards, as: comboKey(move.combo) }));
      return [{ type: "PASS" }, ...beatingMoves(hand, state.lastPlay.combo).map((move) => ({ type: "PLAY" as const, cards: move.cards, as: comboKey(move.combo) }))];
    }
    case "handEnd":
      return [{ type: "READY" }];
  }
}

function finish(ctx: Ctx): DdzState {
  const { state } = ctx;
  for (const player of state.players) player.handCount = player.hand.length;
  state.rng = ctx.rng.state;
  state.events = ctx.events;
  state.history = [...state.history, ...ctx.events].slice(-HISTORY_LIMIT);
  state.version += 1;
  return state;
}

/**
 * 给某位玩家看的状态（4.10、9.3）：别人的手牌只给张数（明牌的人、一盘结束时公开），
 * 底牌在确定地主前是 3 个 -1，加倍在 3 人都选完前只给「选没选」。viewerId 为空串时只有公开信息。
 */
export function redactDdz(state: DdzState, viewerId: string): DdzState {
  const view = structuredClone(state);
  delete view.rng;
  delete view.seed;
  delete view.log;
  const viewer = view.players.findIndex((player) => player.id === viewerId);
  const showAll = view.stage === "handEnd" || view.phase === "finished";
  const doublesHidden = view.stage === "doubling";
  view.players.forEach((player, seat) => {
    if (seat === viewer) return;
    if (!player.shown && !showAll) player.hand = [];
    if (doublesHidden) player.double = null;
  });
  if (view.landlord === null) view.bottom = view.bottom.map(() => -1);
  return view;
}
