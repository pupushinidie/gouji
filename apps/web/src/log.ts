/** 动作记录的文案（牌桌右栏、结算）。名字由调用方给（自己显示成「你」）。 */
import { cardsText, setLabel, TEAM_NAMES, type GameState } from "@gouji/game";

export const KIND_NAMES = { burn: "烧贡", luo: "落贡", chuan: "串贡" } as const;

export type GameEvent = GameState["history"][number];

export function eventText(event: GameEvent, name: (seat: number) => string): string | null {
  switch (event.type) {
    case "HandStarted":
      return `第 ${event.handNo} 盘开始`;
    case "Dealt":
      return event.redeal > 0 ? "重新洗牌发牌" : null;
    case "AntiTribute":
      return `${name(event.seat)} 发到 4 张大王：抗贡`;
    case "TributeChosen":
      return `${name(event.receiver)} ${event.eat ? "吃" : "免"}了队友 ${name(event.giver)} 的${KIND_NAMES[event.kind]}`;
    case "TributePaid":
      return `${name(event.giver)} → ${name(event.receiver)} ${KIND_NAMES[event.kind]}：${cardsText(event.cards) || "没有王和 2，不用进"}`;
    case "TributeReturned":
      return `${name(event.from)} 还给 ${name(event.to)}：${cardsText(event.cards)}`;
    case "Revolted":
      return `${name(event.seat)} 革命：这盘不出牌，算四科`;
    case "RevolutionRedeal":
      return `${event.seats.map(name).join("、")} 都革命，重新发牌（不进贡）`;
    case "FirstLead":
      return `${name(event.seat)} 先出`;
    case "Played":
      return `${name(event.seat)} ${event.lead ? "发" : "上"} ${event.label}${event.gouji ? "（够级）" : ""}${event.left === null ? "" : `，剩 ${event.left} 张`}${event.auto ? "（超时）" : ""}`;
    case "Passed":
      return `${name(event.seat)} 过${event.auto ? "（超时）" : ""}`;
    case "Rang":
      return `${name(event.seat)} 让牌`;
    case "BurnStarted":
      return `${name(event.burner)} 烧 ${name(event.victim)}！`;
    case "BurnBroken":
      return `${name(event.by)} ${event.counter ? "反烧" : "解烧"}，${name(event.burner)} 烧牌失败`;
    case "BurnSucceeded":
      return `${name(event.burner)} 烧牌成功，下盘 ${name(event.victim)} 进 1 张烧贡`;
    case "WentOut":
      return `${name(event.seat)} 出完了：${["头科", "二科", "三科", "四科", "二落", "大落"][event.order] ?? "走科"}`;
    case "RoundEnded":
      return event.jiefeng ? `${name(event.winner)} 赢下这一轮，${name(event.leader)} 接风` : `${name(event.winner)} 赢下这一轮`;
    case "Headless":
      return `${event.seats.map(name).join("、")} 的对头出完了：无头`;
    case "ChaosStarted":
      return "两个人出完了：四人乱缠开始";
    case "HandEnded":
      return `第 ${event.handNo} 盘结束：甲联邦 ${signed(event.result.teamDeltas[0])}，乙联邦 ${signed(event.result.teamDeltas[1])}${event.result.sweep ? `（${TEAM_NAMES[event.result.sweepTeam!]}联邦串三户）` : ""}`;
    case "TimedOut":
      return `${name(event.seat)} 超时`;
    case "AutoChanged":
      return `${name(event.seat)} ${event.on ? "进入托管（人机代打）" : "取消托管"}`;
    case "GameEnded":
      return event.winnerTeam === null ? "一场结束：平局" : `一场结束：${TEAM_NAMES[event.winnerTeam]}联邦赢`;
  }
}

export const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

/** 一套牌的读法（「3 张 Q 挂小王」）。 */
export { setLabel };
