/** 美术资源（文件名和尺寸以 art/spec.md 为准，简洁版和正式美术同名）和联邦色。界面阶段会补全。 */
const BASE = `${import.meta.env.BASE_URL}art/`;

export const art = {
  /** 青岛海边露台场景（512×288）：牌桌背景和首页主图。 */
  sceneNight: `${BASE}scene-night.png`,
  sceneDay: `${BASE}scene-day.png`,
};

/** 联邦色：甲（座位 0、2、4）海蓝，乙（1、3、5）瓦红（开工拍板的美术方向 A）。 */
export const TEAM_COLORS = ["#2f6fb3", "#c4553a"] as const;

export function seatColor(team: number): string {
  return TEAM_COLORS[team % TEAM_COLORS.length]!;
}

/** 背景图 512×288，按整数倍放大到盖满一块区域。 */
export function coverSize(width: number, height: number): string {
  const scale = Math.max(1, Math.ceil(Math.max(width / 512, height / 288)));
  return `${512 * scale}px ${288 * scale}px`;
}
