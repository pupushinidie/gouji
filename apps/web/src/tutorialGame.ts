/**
 * 够级和教程有关的部分（共用的 tutorial/ 文件夹之外，每款游戏自己写的）：
 * 游戏 id、「提示」怎么说、「第一次遇到」小贴士什么时候出。
 */
import { botHint, canRang, oppOf, type GameCommand, type GameState } from "@gouji/game";

/** 本机记录（gm-tutorial-<id>、gm-tips-<id>）用的游戏 id。 */
export const GAME_ID = "gouji";

export interface Hint {
  readonly say: string;
  readonly note?: string;
  /** 高亮哪个元素（data-tutorial）；null 不指。 */
  readonly anchor: string | null;
  /** 建议的操作（出牌、烧牌、还贡时牌桌会替你选好牌）。 */
  readonly command?: GameCommand;
}

function anchorOf(command: GameCommand): string | null {
  switch (command.type) {
    case "PLAY":
      return "btn-play";
    case "PASS":
      return "btn-pass";
    case "RANG":
      return "btn-rang";
    case "BURN":
      return "btn-burn";
    case "RETURN":
      return "btn-return";
    case "TRIBUTE":
      return command.eat ? "btn-eat" : "btn-skip";
    case "REVOLT":
      return command.revolt ? "btn-revolt" : "btn-continue";
    default:
      return null;
  }
}

/** 「提示」：让人机从你的位置算一步（界面拿到的本来就是你能看到的那份），配一句原因。 */
export function hintFor(game: GameState, playerId: string): Hint {
  if (game.phase === "finished") return { say: "这一场已经结束了。", anchor: null };
  const seat = game.players.findIndex((player) => player.id === playerId);
  const decision = seat >= 0 ? botHint(game, seat) : null;
  if (!decision) return { say: "现在不用你做决定，等一下。", anchor: null };
  const command = decision.command;
  let say = "我会这么走。";
  if (command.type === "PLAY") say = "我会出替你选好的这几张。";
  else if (command.type === "PASS") say = "我会过。";
  else if (command.type === "RANG") say = "我会让牌。";
  else if (command.type === "BURN") say = "能烧，我会烧！";
  else if (command.type === "RETURN") say = "我会还替你选好的这几张。";
  else if (command.type === "TRIBUTE") say = command.eat ? "我会吃贡。" : "我会免贡。";
  else if (command.type === "REVOLT") say = command.revolt ? "我会革命。" : "我会继续。";
  return { say, note: decision.reason, anchor: anchorOf(command), command };
}

/** 「第一次遇到」小贴士的内容。 */
export const TIPS = {
  gouji: { title: "够级牌", text: "10 要 5 张、J 4 张、Q 3 张、K 和 A 2 张，单张 2 或带王的牌也是。够级牌只有出牌人的对头能管（别人能烧）。" },
  "burn-ready": { title: "你可以烧牌", text: "火苗按钮只有你看得到：先压住这手够级牌，之后除了最后一套每套都挂王，一口气出完就烧成功。这一轮过过牌就不能烧。" },
  rang: { title: "让牌", text: "对头出普通牌时可以先让下家、下下家（你的队友）接；他们都没上会回到你，有人上了你就算过了。" },
  revolt: { title: "可以革命", text: "你手里一张王和 2 都没有：革命的话这盘不打，算四科 0 分，几乎总是划算。两人以上同时革命会重新发牌。" },
  jiefeng: { title: "接风", text: "出完牌的人赢下这一轮时，由他后面第一个还有牌的人接着发牌。" },
  headless: { title: "无头", text: "对头出完了的人叫无头：他的够级牌谁都能接，他也能接任何人的够级牌，但不能烧。" },
  chaos: { title: "四人乱缠", text: "第 2 个人出完的那一轮打完后：没有够级、烧牌、让牌，过了也还能再接。" },
  sweep: { title: "串三户", text: "一队包揽头科、二科、三科：每人 ±12，这盘立刻结束。下一盘输的一队每人给对头进 1 张贡。" },
  tribute: { title: "进贡", text: "大落给头科 2 张、二落给二科 1 张，只进大王、小王、2；收的人还同样张数。进的牌大家都看得到。" },
} as const;

/** 这一步该出哪些小贴士（按优先顺序；只出第一条没看过的）。 */
export function detectTips(game: GameState, selfId: string): string[] {
  const ids: string[] = [];
  const self = game.players.findIndex((player) => player.id === selfId);
  if (self < 0) return ids;
  if ((game.you?.burnCandidates.length ?? 0) > 0) ids.push("burn-ready");
  if (game.you?.canRevolt) ids.push("revolt");
  if (game.stage === "playing" && game.turn === self && canRang(game, self)) ids.push("rang");
  for (const event of game.events) {
    if (event.type === "Played" && event.gouji && !game.chaos && event.seat === oppOf(self)) ids.push("gouji");
    if (event.type === "RoundEnded" && event.jiefeng) ids.push("jiefeng");
    if (event.type === "Headless") ids.push("headless");
    if (event.type === "ChaosStarted") ids.push("chaos");
    if (event.type === "HandEnded" && event.result.sweep) ids.push("sweep");
    if (event.type === "TributePaid") ids.push("tribute");
  }
  return ids;
}
