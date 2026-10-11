/**
 * 够级人机模拟：自对弈合法性和耗时、对随机 / 贪心基线的强度、混编、革命对比。
 * 用法：cd ~/projects/gouji && npx tsx scripts/sim-gouji.ts <模式> [场数] [key=value…]
 *   selfplay [300]   6 个普通人机打 N 场（每场 5 盘）：每步合法、最大步数、决策耗时（平均 / 最坏）、烧牌革命等次数
 *   vs [500]         普通 ×3 对 random ×3、普通 ×3 对 greedy ×3：同一种子换边各打一场；报场胜率、盘均分、盘胜率
 *   mixed [500]      普通 ×1 + greedy ×2 对 greedy ×3（普通坐甲的 0 / 2 / 4 号轮流），报盘均分和 95% 区间
 *   revolt [1000]    「能革就革」对「不革命」：同种子同局面各跑一盘，比较革命者联邦这盘的分
 *   eat [500]        队内贡「全吃」对「全免」：普通 ×3 两种设置对打
 * 后面的 key=value 临时改人机参数（BOT_TUNING），比如 duelThreshold=3。
 */
import {
  applyCommand,
  beatingMoves,
  botBurn,
  botCommand,
  burnEligibleSeats,
  burnWindowKey,
  createGame,
  isWild,
  legalCommands,
  parseSet,
  pendingSeats,
  rankOf,
  redactGameForViewer,
  BOT_TUNING as DEFAULTS,
  setBotTuning,
  sortCards,
  teamOf,
  tickBurnWindow,
  type Card,
  type GameCommand,
  type GameState,
} from "../packages/game/src/index.js";

interface Strategy {
  readonly name: string;
  cmd(view: GameState, seat: number): GameCommand;
  burn(view: GameState, seat: number): GameCommand | null;
}

let r = 12345;
const random = () => {
  r = (r * 1103515245 + 12345) & 0x7fffffff;
  return r / 0x7fffffff;
};
const pid = (seat: number) => `p${seat}`;
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const timing = { calls: 0, total: 0, worst: 0 };
function timed<T>(fn: () => T): T {
  const start = performance.now();
  const out = fn();
  const spent = performance.now() - start;
  timing.calls += 1;
  timing.total += spent;
  timing.worst = Math.max(timing.worst, spent);
  return out;
}

const normal: Strategy = {
  name: "普通",
  cmd: (view, seat) => timed(() => botCommand(view, seat)),
  burn: (view, seat) => timed(() => botBurn(view, seat)),
};

const randomStrategy: Strategy = {
  name: "random",
  cmd(view, seat) {
    const options = legalCommands(view, view.players[seat]!.id).filter((c) => c.type !== "BURN");
    return pick(options);
  },
  burn(view, seat) {
    const options = legalCommands(view, view.players[seat]!.id).filter((c) => c.type === "BURN");
    return options.length > 0 && random() < 0.5 ? pick(options) : null;
  },
};

const effSum = (cards: readonly Card[]) => parseSet(cards)!.eff.reduce((a, b) => a + b, 0);
/** greedy-min：发最小点数的一整组普通牌；有资格就用最小能压的一套压（不管是不是队友）；能烧就烧；不让牌；不革命。 */
const greedy: Strategy = {
  name: "greedy",
  cmd(view, seat) {
    const legal = legalCommands(view, view.players[seat]!.id).filter((c) => c.type !== "BURN");
    const hand = view.players[seat]!.hand;
    if (view.stage === "revolution") return { type: "REVOLT", revolt: false };
    if (view.stage === "return") return legal[0]!; // legalCommands 第一种就是最小的几张
    if (view.stage !== "playing") return legal.find((c) => c.type === "TRIBUTE" && c.eat) ?? legal[0]!;
    const round = view.round!;
    if (round.top) {
      const moves = beatingMoves(hand, round.top.set).sort((a, b) => effSum(a) - effSum(b));
      return moves.length > 0 ? { type: "PLAY", cards: moves[0]! } : { type: "PASS" };
    }
    const plays = legal.filter((c): c is Extract<GameCommand, { type: "PLAY" }> => c.type === "PLAY");
    if (view.burn?.burner === seat) return plays.sort((a, b) => effSum(a.cards) - effSum(b.cards))[0]!;
    const naturals = hand.filter((card) => !isWild(card));
    if (naturals.length > 0) {
      const low = Math.min(...naturals.map(rankOf));
      return { type: "PLAY", cards: sortCards(naturals.filter((card) => rankOf(card) === low)) };
    }
    return { type: "PLAY", cards: [hand[hand.length - 1]!] };
  },
  burn(view, seat) {
    const options = legalCommands(view, view.players[seat]!.id).filter((c) => c.type === "BURN");
    return options[0] ?? null;
  },
};

interface MatchStats {
  teamScores: [number, number];
  handDeltas: [number, number][];
  sweeps: [number, number];
  revolts: [number, number];
  burnsOk: [number, number];
  burnsBroken: number;
  rangs: number;
  steps: number;
  revoltHands: { seat: number; delta: number }[];
}

const MAX_STEPS = 20_000;

/** 打一场：seats[s] 是座位 s 的策略。 */
function playMatch(seed: number, seats: readonly Strategy[], options: { hands?: 1 | 3 | 5 | 8; tribute?: boolean } = {}, until?: (state: GameState) => boolean): { state: GameState; stats: MatchStats } {
  let state = createGame([0, 1, 2, 3, 4, 5].map((seat) => ({ id: pid(seat), name: `P${seat}`, bot: true })), seed, { hands: options.hands ?? 5, tribute: options.tribute ?? true });
  const stats: MatchStats = { teamScores: [0, 0], handDeltas: [], sweeps: [0, 0], revolts: [0, 0], burnsOk: [0, 0], burnsBroken: 0, rangs: 0, steps: 0, revoltHands: [] };
  let revoltSeat: number | null = null;
  const apply = (seat: number, command: GameCommand) => {
    const before = state.version;
    state = applyCommand(state, pid(seat), command);
    void before;
  };
  while (state.phase !== "finished") {
    if (until?.(state)) break;
    stats.steps += 1;
    if (stats.steps > MAX_STEPS) throw new Error(`种子 ${seed} 超过 ${MAX_STEPS} 步没打完`);
    const startVersion = state.version;
    const window = burnWindowKey(state);
    const pending = pendingSeats(state);
    if (window) {
      for (const seat of burnEligibleSeats(state)) {
        const view = redactGameForViewer(state, pid(seat));
        const command = seats[seat]!.burn(view, seat);
        if (command) apply(seat, command);
      }
      for (const seat of pendingSeats(state)) {
        const view = redactGameForViewer(state, pid(seat));
        if (view.you?.pendingAction) continue;
        if (legalCommands(view, pid(seat)).some((c) => c.type !== "BURN")) apply(seat, seats[seat]!.cmd(view, seat));
      }
      state = tickBurnWindow(state);
    } else {
      if (pending.length === 0) throw new Error(`种子 ${seed} 卡住了`);
      for (const seat of pending) {
        if (!pendingSeats(state).includes(seat)) continue;
        const view = redactGameForViewer(state, pid(seat));
        apply(seat, seats[seat]!.cmd(view, seat));
      }
    }
    if (state.version !== startVersion) {
      for (const event of state.events) {
        switch (event.type) {
          case "Revolted":
            stats.revolts[teamOf(event.seat)] += 1;
            revoltSeat = event.seat;
            break;
          case "BurnSucceeded": stats.burnsOk[teamOf(event.burner)] += 1; break;
          case "BurnBroken": stats.burnsBroken += 1; break;
          case "Rang": stats.rangs += 1; break;
          case "HandEnded": {
            const deltas = event.result.teamDeltas;
            stats.handDeltas.push([deltas[0], deltas[1]]);
            if (event.result.sweep) stats.sweeps[event.result.sweepTeam!] += 1;
            if (revoltSeat !== null) stats.revoltHands.push({ seat: revoltSeat, delta: deltas[teamOf(revoltSeat)] });
            revoltSeat = null;
            break;
          }
          default:
        }
      }
    }
  }
  stats.teamScores = [state.teamScores[0], state.teamScores[1]];
  return { state, stats };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
function ci(xs: number[]): string {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  const half = (1.96 * sd) / Math.sqrt(Math.max(1, xs.length));
  return `${m.toFixed(2)}（95% 区间 ${(m - half).toFixed(2)}～${(m + half).toFixed(2)}）`;
}
const pct = (k: number, n: number) => `${((100 * k) / Math.max(1, n)).toFixed(1)}%`;

function headToHead(a: Strategy, b: Strategy, matches: number, seedBase: number) {
  let wins = 0, losses = 0, draws = 0;
  const handScores: number[] = [];
  let handWins = 0, handLosses = 0, handZero = 0;
  let sweepsFor = 0, sweepsAgainst = 0, revoltsA = 0, burnsA = 0, burnsB = 0;
  for (let i = 0; i < matches; i += 1) {
    const seed = seedBase + i;
    for (const aTeam of [0, 1] as const) {
      const seats = [0, 1, 2, 3, 4, 5].map((seat) => (teamOf(seat) === aTeam ? a : b));
      const { stats } = playMatch(seed, seats);
      const mine = stats.teamScores[aTeam], theirs = stats.teamScores[1 - aTeam]!;
      if (mine > theirs) wins += 1; else if (mine < theirs) losses += 1; else draws += 1;
      for (const deltas of stats.handDeltas) {
        const d = deltas[aTeam];
        handScores.push(d);
        if (d > 0) handWins += 1; else if (d < 0) handLosses += 1; else handZero += 1;
      }
      sweepsFor += stats.sweeps[aTeam];
      sweepsAgainst += stats.sweeps[1 - aTeam]!;
      revoltsA += stats.revolts[aTeam];
      burnsA += stats.burnsOk[aTeam];
      burnsB += stats.burnsOk[1 - aTeam]!;
    }
  }
  const total = matches * 2;
  console.log(`${a.name} ×3 对 ${b.name} ×3：${total} 场（${matches} 个种子 × 换边）`);
  console.log(`  场胜率 ${pct(wins, total)}（负 ${pct(losses, total)}，平 ${pct(draws, total)}）`);
  console.log(`  盘均分 ${ci(handScores)}；盘胜率（不含 0 分盘）${pct(handWins, handWins + handLosses)}，0 分盘 ${pct(handZero, handScores.length)}`);
  console.log(`  串三户 ${sweepsFor} 对 ${sweepsAgainst}；${a.name} 革命 ${revoltsA} 次；烧牌成功 ${burnsA} 对 ${burnsB}（共 ${handScores.length} 盘）`);
}

function main() {
  const [mode = "selfplay", nArg, ...rest] = process.argv.slice(2);
  const tuning: Record<string, number | boolean> = {};
  for (const kv of [nArg, ...rest].filter((x): x is string => !!x && x.includes("="))) {
    const [key, value] = kv.split("=");
    tuning[key!] = value === "true" ? true : value === "false" ? false : Number(value);
  }
  if (Object.keys(tuning).length && mode !== "tune") setBotTuning(tuning as never);
  const n = nArg && !nArg.includes("=") ? Number(nArg) : undefined;
  const started = Date.now();

  if (mode === "selfplay") {
    const matches = n ?? 300;
    let hands = 0, steps = 0, maxSteps = 0, sweeps = 0, revolts = 0, burns = 0, broken = 0, rangs = 0;
    for (let i = 0; i < matches; i += 1) {
      const { stats } = playMatch(100_000 + i, [normal, normal, normal, normal, normal, normal]);
      hands += stats.handDeltas.length;
      steps += stats.steps;
      maxSteps = Math.max(maxSteps, stats.steps);
      sweeps += stats.sweeps[0] + stats.sweeps[1];
      revolts += stats.revolts[0] + stats.revolts[1];
      burns += stats.burnsOk[0] + stats.burnsOk[1];
      broken += stats.burnsBroken;
      rangs += stats.rangs;
    }
    console.log(`自对弈 ${matches} 场 ${hands} 盘，全部打完、每步合法（applyCommand 不报错）`);
    console.log(`  每场步数平均 ${(steps / matches).toFixed(0)}、最多 ${maxSteps}（上限 ${MAX_STEPS}）`);
    console.log(`  决策 ${timing.calls} 次，平均 ${(timing.total / timing.calls).toFixed(3)}ms，最坏 ${timing.worst.toFixed(1)}ms`);
    console.log(`  每盘：串三户 ${(sweeps / hands).toFixed(3)}、革命 ${(revolts / hands).toFixed(3)}、烧牌成功 ${(burns / hands).toFixed(2)}、解烧 ${(broken / hands).toFixed(2)}、让牌 ${(rangs / hands).toFixed(2)}`);
  } else if (mode === "vs") {
    const matches = n ?? 500;
    headToHead(normal, randomStrategy, matches, 200_000);
    headToHead(normal, greedy, matches, 300_000);
    console.log(`  决策平均 ${(timing.total / timing.calls).toFixed(3)}ms，最坏 ${timing.worst.toFixed(1)}ms`);
  } else if (mode === "mixed") {
    const matches = n ?? 500;
    const scores: number[] = [];
    for (let i = 0; i < matches; i += 1) {
      const botSeat = [0, 2, 4][i % 3]!;
      const seats = [0, 1, 2, 3, 4, 5].map((seat) => (seat === botSeat ? normal : greedy));
      const { stats } = playMatch(400_000 + i, seats);
      for (const deltas of stats.handDeltas) scores.push(deltas[0]);
    }
    console.log(`混编：普通 ×1 + greedy ×2（甲）对 greedy ×3（乙），${matches} 场 ${scores.length} 盘`);
    console.log(`  甲的盘均分 ${ci(scores)}`);
  } else if (mode === "revolt") {
    // 同一个种子打到第一次出现「有人能革命」的革命阶段，然后分两支：革 / 不革，各打完这一盘
    const wanted = n ?? 1000;
    const diffs: number[] = [];
    let tried = 0;
    for (let i = 0; diffs.length < wanted && i < wanted * 40; i += 1) {
      tried += 1;
      const seed = 500_000 + i;
      const pre = playMatch(seed, [normal, normal, normal, normal, normal, normal], { hands: 8 }, (state) => state.stage === "revolution" && state.revolution!.eligible.length === 1);
      if (pre.state.phase === "finished") continue;
      const seat = pre.state.revolution!.eligible[0]!;
      const branch = (revolt: boolean) => {
        let state = pre.state;
        for (const s of pendingSeats(state)) state = applyCommand(state, pid(s), { type: "REVOLT", revolt: s === seat ? revolt : false });
        const handNo = state.handNo;
        let delta = 0;
        // 接着全人机打完这一盘
        const seats = [normal, normal, normal, normal, normal, normal];
        let guard = 0;
        while (state.stage !== "handEnd" && state.phase !== "finished" && state.handNo === handNo) {
          if (guard++ > MAX_STEPS) throw new Error("革命分支没打完");
          if (burnWindowKey(state)) {
            for (const s of burnEligibleSeats(state)) {
              const c = seats[s]!.burn(redactGameForViewer(state, pid(s)), s);
              if (c) state = applyCommand(state, pid(s), c);
            }
            for (const s of pendingSeats(state)) {
              const view = redactGameForViewer(state, pid(s));
              if (!view.you?.pendingAction && legalCommands(view, pid(s)).some((c) => c.type !== "BURN")) state = applyCommand(state, pid(s), seats[s]!.cmd(view, s));
            }
            state = tickBurnWindow(state);
          } else for (const s of pendingSeats(state)) state = applyCommand(state, pid(s), seats[s]!.cmd(redactGameForViewer(state, pid(s)), s));
          const ended = state.events.find((e) => e.type === "HandEnded");
          if (ended && ended.type === "HandEnded") delta = ended.result.teamDeltas[teamOf(seat)];
        }
        return delta;
      };
      diffs.push(branch(true) - branch(false));
    }
    console.log(`革命对比：${diffs.length} 个「一人能革命」的局面（试了 ${tried} 个种子），革命 − 不革命 的联邦盘分差 ${ci(diffs)}`);
  } else if (mode === "eat") {
    const matches = n ?? 500;
    const eatAll: Strategy = { name: "全吃", cmd: (v, s) => { setBotTuning({ eatTribute: true }); return botCommand(v, s); }, burn: (v, s) => botBurn(v, s) };
    const skipAll: Strategy = { name: "全免", cmd: (v, s) => { setBotTuning({ eatTribute: false }); const c = botCommand(v, s); setBotTuning({ eatTribute: true }); return c; }, burn: (v, s) => botBurn(v, s) };
    headToHead(eatAll, skipAll, matches, 600_000);
  } else if (mode === "tune") {
    // 改过参数的普通 对 默认普通（参数从命令行 key=value 来）
    const matches = n ?? 500;
    const defaults = setBotTuning({});
    const base = { ...defaults };
    setBotTuning(base);
    const tuned = { ...base, ...tuning };
    const wrap = (name: string, t: typeof base): Strategy => ({
      name,
      cmd: (v, s) => { setBotTuning(t); return botCommand(v, s); },
      burn: (v, s) => { setBotTuning(t); return botBurn(v, s); },
    });
    const { BOT_TUNING } = { BOT_TUNING: base };
    headToHead(wrap(`调过（${JSON.stringify(tuning)}）`, tuned), wrap("默认", { ...BOT_TUNING, ...Object.fromEntries(Object.keys(tuning).map((k) => [k, (DEFAULTS as Record<string, unknown>)[k]])) } as typeof base), matches, 700_000);
  } else throw new Error(`不认识的模式 ${mode}`);
  console.log(`用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
}

main();
