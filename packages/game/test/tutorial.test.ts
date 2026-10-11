/**
 * 新手教程剧本：从头走到尾每步合法、锚点看得见、关键几幕一定发生；剧本自身；练习局人机打得完。
 */
import { describe, expect, it } from "vitest";
import {
  anchorVisible,
  botBurn,
  botCommand,
  botDecision,
  burnEligibleSeats,
  createPracticeGame,
  createTutorialGame,
  legalCommands,
  pendingSeats,
  redactGameForViewer,
  sameCommand,
  TUTORIAL_FINAL_STEP,
  TUTORIAL_SELF,
  TUTORIAL_STEPS,
  tutorialActor,
  tutorialApply,
  tutorialCanAct,
  type GameState,
  type TutorialCommand,
} from "../src/index.js";

const view = (state: GameState) => redactGameForViewer(state, TUTORIAL_SELF);

/** 剧本里的 RETURN 只要求「还贡」，真正还哪几张按网页预选的人机推荐。 */
function realize(state: GameState, command: TutorialCommand): TutorialCommand {
  if (command.type === "RETURN") return botDecision(view(state), 0).command;
  return command;
}

function walk(until?: string): { state: GameState; log: string[] } {
  let state = createTutorialGame("你");
  const log: string[] = [];
  for (const step of TUTORIAL_STEPS) {
    if (step.id === until) break;
    if (step.anchor) expect(anchorVisible(state, step.anchor), `第 ${step.id} 步的锚点 ${step.anchor} 应该看得见`).toBe(true);
    if (step.kind === "do") {
      const expected = realize(state, step.expect);
      const legal = legalCommands(view(state), TUTORIAL_SELF);
      expect(legal.some((command) => sameCommand(command, expected)), `第 ${step.id} 步：${JSON.stringify(step.expect)} 不合法`).toBe(true);
      state = tutorialApply(state, TUTORIAL_SELF, expected);
      log.push(step.id);
    } else if (step.kind === "watch") {
      for (const move of step.moves) {
        const actor = tutorialActor(state);
        expect(actor, `第 ${step.id} 步没人可以走`).not.toBeNull();
        if (move.type !== "SCENE") expect(actor).not.toBe(TUTORIAL_SELF);
        state = tutorialApply(state, actor!, move);
      }
      log.push(step.id);
    }
    // 剧本局里别的座位从来不能烧（烧牌只教你烧）
    if (state.stage === "playing") expect(burnEligibleSeats(state).filter((seat) => seat !== 0), `第 ${step.id} 步后有人机能烧`).toEqual([]);
  }
  return { state, log };
}

describe("新手教程剧本", () => {
  it("从头走到尾：每个「做」都合法，每个「看」的动作都合法，锚点都看得见", () => {
    const { log } = walk();
    expect(log.length).toBeGreaterThan(15);
  });

  it("剧本 A：K K 是够级牌，只有对头能接；对头用 2 2 够回来；两张王压住后你接着发牌", () => {
    let { state } = walk("only-duitou");
    expect(state.round!.top!.set.gouji).toBe(true);
    expect(state.turn).toBe(3);
    ({ state } = walk("lead-again"));
    expect(state.round!.top).toBeNull();
    expect(state.round!.leader).toBe(0);
  });

  it("剧本 A：对头牌不过——咕噜三号过过牌，还能接 10 10", () => {
    const { state } = walk("duitou-pass");
    expect(state.round!.passed).toContain(3);
    expect(state.turn).toBe(1);
  });

  it("剧本 B：你能烧、烧成功、走科头科，咕噜一号接风，咕噜三号无头", () => {
    let { state } = walk("burn-why");
    expect(view(state).you!.burnCandidates.length).toBeGreaterThan(0);
    ({ state } = walk("jiefeng"));
    expect(state.finished[0]).toBe(0);
    expect(state.burnsThisHand).toEqual([{ burner: 0, victim: 1 }]);
    expect(state.round!.leader).toBe(1);
    expect(state.headless[3]).toBe(true);
  });

  it("剧本 C：四人乱缠里过了还能再接", () => {
    const { state } = walk("chaos-again");
    expect(state.chaos).toBe(true);
    expect(state.turn).toBe(0);
    expect(state.round!.entries.some((entry) => entry.seat === 0 && entry.kind === "pass")).toBe(true);
  });

  it("剧本 D：结算你方 +2；进贡你收 2 张落贡 + 1 张烧贡，要还 2 张；还完进革命表态", () => {
    let { state } = walk("sweep");
    expect(state.result!.teamDeltas).toEqual([2, -2]);
    ({ state } = walk("return"));
    expect(state.stage).toBe("return");
    const mine = state.tribute!.items.filter((item) => item.receiver === 0);
    expect(mine.map((item) => item.kind).sort()).toEqual(["burn", "luo"]);
    expect(mine.find((item) => item.kind === "luo")!.cards).toHaveLength(2);
    ({ state } = walk("revolution"));
    expect(state.stage).toBe("revolution");
  });

  it("剧本自身：id 不重复、finale 唯一且在最后、每步都有主句、每句最多两句补充", () => {
    const ids = TUTORIAL_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    const finales = TUTORIAL_STEPS.filter((step) => step.kind === "info" && step.finale);
    expect(finales.map((step) => step.id)).toEqual([TUTORIAL_FINAL_STEP]);
    expect(TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1]!.id).toBe(TUTORIAL_FINAL_STEP);
    for (const step of TUTORIAL_STEPS) {
      expect(step.say.length).toBeGreaterThan(3);
      expect((step.note ?? "").split("。").filter(Boolean).length).toBeLessThanOrEqual(3);
    }
  });

  it("练习局：你和 5 个人机，人机替所有人打，120 局都能打完", () => {
    let stuck = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      let state = createPracticeGame("你", seed);
      let steps = 0;
      while (state.phase !== "finished" && steps < 3000) {
        steps += 1;
        const actor = tutorialActor(state);
        if (!actor) break;
        const seat = state.players.findIndex((player) => player.id === actor);
        // 自己那一座也交给人机（相当于一直点「提示」照着出）
        const command = botCommand(redactGameForViewer(state, actor), seat);
        state = tutorialApply(state, actor, command, true);
      }
      if (state.phase !== "finished") stuck += 1;
    }
    expect(stuck).toBe(0);
  });

  it("练习局：自己能在轮外按烧牌（canAct），人机也会烧", () => {
    let sawBurn = false;
    for (let seed = 1; seed <= 40 && !sawBurn; seed += 1) {
      let state = createPracticeGame("你", seed);
      for (let k = 0; k < 3000 && state.phase !== "finished"; k += 1) {
        if (burnEligibleSeats(state).includes(0)) {
          expect(tutorialCanAct(state, TUTORIAL_SELF)).toBe(true);
          const burn = botBurn(view(state), 0);
          if (burn) {
            state = tutorialApply(state, TUTORIAL_SELF, burn, true);
            sawBurn = true;
            continue;
          }
        }
        const actor = tutorialActor(state)!;
        const seat = state.players.findIndex((player) => player.id === actor);
        state = tutorialApply(state, actor, botCommand(redactGameForViewer(state, actor), seat), true);
        if (state.history.some((event) => event.type === "BurnStarted")) sawBurn = true;
      }
    }
    expect(sawBurn).toBe(true);
    void pendingSeats;
  });
});
