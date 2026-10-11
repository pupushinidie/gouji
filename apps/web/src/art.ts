/** 美术资源（文件名、尺寸、帧数以 art/spec.md 为准；正式美术在 public/art/）和联邦色。 */
const BASE = `${import.meta.env.BASE_URL}art/`;

export type StatusIcon = "gouji" | "shao" | "shao-ok" | "jieshao" | "wutou" | "rang" | "jiefeng" | "geming" | "kanggong" | "luanchan";

export const art = {
  /** 青岛海边露台场景（512×288）：牌桌背景和首页主图。 */
  sceneNight: `${BASE}scene-night.png`,
  sceneDay: `${BASE}scene-day.png`,
  /** 联邦徽记 24×24（0 甲 海浪、1 乙 屋顶）。 */
  team: (team: number) => `${BASE}team/${team === 0 ? "a" : "b"}.png`,
  /** 头像框 48×48（中间 40×40 透明，头像贴在 4,4）。 */
  frame: (team: number) => `${BASE}seat/frame-${team === 0 ? "a" : "b"}.png`,
  /** 名牌底板 24×24 九宫格（边 8px）。 */
  plate: (team: number) => `${BASE}seat/plate-${team === 0 ? "a" : "b"}.png`,
  /** 头像 40×40（0 海鸥、1 海星、2 蛤蜊、3 章鱼、4 海龟、5 海豹）。 */
  avatar: (index: number) => `${BASE}avatar/${((index % 6) + 6) % 6}.png`,
  /** 对头标记 24×24。 */
  duitou: `${BASE}marks/duitou.png`,
  /** 名次徽章 36×20（0 头科 … 5 大落）。 */
  rank: (place: number) => `${BASE}rank/${place + 1}.png`,
  status: (name: StatusIcon) => `${BASE}status/${name}.png`,
  ribbon: (team: number) => `${BASE}deco/ribbon-${team === 0 ? "a" : "b"}.png`,
};

/** 精灵图：单帧尺寸、帧数、每帧毫秒、是否循环（spec 3.6）。 */
export const SPRITES = {
  gouji: { src: `${BASE}fx/gouji.png`, w: 96, h: 40, frames: 6, ms: 80, loop: false },
  flame: { src: `${BASE}fx/flame.png`, w: 16, h: 24, frames: 6, ms: 100, loop: true },
  burn: { src: `${BASE}fx/burn.png`, w: 64, h: 64, frames: 8, ms: 90, loop: false },
  douse: { src: `${BASE}fx/douse.png`, w: 64, h: 64, frames: 6, ms: 90, loop: false },
  finish: { src: `${BASE}fx/finish.png`, w: 64, h: 64, frames: 8, ms: 80, loop: false },
  chuan: { src: `${BASE}fx/chuan.png`, w: 128, h: 96, frames: 10, ms: 100, loop: false },
  ring: { src: `${BASE}fx/duitou-ring.png`, w: 64, h: 64, frames: 4, ms: 120, loop: true },
  arrow: { src: `${BASE}fx/tribute-arrow.png`, w: 48, h: 16, frames: 4, ms: 120, loop: true },
  seagull: { src: `${BASE}deco/seagull.png`, w: 24, h: 16, frames: 4, ms: 150, loop: true },
} as const;
export type SpriteName = keyof typeof SPRITES;

/** 联邦色：甲（座位 0、2、4）海蓝，乙（1、3、5）瓦红（spec 第 1 节）。 */
export const TEAM_COLORS = ["#2f86d6", "#d4553a"] as const;

export function seatColor(team: number): string {
  return TEAM_COLORS[team % TEAM_COLORS.length]!;
}

/** 背景图 512×288，按整数倍放大到盖满一块区域。 */
export function coverSize(width: number, height: number): string {
  const scale = Math.max(1, Math.ceil(Math.max(width / 512, height / 288)));
  return `${512 * scale}px ${288 * scale}px`;
}

/** 预先加载牌桌用到的图，免得特效第一次播的时候闪一下。 */
export function preloadArt(): void {
  for (const sprite of Object.values(SPRITES)) new Image().src = sprite.src;
  const icons: StatusIcon[] = ["gouji", "shao", "shao-ok", "jieshao", "wutou", "rang", "jiefeng", "geming", "kanggong", "luanchan"];
  for (const name of icons) new Image().src = art.status(name);
  for (let i = 0; i < 6; i += 1) {
    new Image().src = art.avatar(i);
    new Image().src = art.rank(i);
  }
}
