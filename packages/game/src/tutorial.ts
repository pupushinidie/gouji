/**
 * 新手教程的剧本（站内统一做法，见 ~/projects/pipeline/handbook/tutorial-notes.md；教学要点见规则书补充文件 2.1–2.2）。
 *
 * 你坐座位 0（甲联邦），队友是咕噜二号（2）、咕噜四号（4），对头是正对面的咕噜三号（3）。
 * 四段残局，都用预览局面工厂摆好（牌全是确定的），中间用 SCENE 换局面：
 *   A 出牌、比大小、对头牌不过、够级、够回来、挂大王必赢；
 *   B 烧牌（咕噜一号出 K K，你用 A A 烧，挂王一套套出完）→ 走科、接风、对头无头；
 *   C 四人乱缠（过了还能再接）；
 *   D 计分（结算表）、进贡和还贡、革命，本站设定。
 * 练习局：一场 1 盘，你和 5 个人机。
 *
 * 教程里不等烧牌窗口：每走一步，有烧牌窗口就立刻满 2 秒（tutorialApply），窗口满了以后按烧牌照样立刻生效。
 */
import { rankOf, type Card, parseRank } from "./cards.js";
import { botBurn, botDecision } from "./bot.js";
import { applyCommand, burnEligibleSeats, burnWindowKey, createGame, legalCommands, pendingSeats, redactGameForViewer, tickBurnWindow } from "./engine.js";
import { buildDeal, buildState } from "./scenes.js";
import { canRang, oppOf } from "./turn.js";
import type { GoujiCommand, GoujiState } from "./types.js";

export type TutorialFace = "base" | "happy" | "surprised" | "think";

/** 剧本里换局面（不是规则引擎的操作）。 */
export type TutorialScene = "lead" | "burn" | "chaos" | "score" | "tribute";
export type TutorialCommand = GoujiCommand | { readonly type: "SCENE"; readonly scene: TutorialScene };

interface StepBase {
  readonly id: string;
  /** 侧栏进度里的课名（只有几步带）。 */
  readonly lesson?: string;
  /** 主句（24px），一句话。 */
  readonly say: string;
  /** 补充（12px），最多两句。 */
  readonly note?: string;
  /** 触屏上换的说法。 */
  readonly noteTouch?: string;
  /** 高亮哪个元素（data-tutorial）。 */
  readonly anchor?: string;
  readonly face?: TutorialFace;
}

export type TutorialStep =
  | (StepBase & { readonly kind: "info"; readonly finale?: boolean })
  | (StepBase & {
      readonly kind: "do";
      readonly expect: TutorialCommand;
      /** 选牌以后高亮挪到哪：当前选中的牌（按点数写，比如 "4 4"、"大 小"）和它一样时用这个锚点。 */
      readonly then?: readonly { readonly cards: string; readonly anchor: string }[];
    })
  | (StepBase & { readonly kind: "watch"; readonly moves: readonly TutorialCommand[] });

/** 自己的玩家 id（座位 0）。 */
export const TUTORIAL_SELF = "p1";
const BOTS = [1, 2, 3, 4, 5];
/** 没写的牌由工厂从剩下的牌里随机补（种子固定）。 */
const FILL = (n: number) => n;

/** 四段残局。名字：你、咕噜一号（下家）、咕噜二号、咕噜三号（对头）、咕噜四号、咕噜五号（上家）。 */
export function createTutorialScene(scene: TutorialScene, selfName = "你"): GoujiState {
  const names = [selfName, "咕噜一号", "咕噜二号", "咕噜三号", "咕噜四号", "咕噜五号"];
  const common = { names, bots: BOTS, seed: 20261010, options: { hands: 1 as const } };
  switch (scene) {
    case "lead":
      // 规则书补充 2.2 剧本 A：你发牌
      return buildState({
        ...common,
        hands: { 0: "4 4 10 10 K K 小 2 大 6 6 6", 1: "6 6 3 3 5 5 7 7 8 8 9 9 J J Q", 2: FILL(15), 3: "Q Q 2 2 3 4 5 7 8 9 9 10 J A", 4: FILL(15), 5: FILL(15) },
        leader: 0,
        turn: 0,
      });
    case "burn":
      // 剧本 B：咕噜一号要发 K K；你手里 A A、7 7 7、9 9、小王、大王（规则书 T7、T8）
      return buildState({
        ...common,
        hands: { 0: "A A 7 7 7 9 9 小 大", 1: "K K 3 3 4 5 6 8 10 J Q", 2: FILL(14), 3: "3 4 5 6 8 10 J Q K 4 5 6", 4: FILL(14), 5: FILL(14) },
        leader: 1,
        turn: 1,
      });
    case "chaos":
      // 剧本 C：咕噜二号、咕噜五号已经出完，四人乱缠；咕噜三号发牌
      return buildState({
        ...common,
        hands: { 0: "J J 9 7", 1: "10 10 3", 2: 0, 3: "8 8 4", 4: "5 5 6", 5: 0 },
        finished: [2, 5],
        chaos: true,
        leader: 3,
        turn: 3,
      });
    case "score":
      // 剧本 C5：名次 你、咕噜五号、咕噜二号、咕噜一号、咕噜四号，剩咕噜三号；你还烧过咕噜一号一次
      return buildState({
        ...common,
        options: { hands: 3 },
        stage: "handEnd",
        hands: { 0: 0, 1: 0, 2: 0, 3: 4, 4: 0, 5: 0 },
        finished: [0, 5, 2, 1, 4],
        burnsThisHand: [{ burner: 0, victim: 1 }],
        result: { order: [0, 5, 2, 1, 4, 3], burns: [{ burner: 0, victim: 1 }] },
      });
    case "tribute":
      // 剧本 C7：第 2 盘发完牌，咕噜三号（大落）给你 2 张、咕噜四号（二落）给咕噜五号 1 张、咕噜一号给你 1 张烧贡
      return buildDeal({
        ...common,
        options: { hands: 3 },
        hands: { 0: "Q Q Q 4 5 8 8", 1: "大 2", 3: "大 小 2", 4: "2" },
        prevResult: { order: [0, 5, 2, 1, 4, 3], burns: [{ burner: 0, victim: 1 }] },
      });
  }
}

export function createTutorialGame(selfName = "你"): GoujiState {
  return createTutorialScene("lead", selfName);
}

/** 练习局：一场 1 盘，你（座位 0）和 5 个人机。 */
export function createPracticeGame(selfName = "你", seed = 1): GoujiState {
  const names = [selfName, "咕噜一号", "咕噜二号", "咕噜三号", "咕噜四号", "咕噜五号"];
  return createGame(names.map((name, seat) => ({ id: `p${seat + 1}`, name, bot: seat > 0 })), seed, { hands: 1 });
}

/**
 * 教程里走一步：SCENE 换局面；其余交给规则引擎，之后有烧牌窗口就立刻满 2 秒。
 * practice 为真时（练习局），窗口满之前先让能烧的人机按烧牌（和服务器上人机的做法一样）。
 */
export function tutorialApply(state: GoujiState, playerId: string, command: TutorialCommand, practice = false, selfName?: string): GoujiState {
  if (command.type === "SCENE") return createTutorialScene(command.scene, selfName ?? state.players[0]!.name);
  let next = applyCommand(state, playerId, command);
  for (let guard = 0; guard < 4 && burnWindowKey(next); guard += 1) {
    if (practice) {
      for (const seat of burnEligibleSeats(next)) {
        const player = next.players[seat]!;
        if (!player.bot && player.id === TUTORIAL_SELF) continue;
        const burn = botBurn(redactGameForViewer(next, player.id), seat);
        if (burn) next = applyCommand(next, player.id, burn);
      }
    }
    next = tickBurnWindow(next);
  }
  return next;
}

// 剧本里的出牌：从那一段开局的手牌里挑具体的牌（按点数写）
const SCENES: Record<TutorialScene, GoujiState> = {
  lead: createTutorialScene("lead"),
  burn: createTutorialScene("burn"),
  chaos: createTutorialScene("chaos"),
  score: createTutorialScene("score"),
  tribute: createTutorialScene("tribute"),
};

function pick(state: GoujiState, seat: number, text: string): Card[] {
  const hand = [...state.players[seat]!.hand];
  const cards: Card[] = [];
  for (const token of text.trim().split(/\s+/)) {
    const rank = parseRank(token);
    const at = hand.findIndex((card) => rankOf(card) === rank);
    if (at < 0) throw new Error(`教程剧本：座位 ${seat} 没有 ${token}`);
    cards.push(hand.splice(at, 1)[0]!);
  }
  return cards;
}
const play = (scene: TutorialScene, seat: number, text: string): GoujiCommand => ({ type: "PLAY", cards: pick(SCENES[scene], seat, text) });
const PASS: GoujiCommand = { type: "PASS" };
const scene = (name: TutorialScene): TutorialCommand => ({ type: "SCENE", scene: name });

// 进贡那一段：咕噜五号（收了 1 张落贡）还的牌按人机的选法
const TRIBUTE_RETURN_5: GoujiCommand = (() => {
  const view = redactGameForViewer(SCENES.tribute, "p6");
  return botDecision(view, 5).command;
})();

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  // ---------------- A 出牌和够级 ----------------
  {
    id: "goal",
    kind: "info",
    lesson: "谁和谁一伙",
    say: "够级是 6 个人 3 对 3：隔一个座位是队友，正对面的是你的对头。",
    note: "你的队友是咕噜二号、咕噜四号（蓝色），对头是正上方的咕噜三号。比哪一队先把牌出完。",
    anchor: "plate-duitou",
    face: "happy",
  },
  {
    id: "lead-44",
    kind: "do",
    lesson: "出牌和压牌",
    say: "一次出一种点数的牌，可以挂 2 和王。先出小的：点「4」那一列。",
    note: "没有顺子，也没有三带二。点一列会选上这一列，再点「出牌」。",
    anchor: "col-4",
    expect: play("lead", 0, "4 4"),
    then: [{ cards: "4 4", anchor: "btn-play" }],
  },
  {
    id: "others-1",
    kind: "watch",
    say: "下家咕噜一号用 6 6 压上，其他人都过了。",
    anchor: "plate-br",
    moves: [play("lead", 1, "6 6"), PASS, PASS, PASS, PASS],
  },
  {
    id: "beat-rule",
    kind: "info",
    say: "压牌要张数一样，而且每一张都更大。",
    note: "两套牌各自从大到小排好，一张对一张比。挂上去的 2 当那个点数用：8 8 2 和 8 8 8 一样大。",
    anchor: "center",
  },
  {
    id: "beat-1010",
    kind: "do",
    say: "轮回到你：选「10」，压上 10 10。",
    anchor: "col-10",
    expect: play("lead", 0, "10 10"),
    then: [{ cards: "10 10", anchor: "btn-play" }],
  },
  {
    id: "duitou-pass",
    kind: "watch",
    say: "过了就锁住这一轮——但对头的牌例外。",
    note: "咕噜三号刚才过过牌，可 10 10 是他对头（你）出的，他还能接。",
    anchor: "plate-duitou",
    moves: [PASS, play("lead", 3, "Q Q")],
  },
  {
    id: "gouji-table",
    kind: "info",
    lesson: "够级牌",
    say: "你的 K K 是够级牌：够大的牌叫够级。",
    note: "10 要 5 张、J 4 张、Q 3 张、K 和 A 2 张；单张 2、带王的牌也都是。点「够级表」随时能看。",
    anchor: "gouji-table",
    face: "think",
  },
  {
    id: "play-kk",
    kind: "do",
    say: "选「K」，压上 K K。",
    anchor: "col-13",
    expect: play("lead", 0, "K K"),
    then: [{ cards: "K K", anchor: "btn-play" }],
  },
  {
    id: "only-duitou",
    kind: "info",
    say: "够级牌只有对头能管，别人想管也不让出。",
    note: "所以现在直接轮到咕噜三号。你俩一来一回地「够」，谁先拿不出更大的谁就输了这一轮。",
    anchor: "plate-duitou",
  },
  { id: "duitou-22", kind: "watch", say: "对头用 2 2 够回来了。", anchor: "center", moves: [play("lead", 3, "2 2")] },
  {
    id: "compare",
    kind: "info",
    say: "小王 2 压不住 2 2：小王比 2 大，可 2 不比 2 大。",
    note: "每一张都要更大才行。纯 2 只有王压得住；挂了大王的牌谁也压不了。",
    anchor: "center",
    face: "think",
  },
  {
    id: "play-big",
    kind: "do",
    say: "点「大王」再点「小王」，用两张王压上。",
    anchor: "col-17",
    expect: play("lead", 0, "大 小"),
    then: [
      { cards: "大", anchor: "col-16" },
      { cards: "大 小", anchor: "btn-play" },
    ],
  },
  { id: "win-round", kind: "watch", say: "咕噜三号压不住，只能过：你赢下这一轮。", anchor: "plate-duitou", moves: [PASS] },
  {
    id: "lead-again",
    kind: "info",
    say: "赢下一轮的人接着发牌。大牌留着抢发牌权，小牌越早出越好。",
    note: "剩 10 张以下大家都看得到你的张数；房主开了「看牌」时，队友能看到你的全部手牌。",
    anchor: "plate-me",
    face: "happy",
  },
  // ---------------- B 烧牌 ----------------
  { id: "to-burn", kind: "watch", say: "换一副残局：学烧牌。", moves: [scene("burn")] },
  {
    id: "burn-kk",
    kind: "watch",
    lesson: "烧牌",
    say: "咕噜一号出了够级牌 K K。他的对头是咕噜四号，平时轮不到你管。",
    anchor: "plate-br",
    moves: [play("burn", 1, "K K")],
  },
  {
    id: "burn-why",
    kind: "info",
    say: "但你的牌能一口气出完，可以「烧」！",
    note: "条件：先用一套压住它，之后除了最后一套，每套都挂一张王。烧牌按钮只在你自己屏幕上亮。",
    anchor: "btn-burn",
    face: "surprised",
  },
  { id: "burn-go", kind: "do", say: "点「烧！2 张 A」。", anchor: "btn-burn", expect: { type: "BURN", cards: pick(SCENES.burn, 0, "A A") } },
  {
    id: "burn-risk",
    kind: "watch",
    say: "烧牌中，你的每一套都可能被你的对头咕噜三号压住，压住就烧不成。",
    note: "他过了，没人压住你，你接着发牌。",
    anchor: "plate-duitou",
    moves: [PASS],
  },
  {
    id: "burn-777",
    kind: "do",
    say: "还没到最后一套，必须挂王：点「7」，再点「小王」。",
    note: "只出 9 9 会被拦下（没挂王）。",
    anchor: "col-7",
    expect: play("burn", 0, "7 7 7 小"),
    then: [
      { cards: "7 7 7", anchor: "col-16" },
      { cards: "7 7 7 小", anchor: "btn-play" },
    ],
  },
  { id: "burn-pass", kind: "watch", say: "咕噜三号还是压不住。", anchor: "plate-duitou", moves: [PASS] },
  {
    id: "burn-last",
    kind: "do",
    say: "最后一套 9 9 挂大王：点「9」，再点「大王」，出完！",
    anchor: "col-9",
    expect: play("burn", 0, "9 9 大"),
    then: [
      { cards: "9 9", anchor: "col-17" },
      { cards: "9 9 大", anchor: "btn-play" },
    ],
  },
  {
    id: "burn-done",
    kind: "watch",
    say: "烧牌成功！你第一个出完：头科。",
    note: "下一盘被烧的咕噜一号要给你进 1 张贡。烧到一半被压住就算失败，没有惩罚；这一轮过过牌的人不能烧。",
    anchor: "plate-me",
    face: "happy",
    moves: [PASS],
  },
  {
    id: "jiefeng",
    kind: "info",
    lesson: "走科、接风、无头",
    say: "你出完了，这一轮由你后面第一个有牌的咕噜一号接着发牌：接风。",
    note: "出完的先后叫走科：头科、二科、三科、四科、二落，最后剩下的是大落。",
    anchor: "plate-br",
  },
  {
    id: "wutou",
    kind: "info",
    say: "咕噜三号的对头（你）走了，他现在「无头」。",
    note: "无头的人出够级牌谁都能接，他也能接任何人的够级牌，但不能烧。",
    anchor: "plate-duitou",
    face: "think",
  },
  // ---------------- C 四人乱缠 ----------------
  { id: "to-chaos", kind: "watch", say: "再换一副：咕噜二号、咕噜五号也出完了。", moves: [scene("chaos")] },
  {
    id: "chaos",
    kind: "info",
    lesson: "四人乱缠",
    say: "第 2 个人出完的那一轮打完，剩下的人进入四人乱缠。",
    note: "乱缠里没有够级、烧牌、让牌，过了也还能再接。",
    anchor: "center",
  },
  { id: "chaos-88", kind: "watch", say: "咕噜三号发 8 8，咕噜四号过。", anchor: "plate-duitou", moves: [play("chaos", 3, "8 8"), PASS] },
  { id: "chaos-pass", kind: "do", say: "先点「过」试试。", anchor: "btn-pass", expect: PASS },
  { id: "chaos-1010", kind: "watch", say: "咕噜一号压上 10 10，别人都过。", anchor: "plate-br", moves: [play("chaos", 1, "10 10"), PASS, PASS] },
  {
    id: "chaos-again",
    kind: "do",
    say: "刚才过了，可乱缠里还能再接：选「J」压上。",
    anchor: "col-11",
    expect: play("chaos", 0, "J J"),
    then: [{ cards: "J J", anchor: "btn-play" }],
  },
  // ---------------- D 计分、进贡、革命 ----------------
  { id: "to-score", kind: "watch", say: "快进到这一盘结束。", moves: [scene("score")] },
  {
    id: "score",
    kind: "info",
    lesson: "计分",
    say: "头科 +4、二科 +2、三科四科 0、二落 −2、大落 −4，全队加起来。",
    note: "你方：你头科 +4、咕噜二号三科 0、咕噜四号二落 −2，合计 +2；每个人都记全队的分。",
    anchor: "summary-ribbons",
  },
  {
    id: "sweep",
    kind: "info",
    say: "一队包揽头科、二科、三科叫「串三户」：每人 ±12，这盘立刻结束。",
    note: "打满约定的盘数，累计分高的联邦赢。",
    anchor: "summary-ribbons",
    face: "surprised",
  },
  { id: "to-tribute", kind: "watch", say: "下一盘发完牌，先进贡。", moves: [scene("tribute")] },
  {
    id: "tribute",
    kind: "info",
    lesson: "进贡和革命",
    say: "大落给头科 2 张、二落给二科 1 张，只进大王、小王和 2。",
    note: "被烧的人还要给烧牌的人 1 张（不还）。进的每一张大家都看得到。",
    anchor: "tribute",
  },
  {
    id: "return",
    kind: "do",
    say: "你收了 2 张落贡，要还 2 张：我先按「不还王和 2、不拆大组」帮你选好了，点「还这 2 张」。",
    note: "想换就点别的列重新选。",
    anchor: "btn-return",
    expect: { type: "RETURN", cards: [] },
  },
  { id: "return-5", kind: "watch", say: "咕噜五号也还了牌。", anchor: "tribute", moves: [TRIBUTE_RETURN_5] },
  {
    id: "revolution",
    kind: "info",
    say: "进贡后手里一张王和 2 都没有的人，可以革命：这盘不打，算四科 0 分。",
    note: "几乎总是划算；他的对头直接无头。两人以上同时革命就重新发牌。每盘大家都要点一下「继续」或「革命」。",
    anchor: "buttons",
    face: "think",
  },
  {
    id: "site",
    kind: "info",
    lesson: "本站设定",
    say: "空座由人机补上；连续超时 2 次进托管，就是人机替你打。",
    note: "掉线 3 秒后人机接手，用原昵称和房间码回来能接着打。出牌限时 30 秒。",
  },
  {
    id: "finale",
    kind: "info",
    finale: true,
    say: "学会了！和 5 个人机打一盘练练吧。",
    note: "拿不准就点「提示」，我告诉你我会怎么出。",
    face: "happy",
  },
];

export const TUTORIAL_FINAL_STEP = "finale";

const RANK_WORDS: Record<string, number> = { 小: 16, 大: 17 };
const ranksOf = (text: string) => text.trim().split(/\s+/).filter(Boolean).map((token) => RANK_WORDS[token] ?? parseRank(token));
const key = (ranks: readonly number[]) => [...ranks].sort((a, b) => a - b).join(",");

/** 选中的牌和剧本写法（"7 7 7 小"）是不是同一套（按点数比，不管花色副数）。 */
export function selectionMatches(cards: readonly Card[], text: string): boolean {
  return key(cards.map(rankOf)) === key(ranksOf(text));
}

/** 两条命令是不是同一步（出牌、烧牌按点数比；还贡只看是不是还贡）。 */
export function sameCommand(a: TutorialCommand, b: TutorialCommand): boolean {
  if (a.type !== b.type) return false;
  if ((a.type === "PLAY" && b.type === "PLAY") || (a.type === "BURN" && b.type === "BURN")) return key(a.cards.map(rankOf)) === key(b.cards.map(rankOf));
  if (a.type === "REVOLT" && b.type === "REVOLT") return a.revolt === b.revolt;
  if (a.type === "TRIBUTE" && b.type === "TRIBUTE") return a.eat === b.eat;
  if (a.type === "AUTO" && b.type === "AUTO") return a.on === b.on;
  if (a.type === "SCENE" && b.type === "SCENE") return a.scene === b.scene;
  return true;
}

/** 现在轮到谁：出牌阶段是轮到的人；同时决定的阶段先让人机，最后才是自己；一场结束返回 null。 */
export function tutorialActor(state: GoujiState): string | null {
  if (state.phase === "finished") return null;
  if (state.stage === "playing" && state.turn >= 0) return state.players[state.turn]!.id;
  const pending = pendingSeats(state);
  const bot = pending.find((seat) => state.players[seat]!.id !== TUTORIAL_SELF);
  const seat = bot ?? pending[0];
  return seat === undefined ? null : state.players[seat]!.id;
}

/** 练习局里自己现在能不能发命令（包括轮外的烧牌）。 */
export function tutorialCanAct(state: GoujiState, playerId: string): boolean {
  return legalCommands(state, playerId).length > 0;
}

/**
 * 锚点在这个局面下应该看得见（剧本单测用；和网页上 data-tutorial 的出现条件一致）。viewer 是自己的座位。
 */
export function anchorVisible(state: GoujiState, anchor: string, viewer = 0): boolean {
  const me = state.players[viewer]!;
  const view = redactGameForViewer(state, me.id);
  const myTurn = state.stage === "playing" && state.turn === viewer;
  const legal = legalCommands(view, me.id);
  if (/^plate-(me|duitou|tl|tr|bl|br)$/.test(anchor) || anchor === "buttons" || anchor === "control" || anchor === "headline" || anchor === "topbar-score") return true;
  if (anchor === "hand") return me.hand.length > 0 && state.stage !== "handEnd";
  if (anchor === "center" || anchor === "gouji-table") return state.stage === "playing" || state.stage === "revolution";
  if (anchor === "btn-play") return myTurn;
  if (anchor === "btn-pass") return myTurn && state.round?.top !== null;
  if (anchor === "btn-rang") return myTurn && canRang(state, viewer);
  if (anchor === "btn-burn") return (view.you?.burnCandidates.length ?? 0) > 0;
  if (anchor === "btn-return") return legal.some((command) => command.type === "RETURN");
  if (anchor === "tribute") return state.tribute !== null && (state.stage === "tribute" || state.stage === "return" || state.stage === "revolution") && state.tribute.items.length > 0;
  if (anchor === "summary" || anchor === "summary-ribbons") return state.stage === "handEnd" && state.result !== null && state.phase === "playing";
  if (anchor === "play-me") return state.round?.entries.some((entry) => entry.seat === viewer) === true;
  const col = /^col-(\d+)$/.exec(anchor);
  if (col) return state.stage !== "handEnd" && me.hand.some((card) => rankOf(card) === Number(col[1]));
  return false;
}

/** 剧本里谁是对头（文案用）。 */
export const TUTORIAL_DUITOU = oppOf(0);
