import { useEffect, useState } from "react";
import { parseCards, type Card } from "@gouji/game";
import { CardRow } from "./cards.js";

/** 示意牌：顺子 3–7、飞机带单 333444+5+9、炸弹、王炸。 */
const EXAMPLES: { label: string; cards: Card[] }[] = [
  { label: "顺子", cards: parseCards("3 4 5 6 7") },
  { label: "飞机带单", cards: parseCards("3 3 3 4 4 4 5 9") },
  { label: "炸弹", cards: parseCards("8 8 8 8") },
  { label: "王炸", cards: parseCards("小 大") },
];

/** 规则说明：一个按钮，点开是像素弹窗。用自己的话写，不照搬别人的规则书。 */
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
          <section className="gm-panel dz-rules" role="dialog" aria-modal="true" aria-labelledby="dz-rules-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="dz-rules-title">斗地主怎么打</h2>
            <div className="game-rules-block">
              <h3>一盘的流程</h3>
              <ol>
                <li>一副 54 张牌，每人 17 张，3 张底牌扣着。开了「明牌」的房间，发牌前可以选「明牌开始」：不看牌就把手牌亮给大家，这一盘 ×5，而且你第一个叫。</li>
                <li><b>叫地主</b>：从随机的一个人开始（有人明牌开始就从他开始）轮流选叫或不叫，有人叫就进入抢地主。三家都不叫就重新发牌。</li>
                <li><b>抢地主</b>：没说过「不叫」的人各有一次机会抢，每抢一次倍数 ×2；有人抢过的话，叫地主的人最后还能再抢一次。最后一个抢的人当地主，没人抢就是叫的人。</li>
                <li>地主亮出 3 张底牌收进手里（20 张），另外两人是农民，一伙。</li>
                <li><b>加倍</b>（房主可关）：三人同时选不加倍 / 加倍（×2），开了超级加倍还能选 ×4，选完一起公布。加倍只翻自己和对手之间的那份。地主还可以选明牌（×2）。</li>
                <li><b>出牌</b>：地主先出。之后每人要么出同样牌型、同样张数、更大的牌，要么不出；炸弹、王炸能压别的牌型。另外两人都不出时，这一轮最后出牌的人重新出任意牌型。不出过的人，下一圈轮到时还能接着出。</li>
                <li>谁先出完，谁那一方就赢：地主出完地主赢；任意一个农民出完，两个农民一起赢。</li>
              </ol>
            </div>
            <div className="game-rules-block">
              <h3>大小</h3>
              <p>3 &lt; 4 &lt; … &lt; 10 &lt; J &lt; Q &lt; K &lt; A &lt; 2 &lt; 小王 &lt; 大王，花色不分大小。王炸最大；炸弹压其他所有牌型，炸弹之间比点数；其他牌只能被同牌型、同张数、点数更大的牌压，带的牌不算大小。</p>
            </div>
            <div className="game-rules-block">
              <h3>牌型</h3>
              <ul>
                <li>单张、对子、三张；三带一（带一张单）、三带一对。</li>
                <li>顺子：5 张以上连续的单牌，只能 3 到 A（2 和王不能连）。连对：3 对以上连续。飞机：2 个以上连续的三张。</li>
                <li>飞机带单 / 飞机带对：每个三张各带一张单牌 / 一个对子。四带二（两张单，可以同点数）、四带两对。带的牌不能和主体同点数，不能同时带两张王。</li>
                <li>炸弹：4 张同点数。王炸：小王 + 大王。四带二、四带两对不算炸弹。</li>
              </ul>
              <div className="dz-rules-examples">
                {EXAMPLES.map((example) => (
                  <span key={example.label}>
                    <CardRow cards={example.cards} scale={1} step={16} />
                    <small>{example.label}</small>
                  </span>
                ))}
              </div>
            </div>
            <div className="game-rules-block">
              <h3>计分</h3>
              <p>倍数 = 2^抢地主次数 × 明牌（明牌开始 5、地主明牌 2，只取最大的）× 2^(炸弹 + 王炸个数) × 春天或反春 2。春天：地主赢，两个农民一张都没出过；反春：农民赢，地主只出过第一手。</p>
              <p>每个农民和地主之间的输赢 = 底分 × 倍数 × 农民的加倍 × 地主的加倍。地主赢就从两个农民那里各收一份，输了各赔一份，所以地主的输赢是两份加起来。打满约定的盘数，总分最高的人获胜，同分并列。</p>
            </div>
            <div className="game-rules-block">
              <h3>操作</h3>
              <ul>
                <li>点牌选中，按住在牌上拖可以一次选一串；右键清空。「提示」会从小到大轮流给出能压的牌。</li>
                <li>快捷键：空格出牌、P 不出、H 提示、Esc 取消选择；叫抢加倍时 Y 是、N 否，S 超级加倍；结算时 N 下一盘。</li>
                <li>限时：明牌开始 5 秒，叫抢、加倍各 10 秒，出牌 25 秒。超时自动处理：不叫、不抢、不加倍、不明牌；该你先出就出最小的一张，跟牌就不出。连续超时 2 次转托管（人机替你打），点「取消托管」恢复；掉线 3 秒后由人机代打，用原昵称回来就能接上。</li>
                <li>房主开了记牌器的话，牌桌上显示每种牌外面（别人手里）还剩几张。</li>
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
