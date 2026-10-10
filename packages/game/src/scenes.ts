/**
 * 预览局面工厂（对外接口）：给界面的预览页、教程剧本、验收测试（包括背靠背的规则核对）造局面用。
 *
 * - buildState(spec)：按参数造出一个精确的出牌阶段 / 结算局面（手牌、桌面牌、过牌、让牌、无头、乱缠、走科、烧牌状态……）。
 * - buildDeal(spec)：按参数造出一盘刚发完牌的局面（可以带上一盘的结果），照常走进贡 / 还贡 / 革命 / 出牌。
 * - createScene(name)：按名字造常见局面（SCENE_NAMES 列出全部）。
 * - previewRoom(state, opts)：把局面包成某个座位看到的房间快照（对手离线、超时倒计时、托管、观战），预览页直接渲染。
 *
 * 造出来的都是服务器上的完整状态（带种子），可以直接接着 applyCommand / tickBurnWindow / timeoutTurn。
 * 给浏览器看之前要过 redactGameForViewer（previewRoom 已经做了）。
 */
import { DECK_SIZE, isWild, parseCards, rankOf, sortCards, TWO, type Card } from "./cards.js";
import { applyGouji, cloneState, createGouji, HAND_SIZE, redactGouji, spectatorView, stackDeal, type NewPlayer } from "./gouji.js";
import { createRng } from "./rng.js";
import { parseSet } from "./sets.js";
import { nextResponder, SEATS, teamOf, oppOf } from "./turn.js";
import type { LobbyMember, LobbyRoomSnapshot } from "./roomTypes.js";
import { DEFAULT_ROOM_ACCESS } from "./roomTypes.js";
import { PLACE_POINTS, type BurnRecord, type GoujiConfig, type GoujiOptions, type GoujiState, type HandResult, type Place, type TableEntry, type TopPlay } from "./types.js";

/** 牌的写法（"A A 7 7 7 9 9 小 大"、"10x5"）或牌的数组。 */
export type CardsSpec = string | readonly Card[];

/** 上一盘的结果：给名次顺序（头科在前；串三户只给前三名）就行，分数自动算。 */
export interface ResultSpec {
  readonly order: readonly number[];
  readonly sweep?: boolean;
  readonly burns?: readonly BurnRecord[];
  readonly revolutionary?: number | null;
  readonly handNo?: number;
}

interface CommonSpec {
  /** 随机补牌用的种子（默认 1）。 */
  readonly seed?: number;
  readonly options?: Partial<GoujiOptions>;
  readonly config?: Partial<GoujiConfig>;
  /** 玩家名字（默认「玩家1」…「玩家6」）；bots 里的座位是人机（名字默认咕噜一号…）。 */
  readonly names?: readonly string[];
  readonly bots?: readonly number[];
  /** 托管中的座位。 */
  readonly auto?: readonly number[];
  /** 第几盘（默认 1，有上一盘结果时默认 2）。 */
  readonly handNo?: number;
  /** 两队累计分。 */
  readonly teamScores?: readonly [number, number];
}

export interface StateSpec extends CommonSpec {
  /**
   * 每个座位的手牌：牌的写法 / 牌的数组，或者张数（从剩下的牌里随机补）。没写的座位默认随机 15 张；
   * 已走科（finished）和革命者的座位默认 0 张。剩下没分出去的牌算作这一盘已经打出过的牌。
   */
  readonly hands?: Readonly<Partial<Record<number, CardsSpec | number>>>;
  /** 革命者扣下的牌（默认随机 30 张）。 */
  readonly revolutionHand?: CardsSpec | number;
  readonly stage?: "playing" | "handEnd";
  /** 这一轮发牌的人（默认：有桌面牌时是桌面牌的主人，否则是 turn 或 0）。 */
  readonly leader?: number;
  /** 桌面牌：谁出的、什么牌（这些牌算已经打出，不占手牌）。ready 默认：不可能被烧的牌是 true，可能被烧的是 false（窗口还没满 2 秒）。 */
  readonly top?: { readonly seat: number; readonly cards: CardsSpec; readonly ready?: boolean; readonly burn?: boolean };
  /** 这一轮之前打出的牌（显示用，按顺序；最后一个就是桌面牌时不用再写 top）。 */
  readonly entries?: readonly ({ readonly seat: number; readonly cards: CardsSpec } | { readonly seat: number; readonly pass: true })[];
  /** 这一轮过过牌的人。 */
  readonly passed?: readonly number[];
  readonly rang?: { readonly seat: number; readonly returned: boolean };
  /** 轮到谁（默认：有桌面牌时按规则找下一个有资格接牌的人，没人就是 -1；否则是 leader）。 */
  readonly turn?: number;
  readonly headless?: readonly number[];
  readonly chaos?: boolean;
  /** 已走科的座位（按顺序）。 */
  readonly finished?: readonly number[];
  /** 其中这一轮刚走科的（这一轮结束时他们的对头变成无头）。 */
  readonly goneThisRound?: readonly number[];
  readonly revolutionary?: number | null;
  /** 当前的烧牌状态。 */
  readonly burn?: BurnRecord | null;
  readonly burnsThisHand?: readonly BurnRecord[];
  readonly prevResult?: ResultSpec | null;
  /** stage 为 handEnd 时这一盘的结果（不给就按 finished + 剩下的人算）。 */
  readonly result?: ResultSpec;
}

export interface DealSpec extends CommonSpec {
  /** 每个座位至少要有的牌（其余从剩下的牌里随机补满 36 张）。 */
  readonly hands?: Readonly<Partial<Record<number, CardsSpec>>>;
  /** 这些座位随机补牌时不补 2 和王（用来造能革命的人）。没写进来的座位保证至少有 1 张配牌。 */
  readonly noWild?: readonly number[];
  /** 上一盘的结果（有它就会进贡，除非开房选项关了进贡）。 */
  readonly prevResult?: ResultSpec | null;
  /** 这一盘该先出的人（默认按规则：上一盘的大落 / 头科的对头 / 第 1 盘随机）。 */
  readonly firstLeader?: number;
}

const BOT_NAMES = ["咕噜一号", "咕噜二号", "咕噜三号", "咕噜四号", "咕噜五号", "咕噜六号"];

function players(spec: CommonSpec): NewPlayer[] {
  let botIndex = 0;
  return SEATS.map((seat) => {
    const bot = spec.bots?.includes(seat) === true;
    const name = spec.names?.[seat] ?? (bot ? BOT_NAMES[botIndex++]! : `玩家${seat + 1}`);
    return { id: `p${seat + 1}`, name, bot };
  });
}

function cardsOf(spec: CardsSpec, used: Map<number, number>, taken: Set<Card>): Card[] {
  const cards = typeof spec === "string" ? parseCards(spec, used) : [...spec];
  for (const card of cards) {
    if (taken.has(card)) throw new Error(`牌 ${card} 用了两次`);
    taken.add(card);
  }
  return cards;
}

/** 按名次顺序算出完整的一盘结果。 */
export function resultFrom(spec: ResultSpec, handNo: number): HandResult {
  const order = [...spec.order];
  const sweep = spec.sweep ?? (order.length === 3 && teamOf(order[0]!) === teamOf(order[1]!) && teamOf(order[1]!) === teamOf(order[2]!));
  const places: (Place | null)[] = [null, null, null, null, null, null];
  order.forEach((seat, place) => {
    places[seat] = place as Place;
  });
  const teamDeltas: [number, number] = [0, 0];
  const sweepTeam = sweep ? teamOf(order[0]!) : null;
  if (sweepTeam !== null) {
    teamDeltas[sweepTeam] = 12;
    teamDeltas[1 - sweepTeam] = -12;
  } else {
    if (order.length !== 6) throw new Error("不是串三户的结果要给全 6 个名次。");
    order.forEach((seat, place) => {
      teamDeltas[teamOf(seat)] += PLACE_POINTS[place]!;
    });
  }
  return {
    handNo: spec.handNo ?? handNo,
    sweep,
    sweepTeam,
    order,
    places,
    revolutionary: spec.revolutionary ?? null,
    burns: [...(spec.burns ?? [])],
    teamDeltas,
    deltas: SEATS.map((seat) => teamDeltas[teamOf(seat)]),
  };
}

function applyCommon(state: GoujiState, spec: CommonSpec): void {
  for (const seat of spec.auto ?? []) state.players[seat]!.auto = true;
  if (spec.teamScores) {
    state.teamScores = [spec.teamScores[0], spec.teamScores[1]];
    state.players.forEach((player, seat) => {
      player.score = state.teamScores[teamOf(seat)];
    });
  }
}

/**
 * 造一盘刚发完牌的局面：每个座位先放指定的牌，其余随机补满 36 张；有上一盘结果时照常进贡。
 * 返回的局面停在进贡（队内吃 / 免）、还贡、革命或出牌（发牌的人第一手）——和真打时一样。
 */
export function buildDeal(spec: DealSpec = {}): GoujiState {
  const seed = spec.seed ?? 1;
  let state = createGouji(players(spec), seed, spec.options ?? {}, spec.config ?? {});
  state = cloneState(state);
  const handNo = spec.handNo ?? (spec.prevResult ? 2 : 1);
  state.handNo = handNo;
  state.prevResult = spec.prevResult ? resultFrom(spec.prevResult, handNo - 1) : null;
  applyCommon(state, spec);
  if (spec.firstLeader !== undefined) state.firstLeader = spec.firstLeader;
  else if (state.prevResult) state.firstLeader = state.prevResult.sweep ? oppOf(state.prevResult.order[0]!) : state.prevResult.order[5]!;
  const used = new Map<number, number>();
  const taken = new Set<Card>();
  const hands: Card[][] = SEATS.map((seat) => (spec.hands?.[seat] !== undefined ? cardsOf(spec.hands[seat]!, used, taken) : []));
  if (hands.some((hand) => hand.length > HAND_SIZE)) throw new Error("每人最多 36 张。");
  const rng = createRng(seed ^ 0x5eed);
  const pool = rng.shuffle(Array.from({ length: DECK_SIZE }, (_, card) => card).filter((card) => !taken.has(card)));
  const noWild = new Set(spec.noWild ?? []);
  // 先给不能有配牌的座位补普通牌，再给其他座位补（剩下的配牌都在他们那里）。
  for (const seat of SEATS.filter((other) => noWild.has(other))) {
    while (hands[seat]!.length < HAND_SIZE) {
      const index = pool.findIndex((card) => !isWild(card));
      hands[seat]!.push(pool.splice(index, 1)[0]!);
    }
  }
  for (const seat of SEATS.filter((other) => !noWild.has(other))) {
    while (hands[seat]!.length < HAND_SIZE) hands[seat]!.push(pool.shift()!);
  }
  // 没写进 noWild 的座位保证至少 1 张配牌（免得意外出现能革命的人）：和配牌多的人换一张普通牌。
  for (const seat of SEATS.filter((other) => !noWild.has(other) && spec.hands?.[other] === undefined)) {
    if (hands[seat]!.some(isWild)) continue;
    const donor = SEATS.filter((other) => !noWild.has(other) && other !== seat).sort((a, b) => hands[b]!.filter(isWild).length - hands[a]!.filter(isWild).length)[0]!;
    const wildIndex = hands[donor]!.findIndex(isWild);
    const plainIndex = hands[seat]!.findIndex((card) => !isWild(card));
    if (wildIndex < 0 || plainIndex < 0 || hands[donor]!.filter(isWild).length < 2) continue;
    [hands[donor]![wildIndex], hands[seat]![plainIndex]] = [hands[seat]![plainIndex]!, hands[donor]![wildIndex]!];
  }
  state.redeals = 0;
  return stackDeal(state, hands.flat());
}

/** 造一个精确的出牌阶段（或结算）局面。 */
export function buildState(spec: StateSpec = {}): GoujiState {
  const seed = spec.seed ?? 1;
  const state = cloneState(createGouji(players(spec), seed, spec.options ?? {}, spec.config ?? {}));
  state.handNo = spec.handNo ?? (spec.prevResult ? 2 : 1);
  state.prevResult = spec.prevResult ? resultFrom(spec.prevResult, state.handNo - 1) : null;
  applyCommon(state, spec);
  state.tribute = null;
  state.revolution = null;
  state.redeals = 0;
  state.revolutionary = spec.revolutionary ?? null;
  state.finished = [...(spec.finished ?? [])];
  state.goneThisRound = [...(spec.goneThisRound ?? [])];
  state.headless = SEATS.map((seat) => spec.headless?.includes(seat) === true || (state.revolutionary !== null && seat === oppOf(state.revolutionary)));
  state.chaos = spec.chaos === true;
  state.burn = spec.burn ?? null;
  state.burnsThisHand = [...(spec.burnsThisHand ?? [])];

  const used = new Map<number, number>();
  const taken = new Set<Card>();
  const explicit: (Card[] | null)[] = SEATS.map((seat) => {
    const value = spec.hands?.[seat];
    return value === undefined || typeof value === "number" ? null : cardsOf(value, used, taken);
  });
  const played: { seat: number; cards: Card[] }[] = [];
  for (const entry of spec.entries ?? []) {
    if ("cards" in entry) played.push({ seat: entry.seat, cards: cardsOf(entry.cards, used, taken) });
  }
  const topCards = spec.top ? cardsOf(spec.top.cards, used, taken) : null;
  const revolutionExplicit = typeof spec.revolutionHand === "string" || Array.isArray(spec.revolutionHand) ? cardsOf(spec.revolutionHand as CardsSpec, used, taken) : null;
  const rng = createRng(seed ^ 0x5eed);
  const pool = rng.shuffle(Array.from({ length: DECK_SIZE }, (_, card) => card).filter((card) => !taken.has(card)));
  SEATS.forEach((seat) => {
    const value = spec.hands?.[seat];
    const out = state.finished.includes(seat) || seat === state.revolutionary;
    const hand = explicit[seat] ?? pool.splice(0, typeof value === "number" ? value : out ? 0 : 15);
    state.players[seat]!.hand = sortCards(hand);
    state.players[seat]!.handCount = hand.length;
  });
  if (state.revolutionary !== null) {
    state.revolutionHand = sortCards(revolutionExplicit ?? pool.splice(0, typeof spec.revolutionHand === "number" ? spec.revolutionHand : 30));
  } else state.revolutionHand = [];
  state.discard = [...pool, ...played.flatMap((entry) => entry.cards), ...(topCards ?? [])];

  // 这一轮
  const entries: TableEntry[] = [];
  let seq = 0;
  let playedIndex = 0;
  for (const entry of spec.entries ?? []) {
    if ("pass" in entry) {
      entries.push({ seat: entry.seat, kind: "pass" });
      continue;
    }
    const cards = sortCards(played[playedIndex++]!.cards);
    const set = parseSet(cards);
    if (!set) throw new Error(`不是合法的一套：${String(entry.cards)}`);
    entries.push({ seat: entry.seat, kind: "play", cards, set, burn: false });
    seq += 1;
  }
  let top: TopPlay | null = null;
  if (spec.top && topCards) {
    const set = parseSet(topCards);
    if (!set) throw new Error("桌面牌不是合法的一套。");
    const burnable = set.gouji && !state.chaos && !state.headless[spec.top.seat];
    seq += 1;
    top = { seq, seat: spec.top.seat, cards: sortCards(topCards), set, burnable, ready: spec.top.ready ?? !burnable, burn: spec.top.burn === true };
    entries.push({ seat: spec.top.seat, kind: "play", cards: sortCards(topCards), set, burn: spec.top.burn === true });
  } else {
    const last = [...entries].reverse().find((entry) => entry.kind === "play");
    if (last && last.kind === "play") {
      const burnable = last.set.gouji && !state.chaos && !state.headless[last.seat];
      top = { seq, seat: last.seat, cards: last.cards, set: last.set, burnable, ready: !burnable, burn: false };
    }
  }
  state.playSeq = seq;
  const stage = spec.stage ?? "playing";
  const leader = spec.leader ?? (entries.find((entry) => entry.kind === "play")?.seat ?? top?.seat ?? spec.turn ?? 0);
  state.round = { leader, top, passed: [...(spec.passed ?? [])], rang: spec.rang ? { ...spec.rang } : null, entries, pending: null, burnRequests: [] };
  state.stage = stage;
  if (stage === "playing") {
    state.turn = spec.turn ?? (top ? nextResponder(state, top.seat) ?? -1 : leader);
  } else {
    state.turn = -1;
    const rest = SEATS.filter((seat) => !state.finished.includes(seat) && seat !== state.revolutionary);
    const rebel = state.revolutionary;
    const order = spec.result?.order ?? (rebel === null ? [...state.finished, ...rest] : [...state.finished.slice(0, 3), rebel, ...state.finished.slice(3), ...rest]);
    const result = resultFrom({ ...spec.result, order, revolutionary: state.revolutionary, burns: state.burnsThisHand }, state.handNo);
    state.result = result;
    state.prevResult = result;
    state.players.forEach((player, seat) => {
      player.handDelta = result.deltas[seat]!;
    });
  }
  state.events = [];
  state.history = [];
  state.step += 1;
  state.version += 1;
  for (const player of state.players) player.handCount = player.hand.length;
  return state;
}

// ---------------------------------------------------------------------------
// 按名字造的常见局面

export const SCENE_NAMES = [
  "opening",
  "beforeLead",
  "beforeRespond",
  "tribute",
  "tributeWaived",
  "tributeReturn",
  "antiTribute",
  "revolution",
  "revolutionPlay",
  "goujiDuel",
  "goujiWait",
  "burnWindow",
  "burnState",
  "burnBroken",
  "rang",
  "rangReturned",
  "jiefeng",
  "headless",
  "chaos",
  "handEnd",
  "sweepEnd",
  "revolutionSweepEnd",
  "matchEnd",
  "matchDraw",
  "timeout",
  "auto",
  "offline",
] as const;
export type SceneName = (typeof SCENE_NAMES)[number];

/** 剧本 B（补充文件 2.2）的烧牌手牌。 */
const BURN_HAND = "A A 7 7 7 9 9 小 大";

/**
 * 按名字造局面。视角默认是座位 0（甲，队友 2、4，对头 3）。
 * - opening：第 1 盘刚发完牌、过了革命阶段，座位 0 先出（36 张）。
 * - beforeLead / beforeRespond：轮到 0 发牌 / 接 5 出的 8 8。
 * - tribute / tributeWaived / tributeReturn / antiTribute：第 2 盘进贡（规则书 T15、T16：1 选吃不吃 5 的烧贡；免贡后的到账；0 要还 5 两张；4 发到 4 张大王抗贡）。
 * - revolution：革命阶段（每盘都有），座位 0 手里没王没 2 可以革命，其他人只能选「继续」；revolutionPlay：4 革命了、1 无头，5 先出。
 * - goujiDuel：0 发 K K，3（对头）已经可以接；goujiWait：同样但窗口没满 2 秒。
 * - burnWindow：1 发 K K，0 能烧（剧本 B），窗口没满 2 秒；burnState：0 烧成、正在烧牌状态下发牌；burnBroken：0 的 A A 被对头 3 用 2 2 解烧。
 * - rang：3 发 6 6，4、5 过，轮到 0 可以让牌；rangReturned：0 让牌后 1、2 都过，回到 0。
 * - jiefeng：0 出完牌走科，这一轮没人压，1 接风发牌、3 变无头。
 * - headless：3 无头，3 发 K K。chaos：0、5 走科后四人乱缠。
 * - handEnd / sweepEnd / revolutionSweepEnd：结算（规则书例 1、例 2、例 3 的变化）。
 * - matchEnd / matchDraw：一场结束（甲赢 / 平局）。
 * - timeout：3 发牌超时、系统替他出了最小的一张。auto：0 托管中。offline：用 previewRoom(state, { offline: [3] }) 显示对手离线。
 */
export function createScene(name: SceneName): GoujiState {
  switch (name) {
    case "opening": {
      // 发完牌先过革命阶段（每盘都有，人人表态「不革命 / 继续」）
      let state = buildDeal({ seed: 7, firstLeader: 0, bots: [1, 2, 3, 4, 5] });
      for (const seat of SEATS) if (state.stage === "revolution") state = applyGouji(state, `p${seat + 1}`, { type: "REVOLT", revolt: false }).state;
      return state;
    }
    case "beforeLead":
      return buildState({ hands: { 0: "3 3 3 5 6 6 9 9 9 9 K K 2 小", 1: 14, 2: 14, 3: 14, 4: 14, 5: 14 }, turn: 0, leader: 0 });
    case "beforeRespond":
      return buildState({ hands: { 0: "4 4 10 10 J J J K K 2 小 大" }, leader: 5, top: { seat: 5, cards: "8 8" } });
    case "tribute":
      return buildDeal({ prevResult: { order: [0, 3, 1, 2, 4, 5], burns: [{ burner: 1, victim: 5 }] }, hands: { 5: "大 2 2 2" }, noWild: [4, 5], seed: 3 });
    case "tributeWaived":
      return applyGouji(createScene("tribute"), "p2", { type: "TRIBUTE", eat: false }).state;
    case "tributeReturn":
      return applyGouji(createScene("tribute"), "p2", { type: "TRIBUTE", eat: true }).state;
    case "antiTribute":
      return buildDeal({ prevResult: { order: [0, 3, 1, 5, 2, 4] }, hands: { 4: "大 大 大 大" }, seed: 4 });
    case "revolution":
      return buildDeal({ noWild: [0], seed: 5, firstLeader: 1 });
    case "revolutionPlay":
      return buildState({ revolutionary: 4, hands: { 0: 20, 1: 20, 2: 20, 3: 20, 5: 20 }, turn: 5, leader: 5 });
    case "goujiDuel":
      return buildState({ hands: { 0: "4 4 10 10 小 2 大", 3: "Q Q 2 2 5 5 8" }, top: { seat: 0, cards: "K K", ready: true } });
    case "goujiWait":
      return buildState({ hands: { 0: "4 4 10 10 小 2 大", 3: "Q Q 2 2 5 5 8" }, top: { seat: 0, cards: "K K" } });
    case "burnWindow":
      return buildState({ hands: { 0: BURN_HAND, 1: 20, 2: 20, 3: 20, 4: 20, 5: 20 }, top: { seat: 1, cards: "K K" } });
    case "burnState":
      return buildState({ hands: { 0: "7 7 7 9 9 小 大", 1: 20, 2: 20, 3: 20, 4: 20, 5: 20 }, burn: { burner: 0, victim: 1 }, leader: 0, turn: 0 });
    case "burnBroken": {
      const window = buildState({ hands: { 0: BURN_HAND, 1: 20, 2: 20, 3: "2 2 5 6 7 8 9 10 J Q K 3 4 4 4 5 6 7 8 9", 4: 20, 5: 20 }, top: { seat: 1, cards: "K K" } });
      const burned = applyGouji(applyGouji(window, "p1", { type: "BURN", cards: parseCards("A A") }).state, "", { type: "TICK" }).state;
      const afterTick = applyGouji(burned, "", { type: "TICK" }).state;
      const twos = afterTick.players[3]!.hand.filter((card) => rankOf(card) === TWO).slice(0, 2);
      return applyGouji(afterTick, "p4", { type: "PLAY", cards: twos }).state;
    }
    case "rang":
      return buildState({ hands: { 0: "7 7 9 9 J J 2", 1: 15, 2: 15, 3: 15, 4: 15, 5: 15 }, entries: [{ seat: 3, cards: "6 6" }, { seat: 4, pass: true }, { seat: 5, pass: true }], passed: [4, 5] });
    case "rangReturned": {
      const rang = applyGouji(createScene("rang"), "p1", { type: "RANG" }).state;
      const one = applyGouji(rang, "p2", { type: "PASS" }).state;
      return applyGouji(one, "p3", { type: "PASS" }).state;
    }
    case "jiefeng": {
      const last = buildState({ hands: { 0: "5 5", 1: 15, 2: 15, 3: 15, 4: 15, 5: 15 }, leader: 0, turn: 0 });
      let state = applyGouji(last, "p1", { type: "PLAY", cards: last.players[0]!.hand }).state;
      for (const seat of [1, 2, 3, 4, 5]) state = applyGouji(state, `p${seat + 1}`, { type: "PASS" }).state;
      return state;
    }
    case "headless":
      return buildState({ finished: [0], headless: [3], hands: { 3: "K K 4 4 6 7 8 9 9 J J", 1: 15, 2: 15, 4: "A A 3 3 5 6 8 10 Q Q", 5: 15 }, top: { seat: 3, cards: "K K" } });
    case "chaos":
      return buildState({ finished: [0, 5], headless: [3, 2], chaos: true, hands: { 1: 12, 2: 9, 3: 10, 4: 8 }, top: { seat: 1, cards: "K K" } });
    case "handEnd":
      return buildState({ stage: "handEnd", finished: [0, 3, 1, 2, 4], hands: { 5: 6 }, burnsThisHand: [], teamScores: [2, -2] });
    case "sweepEnd":
      return buildState({ stage: "handEnd", finished: [1, 5, 3], hands: { 0: 8, 2: 6, 4: 12 }, result: { order: [1, 5, 3], sweep: true }, teamScores: [-12, 12] });
    case "revolutionSweepEnd":
      return buildState({ stage: "handEnd", revolutionary: 4, finished: [0, 2], hands: { 1: 9, 3: 7, 5: 11 }, result: { order: [0, 2, 4], sweep: true }, teamScores: [12, -12] });
    case "matchEnd":
    case "matchDraw": {
      const state = buildState({
        stage: "handEnd",
        options: { hands: 3 },
        handNo: 3,
        finished: [0, 3, 1, 2, 4],
        hands: { 5: 6 },
        teamScores: name === "matchEnd" ? [14, -14] : [0, 0],
      });
      const [a, b] = state.teamScores;
      const winnerTeam: 0 | 1 | null = a > b ? 0 : b > a ? 1 : null;
      state.phase = "finished";
      state.finalResult = {
        winnerTeam,
        winners: state.players.filter((_, seat) => winnerTeam === null || teamOf(seat) === winnerTeam).map((player) => player.id),
        draw: winnerTeam === null,
        teamScores: [a, b],
      };
      return state;
    }
    case "timeout": {
      const state = buildState({ hands: { 3: "4 4 6 9 9 J J Q Q K 2 2", 0: 15, 1: 15, 2: 15, 4: 15, 5: 15 }, turn: 3, leader: 3 });
      return applyGouji(state, "", { type: "TIMEOUT", seats: [3] }).state;
    }
    case "auto":
      return buildState({ auto: [0], hands: { 0: 15, 1: 15, 2: 15, 3: 15, 4: 15, 5: 15 }, turn: 0, leader: 0 });
    case "offline":
      return buildState({ hands: { 0: 15, 1: 15, 2: 15, 3: 15, 4: 15, 5: 15 }, turn: 3, leader: 3 });
  }
}

export interface PreviewRoomOptions {
  /** 从哪个座位看（默认 0）；-1 表示观战。 */
  readonly viewerSeat?: number;
  /** 观战时能不能看全部手牌。 */
  readonly spectatorsSeeAll?: boolean;
  /** 离线的座位（显示「离线」、由人机代打）。 */
  readonly offline?: readonly number[];
  /** 倒计时剩多少毫秒（0 = 已经超时）。 */
  readonly turnRemainingMs?: number;
  /** 房间码（默认 ABC234）。 */
  readonly code?: string;
}

/** 把局面包成某个座位收到的房间快照（和服务器发的 room:updated 一样的结构），预览页、教程直接用。 */
export function previewRoom(state: GoujiState, options: PreviewRoomOptions = {}): LobbyRoomSnapshot {
  const viewer = options.viewerSeat ?? 0;
  const members: LobbyMember[] = state.players
    .map((player, seat) => ({ player, seat }))
    .filter(({ player }) => !player.bot)
    .map(({ player, seat }) => ({
      id: viewer === seat ? "me" : `socket-${seat}`,
      playerId: player.id,
      name: player.name,
      isHost: seat === state.players.findIndex((candidate) => !candidate.bot),
      connected: !options.offline?.includes(seat),
      seat,
    }));
  const game = viewer >= 0 ? redactGouji(state, state.players[viewer]!.id) : spectatorView(state, options.spectatorsSeeAll === true);
  return {
    code: viewer >= 0 ? options.code ?? "ABC234" : "",
    options: { hands: state.config.hands, tribute: state.config.tribute, rang: state.config.rang, peek: state.config.peek },
    status: "playing",
    members,
    spectators: viewer >= 0 ? [] : [{ id: "me", name: "观战的人" }],
    access: { ...DEFAULT_ROOM_ACCESS, spectatorsSeeAll: options.spectatorsSeeAll === true },
    chat: [],
    voice: [],
    ...(options.turnRemainingMs !== undefined ? { turnRemainingMs: options.turnRemainingMs } : {}),
    game,
  };
}
