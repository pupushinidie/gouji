/**
 * 服务端和网页只调这里：对局的创建、操作、超时、机器人、隐藏信息。
 */
import { botCommand as ddzBotCommand } from "./bot.js";
import { applyDdz, createDdz, legalCommands as ddzLegal, pendingSeats as ddzPending, redactDdz, stepSeconds as ddzStepSeconds, timeoutCommand as ddzTimeoutCommand, type NewPlayer } from "./ddz.js";
import type { DdzOptions, GameCommand, GameState } from "./types.js";

export type { NewPlayer };
export type GameOptions = DdzOptions;

export function createGame(players: readonly NewPlayer[], seed: number, options: Partial<GameOptions> = {}): GameState {
  return createDdz(players, seed, options);
}

/** 玩家（或机器人）的操作。不合法时抛出带中文说明的错误。 */
export function applyCommand(state: GameState, playerId: string, command: GameCommand): GameState {
  return applyDdz(state, playerId, command).state;
}

/** 系统操作：到时间了，给还没决定的人（seats 只给这些座位）套用默认动作（连续超时 2 次转托管）。 */
export function timeoutTurn(state: GameState, seats?: readonly number[]): GameState {
  return applyDdz(state, "", { type: "TIMEOUT", ...(seats ? { seats } : {}) }).state;
}

/** 现在要做决定的座位。 */
export const pendingSeats = (state: GameState) => ddzPending(state);
/** 当前这一步的限时（秒）。 */
export const stepSeconds = (state: GameState) => ddzStepSeconds(state);
export const botCommand = (state: GameState, seat: number): GameCommand => ddzBotCommand(state, seat);
export const timeoutCommand = (state: GameState, seat: number): GameCommand => ddzTimeoutCommand(state, seat);
export const redactGameForViewer = (state: GameState, viewerId: string): GameState => redactDdz(state, viewerId);
/** 决定点的标识；变了就重新计时。 */
export const timerKey = (state: GameState) => `${state.handNo}:${state.step}`;
/** 列表、日志里显示的分数。 */
export const scoreOf = (state: GameState, seat: number): number => state.players[seat]!.score;
/** 这位玩家现在能发的操作（测试用）。 */
export const legalCommands = (state: GameState, playerId: string) => ddzLegal(state, playerId);
