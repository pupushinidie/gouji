/**
 * 斗地主的对局状态。座位 0–2 按逆时针（出牌顺序）排：i 的下家是 (i+1)%3，上家是 (i+2)%3。
 * 规则书：~/Desktop/游戏规则/斗地主.md。
 */
import type { Card } from "./cards.js";
import type { Combo } from "./combos.js";

export interface DdzOptions {
  /** 底分。 */
  readonly base: 1 | 2 | 5;
  /** 一场打几盘（3 人都不叫重新发牌不算一盘）。 */
  readonly hands: 3 | 6 | 9 | 12;
  /** 明牌：发牌前「明牌开始」×5、地主拿底牌后明牌 ×2。 */
  readonly mingpai: boolean;
  /** 加倍阶段。 */
  readonly doubling: boolean;
  /** 加倍阶段多一个「超级加倍」×4。 */
  readonly superDouble: boolean;
  /** 记牌器：显示每种点数外面还有几张。 */
  readonly tracker: boolean;
}

export interface DdzConfig extends DdzOptions {
  /** 各阶段限时（秒），超时按 timeoutCommand 自动处理。 */
  readonly showStartSec: number;
  readonly bidSec: number;
  readonly doubleSec: number;
  readonly landlordShowSec: number;
  readonly playSec: number;
  readonly handEndSec: number;
}

export type Stage = "showStart" | "bidding" | "robbing" | "doubling" | "landlordShow" | "playing" | "handEnd";

/** 桌上每个人这一轮最近一次的动作（画面显示用）。 */
export type TableEntry = { readonly kind: "play"; readonly cards: Card[]; readonly combo: Combo } | { readonly kind: "pass" };

export interface DdzPlayer {
  readonly id: string;
  readonly name: string;
  /** 空座位上的机器人。 */
  readonly bot: boolean;
  /** 托管：连续超时 2 次自动打开，点「取消托管」关掉。托管时由机器人代打（全站统一的做法）。 */
  auto: boolean;
  /** 连续超时次数。 */
  timeouts: number;
  /** 累计积分。 */
  score: number;
  /** 本盘得失。 */
  handDelta: number;

  /** 手牌（从大到小）。别人的手牌发给你时是空数组（明牌的人除外），张数看 handCount。 */
  hand: Card[];
  handCount: number;
  /** 手牌对所有人公开（明牌开始或地主明牌）。 */
  shown: boolean;
  /** 明牌开始阶段已经表态。 */
  showStartChosen: boolean;
  /** 叫地主、抢地主的表态（没轮到是 null）。 */
  bid: "call" | "noCall" | null;
  rob: "rob" | "noRob" | null;
  /** 加倍系数；3 人都选完之前，别人的发给你是 null（看 doubleChosen）。 */
  double: 1 | 2 | 4 | null;
  doubleChosen: boolean;
  /** 本盘出过几手牌（判春天、反春）。 */
  plays: number;
}

export interface MultiplierParts {
  /** 抢地主次数（每次 ×2）。 */
  readonly robs: number;
  /** 明牌倍数：5 / 2 / 1，多人明牌只取最大。 */
  readonly show: number;
  /** 炸弹 + 王炸个数（每个 ×2）。 */
  readonly bombs: number;
  readonly spring: "spring" | "antiSpring" | null;
  /** 合计 M。 */
  readonly total: number;
}

export interface HandSummary {
  readonly landlord: number;
  readonly landlordWon: boolean;
  /** 先出完的人。 */
  readonly winner: number;
  readonly multiplier: MultiplierParts;
  readonly base: number;
  /** 每个人的加倍系数。 */
  readonly doubles: [number, number, number];
  /** 本盘得失（下标是座位），加起来是 0。 */
  readonly deltas: [number, number, number];
  readonly bottom: Card[];
}

export type DdzCommand =
  /** 明牌开始阶段：明牌开始（×5）或者不明牌。 */
  | { readonly type: "SHOW_START"; readonly show: boolean }
  /** 叫地主 / 不叫。 */
  | { readonly type: "BID"; readonly call: boolean }
  /** 抢地主 / 不抢。 */
  | { readonly type: "ROB"; readonly rob: boolean }
  /** 加倍：1 不加倍、2 加倍、4 超级加倍。 */
  | { readonly type: "DOUBLE"; readonly factor: 1 | 2 | 4 }
  /** 地主拿底牌后明牌（×2）或不明牌。 */
  | { readonly type: "LANDLORD_SHOW"; readonly show: boolean }
  /** 出牌；as 是多种认法时选哪种（comboKey），不给就按能压过的、点数最大的那种。 */
  | { readonly type: "PLAY"; readonly cards: readonly Card[]; readonly as?: string }
  | { readonly type: "PASS" }
  /** 结算画面：准备好下一盘。 */
  | { readonly type: "READY" }
  /** 托管开关。 */
  | { readonly type: "AUTO"; readonly on: boolean };

export type DdzEvent =
  | { readonly type: "HandStarted"; readonly handNo: number }
  | { readonly type: "ShowStart"; readonly seat: number; readonly show: boolean }
  | { readonly type: "Dealt"; readonly firstBidder: number; readonly redeal: number }
  | { readonly type: "Bid"; readonly seat: number; readonly call: boolean }
  | { readonly type: "Rob"; readonly seat: number; readonly rob: boolean; readonly robs: number }
  /** 3 人都不叫，重新洗牌发牌。 */
  | { readonly type: "Redeal"; readonly count: number }
  | { readonly type: "LandlordChosen"; readonly seat: number; readonly bottom: Card[] }
  | { readonly type: "DoublesRevealed"; readonly doubles: number[] }
  | { readonly type: "LandlordShow"; readonly seat: number; readonly show: boolean }
  | { readonly type: "Played"; readonly seat: number; readonly cards: Card[]; readonly combo: Combo; readonly left: number; readonly auto?: boolean }
  | { readonly type: "Passed"; readonly seat: number; readonly auto?: boolean }
  /** 另外两人都不出，这一轮结束，leader 重新出牌。 */
  | { readonly type: "TrickWon"; readonly leader: number }
  | { readonly type: "HandEnded"; readonly handNo: number; readonly summary: HandSummary }
  | { readonly type: "TimedOut"; readonly seat: number }
  | { readonly type: "AutoChanged"; readonly seat: number; readonly on: boolean }
  | { readonly type: "GameEnded"; readonly winners: readonly string[] };

export interface FinalResult {
  readonly winners: string[];
  /** 名次（并列同名次），下标是座位。 */
  readonly ranks: number[];
}

export interface DdzState {
  readonly config: DdzConfig;
  phase: "playing" | "finished";
  players: DdzPlayer[];
  /** 第几盘，从 1 开始（重新发牌不加）。 */
  handNo: number;
  /** 这一盘连续重新发牌了几次（3 人都不叫）。 */
  redeals: number;
  stage: Stage;
  /** 叫地主、抢地主、地主明牌、出牌阶段轮到谁；同时决定的阶段（明牌开始、加倍、结算）是 -1。 */
  turn: number;
  /** 第一个叫的人。 */
  firstBidder: number;
  /** 叫地主的人。 */
  caller: number | null;
  landlord: number | null;
  /** 抢地主次数 0–3。 */
  robs: number;
  /** 最后一个选「抢地主」的人（地主就是他；没人抢就是叫地主的人）。 */
  robber: number | null;
  /** 抢地主阶段还要表态的座位（按顺序；叫地主的人最后一次表态在有人抢过时才加进来）。 */
  robQueue: number[];
  /** 点了明牌开始的人，按点击顺序。 */
  showStarts: number[];
  /** 地主拿底牌后明牌了。 */
  landlordShown: boolean;
  /** 底牌；确定地主前发给玩家的是 3 个 -1。 */
  bottom: Card[];
  /** 本轮当前最大的一手；null 表示该引牌。 */
  lastPlay: { readonly seat: number; readonly cards: Card[]; readonly combo: Combo } | null;
  /** lastPlay 之后连续不出的人数。 */
  passes: number;
  /** 桌上每个座位这一轮的动作（新一轮引牌时清空）。 */
  table: (TableEntry | null)[];
  /** 本盘打出过的所有牌（记牌器用，本来就是公开信息）。 */
  played: Card[];
  /** 本盘炸弹 + 王炸个数。 */
  bombs: number;
  summary: HandSummary | null;
  /** 结算画面里点了「下一盘」的玩家 id。 */
  ready: string[];
  events: DdzEvent[];
  history: DdzEvent[];
  finalResult?: FinalResult;
  version: number;
  /** 每到一个新的决定点（换阶段、轮到下一个人）+1；服务端据此重置计时。 */
  step: number;
  /** 以下只在服务端。 */
  rng?: number;
  seed?: number;
  log?: { seat: number; command: DdzCommand | { type: "TIMEOUT" } }[];
}

export type GameState = DdzState;
export type GameCommand = DdzCommand;
export type GameEvent = DdzEvent;
