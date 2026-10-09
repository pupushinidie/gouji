/**
 * 长跑随机对局（npm test 里只跑 350 盘）：npx tsx scripts/sim-random.ts [场数=400] [种子=1] [盘数=5]
 * 不变量见 packages/game/test/sim.ts。最后打印统计；有问题时打印前 20 条并以退出码 1 结束。
 */
import { simulate } from "../packages/game/test/sim.js";

const matches = Number(process.argv[2] ?? 400);
const seed = Number(process.argv[3] ?? 1);
const hands = Number(process.argv[4] ?? 5) as 1 | 3 | 5 | 8;
const started = Date.now();
const runs = [
  { label: "默认选项", gameOptions: { hands } },
  { label: "进贡关", gameOptions: { hands, tribute: false } },
  { label: "让牌关", gameOptions: { hands, rang: false } },
  { label: "看牌关", gameOptions: { hands, peek: false } },
];
let failed = false;
for (const run of runs) {
  const count = run.label === "默认选项" ? matches : Math.max(1, Math.round(matches / 4));
  const { stats, violations } = simulate({ matches: count, seed: seed + runs.indexOf(run), gameOptions: run.gameOptions });
  console.log(`${run.label}：${count} 场 ${stats.hands} 盘，${stats.steps} 步（单场最多 ${stats.maxStepsPerMatch}），进贡 ${stats.handsWithTribute} 盘、队内吃免 ${stats.intraTributeChoices}、还贡 ${stats.returns}、抗贡 ${stats.antiTribute}、革命 ${stats.revolutions}、重发 ${stats.redeals}、烧牌 ${stats.burnsStarted}（成功 ${stats.burnsSucceeded}、解烧 ${stats.burnsBroken}、反烧 ${stats.counterBurns}）、让牌 ${stats.rangs}、串三户 ${stats.sweeps}、乱缠 ${stats.chaosHands} 盘、超时 ${stats.timeouts}、托管 ${stats.autos}、平局 ${stats.draws} 场、隐藏信息抽查 ${stats.redactChecks} 次；问题 ${violations.length} 条`);
  if (violations.length > 0) {
    failed = true;
    for (const line of violations.slice(0, 20)) console.log("  ✗", line);
  }
}
console.log(`用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
process.exit(failed ? 1 : 0);
