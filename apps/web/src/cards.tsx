/**
 * 像素扑克牌（和掼蛋、德州共用的牌面，41×57，见 public/cards-pixel/）。只按整数倍放大。
 */
import type { CSSProperties, HTMLAttributes } from "react";
import { cardName, rankOf, suitOf, type Card } from "@gouji/game";

export const CARD_W = 41;
export const CARD_H = 57;

const BASE = `${import.meta.env.BASE_URL}cards-pixel/`;

/** 牌面图片：黑桃 A 是 Sa.png、红桃 10 是 H10.png、梅花 2 是 C2.png；大王 J1（彩色）、小王 J2（黑白）；牌背 back.png。 */
export function cardImage(card: Card): string {
  if (card < 0) return `${BASE}back.png`;
  const suit = suitOf(card);
  const rank = rankOf(card);
  if (suit === "J") return `${BASE}${rank === 17 ? "J1" : "J2"}.png`;
  const label = ({ 11: "j", 12: "q", 13: "k", 14: "a", 15: "2" } as Record<number, string>)[rank] ?? String(rank);
  return `${BASE}${suit}${label}.png`;
}

/** 提前加载整副牌，免得发牌时一张张冒出来。 */
export function preloadCards(): void {
  for (let card = -1; card < 54; card += 1) new Image().src = cardImage(card);
}

interface CardViewProps extends HTMLAttributes<HTMLSpanElement> {
  readonly card: Card;
  readonly scale: number;
}

/** 一张牌。外层 span 定尺寸（41×57 的整数倍），样式由 className 加（选中、变暗、角标……）。 */
export function CardView({ card, scale, className, style, ...rest }: CardViewProps) {
  const size: CSSProperties = { width: CARD_W * scale, height: CARD_H * scale, ...style };
  return (
    <span className={["dz-card", className].filter(Boolean).join(" ")} style={size} title={cardName(card)} {...rest}>
      <img src={cardImage(card)} alt={cardName(card)} draggable={false} width={CARD_W * scale} height={CARD_H * scale} />
    </span>
  );
}

/**
 * 一排叠着的牌（出过的牌、明牌的手牌、底牌、结算里的手牌）。step 是相邻两张错开的像素；
 * perRow 超过就换行（下一行往上压住上一行的下半截）。
 */
export function CardRow({ cards, scale, step, perRow = 99, className, align = "start" }: {
  readonly cards: readonly Card[];
  readonly scale: number;
  readonly step?: number;
  readonly perRow?: number;
  readonly className?: string;
  readonly align?: "start" | "center" | "end";
}) {
  const gap = step ?? Math.round(CARD_W * scale * 0.42);
  const rows: Card[][] = [];
  for (let index = 0; index < cards.length; index += perRow) rows.push(cards.slice(index, index + perRow));
  return (
    <span className={["dz-card-rows", `align-${align}`, className].filter(Boolean).join(" ")} style={{ "--row-lift": `${Math.round(CARD_H * scale * 0.45)}px` } as CSSProperties}>
      {rows.map((row, r) => (
        <span key={r} className="dz-card-row">
          {row.map((card, index) => (
            <CardView key={`${card}-${index}`} card={card} scale={scale} style={index > 0 ? { marginLeft: gap - CARD_W * scale } : undefined} />
          ))}
        </span>
      ))}
    </span>
  );
}
