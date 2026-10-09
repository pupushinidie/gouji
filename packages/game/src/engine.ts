/**
 * 服务端和网页只调这里：对局的创建、操作、超时、烧牌窗口、人机、隐藏信息。
 */
import { botBurn as goujiBotBurn, botCommand as goujiBotCommand } from "./bot.js";
import {
  applyGouji,
  burnWindowKey as goujiBurnWindowKey,
  createGouji,
  legalCommands as goujiLegal,
  pendingSeats as goujiPending,
  redactGouji,
  spectatorView as goujiSpectatorView,
  stepSeconds as goujiStepSeconds,
  timeoutCommand as goujiTimeoutCommand,
  topKey as goujiTopKey,
  type NewPlayer,
} from "./gouji.js";
import { burnEligibleSeats as goujiBurnEligible } from "./turn.js";
import type { Rng } from "./rng.js";
import type { GoujiConfig, GoujiOptions, GameCommand, GameState } from "./types.js";

export type { NewPlayer };
export type GameOptions = GoujiOptions;

/** players 按座位 0–5 的顺序给（选座就是选队）。 */
export function createGame(players: readonly NewPlayer[], seed: number, options: Partial<GameOptions> = {}, overrides: Partial<GoujiConfig> = {}): GameState {
  return createGouji(players, seed, options, overrides);
}

/** 玩家（或人机）的操作。不合法时抛出带中文说明的错误。rng 可以不给（用状态里的种子随机数）。 */
export function applyCommand(state: GameState, playerId: string, command: GameCommand, rng?: Rng): GameState {
  return applyGouji(state, playerId, command, rng).state;
}

/** 系统操作：到时间了，给还没决定的人（seats 只给这些座位）套用默认动作（连续超时 2 次转托管）。 */
export function timeoutTurn(state: GameState, seats?: readonly number[]): GameState {
  return applyGouji(state, "", { type: "TIMEOUT", ...(seats ? { seats } : {}) }).state;
}

/** 系统操作：烧牌窗口满 2 秒（服务器在 burnWindowKey 出现后 config.burnWindowMs 毫秒时调用）。 */
export function tickBurnWindow(state: GameState): GameState {
  return applyGouji(state, "", { type: "TICK" }).state;
}

/** 现在要做决定的座位（烧牌不算）。 */
export const pendingSeats = (state: GameState) => goujiPending(state);
/** 当前这一步的限时（秒）。 */
export const stepSeconds = (state: GameState) => goujiStepSeconds(state);
/** 人机：轮到自己时的操作。view 必须是 redactGameForViewer(game, 这个座位的 id)。 */
export const botCommand = (view: GameState, seat: number): GameCommand => goujiBotCommand(view, seat);
/** 人机：要不要烧（不烧返回 null）。view 必须是这个座位的视图。 */
export const botBurn = (view: GameState, seat: number): GameCommand | null => goujiBotBurn(view, seat);
export const timeoutCommand = (state: GameState, seat: number): GameCommand => goujiTimeoutCommand(state, seat);
export const redactGameForViewer = (state: GameState, viewerId: string): GameState => redactGouji(state, viewerId);
/** 观战的人看到的对局（seeAll = 房主打开了「观战看手牌」）。 */
export const spectatorView = (state: GameState, seeAll: boolean): GameState => goujiSpectatorView(state, seeAll);
/** 决定点的标识；变了就重新计时。烧牌窗口里先收下的动作不会让它变。 */
export const timerKey = (state: GameState) => `${state.handNo}:${state.step}`;
/** 烧牌窗口：有值时服务器在 config.burnWindowMs 后发 TICK。 */
export const burnWindowKey = (state: GameState) => goujiBurnWindowKey(state);
/** 当前桌面牌的标识（给人机安排烧牌决定用）。 */
export const topKey = (state: GameState) => goujiTopKey(state);
/** 现在能烧牌的座位（只给服务器给人机安排烧牌用，不要发给浏览器）。 */
export const burnEligibleSeats = (state: GameState) => goujiBurnEligible(state);
/** 列表、日志里显示的分数（联邦累计分）。 */
export const scoreOf = (state: GameState, seat: number): number => state.players[seat]!.score;
/** 这位玩家现在能发的操作（测试、调试牌桌用）。 */
export const legalCommands = (state: GameState, playerId: string) => goujiLegal(state, playerId);
