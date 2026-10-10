import { useEffect, useState } from "react";
import { parseCards, type Card } from "@gouji/game";
import { CardRow } from "./cards.js";

/** 示意牌：同点数挂配牌、纯 2 挂王、纯王、够级牌。 */
const EXAMPLES: { label: string; cards: Card[] }[] = [
  { label: "8 8 2（= 3 张 8）", cards: parseCards("8 8 2") },
  { label: "3 张 Q 挂小王", cards: parseCards("Q Q 2 小") },
  { label: "纯 2 挂王", cards: parseCards("2 2 大") },
  { label: "够级：2 张 K", cards: parseCards("K K") },
];

/** 规则说明（引擎阶段先写的版本，界面阶段会排版）。用自己的话写，不照搬规则书。 */
function GameRules() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button className="quiet-button dz-rules-button" type="button" aria-expanded={open} onClick={() => setOpen(true)}>规则</button>
      {open && (
        <div className="gm-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section className="gm-panel dz-rules" role="dialog" aria-modal="true" aria-labelledby="gj-rules-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="gj-rules-title">够级怎么打</h2>
            <div className="game-rules-block">
              <ul>
                <li>四副牌 216 张，6 人每人 36 张。隔一个座位是队友（甲 0、2、4，乙 1、3、5），正对面的人是你的<b>对头</b>。比谁先出完：第一个出完是头科，然后二科、三科、四科、二落，最后剩下的是大落。</li>
                <li>一次出的一组牌只有三种：同点数的牌加任意张 2 和王；只有 2 加王；只有王。没有顺子。挂上去的 2 当那个点数用，王还是王。</li>
                <li>后出的要张数一样，两组牌各自从大到小排好，<b>每一张都更大</b>才算压住。挂大王的牌没人压得住。</li>
              </ul>
              <div className="dz-rules-examples">
                {EXAMPLES.map((example) => (
                  <figure key={example.label}><CardRow cards={example.cards} scale={1} /><figcaption>{example.label}</figcaption></figure>
                ))}
              </div>
            </div>
            <div className="game-rules-block">
              <h3>够级、烧牌、让牌</h3>
              <ul>
                <li><b>够级牌</b>：5 张 10、4 张 J、3 张 Q、2 张 K、2 张 A，或者单张 2、任何带王的牌。有头的人出够级牌，正常只有他的对头能接，两人一来一回地「够」。</li>
                <li>一轮里过了牌就不能再上，但对头出的牌过过也能接。</li>
                <li><b>烧牌</b>：别人（不是你对头）出了够级牌，你的牌能先压住它、之后除了最后一组每组都挂王一口气出完，就能抢着按「烧」。按钮只有你自己看得到；够级牌打出后至少有 2 秒可以按。烧牌成功就走科，下一盘被烧的人给你 1 张贡；中途被压住就失败，没有惩罚。这一轮过过牌不能烧。</li>
                <li><b>让牌</b>（房主可关）：对头出的不是够级牌时，可以先让你后面两个人（下家、下下家）接；他们都没上，又轮回你。</li>
                <li>对头出完以后（那一轮结束起）你就<b>无头</b>：你的够级牌谁都能接，你也能接任何人的够级牌。第二个人出完的那一轮结束后进入<b>四人乱缠</b>：没有够级、烧牌、让牌，过了也还能接。</li>
              </ul>
            </div>
            <div className="game-rules-block">
              <h3>进贡、革命、计分</h3>
              <ul>
                <li>第 2 盘起（房主可关）：大落给头科 2 张、二落给二科 1 张，只进大王、小王、2，从大到小，没有就欠着不补；收的人挑同样张数还回去。上一盘一队包揽前三名（串三户）时，输的一队每人给自己的对头 1 张。被烧的人给烧牌的人 1 张，不还。给的和收的是队友时，由收的人选吃贡还是免贡。发到 4 张大王的人不用进落贡、串贡（抗贡）。</li>
                <li>进贡后手里一张王和 2 都没有，可以<b>革命</b>：这盘不打、算四科，对头直接无头。两人以上革命就重新发牌。</li>
                <li>名次分：头科 +4、二科 +2、三科四科 0、二落 −2、大落 −4，全队加起来，每个人记自己联邦的分。一队包揽头科、二科、三科叫串三户，±12，这盘立刻结束。打满约定的盘数，累计分高的联邦获胜。</li>
                <li>手牌剩 10 张或以下时大家看得到张数；房主开了「看牌」的话，队友能看到你的全部手牌。</li>
              </ul>
            </div>
            <div className="game-rules-block">
              <h3>限时和托管</h3>
              <ul>
                <li>出牌 30 秒（让牌后再表态 15 秒），吃免贡 10 秒，还贡 20 秒，革命 10 秒。超时自动处理：发牌出最小的一张，接牌过，吃贡，还最小的牌，不革命。</li>
                <li>连续超时 2 次转托管（人机替你打），点「取消托管」恢复；掉线 3 秒后由人机代打，用原昵称回来就能接上。空座位开局时由人机（咕噜一号、二号……）补上。</li>
              </ul>
            </div>
            <div className="gm-panel-actions">
              <button className="primary-button" type="button" onClick={() => setOpen(false)}>知道了</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default GameRules;
