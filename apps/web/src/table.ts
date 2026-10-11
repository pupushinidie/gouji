/**
 * 牌桌的尺寸计算和倒计时。像素图只按整数倍放大：
 * 自己的手牌 hs 倍、桌上出的牌 ps 倍、头像框和状态图标 as 倍。
 *
 * 桌面版牌桌（量的是 .gj-table 的实际大小）从上到下：
 *   对手两排（左上 / 对头 / 右上；左下 / 桌面中间 / 右下），每格 = 名牌 + 出的牌；
 *   操作行（自己的名牌、选中的牌和提示、按钮）；手牌（按点数分列，一列一张，列顶写点数和张数）。
 * 手机版（宽 < 640）：对手是两排小名牌，手牌分两行，每行 8 列，牌 1 倍。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LobbyRoomSnapshot } from "@gouji/game";
import { CARD_H, CARD_W } from "./cards.js";

export function useCountdown(room: LobbyRoomSnapshot): number | null {
  const [now, setNow] = useState(Date.now());
  const [anchor, setAnchor] = useState({ at: Date.now(), ms: room.turnRemainingMs });
  useEffect(() => setAnchor({ at: Date.now(), ms: room.turnRemainingMs }), [room]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  if (anchor.ms === undefined) return null;
  return Math.max(0, Math.ceil((anchor.ms - Math.max(0, now - anchor.at)) / 1000));
}

export interface Layout {
  readonly mobile: boolean;
  /** 手牌倍数。 */
  readonly hs: number;
  /** 桌上出的牌的倍数。 */
  readonly ps: number;
  /** 头像框、状态图标、名次徽章的倍数。 */
  readonly as: number;
  /** 手牌相邻两列的间距（像素）。 */
  readonly step: number;
  /** 手牌每行几列。 */
  readonly perRow: number;
}

/** 名牌高度（头像框 48×as + 上下边）。 */
export const plateH = (as: number) => 48 * as + 28;
/** 一手出的牌（牌 + 一行读法）。 */
export const playH = (ps: number) => CARD_H * ps + 36;
/** 手牌区：列顶一行字 + 牌 + 选中时抬起的空间。 */
export const handH = (hs: number) => CARD_H * hs + 44;
const PAD = 40;

const OPTIONS: [number, number, number][] = [
  [3, 2, 2], [3, 2, 1], [3, 1, 2], [3, 1, 1], [2, 2, 1], [2, 1, 1],
];

export function pickLayout(width: number, height: number, columns: number): Layout {
  const cols = Math.max(columns, 1);
  if (width < 640) {
    const perRow = 8;
    const step = Math.min(CARD_W + 8, Math.floor((width - 12 - CARD_W) / (perRow - 1)));
    return { mobile: true, hs: 1, ps: 1, as: 1, step, perRow };
  }
  const usable = width - 32;
  const stepFor = (hs: number) => (cols > 1 ? Math.min(CARD_W * hs + 8, Math.floor((usable - CARD_W * hs) / (cols - 1))) : CARD_W * hs);
  // 最多 15 列都要露出角上的点数（每列至少 16 个原始像素）
  const fitsWidth = (hs: number) => (usable - CARD_W * hs) / 14 >= 16 * hs;
  const need = (hs: number, ps: number, as: number) =>
    handH(hs) + Math.max(plateH(as), playH(ps) + 28, 96) + 2 * (plateH(as) + 6 + playH(ps)) + PAD;
  const [hs, ps, as] = OPTIONS.find(([h, p, a]) => fitsWidth(h) && need(h, p, a) <= height) ?? [2, 1, 1];
  return { mobile: false, hs, ps, as, step: stepFor(hs), perRow: cols };
}

export function useBox<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [box, setBox] = useState({ width: 1100, height: 700 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, box];
}
