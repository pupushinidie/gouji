/**
 * 随机对局（流水线引擎交付标准第 3 条）：随机走合法操作直到终局，用普通代码检查不变量，最后汇总断言。
 * 够级固定 6 个座位，只有一种人数。npm test 里跑 70 场 × 5 盘 = 350 盘（含第 2 盘起的进贡、革命），
 * 再加开房选项组合（进贡关、让牌关、看牌关）各 20 场 × 3 盘。更长的跑法：npx tsx scripts/sim-random.ts。
 */
import { describe, expect, it } from "vitest";
import { simulate } from "./sim.js";

describe("随机对局", () => {
  it("默认选项 70 场 × 5 盘：牌数守恒、计分合计为 0、回合推进、终局判定、不卡死、隐藏信息", () => {
    const { stats, violations } = simulate({ matches: 70, seed: 1 });
    console.log("随机对局（默认选项）", JSON.stringify(stats));
    expect(violations.slice(0, 10)).toEqual([]);
    expect(stats.hands).toBeGreaterThanOrEqual(300);
    expect(stats.handsWithTribute).toBeGreaterThanOrEqual(stats.matches * 4 - 5);
    expect(stats.revolutions + stats.redeals).toBeGreaterThan(0);
    expect(stats.burnsStarted).toBeGreaterThan(0);
    expect(stats.rangs).toBeGreaterThan(0);
    expect(stats.sweeps).toBeGreaterThan(0);
  }, 120_000);

  for (const [label, gameOptions] of [
    ["进贡关", { tribute: false, hands: 3 }],
    ["让牌关", { rang: false, hands: 3 }],
    ["看牌关", { peek: false, hands: 3 }],
    ["全关、1 盘", { tribute: false, rang: false, peek: false, hands: 1 }],
  ] as const) {
    it(`开房选项：${label}`, () => {
      const { stats, violations } = simulate({ matches: 20, seed: 7, gameOptions });
      console.log(`随机对局（${label}）`, JSON.stringify(stats));
      expect(violations.slice(0, 10)).toEqual([]);
      if (!("tribute" in gameOptions) || gameOptions.tribute) expect(stats.handsWithTribute).toBeGreaterThan(0);
      else expect(stats.handsWithTribute).toBe(0);
      if ("rang" in gameOptions && !gameOptions.rang) expect(stats.rangs).toBe(0);
    }, 120_000);
  }
});
