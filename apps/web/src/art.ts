/** 美术资源（art/ 下的脚本导出到 public/art/）和座位色。 */
const BASE = `${import.meta.env.BASE_URL}art/`;

export const art = {
  /** 乡村大院场景（512×288）：夜间灯笼月光、白天柿子树麦垛。牌桌背景和首页主图。 */
  sceneNight: `${BASE}scene-night.png`,
  sceneDay: `${BASE}scene-day.png`,
  /** 座位头像 0–2（40px）。 */
  avatar: (index: number) => `${BASE}avatar-${index % 3}.png`,
  /** 地主帽、农民草帽（32px）。 */
  hatLandlord: `${BASE}hat-landlord.png`,
  hatFarmer: `${BASE}hat-farmer.png`,
  /** 特效：炸弹、火箭（王炸）、爆炸、春天的桃花。 */
  bomb: `${BASE}bomb.png`,
  rocket: `${BASE}rocket.png`,
  boom: `${BASE}boom.png`,
  spring: `${BASE}spring.png`,
};

/** 座位色：自己、下家（右）、上家（左）。 */
export const SEAT_COLORS = ["#f0b53a", "#3f8fe8", "#47b968"] as const;

export function seatColor(index: number): string {
  return SEAT_COLORS[index % SEAT_COLORS.length]!;
}

/** 背景图 512×288，按整数倍放大到盖满一块区域。 */
export function coverSize(width: number, height: number): string {
  const scale = Math.max(1, Math.ceil(Math.max(width / 512, height / 288)));
  return `${512 * scale}px ${288 * scale}px`;
}
