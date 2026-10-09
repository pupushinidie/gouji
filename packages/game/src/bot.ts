/**
 * 人机（占位实现，归人机阶段替换成正式策略）。
 *
 * 只能用 redactGameForViewer(game, 自己) 之后的视图：自己的手牌、公开信息、view.you 里自己的烧牌候选。
 * - botCommand：轮到自己（或同时决定的阶段）时，从合法操作里挑一个（不含烧牌）。
 * - botBurn：别人打出可能被烧的够级牌时，要不要烧（轮外操作），不烧返回 null。
 * 占位策略：按 view.version 和座位算一个确定的伪随机数来挑，方便复现。
 */
import { legalCommands } from "./gouji.js";
import type { GoujiCommand, GoujiState } from "./types.js";

function pseudoRandom(view: GoujiState, seat: number, salt: number): number {
  let x = (view.version * 2654435761 + seat * 40503 + salt * 97 + view.handNo * 7919) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

export function botCommand(view: GoujiState, seat: number): GoujiCommand {
  const id = view.players[seat]!.id;
  const options = legalCommands(view, id).filter((command) => command.type !== "BURN");
  if (options.length === 0) throw new Error("人机没有能做的操作。");
  return options[Math.floor(pseudoRandom(view, seat, 1) * options.length)]!;
}

export function botBurn(view: GoujiState, seat: number): GoujiCommand | null {
  const candidates = view.you?.seat === seat ? view.you.burnCandidates : [];
  if (candidates.length === 0 || view.you?.burnRequested) return null;
  if (pseudoRandom(view, seat, 2) < 0.5) return null;
  return { type: "BURN", cards: candidates[Math.floor(pseudoRandom(view, seat, 3) * candidates.length)]! };
}
