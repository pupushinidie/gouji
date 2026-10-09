/**
 * 牌桌的尺寸计算和倒计时。像素牌只按整数倍放大：自己手牌 hs 倍，桌上出的牌 ps 倍，别人明牌 1 倍。
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
  /** 自己手牌的倍数。 */
  readonly hs: number;
  /** 桌上出的牌、底牌的倍数。 */
  readonly ps: number;
  /** 手牌相邻两张错开的像素。 */
  readonly step: number;
  /** 手牌每行几张（手机上分两行）。 */
  readonly perRow: number;
  readonly mobile: boolean;
}

/** 牌桌各部分的高度（桌面版）：上面的底牌倍数条、对手名牌、操作条、自己名牌那一栏。 */
export const TOP_H = 76;
export const PLATE_H = 168;
export const ACTION_H = 64;
/** 左右两边对手那一栏的宽度、自己名牌的宽度。 */
export const SIDE_W = 216;
const PAD = 24;

/**
 * 按牌桌区域大小挑倍数：手牌尽量大（4 → 3 → 2），出的牌比手牌小一号；
 * 20 张手牌一排放得下，每张至少露出角上的点数（13 个原始像素）。
 */
export function pickLayout(width: number, height: number, handCount: number): Layout {
  const count = Math.max(handCount, 1);
  if (width < 640) {
    const hs = 2;
    const perRow = count > 10 ? Math.ceil(count / 2) : count;
    const step = perRow > 1 ? Math.min(18 * hs, Math.floor((width - 16 - CARD_W * hs) / (perRow - 1))) : CARD_W * hs;
    return { hs, ps: 1, step, perRow, mobile: true };
  }
  const handWidth = width - SIDE_W - 2 * PAD;
  // 每张至少露出 12 个原始像素（角上的点数和花色）
  const fits = (hs: number) => 19 * 12 * hs + CARD_W * hs <= handWidth;
  const need = (hs: number, ps: number) => TOP_H + Math.max(PLATE_H, CARD_H * ps + 16) + CARD_H * ps + 12 + ACTION_H + CARD_H * hs + 8 * hs + PAD;
  const options: [number, number][] = [[4, 3], [3, 2], [2, 2], [2, 1]];
  const [hs, ps] = options.find(([h, p]) => fits(h) && need(h, p) <= height) ?? [2, 1];
  const step = count > 1 ? Math.min(18 * hs, Math.floor((handWidth - CARD_W * hs) / (count - 1))) : CARD_W * hs;
  return { hs, ps, step, perRow: count, mobile: false };
}

export function useLayout(handCount: number): [React.RefObject<HTMLDivElement | null>, Layout, { width: number; height: number }] {
  const ref = useRef<HTMLDivElement | null>(null);
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
  return [ref, pickLayout(box.width, box.height, handCount), box];
}
