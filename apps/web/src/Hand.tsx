/**
 * 自己的手牌：按点数分列（3 … A、2、小王、大王），一列只画一张牌，列顶写点数、牌上写张数。
 * 选牌按列：
 * - 普通牌（3～A）：点一下选「合适的张数」（发牌时整列；接牌时和桌面牌一样多的张数），再点取消；
 *   同一时间只能选一种点数（够级没有顺子），点别的点数会换过去。还贡时每点一下加 1 张，可以选好几种。
 * - 2、小王、大王：每点一下加 1 张，加满了再点清零。
 * 多一张 / 少一张在操作行里调。
 */
import type { CSSProperties } from "react";
import { groupByRank, rankLabel, type Card } from "@gouji/game";
import { CARD_W, CardView } from "./cards.js";
import type { Layout } from "./table.js";

export const HAND_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] as const;
export const isWildRank = (rank: number) => rank >= 15;
export const shortRank = (rank: number) => (rank === 16 ? "小王" : rank === 17 ? "大王" : rankLabel(rank));

/** 选中的张数（下标是点数）→ 具体的牌（每种点数取前几张）。 */
export function selectedCards(hand: readonly Card[], picks: readonly number[]): Card[] {
  const groups = groupByRank(hand);
  const cards: Card[] = [];
  for (const rank of HAND_RANKS) cards.push(...groups[rank]!.slice(0, picks[rank] ?? 0));
  return cards;
}

/** 具体的牌 → 每种点数选几张。 */
export function picksOf(cards: readonly Card[], rankOf: (card: Card) => number): number[] {
  const picks = new Array<number>(18).fill(0);
  for (const card of cards) picks[rankOf(card)]! += 1;
  return picks;
}

export default function Hand({
  hand,
  picks,
  layout,
  dim,
  onPick,
  disabled,
}: {
  readonly hand: readonly Card[];
  readonly picks: readonly number[];
  readonly layout: Layout;
  /** 这些点数的列变暗（接牌时用不上的）。 */
  readonly dim: ReadonlySet<number>;
  readonly onPick: (rank: number) => void;
  readonly disabled: boolean;
}) {
  const groups = groupByRank(hand);
  const columns = HAND_RANKS.filter((rank) => groups[rank]!.length > 0);
  const rows: number[][] = [];
  for (let index = 0; index < columns.length; index += layout.perRow) rows.push(columns.slice(index, index + layout.perRow));
  const { hs, step } = layout;
  const width = CARD_W * hs;
  return (
    <div className={layout.mobile ? "gj-hand mobile" : "gj-hand"} data-tutorial="hand" style={{ "--hs": hs } as CSSProperties}>
      {hand.length === 0 && <span className="gj-hand-empty">手里没有牌了</span>}
      {rows.map((row, r) => (
        <div className="gj-hand-row" key={r}>
          {row.map((rank, index) => {
            const count = groups[rank]!.length;
            const picked = picks[rank] ?? 0;
            const classes = ["gj-col", picked > 0 ? "picked" : "", dim.has(rank) ? "dim" : "", isWildRank(rank) ? "wild" : ""].filter(Boolean).join(" ");
            return (
              <button
                key={rank}
                type="button"
                className={classes}
                data-rank={rank}
                data-tutorial={`col-${rank}`}
                disabled={disabled}
                style={{ width, marginLeft: index > 0 ? step - width : 0, zIndex: index + 1 } as CSSProperties}
                onClick={() => onPick(rank)}
                aria-label={`${shortRank(rank)} ${count} 张${picked ? `，选了 ${picked} 张` : ""}`}
              >
                <span className="gj-col-head">{layout.mobile && rank >= 16 ? (rank === 16 ? "小" : "大") : shortRank(rank)}</span>
                <span className="gj-col-card">
                  <CardView card={groups[rank]![0]!} scale={hs} />
                  {count > 1 && <span className="gj-col-stack" aria-hidden="true" />}
                  <b className="gj-col-count">{picked > 0 ? `${picked}/${count}` : `×${count}`}</b>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
