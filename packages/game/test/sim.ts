/**
 * 随机对局：随机走合法操作直到一场结束，用普通代码检查不变量（最后再汇总断言，每步都 expect 太慢）。
 * vitest（random.test.ts）和长跑脚本（scripts/sim-random.ts）共用。
 *
 * 不变量：
 * - 216 张牌守恒（手牌 + 革命者扣下的 + 打出过的），没有重复；
 * - 每盘结束：两队分数合计 0，每人记自己联邦的分，串三户 ±12，否则名次分 4/2/0/0/−2/−4，名次不重复；累计分对得上；
 * - 回合推进：出牌阶段轮到的人在打、有资格（发牌时是这一轮的发牌人）；turn = -1 只出现在等烧牌窗口时；
 *   无头 ⇒ 对头走科了或是革命者；四人乱缠 ⇒ 至少两人走科；烧牌状态 ⇒ 烧牌的人剩下的牌能步步带王；
 * - 不卡死：每个没结束的状态都有要做决定的人，或者有等着的烧牌窗口（TICK）；一场在步数上限内结束；
 * - 隐藏信息（抽样）：每个座位和观战视角都拿不到种子、别人的手牌（看牌可见的队友除外）、超过 10 张的张数、
 *   革命者扣下的牌、别人的烧牌候选 / 烧牌请求 / 先收下的动作、别人的革命资格和选择、还没公开的吃免和还贡。
 */
import {
  applyCommand,
  burnEligibleSeats,
  burnWindowKey,
  canBurnTail,
  canRespond,
  createGame,
  DECK_SIZE,
  isActive,
  isWild,
  legalCommands,
  rankOf,
  oppOf,
  pendingSeats,
  PLACE_POINTS,
  redactGameForViewer,
  spectatorView,
  teamOf,
  tickBurnWindow,
  timeoutTurn,
  type GameCommand,
  type GameOptions,
  type GameState,
} from "../src/index.js";

export interface SimStats {
  matches: number;
  hands: number;
  handsWithTribute: number;
  intraTributeChoices: number;
  returns: number;
  antiTribute: number;
  revolutions: number;
  redeals: number;
  burnRequests: number;
  burnsStarted: number;
  burnsSucceeded: number;
  burnsBroken: number;
  counterBurns: number;
  rangs: number;
  sweeps: number;
  chaosHands: number;
  timeouts: number;
  autos: number;
  steps: number;
  maxStepsPerMatch: number;
  redactChecks: number;
  draws: number;
}

export interface SimResult {
  stats: SimStats;
  violations: string[];
}

function mulberry(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pid = (seat: number) => `p${seat + 1}`;

function checkConservation(state: GameState, where: string, violations: string[]): void {
  const all = [...state.players.flatMap((player) => player.hand), ...state.revolutionHand, ...state.discard];
  if (all.length !== DECK_SIZE || new Set(all).size !== DECK_SIZE || all.some((card) => card < 0 || card >= DECK_SIZE)) {
    violations.push(`${where}: 牌数不守恒（${all.length} 张，${new Set(all).size} 种）`);
  }
}

function checkStructure(state: GameState, where: string, violations: string[]): void {
  if (state.phase === "finished") return;
  const pending = pendingSeats(state);
  const window = burnWindowKey(state);
  if (pending.length === 0 && window === null) violations.push(`${where}: 卡住了（stage ${state.stage}，没人要做决定，也没有烧牌窗口）`);
  state.headless.forEach((headless, seat) => {
    if (headless && !state.finished.includes(oppOf(seat)) && state.revolutionary !== oppOf(seat)) violations.push(`${where}: 座位 ${seat} 无头但对头没走科`);
  });
  if (state.chaos && state.finished.length < 2) violations.push(`${where}: 不到两人走科就乱缠了`);
  if (state.stage !== "playing") return;
  const round = state.round!;
  if (state.turn >= 0) {
    if (!isActive(state, state.turn)) violations.push(`${where}: 轮到的人 ${state.turn} 不在打`);
    if (!round.top && state.turn !== round.leader) violations.push(`${where}: 发牌的不是这一轮的发牌人`);
    if (round.top && !canRespond(state, state.turn)) violations.push(`${where}: 轮到的人 ${state.turn} 没资格接牌`);
  } else if (window === null) violations.push(`${where}: turn = -1 但没有烧牌窗口`);
  if (state.burn) {
    const hand = state.players[state.burn.burner]!.hand;
    if (hand.length > 0 && !canBurnTail(hand)) violations.push(`${where}: 烧牌的人剩下的牌不能步步带王`);
  }
  if (state.revolutionary !== null && state.players[state.revolutionary]!.hand.length > 0) violations.push(`${where}: 革命者手里还有牌`);
}

function checkResult(state: GameState, where: string, violations: string[], prevScores: [number, number]): void {
  const result = state.result!;
  const [a, b] = result.teamDeltas;
  if (a + b !== 0) violations.push(`${where}: 两队分数合计不是 0（${a} ${b}）`);
  result.deltas.forEach((delta, seat) => {
    if (delta !== result.teamDeltas[teamOf(seat)]) violations.push(`${where}: 座位 ${seat} 没记自己联邦的分`);
  });
  if (result.sweep) {
    if (Math.abs(a) !== 12 || result.order.length !== 3 || new Set(result.order.map(teamOf)).size !== 1) violations.push(`${where}: 串三户的结果不对`);
  } else {
    if (result.order.length !== 6 || new Set(result.order).size !== 6) violations.push(`${where}: 名次不全`);
    const expected: [number, number] = [0, 0];
    result.order.forEach((seat, place) => {
      expected[teamOf(seat)] += PLACE_POINTS[place]!;
    });
    if (expected[0] !== a || expected[1] !== b) violations.push(`${where}: 名次分算错`);
    if (result.revolutionary !== null && result.order[3] !== result.revolutionary) violations.push(`${where}: 革命者不是四科`);
  }
  if (state.teamScores[0] !== prevScores[0] + a || state.teamScores[1] !== prevScores[1] + b) violations.push(`${where}: 累计分对不上`);
  state.players.forEach((player, seat) => {
    if (player.score !== state.teamScores[teamOf(seat)]) violations.push(`${where}: 座位 ${seat} 的累计分不是联邦分`);
  });
}

/** 隐藏信息：每个座位和观战视角。 */
export function checkRedaction(state: GameState, where: string, violations: string[]): void {
  const showAll = state.stage === "handEnd" || state.phase === "finished";
  const views = [...state.players.map((player, seat) => ({ seat, view: redactGameForViewer(state, player.id) })), { seat: -1, view: redactGameForViewer(state, "") }, { seat: -2, view: spectatorView(state, true) }];
  for (const { seat: viewer, view } of views) {
    const tag = `${where} 视角 ${viewer}`;
    const raw = view as unknown as Record<string, unknown>;
    if (raw.seed !== undefined || raw.rng !== undefined) violations.push(`${tag}: 拿到了种子`);
    view.players.forEach((player, seat) => {
      const real = state.players[seat]!;
      if (seat === viewer) {
        if (player.hand.length !== real.hand.length || player.handCount !== real.hand.length) violations.push(`${tag}: 自己的手牌不全`);
        return;
      }
      const teammateVisible = viewer >= 0 && state.config.peek && teamOf(seat) === teamOf(viewer) && real.hand.length <= 10;
      const mayShow = showAll || teammateVisible || viewer === -2;
      if (!mayShow && player.hand.length > 0) violations.push(`${tag}: 看到了座位 ${seat} 的手牌`);
      if (mayShow && player.hand.length !== real.hand.length) violations.push(`${tag}: 应该看得到座位 ${seat} 的手牌`);
      if (!showAll && real.hand.length > 10 && player.handCount !== null && viewer !== -2) violations.push(`${tag}: 看到了座位 ${seat} 超过 10 张的张数`);
      if (real.hand.length <= 10 && player.handCount !== real.hand.length) violations.push(`${tag}: 座位 ${seat} 剩 10 张以下应该公开张数`);
      if (player.timeouts !== 0) violations.push(`${tag}: 看到了别人的超时次数`);
    });
    if (viewer !== state.revolutionary && view.revolutionHand.length > 0) violations.push(`${tag}: 看到了革命者扣下的牌`);
    if (view.round) {
      if (view.round.pending && view.round.pending.seat !== viewer) violations.push(`${tag}: 看到了别人先收下的动作`);
      if (view.round.burnRequests.some((request) => request.seat !== viewer)) violations.push(`${tag}: 看到了别人的烧牌请求`);
    }
    if (view.revolution) {
      if (view.revolution.eligible.some((seat) => seat !== viewer)) violations.push(`${tag}: 看到了别人能不能革命`);
      if (view.revolution.choices.some((choice, seat) => choice !== null && seat !== viewer)) violations.push(`${tag}: 看到了别人的革命选择`);
    }
    if (view.tribute && state.stage === "tribute") {
      view.tribute.items.forEach((item) => {
        if (item.intra && item.receiver !== viewer && item.eat !== null) violations.push(`${tag}: 提前看到了别人吃不吃贡`);
      });
    }
    if (view.tribute && state.stage === "return") {
      view.tribute.items.forEach((item) => {
        if (item.receiver !== viewer && item.returned !== null) violations.push(`${tag}: 提前看到了别人还的牌`);
      });
    }
    if (viewer < 0 && view.you) violations.push(`${tag}: 观战拿到了私人信息`);
    if (viewer >= 0) {
      const own = view.you!;
      if (own.seat !== viewer) violations.push(`${tag}: you 不是自己`);
      if (own.burnCandidates.length > 0 && !burnEligibleSeats(state).includes(viewer)) violations.push(`${tag}: 不能烧却给了烧牌候选`);
    }
  }
}

/**
 * 随机策略：接牌时 35% 过牌，75% 只出不带配牌的牌。keeper 座位（每场一半）更像真人：发牌出整组普通牌、
 * 接牌只用整组普通牌、把 2 和王留着——这样后半盘常有人满足烧牌条件，烧牌、解烧、反烧都能跑到。
 */
function choose(state: GameState, seat: number, random: () => number, keeper: boolean): GameCommand {
  const commands = legalCommands(state, pid(seat)).filter((command) => command.type !== "BURN");
  if (commands.length === 0) throw new Error(`座位 ${seat} 没有能做的操作（stage ${state.stage}）`);
  const passOption = commands.find((command) => command.type === "PASS");
  const plays = commands.filter((command): command is Extract<GameCommand, { type: "PLAY" }> => command.type === "PLAY");
  const plain = plays.filter((command) => !command.cards.some(isWild));
  if (keeper && state.stage === "playing") {
    const hand = state.players[seat]!.hand;
    const whole = plain.filter((command) => hand.filter((card) => rankOf(card) === rankOf(command.cards[0]!)).length === command.cards.length);
    if (whole.length > 0 && (!passOption || random() < 0.7)) return whole.sort((a, b) => rankOf(a.cards[0]!) - rankOf(b.cards[0]!))[0]!;
    if (passOption && random() < 0.8) return passOption;
  }
  if (passOption && random() < 0.35) return passOption;
  if (plain.length > 0 && random() < 0.75) return plain[Math.floor(random() * plain.length)]!;
  return commands[Math.floor(random() * commands.length)]!;
}

export function simulate(options: { matches: number; seed: number; gameOptions?: Partial<GameOptions>; maxSteps?: number; redactEvery?: number }): SimResult {
  const random = mulberry(options.seed);
  const violations: string[] = [];
  const stats: SimStats = {
    matches: 0, hands: 0, handsWithTribute: 0, intraTributeChoices: 0, returns: 0, antiTribute: 0, revolutions: 0, redeals: 0,
    burnRequests: 0, burnsStarted: 0, burnsSucceeded: 0, burnsBroken: 0, counterBurns: 0, rangs: 0, sweeps: 0, chaosHands: 0,
    timeouts: 0, autos: 0, steps: 0, maxStepsPerMatch: 0, redactChecks: 0, draws: 0,
  };
  const maxSteps = options.maxSteps ?? 12_000;
  const redactEvery = options.redactEvery ?? 11;
  for (let match = 0; match < options.matches; match += 1) {
    const seed = options.seed * 1000 + match;
    let state = createGame([0, 1, 2, 3, 4, 5].map((seat) => ({ id: pid(seat), name: `P${seat}`, bot: seat % 3 === 0 })), seed, options.gameOptions ?? {});
    let steps = 0;
    let scoresBefore: [number, number] = [0, 0];
    let chaosSeen = false;
    const keepers = new Set([0, 1, 2, 3, 4, 5].filter((seat) => (seat + match) % 2 === 0));
    const where = () => `第 ${match} 场（种子 ${seed}）第 ${state.handNo} 盘第 ${steps} 步`;
    while (state.phase !== "finished" && steps < maxSteps) {
      steps += 1;
      const before = state;
      try {
        const window = burnWindowKey(state);
        const pending = pendingSeats(state);
        if (window && (pending.length === 0 || random() < 0.6)) {
          for (const seat of burnEligibleSeats(state)) {
            if (random() < 0.5) {
              const burns = legalCommands(state, pid(seat)).filter((command) => command.type === "BURN");
              if (burns.length > 0) {
                state = applyCommand(state, pid(seat), burns[Math.floor(random() * burns.length)]!);
                stats.burnRequests += 1;
              }
            }
          }
          if (pending.length > 0 && random() < 0.5) {
            const seat = pending[0]!;
            state = applyCommand(state, pid(seat), choose(state, seat, random, keepers.has(seat)));
          }
          state = tickBurnWindow(state);
        } else if (pending.length === 0) {
          violations.push(`${where()}: 卡住了`);
          break;
        } else if (random() < 0.03) {
          state = timeoutTurn(state);
          stats.timeouts += 1;
        } else {
          // 烧牌窗口满 2 秒之后也可能有人按烧牌
          const late = state.stage === "playing" && state.round?.top?.ready ? burnEligibleSeats(state) : [];
          if (late.length > 0 && random() < 0.3) {
            const seat = late[0]!;
            const burns = legalCommands(state, pid(seat)).filter((command) => command.type === "BURN");
            state = applyCommand(state, pid(seat), burns[0]!);
            stats.burnRequests += 1;
          } else {
            const seat = pending[Math.floor(random() * pending.length)]!;
            const command = state.stage === "revolution" ? ({ type: "REVOLT", revolt: random() < 0.6 } as GameCommand) : choose(state, seat, random, keepers.has(seat));
            state = applyCommand(state, pid(seat), command);
          }
        }
      } catch (error) {
        violations.push(`${where()}: 合法操作被拒或出错：${(error as Error).message}`);
        break;
      }
      if (state.version < before.version) violations.push(`${where()}: version 倒退`);
      checkConservation(state, where(), violations);
      checkStructure(state, where(), violations);
      if (state.chaos) chaosSeen = true;
      if (steps % redactEvery === 0) {
        checkRedaction(state, where(), violations);
        stats.redactChecks += 1;
      }
      if (state !== before && state.version !== before.version) {
        for (const event of state.events) {
          switch (event.type) {
            case "TributeChosen": stats.intraTributeChoices += 1; break;
            case "TributeReturned": stats.returns += 1; break;
            case "AntiTribute": stats.antiTribute += 1; break;
            case "Revolted": stats.revolutions += 1; break;
            case "RevolutionRedeal": stats.redeals += 1; break;
            case "BurnStarted": stats.burnsStarted += 1; break;
            case "BurnSucceeded": stats.burnsSucceeded += 1; break;
            case "BurnBroken": stats.burnsBroken += 1; if (event.counter) stats.counterBurns += 1; break;
            case "Rang": stats.rangs += 1; break;
            case "AutoChanged": if (event.on) stats.autos += 1; break;
            case "HandEnded":
              stats.hands += 1;
              if (event.result.sweep) stats.sweeps += 1;
              if (chaosSeen) stats.chaosHands += 1;
              chaosSeen = false;
              checkResult(state, where(), violations, scoresBefore);
              checkRedaction(state, `${where()} 结算`, violations);
              scoresBefore = [state.teamScores[0], state.teamScores[1]];
              break;
            default:
          }
        }
        if (state.stage === "handEnd" && state.phase !== "finished") {
          // 结算画面：所有人点下一盘
          for (let seat = 0; seat < 6; seat += 1) state = applyCommand(state, pid(seat), { type: "READY" });
          checkConservation(state, `${where()} 下一盘`, violations);
          checkStructure(state, `${where()} 下一盘`, violations);
          if (state.tribute) stats.handsWithTribute += 1;
          for (const event of state.events) {
            if (event.type === "AntiTribute") stats.antiTribute += 1;
            if (event.type === "TributeReturned") stats.returns += 1;
          }
        }
      }
      if (violations.length > 30) break;
    }
    if (state.phase !== "finished") violations.push(`第 ${match} 场（种子 ${seed}）${steps} 步没打完`);
    else {
      if (state.handNo !== state.config.hands) violations.push(`第 ${match} 场打了 ${state.handNo} 盘，应该 ${state.config.hands} 盘`);
      const [a, b] = state.teamScores;
      if (state.finalResult!.winnerTeam !== (a > b ? 0 : b > a ? 1 : null)) violations.push(`第 ${match} 场胜负判定不对`);
      if (state.finalResult!.draw) stats.draws += 1;
    }
    stats.matches += 1;
    stats.steps += steps;
    stats.maxStepsPerMatch = Math.max(stats.maxStepsPerMatch, steps);
    if (violations.length > 30) break;
  }
  return { stats, violations };
}
