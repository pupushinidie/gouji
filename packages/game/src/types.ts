/**
 * 够级的对局状态、操作和事件。规则书：~/Desktop/游戏规则/够级.md，补充和勘误：够级-补充.md。
 *
 * 座位 0–5 逆时针轮流：s 的下家是 s+1，上家是 s−1，对头是 s+3（都按 6 取模）。
 * 甲联邦（team 0）是座位 0、2、4，乙联邦（team 1）是 1、3、5。
 */
import type { Card } from "./cards.js";
import type { PlaySet } from "./sets.js";

/** 开房选项（规则书 8.1）。 */
export interface GoujiOptions {
  /** 一场打几盘（两人以上革命重新发牌不算一盘）。 */
  readonly hands: 1 | 3 | 5 | 8;
  /** 进贡（关掉就是「比赛版」：不进贡，串三户仍然 ±12）。 */
  readonly tribute: boolean;
  /** 让牌。 */
  readonly rang: boolean;
  /** 看牌：手牌剩 10 张或以下时队友能看到全部手牌。 */
  readonly peek: boolean;
}

export interface GoujiConfig extends GoujiOptions {
  /** 各步限时（秒，规则书 9.5），超时按 timeoutCommand 自动处理。 */
  readonly playSec: number;
  /** 让牌后轮回到自己再表态。 */
  readonly rangSec: number;
  /** 队内贡吃 / 免。 */
  readonly tributeSec: number;
  readonly returnSec: number;
  readonly revolutionSec: number;
  /** 一盘结束的结算画面。 */
  readonly handEndSec: number;
  /** 有头的人打出够级牌后，出牌 / 过牌生效 / 本轮结束都要等满这么久（毫秒，勘误 #3）。服务器按它发 TICK。 */
  readonly burnWindowMs: number;
}

export type Stage =
  /** 队内贡：收的人选吃贡或免贡（同时选）。 */
  | "tribute"
  /** 收了落贡 / 串贡的人还贡（同时选）。 */
  | "return"
  /** 没王没 2 的人选革命不革命（同时选）。 */
  | "revolution"
  | "playing"
  /** 一盘结束的结算画面，大家点「下一盘」。 */
  | "handEnd";

/** 名次：0 头科、1 二科、2 三科、3 四科、4 二落、5 大落。 */
export type Place = 0 | 1 | 2 | 3 | 4 | 5;
export const PLACE_NAMES = ["头科", "二科", "三科", "四科", "二落", "大落"] as const;
/** 名次分（6.1）。 */
export const PLACE_POINTS = [4, 2, 0, 0, -2, -4] as const;
export const TEAM_NAMES = ["甲", "乙"] as const;

export interface GoujiPlayer {
  readonly id: string;
  readonly name: string;
  /** 空座位上的人机。 */
  readonly bot: boolean;
  /** 联邦：0 甲（座位 0、2、4），1 乙（座位 1、3、5）。 */
  readonly team: 0 | 1;
  /** 托管：连续超时 2 次自动打开，自己出手或点「取消托管」关掉。托管时由人机代打（全站约定）。 */
  auto: boolean;
  /** 连续超时次数。 */
  timeouts: number;
  /** 累计分（每个成员记自己联邦的分，同一联邦的人一样）。 */
  score: number;
  /** 这一盘的得分。 */
  handDelta: number;
  /** 手牌（从大到小）。看不到的人拿到的是空数组：自己、看牌打开时剩 10 张以下的队友、一盘结束时才看得到。 */
  hand: Card[];
  /** 手牌张数：10 张以下所有人看得到；超过 10 张时别人拿到 null（显示「10+」），自己看得到。 */
  handCount: number | null;
}

/** 桌面上这一轮的每个动作（画面显示用）。 */
export type TableEntry =
  | { readonly seat: number; readonly kind: "play"; readonly cards: Card[]; readonly set: PlaySet; readonly burn: boolean }
  | { readonly seat: number; readonly kind: "pass" }
  | { readonly seat: number; readonly kind: "rang" };

/** 桌面牌（当前最大的一套）。 */
export interface TopPlay {
  /** 一盘里每套牌的编号（烧牌窗口的标识）。 */
  readonly seq: number;
  readonly seat: number;
  readonly cards: Card[];
  readonly set: PlaySet;
  /** 有头的人打出的够级牌（不在四人乱缠里）：可能被烧，接下来的动作要等满 burnWindowMs。 */
  readonly burnable: boolean;
  /** 烧牌窗口已经满 2 秒（不可能被烧的牌一打出就是 true）。 */
  ready: boolean;
  /** 这套是烧牌打出的 S₁。 */
  readonly burn: boolean;
}

export type PlayOrPass = { readonly type: "PLAY"; readonly cards: readonly Card[] } | { readonly type: "PASS" };

export interface Round {
  /** 这一轮发牌的人。 */
  readonly leader: number;
  /** 桌面牌；null 表示该发牌。 */
  top: TopPlay | null;
  /** 这一轮过过牌的人（四人乱缠里每次有人上牌就清空）。 */
  passed: number[];
  /** 让牌（4.7）：seat 让了牌；returned 为 true 表示已经轮回到他，他只能上牌或过牌。 */
  rang: { readonly seat: number; returned: boolean } | null;
  /** 这一轮的动作（画面显示用）。 */
  entries: TableEntry[];
  /** 烧牌窗口没满 2 秒时先收下的正常出牌 / 过牌，满 2 秒才生效（只发给本人）。 */
  pending: { readonly seat: number; readonly command: PlayOrPass; readonly auto?: boolean } | null;
  /** 烧牌窗口没满 2 秒时按下的烧牌，满 2 秒时按「从被烧的人下家起最近」裁决（只发给本人）。 */
  burnRequests: { readonly seat: number; readonly cards: Card[] }[];
}

export type TributeKind =
  /** 烧贡：上一盘被烧的人给烧牌成功的人 1 张，不还。 */
  | "burn"
  /** 落贡：大落给头科 2 张、二落给二科 1 张，还同样张数。 */
  | "luo"
  /** 串贡：上一盘串三户，输的一队每人给自己的对头 1 张，还同样张数。 */
  | "chuan";

export interface TributeItem {
  readonly kind: TributeKind;
  readonly giver: number;
  readonly receiver: number;
  /** 应进几张。 */
  readonly count: number;
  /** 同一联邦内的贡：由收的人选吃贡（true）或免贡（false）。 */
  readonly intra: boolean;
  /** 吃不吃：跨联邦的贡总是 true；队内贡没选是 null（选的过程中别人拿到的也是 null）。 */
  eat: boolean | null;
  /** 实际进的牌（只能是大王、小王、2，从大到小；不够就少进）。吃 / 免都选完才算。 */
  cards: Card[];
  /** 还的牌（还贡的人都选完后才公开；选的过程中只发给还贡的人自己）。 */
  returned: Card[] | null;
}

export interface TributeState {
  readonly items: TributeItem[];
  /** 抗贡的人（发到 4 张大王，不进落贡和串贡）。 */
  readonly antiTribute: number[];
  /** 进贡的牌已经到账。 */
  paid: boolean;
}

export interface RevolutionState {
  /** 可以革命的人（手里没王没 2）。只发给本人。 */
  eligible: number[];
  /** 每个座位的选择；没选是 null（只发给本人）。 */
  choices: (boolean | null)[];
}

export interface BurnRecord {
  readonly burner: number;
  readonly victim: number;
}

/** 一盘的结果（结算画面和下一盘的进贡、首出用）。 */
export interface HandResult {
  readonly handNo: number;
  /** 串三户：一队包揽头科、二科、三科。 */
  readonly sweep: boolean;
  /** 串三户赢的联邦。 */
  readonly sweepTeam: 0 | 1 | null;
  /** 按名次排的座位（头科在前）；串三户只有前三名。 */
  readonly order: number[];
  /** 每个座位的名次（下标是座位）；串三户时输的一队是 null。 */
  readonly places: (Place | null)[];
  readonly revolutionary: number | null;
  /** 这盘成功的烧牌（按发生的先后），下一盘进烧贡。 */
  readonly burns: BurnRecord[];
  /** 两队这盘的分（合计 0）。 */
  readonly teamDeltas: [number, number];
  /** 每个座位这盘的分（= 自己联邦的分）。 */
  readonly deltas: number[];
}

export interface FinalResult {
  /** 赢的联邦；平局是 null。 */
  readonly winnerTeam: 0 | 1 | null;
  /** 胜者的玩家 id（平局时所有人并列）。 */
  readonly winners: string[];
  readonly draw: boolean;
  readonly teamScores: [number, number];
}

/** 只放在发给某位玩家的视图里的私人信息（redactGameForViewer 算出来；服务器上的完整状态里没有）。 */
export interface PrivateView {
  readonly seat: number;
  /** 现在能烧牌：每种候选 S₁ 一组牌；不能烧是空数组。只有本人知道（规则书 4.12、9.4）。 */
  readonly burnCandidates: Card[][];
  /** 已经按了烧牌、等窗口满 2 秒生效。 */
  readonly burnRequested: Card[] | null;
  /** 烧牌窗口里已经选好的出牌 / 过牌（满 2 秒生效）。 */
  readonly pendingAction: PlayOrPass | null;
  /** 现在可以选革命。 */
  readonly canRevolt: boolean;
}

export type GoujiCommand =
  /** 发牌或上牌。 */
  | { readonly type: "PLAY"; readonly cards: readonly Card[] }
  /** 过牌（发牌的人不能过）。 */
  | { readonly type: "PASS" }
  /** 让牌（4.7）。 */
  | { readonly type: "RANG" }
  /** 烧牌：cards 是 S₁。不用轮到自己。 */
  | { readonly type: "BURN"; readonly cards: readonly Card[] }
  /** 队内贡：吃贡（true）或免贡（false）。item 是 tribute.items 的下标，不给就是自己第一份没选的。 */
  | { readonly type: "TRIBUTE"; readonly eat: boolean; readonly item?: number }
  /** 还贡：张数等于实际收到的贡牌数。 */
  | { readonly type: "RETURN"; readonly cards: readonly Card[] }
  /** 革命 / 不革命。 */
  | { readonly type: "REVOLT"; readonly revolt: boolean }
  /** 结算画面：准备好下一盘。 */
  | { readonly type: "READY" }
  /** 托管开关。 */
  | { readonly type: "AUTO"; readonly on: boolean };

/** 系统操作（只有服务器发）：超时、烧牌窗口满 2 秒。 */
export type SystemCommand = { readonly type: "TIMEOUT"; readonly seats?: readonly number[] } | { readonly type: "TICK" };

export type GoujiEvent =
  | { readonly type: "HandStarted"; readonly handNo: number; readonly firstLeader: number }
  | { readonly type: "Dealt"; readonly redeal: number }
  /** 发到 4 张大王：不进落贡、串贡。 */
  | { readonly type: "AntiTribute"; readonly seat: number }
  /** 队内贡的选择（选完才公开）。 */
  | { readonly type: "TributeChosen"; readonly giver: number; readonly receiver: number; readonly kind: TributeKind; readonly eat: boolean }
  /** 进贡（所有人看得到牌）；cards 少于 count 是欠的不补。 */
  | { readonly type: "TributePaid"; readonly giver: number; readonly receiver: number; readonly kind: TributeKind; readonly count: number; readonly cards: Card[] }
  | { readonly type: "TributeReturned"; readonly from: number; readonly to: number; readonly cards: Card[] }
  | { readonly type: "Revolted"; readonly seat: number }
  /** 两人以上革命：这盘作废重新发牌（不进贡，首出不变）。 */
  | { readonly type: "RevolutionRedeal"; readonly seats: number[] }
  | { readonly type: "FirstLead"; readonly seat: number }
  /** 出牌。left 是剩几张（超过 10 张是 null）。 */
  | { readonly type: "Played"; readonly seat: number; readonly cards: Card[]; readonly label: string; readonly gouji: boolean; readonly lead: boolean; readonly left: number | null; readonly auto?: boolean }
  | { readonly type: "Passed"; readonly seat: number; readonly auto?: boolean }
  | { readonly type: "Rang"; readonly seat: number }
  /** 烧牌成立：burner 打出 S₁，进入烧牌状态。 */
  | { readonly type: "BurnStarted"; readonly burner: number; readonly victim: number }
  /** 烧牌失败（解烧）：by 压住了烧牌的人；counter 表示是被烧的人反过来压住（反烧）。 */
  | { readonly type: "BurnBroken"; readonly burner: number; readonly victim: number; readonly by: number; readonly counter: boolean }
  /** 烧牌成功：烧牌的人出完了。 */
  | { readonly type: "BurnSucceeded"; readonly burner: number; readonly victim: number }
  /** 走科：order 是第几个出完（0 起）。 */
  | { readonly type: "WentOut"; readonly seat: number; readonly order: number }
  /** 一轮结束：winner 赢下这一轮；leader 发下一轮（winner 已走科时是接风的人）。 */
  | { readonly type: "RoundEnded"; readonly winner: number; readonly leader: number; readonly jiefeng: boolean }
  /** 这些人从这一轮结束起无头（对头走科了）。 */
  | { readonly type: "Headless"; readonly seats: number[] }
  | { readonly type: "ChaosStarted" }
  | { readonly type: "HandEnded"; readonly handNo: number; readonly result: HandResult }
  | { readonly type: "TimedOut"; readonly seat: number }
  | { readonly type: "AutoChanged"; readonly seat: number; readonly on: boolean }
  | { readonly type: "GameEnded"; readonly winnerTeam: 0 | 1 | null };

export interface GoujiState {
  readonly config: GoujiConfig;
  phase: "playing" | "finished";
  stage: Stage;
  /** 第几盘，从 1 开始（重新发牌不加）。 */
  handNo: number;
  /** 这一盘因为两人以上革命重新发了几次牌。 */
  redeals: number;
  /** 下标就是座位号。 */
  players: GoujiPlayer[];
  /** 两队的累计分。 */
  teamScores: [number, number];
  /** 出牌阶段轮到谁；同时决定的阶段（进贡、还贡、革命、结算）和「等烧牌窗口满 2 秒再结束这一轮」时是 -1。 */
  turn: number;
  /** 这一盘该先出的人（3.5，革命前定下；他革命了由下一个没革命的下家先出）。 */
  firstLeader: number;
  /** 这一盘的革命者。 */
  revolutionary: number | null;
  /** 革命者扣下的手牌（不参与任何判定；只发给他自己）。 */
  revolutionHand: Card[];
  /** 走科顺序（不含革命者）。 */
  finished: number[];
  /** 这一轮走科的人（这一轮结束时他们的对头变成无头）。 */
  goneThisRound: number[];
  /** 无头（下标是座位）。 */
  headless: boolean[];
  /** 四人乱缠。 */
  chaos: boolean;
  /** 当前这一轮（出牌阶段才有）。 */
  round: Round | null;
  /** 上一轮（回看用）。 */
  lastRound: { readonly entries: TableEntry[]; readonly winner: number } | null;
  /** 当前的烧牌状态。 */
  burn: BurnRecord | null;
  /** 这一盘成功的烧牌（按先后）。 */
  burnsThisHand: BurnRecord[];
  /** 这一盘的进贡（第 2 盘起、开房选项打开时）。 */
  tribute: TributeState | null;
  /** 革命阶段的选择。 */
  revolution: RevolutionState | null;
  /** 上一盘的结果（进贡、首出用）。 */
  prevResult: HandResult | null;
  /** 这一盘的结果（结算画面）。 */
  result: HandResult | null;
  /** 这一盘打出过的牌（公开）。 */
  discard: Card[];
  /** 结算画面里点了「下一盘」的玩家 id。 */
  ready: string[];
  /** 每套牌的编号计数。 */
  playSeq: number;
  events: GoujiEvent[];
  history: GoujiEvent[];
  finalResult?: FinalResult;
  /** 每次有公开的变化 +1（网页靠它触发动画）。烧牌窗口里先收下的动作只有本人看得到，不加。 */
  version: number;
  /** 每到一个新的决定点（换阶段、轮到下一个人）+1；服务器据此重置计时。烧牌（轮外操作）不会单独让它变。 */
  step: number;
  /** 只在发给玩家的视图里：这位玩家自己的私人信息。 */
  you?: PrivateView;
  /** 以下只在服务端。 */
  rng?: number;
  seed?: number;
}

export type GameState = GoujiState;
export type GameCommand = GoujiCommand;
export type GameEvent = GoujiEvent;
