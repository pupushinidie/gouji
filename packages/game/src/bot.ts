/**
 * 人机「普通」难度（补充文件第一节）：像一个认真玩、会算账的普通玩家。
 *
 * 只能用 redactGameForViewer(game, 自己) 之后的视图：自己的手牌、公开信息（出过的牌、张数 ≤10、看牌可见的队友手牌）、
 * view.you 里自己的烧牌候选。不读别人的手牌、种子、别人的烧牌资格。
 *
 * - botDecision：轮到自己（或同时决定的阶段）时的操作 + 一句玩家听得懂的理由（教程「提示」按钮用）。
 * - botBurnDecision：别人打出可能被烧的够级牌时要不要烧（轮外操作），不烧返回 null。
 *
 * 思路：
 * - 手牌按点数分组，一组普通牌（3～A）就是一套，2 和王是「配牌」，挂上去让一套变大、变成够级牌。
 * - 发牌：能一口气出完就出完；挂大王（或者大王都见过了以后挂小王）的套谁也压不了，够数时连着出，最后一套随便；
 *   队友快走了就喂他能接的小牌；否则出最小、张数多的普通牌组，大牌留着抢发牌权。
 * - 接牌：每种能压的出法算一个「代价」（用掉的 2 和王、拆开的组、拆掉的够级门槛、用掉的大点数），
 *   代价低于这一手的门槛才压；门槛随局面变：对头够级时高一点、手牌少了高一点、对手快走了 / 要挡串三户时很高。
 *   队友的牌不压（除非一手出完）；要过牌时能让牌就让。
 * - 烧牌：基本能烧就烧，挑富余王最多、挂大王的 S₁；烧牌状态下先出挂王的套，不挂王的留到最后。
 * - 还贡：不还 2 和王，不拆够级组，先还孤张小牌。革命：能革就革。队内贡：吃。
 */
import { ACE, BIG_JOKER, groupByRank, rankCounts, rankLabel, rankOf, SMALL_JOKER, sortCards, TWO, type Card } from "./cards.js";
import { burnLeadDefault, legalCommands, needsReturn } from "./gouji.js";
import { beatingMoves, GOUJI_THRESHOLD, legalBurnLead, parseSet, setLabel } from "./sets.js";
import { canRang, nextSeat, oppOf, teamOf } from "./turn.js";
import type { GoujiCommand, GoujiState } from "./types.js";

export interface BotDecision {
  readonly command: GoujiCommand;
  /** 一句玩家听得懂的理由。 */
  readonly reason: string;
}

/** 可调参数（模拟脚本调参用）。 */
export const BOT_TUNING = {
  /** 接牌的基本门槛：代价不超过它才压。 */
  baseThreshold: 1.0,
  /** 对头出够级牌时的门槛。 */
  duelThreshold: 2.6,
  /** 手牌 ≤10 张时门槛加多少，≤5 张再加多少。 */
  shortHandBonus: 2.0,
  veryShortBonus: 1.5,
  /** 出牌的对手剩 ≤5 张时门槛加多少（不让他拿回发牌权）。 */
  blockBonus: 2.5,
  /** 压上以后下一手能一口气出完时代价减多少。 */
  finishBonus: 3.0,
  /** 我方已拿头科、二科，我是第三个人时门槛加多少。 */
  sweepGoBonus: 4.0,
  /** 配牌的代价。 */
  twoCost: 1.0,
  smallCost: 1.8,
  bigCost: 4.0,
  /** 烧牌：富余王 = 0、剩下的王没有大王、未见大王 ≥ 这么多、对头 >10 张时不烧。 */
  burnRiskUnseenBig: 2,
  /** 被烧的是队友、而且他剩 ≤ 这么多张时不烧。 */
  burnSpareTeammate: 6,
  /** 革命：能革就革。 */
  revolt: true,
  /** 队内贡：吃。 */
  eatTribute: true,
  /** 让牌：要过牌时能让就让。 */
  rang: true,
  /** 喂牌：看得到手牌的队友剩 ≤ 这么多张时喂。 */
  feedLimit: 8,
};

export type BotTuning = typeof BOT_TUNING;
let tuning: BotTuning = { ...BOT_TUNING };

/** 模拟脚本临时换参数（返回之前的参数）。 */
export function setBotTuning(next: Partial<BotTuning>): BotTuning {
  const before = tuning;
  tuning = { ...tuning, ...next };
  return before;
}

const isNaturalRank = (rank: number) => rank <= ACE;
/** 视图里别人的手牌是空数组，所以「还在打」要看张数（>10 张是 null）。 */
const isActive = (view: GoujiState, seat: number) => seat !== view.revolutionary && (view.players[seat]!.handCount ?? 99) > 0;
const label = (cards: readonly Card[]) => {
  const set = parseSet(cards);
  return set ? setLabel(set) : `${cards.length} 张牌`;
};
const seatName = (view: GoujiState, seat: number) => view.players[seat]?.name || `${seat + 1} 号`;

interface Ctx {
  readonly view: GoujiState;
  readonly seat: number;
  readonly hand: Card[];
  readonly counts: number[];
  readonly groups: Card[][];
  /** 没见过的大王（4 − 出过的 − 我手里的 − 看得到的队友手里的）。 */
  readonly unseenBig: number;
}

function makeCtx(view: GoujiState, seat: number): Ctx {
  const hand = view.players[seat]!.hand;
  const seen = rankCounts([...view.discard, ...hand, ...view.players.flatMap((player, other) => (other !== seat ? player.hand : []))]);
  return { view, seat, hand, counts: rankCounts(hand), groups: groupByRank(hand), unseenBig: Math.max(0, 4 - seen[BIG_JOKER]!) };
}

const naturalRanks = (counts: readonly number[]) => {
  const ranks: number[] = [];
  for (let rank = 3; rank <= ACE; rank += 1) if (counts[rank]! > 0) ranks.push(rank);
  return ranks;
};

const isGoujiGroup = (rank: number, count: number) => GOUJI_THRESHOLD[rank] !== undefined && count >= GOUJI_THRESHOLD[rank]!;

/** 剩下的牌是一套合法的牌（一口气出完）。 */
const isOneSet = (cards: readonly Card[]) => cards.length > 0 && parseSet(cards) !== null;

function minus(hand: readonly Card[], cards: readonly Card[]): Card[] {
  const out = new Set(cards);
  return hand.filter((card) => !out.has(card));
}

/** 还在打的对手剩几张（>10 张看不到，按 99 算）。 */
function opponentsLeft(ctx: Ctx): number[] {
  const { view, seat } = ctx;
  return view.players.flatMap((player, other) => (teamOf(other) !== teamOf(seat) && isActive(view, other) ? [player.handCount ?? 99] : []));
}

/** 串三户形势：四人乱缠里某一队已经拿了头科、二科。 */
function sweepTeamThreat(view: GoujiState): 0 | 1 | null {
  const [first, second] = view.finished;
  if (first === undefined || second === undefined || view.finished.length !== 2) return null;
  return teamOf(first) === teamOf(second) ? teamOf(first) : null;
}

// ---------------------------------------------------------------------------
// 接牌：每种能压的出法的代价

function moveCost(ctx: Ctx, cards: readonly Card[]): number {
  const set = parseSet(cards)!;
  let cost = set.twos * tuning.twoCost + set.small * tuning.smallCost + set.big * tuning.bigCost;
  if (set.base !== null && isNaturalRank(set.base)) {
    const have = ctx.counts[set.base]!;
    const left = have - set.naturals;
    if (left > 0) {
      cost += 1.2; // 拆开一组
      if (isGoujiGroup(set.base, have) && !isGoujiGroup(set.base, left)) cost += 2; // 拆掉够级门槛
    } else cost -= 0.5; // 整组出掉，少一手
    if (set.base >= 13) cost += 0.8;
    else if (set.base >= 11) cost += 0.4;
  }
  return cost;
}

function respond(ctx: Ctx): BotDecision {
  const { view, seat, hand } = ctx;
  const round = view.round!;
  const top = round.top!;
  const owner = top.seat;
  const moves = beatingMoves(hand, top.set);
  const passCmd: GoujiCommand = { type: "PASS" };

  // 一手出完
  const finishing = moves.find((cards) => cards.length === hand.length);
  if (finishing) return { command: { type: "PLAY", cards: finishing }, reason: `压上 ${label(finishing)} 就出完了，走科！` };

  const mine = teamOf(seat);
  if (teamOf(owner) === mine) return { command: passCmd, reason: `这是队友 ${seatName(view, owner)} 的牌，不压。` };

  // 每种出法的代价，挑最便宜的
  let best: { cards: Card[]; cost: number } | null = null;
  for (const cards of moves) {
    let cost = moveCost(ctx, cards);
    if (isOneSet(minus(hand, cards))) cost -= tuning.finishBonus; // 压上以后下一手能一口气出完
    if (!best || cost < best.cost) best = { cards, cost };
  }

  const myLeft = hand.length;
  const ownerLeft = view.players[owner]!.handCount ?? 99;
  const duel = top.set.gouji && owner === oppOf(seat) && !view.headless[owner] && !view.chaos;
  let threshold = duel ? tuning.duelThreshold : tuning.baseThreshold;
  if (myLeft <= 10) threshold += tuning.shortHandBonus;
  if (myLeft <= 5) threshold += tuning.veryShortBonus;
  if (ownerLeft <= 5) threshold += tuning.blockBonus;
  const sweep = view.chaos ? sweepTeamThreat(view) : null;
  const blockSweep = sweep !== null && sweep !== mine && teamOf(owner) === sweep;
  if (blockSweep) threshold = 99;
  else if (sweep === mine) threshold += tuning.sweepGoBonus;

  if (best && best.cost <= threshold) {
    const set = parseSet(best.cards)!;
    let reason: string;
    if (blockSweep) reason = `对面已经拿了头科、二科，绝不能让 ${seatName(view, owner)} 第三个走，用 ${label(best.cards)} 压住。`;
    else if (duel) reason = `对头出了 ${setLabel(top.set)}，用 ${label(best.cards)} 够回去。`;
    else if (ownerLeft <= 5) reason = `${seatName(view, owner)} 只剩 ${ownerLeft} 张，不能让他拿回发牌权，用 ${label(best.cards)} 压住。`;
    else if (isOneSet(minus(hand, best.cards))) reason = `压上 ${label(best.cards)}，拿到发牌权下一手就能出完。`;
    else if (round.passed.includes(seat)) reason = `刚才过过牌，但这是对头的牌，还能接：出 ${label(best.cards)}。`;
    else if (set.small + set.big + set.twos === 0) reason = `用 ${label(best.cards)} 压住，不用配牌，划算。`;
    else reason = `用 ${label(best.cards)} 压住，抢发牌权。`;
    return { command: { type: "PLAY", cards: best.cards }, reason };
  }

  // 不压：能让牌就让（让牌后下家、下下家都没上，还会回到我）
  if (tuning.rang && canRang(view, seat)) {
    const mate = (seat + 2) % 6;
    const nextLeft = view.players[nextSeat(seat)]!.handCount ?? 99;
    if (isActive(view, mate) && !round.passed.includes(mate) && nextLeft > 4) {
      return { command: { type: "RANG" }, reason: "先让一手，看队友能不能接；没人上还会回到我。" };
    }
  }
  let reason: string;
  if (!best) reason = duel ? `对头的 ${setLabel(top.set)} 压不住，过。` : `压不住 ${setLabel(top.set)}，过。`;
  else {
    const set = parseSet(best.cards)!;
    if (set.big > 0) reason = "要压只能用大王，留着关键时候用。";
    else if (set.small > 0) reason = "要压得挂小王，现在不值得，过。";
    else if (set.twos > 0) reason = "要压得用 2，留着够对头，过。";
    else reason = "要压得拆开好牌，不划算，过。";
  }
  return { command: passCmd, reason };
}

// ---------------------------------------------------------------------------
// 发牌

function burnLead(ctx: Ctx): BotDecision {
  const { hand } = ctx;
  if (isOneSet(hand)) return { command: { type: "PLAY", cards: sortCards(hand) }, reason: `烧牌最后一套：${label(hand)}，出完烧牌成功！` };
  // 不挂王的那一套留到最后（留点数最小的一组）；其余每组挂一张王，先挂小王
  const ranks = naturalRanks(ctx.counts);
  const others = ranks.slice(1).sort((a, b) => b - a);
  for (const rank of others) {
    for (const joker of [ctx.groups[SMALL_JOKER]![0], ctx.groups[BIG_JOKER]![0]]) {
      if (joker === undefined) continue;
      const cards = sortCards([...ctx.groups[rank]!, joker]);
      if (legalBurnLead(hand, cards)) return { command: { type: "PLAY", cards }, reason: `烧牌中每一套都要挂王：出 ${label(cards)}，不挂王的留到最后。` };
    }
  }
  const cards = burnLeadDefault(hand);
  return { command: { type: "PLAY", cards }, reason: `烧牌中，出 ${label(cards)}，剩下的还能一口气出完。` };
}

function lead(ctx: Ctx): BotDecision {
  const { view, seat, hand, counts, groups } = ctx;
  if (view.burn?.burner === seat) return burnLead(ctx);
  if (isOneSet(hand)) return { command: { type: "PLAY", cards: sortCards(hand) }, reason: `剩下的 ${label(hand)} 一套出完，走科！` };

  const ranks = naturalRanks(counts);
  if (ranks.length === 0) return { command: { type: "PLAY", cards: sortCards(hand) }, reason: "把配牌一起出。" }; // 不会发生：只剩配牌一定是一套
  const bigs = groups[BIG_JOKER]!;
  const smalls = groups[SMALL_JOKER]!;
  const controls = bigs.length + (ctx.unseenBig === 0 ? smalls.length : 0);

  // 控制够数：挂大王（大王都见过了就挂小王）的套谁也压不了，连着出，最后一套随便
  if (ranks.length >= 2 && controls >= ranks.length - 1) {
    const lastRank = ranks[0]!;
    const rank = ranks[ranks.length - 1]!;
    const cards = sortCards([...groups[rank]!, bigs[0] ?? smalls[0]!]);
    return { command: { type: "PLAY", cards }, reason: `${label(cards)} 谁也压不了，连着出，最后一套 ${rankLabel(lastRank)} 随便出。` };
  }

  const danger = Math.min(99, ...opponentsLeft(ctx));
  const sweep = view.chaos ? sweepTeamThreat(view) : null;

  // 喂牌：看得到手牌的队友快走了，出一套他能接的小牌
  const mates = view.players
    .map((player, other) => ({ player, other }))
    .filter(({ player, other }) => other !== seat && teamOf(other) === teamOf(seat) && isActive(view, other) && player.hand.length > 0)
    .sort((a, b) => a.player.hand.length - b.player.hand.length);
  for (const { player, other } of mates) {
    if (player.hand.length > tuning.feedLimit || player.hand.length >= hand.length) continue;
    const mateCounts = rankCounts(player.hand);
    for (const rank of ranks) {
      const count = counts[rank]!;
      if (isGoujiGroup(rank, count)) continue;
      let ok = false;
      for (let higher = rank + 1; higher <= ACE && !ok; higher += 1) ok = mateCounts[higher]! > 0 && mateCounts[higher]! + mateCounts[TWO]! >= count;
      if (ok) {
        const cards = sortCards(groups[rank]!);
        return { command: { type: "PLAY", cards }, reason: `队友 ${seatName(view, other)} 只剩 ${player.hand.length} 张，出 ${label(cards)} 给他接。` };
      }
    }
  }

  // 普通情况：最小、张数多的普通牌组；够级组留着抢发牌权；对手快走了出张数比他手牌多的
  let best: { rank: number; score: number } | null = null;
  for (const rank of ranks) {
    const count = counts[rank]!;
    let score = rank - 1.2 * Math.min(count, 4) + (count === 1 ? 1.5 : 0);
    if (isGoujiGroup(rank, count)) score += 8;
    if (danger <= 6 && count <= danger) score += 3;
    if (sweep !== null && sweep !== teamOf(seat) && count <= danger) score += 3;
    if (!best || score < best.score) best = { rank, score };
  }
  const cards = sortCards(groups[best!.rank]!);
  let reason: string;
  if (danger <= 6 && cards.length > danger) reason = `对手只剩 ${danger} 张，出 ${label(cards)}，张数多他接不住。`;
  else if (parseSet(cards)!.gouji) reason = `出够级牌 ${label(cards)}，只有对头能管。`;
  else reason = `先把 ${label(cards)} 打出去，小牌越早出越好。`;
  return { command: { type: "PLAY", cards }, reason };
}

// ---------------------------------------------------------------------------
// 还贡：不还配牌，不拆够级组，先还孤张小牌

function returnCards(ctx: Ctx, n: number): Card[] {
  const counts = [...ctx.counts];
  const left = [...ctx.hand];
  const chosen: Card[] = [];
  for (let k = 0; k < n && left.length > 0; k += 1) {
    let best: { card: Card; cost: number } | null = null;
    for (const card of left) {
      const rank = rankOf(card);
      let cost: number;
      if (rank >= TWO) cost = 100 + rank;
      else {
        const have = counts[rank]!;
        cost = rank + (have === 1 ? 0 : 15) + (rank >= 13 ? 10 : 0); // 孤张 K、A 留着（挂一张 2 就是够级牌）
        if (isGoujiGroup(rank, have) && !isGoujiGroup(rank, have - 1)) cost += 30;
      }
      if (!best || cost < best.cost) best = { card, cost };
    }
    chosen.push(best!.card);
    counts[rankOf(best!.card)]! -= 1;
    left.splice(left.indexOf(best!.card), 1);
  }
  return sortCards(chosen);
}

// ---------------------------------------------------------------------------

function isLegalPlay(view: GoujiState, seat: number, command: GoujiCommand): boolean {
  const round = view.round;
  if (!round || view.turn !== seat) return false;
  const hand = view.players[seat]!.hand;
  if (command.type === "PASS") return round.top !== null;
  if (command.type === "RANG") return canRang(view, seat);
  if (command.type !== "PLAY") return false;
  const own = new Set(hand);
  if (!command.cards.every((card) => own.has(card))) return false;
  const set = parseSet(command.cards);
  if (!set) return false;
  if (round.top) return set.eff.length === round.top.set.eff.length && set.eff.every((rank, i) => rank > round.top!.set.eff[i]!);
  if (view.burn?.burner === seat) return legalBurnLead(hand, command.cards);
  return true;
}

export function botDecision(view: GoujiState, seat: number): BotDecision {
  const player = view.players[seat]!;
  const legal = legalCommands(view, player.id).filter((command) => command.type !== "BURN");
  if (legal.length === 0) throw new Error("人机没有能做的操作。");
  const ctx = makeCtx(view, seat);
  switch (view.stage) {
    case "tribute": {
      const command = legal.find((c) => c.type === "TRIBUTE" && c.eat === tuning.eatTribute) ?? legal[0]!;
      return { command, reason: tuning.eatTribute ? "队友进的贡吃下：好牌集中到一边。" : "队友的贡免了。" };
    }
    case "return": {
      const item = view.tribute!.items.find((candidate) => candidate.receiver === seat && needsReturn(candidate) && candidate.returned === null)!;
      const cards = returnCards(ctx, item.cards.length);
      return { command: { type: "RETURN", cards }, reason: `还 ${cards.map((card) => rankLabel(rankOf(card))).join("、")}：不还 2 和王，不拆够级组。` };
    }
    case "revolution":
      if (view.you?.canRevolt && tuning.revolt) return { command: { type: "REVOLT", revolt: true }, reason: "手里一张王和 2 都没有，革命：这盘算四科，不扣分。" };
      return { command: { type: "REVOLT", revolt: false }, reason: view.you?.canRevolt ? "不革命，正常打。" : "你手里有王或 2，不能革命；每盘大家都要表态，点「继续」。" };
    case "handEnd":
      return { command: { type: "READY" }, reason: "准备好下一盘。" };
    case "playing": {
      const decision = view.round!.top ? respond(ctx) : lead(ctx);
      if (isLegalPlay(view, seat, decision.command)) return decision;
      // 保险：策略算错时退回一个合法操作
      const fallback = legal.find((c) => c.type === "PASS") ?? legal.find((c) => c.type === "PLAY") ?? legal[0]!;
      return { command: fallback, reason: fallback.type === "PASS" ? "过。" : "出牌。" };
    }
  }
}

export function botCommand(view: GoujiState, seat: number): GoujiCommand {
  return botDecision(view, seat).command;
}

// ---------------------------------------------------------------------------
// 烧牌

export function botBurnDecision(view: GoujiState, seat: number): BotDecision | null {
  const candidates = view.you?.seat === seat ? view.you.burnCandidates : [];
  if (candidates.length === 0 || view.you?.burnRequested) return null;
  const top = view.round?.top;
  if (!top) return null;
  const ctx = makeCtx(view, seat);
  const victim = top.seat;

  // 被烧的是队友、而且他快走了：别抢队友的发牌权
  const victimLeft = view.players[victim]!.handCount ?? 99;
  if (teamOf(victim) === teamOf(seat) && victimLeft <= tuning.burnSpareTeammate) return null;

  // 挑 S₁：富余王最多 → 挂大王 → 用掉的配牌最少
  let best: { cards: Card[]; spare: number; big: number; wilds: number; restBig: number; restSets: number } | null = null;
  for (const cards of candidates) {
    const rest = minus(ctx.hand, cards);
    const restCounts = rankCounts(rest);
    const d = naturalRanks(restCounts).length;
    const jokers = restCounts[SMALL_JOKER]! + restCounts[BIG_JOKER]!;
    const set = parseSet(cards)!;
    const option = {
      cards,
      spare: rest.length === 0 ? 9 : jokers - (Math.max(d, 1) - 1),
      big: set.big,
      wilds: set.twos + set.small + set.big,
      restBig: restCounts[BIG_JOKER]!,
      restSets: d,
    };
    if (
      !best ||
      option.spare > best.spare ||
      (option.spare === best.spare && option.big > best.big) ||
      (option.spare === best.spare && option.big === best.big && option.wilds < best.wilds)
    ) best = option;
  }
  const pick = best!;
  // 成功率低：没有富余王、剩下的王里没有大王、大王还有好几张没见、自己的对头张数多（大概率有大王）
  const oppLeft = view.players[oppOf(seat)]!.handCount ?? 99;
  if (pick.spare === 0 && pick.restSets >= 2 && pick.restBig === 0 && ctx.unseenBig >= tuning.burnRiskUnseenBig && oppLeft > 10) return null;

  const rest = minus(ctx.hand, pick.cards);
  const restText = rest.length === 0 ? "直接出完" : "剩下的每套都能挂上王，一口气出完";
  return { command: { type: "BURN", cards: pick.cards }, reason: `${label(pick.cards)} 压住 ${setLabel(top.set)}，${restText}——烧！` };
}

export function botBurn(view: GoujiState, seat: number): GoujiCommand | null {
  return botBurnDecision(view, seat)?.command ?? null;
}

/** 教程「提示」用：现在人机会怎么做、为什么（能烧时先说烧牌）。没有能做的操作返回 null。 */
export function botHint(view: GoujiState, seat: number): BotDecision | null {
  const burn = botBurnDecision(view, seat);
  if (burn) return burn;
  const legal = legalCommands(view, view.players[seat]!.id).filter((command) => command.type !== "BURN");
  return legal.length === 0 ? null : botDecision(view, seat);
}
