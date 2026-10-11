# 够级

够级的网页联机版：青岛的四副牌扑克，6 个座位分成两个联邦 3 对 3（隔座是队友，正对面是「对头」），开局时空座由人机（咕噜一号、二号……）补满。线上路径 https://gulugagame.com/gouji/ （还没上线）。

- 规则书：`~/Desktop/游戏规则/够级.md`；补充和勘误：`~/Desktop/游戏规则/够级-补充.md`（第三节勘误 7 条照做）。
- 开工拍板：`~/projects/pipeline/games/gouji/decisions/kickoff.json`（名字、路径、美术方向 A 青岛海边露台、待确认 1–11 和勘误 5–7 全按推荐）。
- 脚手架从斗地主 `doudizhu@468d826` 复制（固定座位、开局补人机、托管、观战、挤登录、管理员解散都继承）。

## 跑起来

| 命令 | 做什么 |
|---|---|
| `npm install` | 装依赖 |
| `npm run dev` | 服务 3021 + 网页 5292（另起一套：`WEB_PORT=5392 SERVER_PORT=3121 npm run dev`，服务端口也可以用 `PORT`） |
| `npm test` | 全部测试（约 15 秒，见下面「测试」） |
| `npm run typecheck` | 规则包、测试、服务器、网页的类型检查（会重写 `packages/game/dist`，别人在 dev 服务上测时先打招呼） |
| `BASE_PATH=/gouji/ npm run build` | 生产构建 |
| `npm run sim -- 400 1 5` | 长跑随机对局（400 场 × 5 盘 + 三种选项组合，约 15 秒） |
| `node scripts/test-bot.mjs …` | 陪玩脚本（见下面） |
| `node scripts/spy.mjs 3` | 抓包检查隐藏信息（连真实服务器） |

改了 `packages/game` 要先 `npm run build:game` 再跑服务器测试（服务器读的是 dist）。

测试用的服务器环境变量（导入时读取）：`BOT_DELAY_SCALE=0`（人机立刻出手）、`TURN_MS=300`（每步超时）、`BURN_WINDOW_MS=300`（烧牌窗口，规则默认 2000）、`OFFLINE_TURN_MS`（离线代打前等多久，默认 3000）、`BOT_MIN_MS` / `BOT_MAX_MS`（人机思考 0.6–1.6 秒）、`BURN_MIN_MS` / `BURN_MAX_MS`（人机按烧牌的时刻 0.4–1.6 秒）、`ROOM_ABANDON_MS`、`REMATCH_TIMEOUT_MS`、`GAME_LOG`。

## 目录

| 位置 | 内容 |
|---|---|
| `packages/game/src/cards.ts` | 四副牌 216 张的编码（id 0–215；`id % 54` 是副内编号，和一副牌的斗地主一样：`rank = 3 + (local >> 2)`，52 小王 53 大王；牌面图按副内编号找） |
| `packages/game/src/sets.ts` | 核心判定（规则书 9.2）：`parseSet`、`beats`、`canBurnTail`、`burnCandidates`、`legalBurnLead`、`leadMoves`、`beatingMoves`、`setLabel` |
| `packages/game/src/turn.ts` | 轮转和资格：`canRespond`（4.4 的判定）、`nextResponder`（9.2 nextTurn）、`mayBurn` / `canBurn` / `burnOptions`、`canRang`、`isActive`、`nextActive` |
| `packages/game/src/gouji.ts` | 一盘的流程（发牌 → 进贡 → 还贡 → 革命 → 出牌 → 结算）、烧牌窗口、超时、托管、隐藏信息 `redactGouji` / `spectatorView` |
| `packages/game/src/scenes.ts` | **预览局面工厂**（对外接口，见下面「接口」） |
| `packages/game/src/engine.ts` | 服务器和网页用的统一入口 |
| `packages/game/src/bot.ts` | 人机「普通」难度（见下面「人机」一节）；`scripts/sim-gouji.ts` 是强度模拟 |
| `packages/game/test/` | 规则书 T1–T20（`rulebook.test.ts`）、勘误和正文各节（`rules.test.ts`）、隐藏信息（`redact.test.ts`）、核心判定对拍（`sets.test.ts`）、随机对局（`random.test.ts` + `sim.ts`）；`acceptance/` 归规则核对，引擎不改 |
| `apps/server/src/index.ts` | Socket.IO 房间服务器 |
| `apps/server/test/` | 观战、挤登录（继承）、够级房间（`game.test.ts`）、人机接线（`bots.test.ts`） |
| `apps/web/` | 网页。牌桌 `src/GameBoard.tsx`（六座围桌、对头在正上方）+ `Hand.tsx`（按点数分列的手牌和按列选牌）+ `table.ts`（按牌桌实测尺寸挑整数倍：手牌 hs、出的牌 ps、头像 as）+ `gouji.css`（`gj-` 牌桌、`gjt-` 顶栏、`gjs-` 右栏、`gjd-` 弹窗、`gjr-` 等候房间）；预览页 `preview.html?s=<场景>`（`&nav=1` 场景列表，`&then=bot,burn,tick` 往下走看特效，`&debug=1` 旧的调试牌桌 `DebugBoard.tsx`） |
| `art/`、`apps/web/public/art/` | 美术（归美术阶段，规格表 `art/spec.md`）；牌面复用全站像素扑克牌 `public/cards-pixel/` |
| `scripts/` | `test-bot.mjs` 陪玩、`spy.mjs` 抓包、`sim-random.ts` 长跑随机对局、`reconnect-check.mjs` 断线重连 |

## 规则（用自己的话）

**人和牌**：四副带大小王的扑克，216 张，6 人每人 36 张。座位 0–5 逆时针轮流，座位 s 的下家是 s+1。甲联邦坐 0、2、4，乙联邦坐 1、3、5；s 的**对头**是 s+3（正对面）。上家、下家、对头都是对手。花色不影响任何规则。点数从小到大：3 … A、2、小王、大王。2 和王是**配牌**。

**一套牌**只有三种：一种普通点数（3～A）加任意张配牌；只有 2 加任意张王；只有王。挂上去的 2 当成那个普通点数，王还是王。张数不限。

**比大小**：张数相同，把两套牌换成「等效牌」（挂的 2 换成普通点数）各自从大到小排好，每一张都严格大于对应的那张才算压住。所以挂大王的牌没人能压；纯 2 只有同样张数的纯王能压。

**够级牌**：等效后 10 有 5 张、J 4 张、Q 3 张、K 2 张、A 2 张，或者纯 2（1 张起），或者带任何一张王。

**一轮**：发牌的人出任意一套，之后逆时针每人上牌（压住）或过牌，转回桌面牌主人的座位都没人上，这一轮结束，最后出牌的人发下一轮。过了牌这一轮就不能再上——除非桌面牌是自己有头的对头出的（「对头牌不过」）。有头的人出够级牌时，正常只有他的对头能接（过过也行），外加这一轮没过过牌的无头的人。

**烧牌**：有头的人 O 打出够级牌后，除了 O 和 O 的对头，在打、有头、这一轮没过过牌的人，如果手牌能「先拿一套 S₁ 压住它，剩下的每套（除了最后一套）都挂王」一口气出完，就能抢着烧。烧成后进入烧牌状态：之后每次发牌只能出全部剩下的牌（正好一套），或者挂王而且剩下仍能步步带王的一套；任何一套被压住（解烧，被烧的人压住叫反烧）就失败，没有惩罚。出完就烧牌成功，下一盘被烧的人给他 1 张烧贡。队友之间也能烧。

**让牌**（开房选项）：对头出的不是够级牌、轮到我时，可以先让我的下家、下下家接；他们都没上就回到我，我只能上或过；他们有人上了，我算过过牌。

**走科、接风、无头、乱缠**：出完手牌叫走科，依次是头科、二科、三科、四科、二落，最后剩下的是大落。走科那一轮照常打完，别人可以压他的底牌；这一轮最后出牌的人已经走了，就由他之后第一个还在打的人接风。对头走科的那一轮结束起，这个人无头：他的够级牌没有限制、也不能被烧，他能接任何人的够级牌，但不能烧、没有「对头牌不过」。第二个人走科的那一轮结束后进入四人乱缠：没有够级限制、烧牌、让牌，过了也还能接。

**一盘结束**：一队包揽头科、二科、三科（串三户）立刻结束；否则打到只剩一个人有牌。名次分 +4 / +2 / 0 / 0 / −2 / −4，全队相加，每个人记自己联邦的分；串三户 ±12。

**进贡**（第 2 盘起，开房选项）：烧贡（每次成功的烧牌，被烧的人给烧的人 1 张，不还）、落贡（大落给头科 2 张、二落给二科 1 张）、串贡（上盘串三户，输的一队每人给自己的对头 1 张）。只进自己发到的大王、小王、2，从大到小，不够就少进、欠的不补；一个人好几份时先烧贡（按烧牌先后）再落贡 / 串贡。给的和收的是队友时，由收的人选吃贡或免贡。发到全部 4 张大王的人不进落贡和串贡（抗贡）。收了落贡、串贡的人挑同样张数的任意牌还回去（可以还刚收到的）。所有进贡、还贡的牌对大家公开。

**革命**：进贡还贡后手里一张王和 2 都没有，可以革命（网上每盘都有一个革命表态阶段，人人都要表态，没资格的人点「继续」——这样谁也看不出有没有人能革命）：这盘不出牌，扣下的牌不算，名次是四科（两个队友拿了头科、二科时补成三科，构成串三户），他的对头从开局起无头。两人以上革命就重新发牌（不进贡，盘数不加，首出不变）。

**首出**：第 1 盘随机；之后上一盘的大落先出，串三户时头科的对头先出；该先出的人革命了由下一个没革命的下家先出。

**一场**：打满房间设定的盘数（1 / 3 / 5 / 8），累计分高的联邦获胜，相等为平局。

**报牌、看牌**：手牌 10 张或以下时张数公开，否则显示「10+」；看牌打开时，剩 10 张或以下的人的队友能看到他的全部手牌。

## 默认规则表（规则书没写死、这里这样处理的地方）

| 项目 | 做法 | 来源 |
|---|---|---|
| 3 能不能挂王、挂 2 | 能（3 3 大 合法） | 待确认 #1，拍板 |
| 让牌后下家 / 下下家上了牌 | 让牌的人算过牌 | 待确认 #2，拍板 |
| 烧贡 | 只有烧牌成功（出完）才有；反烧不翻倍 | 待确认 #3，拍板 |
| 只剩同一队的人 | 打到只剩 1 人（分出二落、大落） | 待确认 #4，拍板 |
| 还贡 | 任意牌，包括刚收到的贡牌 | 待确认 #5，拍板 |
| 串三户后谁先出 | 头科的对头 | 待确认 #6，拍板 |
| 关掉进贡（比赛版） | 不进贡，串三户仍 ±12 | 待确认 #7，拍板 |
| 报牌、看牌门槛 | 10 张或以下 | 待确认 #8，拍板 |
| 革命者的对头 | 直接无头，不做够死级 | 待确认 #9，拍板 |
| 四人乱缠出牌顺序 | 照常逆时针 | 待确认 #10，拍板 |
| 一场盘数 | 默认 5，可选 1 / 3 / 5 / 8 | 待确认 #11，拍板 |
| 让牌的条件 | 只在对头出非够级牌时（下两家有无头的人也不行） | 勘误 #5，拍板 |
| 串贡 | 输的一队每人给自己的对头 1 张 | 勘误 #6，拍板 |
| 谁能烧 | 除了出牌人和他的对头都能烧（队友也能）；多人同时按，从被烧的人下家起逆时针最近的烧成 | 勘误 #7，拍板 |
| 在打的人 | 手里有牌、并且不是革命者（革命者扣下的牌放进 `revolutionHand`，不参与任何判定） | 勘误 #1 |
| 队内贡 | 先定下所有吃 / 免，再按顺序算每个人具体进哪几张（免掉的烧贡会改变后面落贡的牌） | 勘误 #2 |
| 烧牌窗口 | 有头的人打出够级牌（不在乱缠里）后，不管有没有人能烧，出牌、过牌生效、本轮结束、接风都等满 2 秒；无头的人、乱缠里的够级牌不用等 | 勘误 #3 |
| 2 秒内的动作 | 轮到的人先选的出牌 / 过牌、别人按的烧牌都先收下，只有本人看得到（别人的画面一点都不变，`version` 也不加）；满 2 秒时先结算烧牌（从被烧的人下家起最近的那个），再让先收下的动作生效 | 实现 |
| 2 秒之后按烧牌 | 立刻生效（窗口一直开到下一个人正常上牌或这一轮结束） | 实现 |
| 同时决定的阶段（吃免贡、还贡、革命） | 大家同时选，每个人的选择在所有人选完之前只有自己看得到；倒计时大家看到同一个阶段截止时间（不暴露谁还没选、谁能革命） | 实现 |
| 革命阶段 | **每盘都有**（进贡还贡之后，没人能革命也有），6 个座位都要表态：能革命的人选革命 / 不革命，其他人只能选「不革命」（界面上叫「继续」）；所有人表态完或 10 秒到才结束。阶段出不出现、多久结束都和谁能革命无关 | 实现（评审指出只在有人能革命时才出现会泄露） |
| 系统操作 | 超时（TIMEOUT）、烧牌窗口满（TICK）只有服务器能发；客户端发来一律拒绝 | 实现 |
| 革命的超时 | 算不革命，**不计入**托管的连续超时（不然托管的开关会暴露谁能革命） | 实现 |
| 一个人有两份队内贡 | 每份单独选吃 / 免 | 实现 |
| 队内贡、给的人一张配牌都没有 | 照样让收的人选（不提前暴露对方的牌），吃了也收不到牌 | 实现 |
| 上一盘的革命者在串三户赢的一队 | 他的对头照常给他串贡，他照常还贡 | 「串贡照常」的推论 |
| 烧牌状态遇上四人乱缠 | 烧牌状态继续（规则书没写；烧牌的人照样要步步带王，被压住就失败） | 实现，见交接报告 |
| 让牌后两家都没资格 | 直接回到让牌的人（规则书 5.7）；同一轮里对头再出非够级牌时还能再让 | 规则书 + 实现 |
| 一盘结束 | 剩下的人的手牌对所有人公开（革命者扣下的牌除外）；结算画面 20 秒，大家点「下一盘」或超时自动开始 | 实现 |
| 平局 | 一场累计分相同：`finalResult.draw = true`，6 个人都算并列 | 实现 |
| 自动入座 | 进房间按 0、3、1、4、2、5 的顺序坐（两个人先坐正对面，之后两队轮流加人）；可以换到空座，房主可以对调任意两个座位 | 实现（规则书 3.1「可以自己选座、房主可以调换」） |

### 全站约定覆盖规则书的地方

- **托管 = 人机代打**（规则书 9.5 写的是按默认动作）：超时一次按下表的默认动作；连续 2 次超时自动托管，之后由人机替他打，点「取消托管」（发 `{ type: "AUTO", on: false }`）恢复。
- **离线**：轮到离线的人时先等 3 秒（不算超时），然后由人机代打；用原昵称加房间码回来接管座位。
- **人机**：开局时空座自动补人机，叫咕噜一号、二号……（按座位顺序），带「人机」标签（`player.bot`），只有「普通」难度；没有「加人机」按钮。
- 人机只看自己座位的视图（`redactGameForViewer` 之后），烧牌也一样（候选在 `view.you.burnCandidates`）；人机按烧牌的时刻在 0.4–1.6 秒里随机。

## 人机（普通难度）

只吃自己座位的视图（`redactGameForViewer` 之后）。手牌按点数分组，一组普通牌就是一套，2 和王是配牌：
- **发牌**：剩下一套就出完；挂大王（大王都见过了就挂小王）的套谁也压不了，够数时连着出、最后一套随便；看得到手牌的队友剩 ≤8 张就喂他能接的小牌；否则出最小、张数多的普通牌组，够级组留着；有对手剩 ≤6 张时出张数比他手牌多的。
- **接牌**：每种能压的出法算代价（2 算 1、小王 1.8、大王 4，拆组 1.2，拆够级门槛再 +2，用 J 以上的点数小加），代价不超过门槛才压：平时 1，对头够级时 2.6，手牌 ≤10 张 +2、≤5 张再 +1.5，出牌的对手剩 ≤5 张 +2.5，四人乱缠里对面拿了头科二科、要挡第三个人时什么都压；队友的牌不压（一手出完除外）；要过牌时能让牌就让（下家剩 ≤4 张不让）。
- **烧牌**：基本能烧就烧，挑富余王最多 → 挂大王 → 用配牌最少的 S₁；被烧的是剩 ≤6 张的队友不烧；没有富余王、剩下没大王、大王还有 ≥2 张没见、对头 >10 张时不烧。烧牌状态下先出挂小王的套，点数最小的那组不挂王留到最后。
- **还贡**：不还 2 和王，不拆够级组，先还孤张小牌。**革命**：能革就革（模拟：革命比不革命每盘多 +3.2 分）。**队内贡**：吃（模拟：全吃比全免每盘多 +0.5 分）。
- 强度（`npm run sim:bot -- vs 500`，同种子换边，每场 5 盘）：对随机场胜率 100%、盘均分 +11.95；对 greedy-min（最小能压就压、不管队友）场胜率 100%、盘均分 +8.3；混编（普通 ×1 + greedy ×2 对 greedy ×3）盘均分 +2.1。决策平均 0.02ms、最坏约 2ms。
- 参数在 `BOT_TUNING`，`npm run sim:bot -- tune 500 key=value` 对比默认值。

## 限时和超时

| 步骤 | 限时 | 超时的默认动作 |
|---|---|---|
| 发牌（自由出） | 30 秒 | 出手里最小的一张普通牌（没有普通牌出最小的一张） |
| 烧牌状态下发牌 | 30 秒 | 出挂王最少的一套合法出法（整手是一套就全出；否则最小的一整组普通牌 + 1 张王，优先小王） |
| 接牌 | 30 秒 | 过牌 |
| 让牌后轮回到自己 | 15 秒 | 过牌 |
| 队内贡吃 / 免 | 10 秒 | 吃贡 |
| 还贡 | 20 秒 | 还点数最小的牌 |
| 革命表态（每盘都有） | 10 秒 | 不革命 / 继续（不计托管，也不清零连续超时） |
| 结算画面 | 20 秒 | 下一盘（不计托管） |
| 烧牌 | 不用轮到，不计时 | 不烧 |

计时按「决定点」：`timerKey = 盘数:step`，`step` 只在换人或换阶段时加 1。烧牌是轮外操作：窗口里按的烧牌、轮到的人先选好的动作都不会让 `step` 变，所以别人的倒计时不会被重置。

## 隐藏信息

只经过 `redactGameForViewer(state, viewerId)` / `spectatorView(state, seeAll)` 下发：

- 自己的手牌完整；看牌打开时剩 10 张或以下的队友给全部手牌；其他人只给张数（超过 10 张是 `null`）；一盘结束时公开剩下的手牌。
- 革命者扣下的牌（`revolutionHand`）只有他自己有（观战看全部手牌也看不到）。
- 烧牌资格和候选 S₁ 只在本人的 `you.burnCandidates`；窗口里按的烧牌（`round.burnRequests`）、先选好的动作（`round.pending`）只发给本人。
- 革命阶段谁能革命（`revolution.eligible`）、选了什么（`revolution.choices`），吃免贡的选择（`tribute.items[].eat`）、还的牌（`returned`），在所有人选完之前只发给本人。
- 种子、随机数状态不下发；服务器的操作序列只写进 `logs/games.jsonl`。
- 服务器给每个连接发快照时，和上次发的一样就不发——窗口里有人按烧牌，别人连「收到一条更新」这样的动静都没有。

## 接口（给界面、人机、教程、验收）

### 规则包入口（`@gouji/game`）

```ts
createGame(players: NewPlayer[6 个，下标就是座位], seed: number, options?: Partial<GameOptions>, overrides?: Partial<GoujiConfig>): GameState
applyCommand(state, playerId, command, rng?): GameState   // 不改输入；rng 不给就用状态里的种子随机数（教程可以传按剧本出数的 Rng）
timeoutTurn(state, seats?): GameState                      // 系统：给还没决定的人套默认动作
tickBurnWindow(state): GameState                           // 系统：烧牌窗口满 2 秒（burnWindowKey 有值时，过 config.burnWindowMs 毫秒调用）
pendingSeats(state): number[]                              // 现在要做决定的座位（烧牌不算）
stepSeconds(state): number                                 // 当前这一步的限时
legalCommands(state, playerId): GameCommand[]              // 能发的操作（可以用在视图上）；出牌每种形状一种出法
redactGameForViewer(state, playerId | ""): GameState       // 某个座位（"" = 观战公开信息）看到的状态，带 you
spectatorView(state, seeAll): GameState                    // 观战
botCommand(view, seat) / botBurn(view, seat)               // 人机（普通难度）
botDecision / botBurnDecision / botHint(view, seat)        // 同上，附一句理由（教程「提示」用）
burnWindowKey(state) / topKey(state) / burnEligibleSeats(state) / timerKey(state)   // 服务器用
canRespond / canBurn / burnOptions / canRang / nextResponder / isActive / oppOf / teamOf  // 资格判定
parseSet / beats / setLabel / canBurnTail / burnCandidates / legalBurnLead / leadMoves / beatingMoves  // 核心判定
parseCards("A A 2 小") / cardsText(cards) / rankOf / suitOf / cardName                // 牌
```

### 操作（`GameCommand`）

| 操作 | 参数 | 什么时候 |
|---|---|---|
| `{ type: "PLAY", cards }` | 牌的 id | 轮到自己发牌或接牌（窗口没满 2 秒时先收下） |
| `{ type: "PASS" }` | — | 接牌时 |
| `{ type: "RANG" }` | — | `canRang` 为真时 |
| `{ type: "BURN", cards }` | S₁ 的牌 | `you.burnCandidates` 不为空时，不用轮到 |
| `{ type: "TRIBUTE", eat, item? }` | 吃 true / 免 false；item 是 `tribute.items` 下标，不给就是自己第一份没选的 | 进贡阶段（`stage === "tribute"`） |
| `{ type: "RETURN", cards }` | 张数 = 收到的贡牌数 | 还贡阶段 |
| `{ type: "REVOLT", revolt }` | 能革命（`you.canRevolt`）的人 true / false；其他人只能发 false（「继续」） | 革命阶段（每盘都有，人人表态） |
| `{ type: "READY" }` | — | 结算画面 |
| `{ type: "AUTO", on }` | — | 托管开关（取消托管发 `on: false`） |

### 状态里给界面显示的字段（`GameState`）

- `stage`：`tribute`（队内吃免）/ `return`（还贡）/ `revolution` / `playing` / `handEnd`；`phase` 是 `finished` 时一场结束（`finalResult`）。
- `handNo`、`config.hands`、`redeals`、`teamScores`（甲、乙累计分）、`players[s]`：`name`、`bot`、`auto`、`team`、`hand`、`handCount`（`null` = 10+）、`score`、`handDelta`。
- `turn`（-1 = 同时决定，或等烧牌窗口结束这一轮）、`firstLeader`、`revolutionary`、`finished`（走科顺序）、`headless[s]`（无头）、`chaos`（四人乱缠）。
- `round`：`leader`、`top`（桌面牌：`seat`、`cards`、`set`（`setLabel(set)` 是「3 张 Q 挂小王」这样的读法，`set.gouji`）、`burnable`、`ready`（烧牌窗口满了没有）、`burn`（是不是烧牌的 S₁））、`passed`、`rang`（`{ seat, returned }`）、`entries`（这一轮的每个动作）。`lastRound` 是上一轮（回看）。
- `burn`（当前谁在烧谁）、`burnsThisHand`、`tribute`（`items`：`kind` 烧贡 / 落贡 / 串贡、`giver`、`receiver`、`count`、`intra`、`eat`、`cards`、`returned`；`antiTribute`）、`result` / `prevResult`（`order` 名次顺序、`places[s]`（0 头科 … 5 大落）、`sweep`、`teamDeltas`、`burns`）、`discard`（这盘打出过的牌）。
- `you`（只有自己）：`burnCandidates`、`burnRequested`、`pendingAction`、`canRevolt`。
- `events`（这一步的事件）/ `history`（最近 120 条）：`Played`（`label`、`gouji`、`lead`、`left`）、`Passed`、`Rang`、`BurnStarted`、`BurnBroken`（`counter` = 反烧）、`BurnSucceeded`、`WentOut`、`RoundEnded`（`jiefeng`）、`Headless`、`ChaosStarted`、`TributeChosen`、`TributePaid`、`TributeReturned`、`AntiTribute`、`Revolted`、`RevolutionRedeal`、`FirstLead`、`HandStarted`、`Dealt`、`HandEnded`、`GameEnded`、`TimedOut`、`AutoChanged`。
- `version` 每次有公开变化加 1（动画信号）；窗口里先收下的动作不加。

### 预览局面工厂（`packages/game/src/scenes.ts`）

```ts
buildState(spec: StateSpec): GameState   // 精确的出牌 / 结算局面
buildDeal(spec: DealSpec): GameState     // 一盘刚发完牌（可带上一盘结果），照常走进贡 / 还贡 / 革命
createScene(name: SceneName): GameState  // 按名字：SCENE_NAMES
previewRoom(state, { viewerSeat?, offline?, turnRemainingMs?, spectatorsSeeAll?, code? }): LobbyRoomSnapshot   // 某个座位收到的房间快照
resultFrom({ order, sweep?, burns?, revolutionary? }, handNo): HandResult
```

`StateSpec` 主要字段：`hands`（每个座位的牌，写法 `"A A 7 7 7 9 9 小 大"`、`"10x5"`，或者张数随机补；没写的座位 15 张）、`top`（`{ seat, cards, ready? }` 桌面牌）、`entries`（这一轮之前的动作）、`passed`、`rang`、`turn`、`leader`、`headless`、`chaos`、`finished`、`goneThisRound`、`revolutionary`、`burn`、`burnsThisHand`、`stage`（`"handEnd"` 时按 `finished` 算结果）、`result`、`prevResult`、`handNo`、`teamScores`、`options`、`names`、`bots`、`auto`、`seed`。剩下没分出去的牌算这一盘打出过的（216 张始终守恒）。玩家 id 是 `p1`…`p6`（座位 0–5）。

`DealSpec`：`hands`（每个座位至少要有的牌，随机补满 36 张）、`noWild`（这些座位不补 2 和王，用来造能革命的人）、`prevResult`、`firstLeader`、`handNo`、`options`、`seed`。

例子：

```ts
// 剧本 B（烧牌）：1 号发 K K，0 号能烧，窗口还没满 2 秒
const s = buildState({ hands: { 0: "A A 7 7 7 9 9 小 大", 1: 20, 2: 20, 3: 20, 4: 20, 5: 20 }, top: { seat: 1, cards: "K K" } });
redactGameForViewer(s, "p1").you!.burnCandidates;   // [[A, A]]
// 规则书 T15：上一盘 0、3、1、2、4，剩 5；1 烧过 5；5 有 大王 2 2 2
const t = buildDeal({ prevResult: { order: [0, 3, 1, 2, 4, 5], burns: [{ burner: 1, victim: 5 }] }, hands: { 5: "大 2 2 2" }, noWild: [4, 5] });
```

场景名：`opening`、`beforeLead`、`beforeRespond`、`tribute`、`tributeWaived`、`tributeReturn`、`antiTribute`、`revolution`、`revolutionPlay`、`goujiDuel`、`goujiWait`、`burnWindow`、`burnState`、`burnBroken`、`rang`、`rangReturned`、`jiefeng`、`headless`、`chaos`、`handEnd`、`sweepEnd`、`revolutionSweepEnd`、`matchEnd`、`matchDraw`、`timeout`、`auto`、`offline`（每个是什么见 `createScene` 的注释）。预览页：`http://localhost:5292/preview.html?s=burnWindow&seat=0`（`seat=-1` 观战、`all=1` 看全部、`offline=3`、`remaining=0`）。

### 服务器事件（在全站房间事件之外）

- `room:seat (seat, ack)`：等候时换到空座位；`room:swap-seats ({ a, b }, ack)`：房主对调两个座位。`LobbyMember.seat` 是座位号。
- 开房选项：`{ hands: 1|3|5|8, tribute, rang, peek }`。
- 测试钩子 `testHooks.setGame(code, state)` 可以把房间换成工厂造的局面（玩家 id 要换成房间里的）。
- `game:command` 只收玩家操作（PLAY / PASS / RANG / BURN / TRIBUTE / RETURN / REVOLT / READY / AUTO）；TIMEOUT、TICK 被拒。

## 陪玩脚本和抓包

```bash
node scripts/test-bot.mjs host 陪玩房主 --start-at=1 --hands=1        # 一个人建房马上开局（5 个人机补位），打完一整场
node scripts/test-bot.mjs host 陪玩甲 --start-at=2 --hands=3          # 等第二个真人进来再开
node scripts/test-bot.mjs join <房间码> 陪玩乙 [--seat=3]
BOT_IDLE=1 node scripts/test-bot.mjs join <房间码> 挂机               # 只挂着不动（测超时、托管）
BOT_REMATCH=0 …                                                       # 一场结束就退出
node scripts/spy.mjs 3                                                # 两个真人 + 观战打 3 盘，检查发给 B 和观战的每条快照
```

服务器建议 `BOT_DELAY_SCALE=0.05` 起，跑得快；线上在服务器上连 `BOT_URL=http://localhost:3021`。

## 测试

- `npm test`：138 个测试，约 15 秒。
  - 规则书 T1–T20 每条一个（`规则书#T5 …`），补充文件勘误 #1–#7 各有测试，正文各节（进贡细节、革命、首出、底牌接风、乱缠、烧牌各种情况、让牌、一场结束、托管）。
  - 核心判定和暴力枚举对拍（200 手随机小牌：发牌能出的、能压住的、烧牌候选、烧牌状态下能发的）。
  - 隐藏信息：每个座位和观战视角。
  - 预览局面工厂：27 个场景都能造、216 张守恒、状态符合说明；buildState / buildDeal / previewRoom 按参数造局面。
  - 随机对局：默认选项 70 场 × 5 盘 = 350 盘 + 进贡关 / 让牌关 / 看牌关 / 全关各 20 场；查牌数守恒、计分、回合推进、终局、不卡死、隐藏信息抽查。
  - 服务器：观战、挤登录、管理员解散、选座、一整场 + 再来一局 + 用种子和操作序列复盘、每种操作经过服务器、烧牌窗口不泄露、计时 key、超时托管、离线代打回座、人机接线。
- `npm run sim`：长跑（400 场默认 + 每种选项 100 场，共 3500 盘，约 15 秒）。
