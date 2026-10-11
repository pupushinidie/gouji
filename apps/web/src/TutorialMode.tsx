/**
 * 够级的新手教程：在浏览器里按剧本走四段残局（packages/game/src/tutorial.ts），
 * 牌桌就是真正对局的 GameBoard，咕噜嘎的对话框叠在上面；剧本走完开一局练习局（1 盘），其他 5 个座位交给人机。
 * 不连服务器，不占房间；首页、等候房间都能进来（从等候房间进来时，房主开局会自动回到牌桌，见 App.tsx）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  botCommand,
  createPracticeGame,
  createTutorialGame,
  DEFAULT_ROOM_ACCESS,
  redactGameForViewer,
  sameCommand,
  selectionMatches,
  TUTORIAL_SELF,
  TUTORIAL_STEPS,
  tutorialActor,
  tutorialApply,
  tutorialCanAct,
  type Card,
  type GameCommand,
  type GameState,
  type LobbyMember,
  type LobbyRoomSnapshot,
  type TutorialCommand,
  type TutorialStep,
} from "@gouji/game";
import GameBoard from "./GameBoard.js";
import { Coach, isTouchDevice, StepPips, type CoachView } from "./tutorial/Coach.js";
import { writeTutorial } from "./tutorial/storage.js";
import type { Theme } from "./theme.js";
import { useTutorial } from "./tutorial/useTutorial.js";
import { GAME_ID } from "./tutorialGame.js";

const SELF_MEMBER = "tutorial-self";
const TUTORIAL_CODE = "GULU01";
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

export default function TutorialMode({ name, brand, themeToggle, theme, waitingRoom, onExit }: {
  /** 首页填过的昵称；没填叫「新玩家」。 */
  name: string;
  brand: ReactNode;
  themeToggle: ReactNode;
  theme: Theme;
  /** 从等候房间点进来的：那个房间的房间码。 */
  waitingRoom?: string | undefined;
  onExit: () => void;
}) {
  const selfName = name.trim().length >= 2 ? name.trim() : "新玩家";
  const [selection, setSelection] = useState<readonly Card[]>([]);
  const practiceRef = useRef(false);

  const tutorial = useTutorial<GameState, TutorialCommand, TutorialStep>({
    steps: TUTORIAL_STEPS,
    self: TUTORIAL_SELF,
    start: () => createTutorialGame(selfName),
    restart: () => createPracticeGame(selfName, randomSeed()),
    apply: (state, playerId, command) => tutorialApply(state, playerId, command, practiceRef.current, selfName),
    same: sameCommand,
    actor: tutorialActor,
    canAct: tutorialCanAct,
    bot: (state, playerId) => {
      const seat = state.players.findIndex((player) => player.id === playerId);
      return botCommand(redactGameForViewer(state, playerId), seat);
    },
    // 出牌快一点，结算、表态慢一点让人看清楚
    botDelay: (state) => (state.stage === "playing" ? 900 : state.stage === "handEnd" ? 2500 : 1200),
    watchDelay: (command) => (command.type === "SCENE" ? 400 : command.type === "PASS" ? 700 : 1200),
  });
  const { game, step, index, practice, flash } = tutorial;
  practiceRef.current = practice;
  // 每开一局练习局，牌桌重新挂载（动作记录从头记）
  const [table, setTable] = useState(0);
  const newPractice = () => {
    practiceRef.current = true;
    setTable((value) => value + 1);
    tutorial.newPractice();
  };

  // 走到最后一步就算学完（之后首页不再邀请）
  useEffect(() => {
    if (practice || (step?.kind === "info" && step.finale)) writeTutorial(GAME_ID, "done");
  }, [practice, step?.id]);

  function leave() {
    writeTutorial(GAME_ID, "skipped");
    onExit();
  }

  const members = useMemo<LobbyMember[]>(() => [{ id: SELF_MEMBER, playerId: TUTORIAL_SELF, name: selfName, isHost: false, connected: true, seat: 0 }], [selfName]);
  const room = useMemo<LobbyRoomSnapshot>(() => ({
    code: TUTORIAL_CODE,
    options: { hands: game.config.hands, tribute: game.config.tribute, rang: game.config.rang, peek: game.config.peek },
    spectators: [],
    access: DEFAULT_ROOM_ACCESS,
    status: "playing",
    members,
    chat: [],
    voice: [],
    game: redactGameForViewer(game, TUTORIAL_SELF),
  }), [game, members]);

  let view: CoachView | null = null;
  if (step) {
    const note = isTouchDevice() && step.noteTouch ? step.noteTouch : step.note;
    const finale = step.kind === "info" && step.finale === true;
    // 先选牌再出：选对了，高亮就挪到下一个要点的地方
    let anchor = step.anchor ?? null;
    if (step.kind === "do" && step.then) {
      for (const follow of step.then) if (selectionMatches(selection, follow.cards)) anchor = follow.anchor;
    }
    view = {
      key: `${step.id}:${anchor ?? ""}`,
      say: step.say,
      ...(note ? { note } : {}),
      ...(flash ? { flash } : {}),
      anchor,
      focus: step.kind !== "watch",
      face: flash ? "surprised" : step.face ?? "base",
      footer: (
        <>
          <StepPips index={index} total={TUTORIAL_STEPS.length} />
          {!finale && <button className="tut-link" type="button" onClick={leave}>跳过教程</button>}
        </>
      ),
      actions: step.kind !== "info" ? null : finale ? (
        <>
          <button className="quiet-button" type="button" onClick={onExit}>结束教程</button>
          <button className="primary-button tut-main" type="button" onClick={newPractice}>开一局练习</button>
        </>
      ) : (
        <button className="primary-button tut-main" type="button" onClick={tutorial.next}>下一步 ▶</button>
      ),
    };
  }

  return (
    <div className={practice ? "tut-practice" : "tut-script"} style={{ display: "contents" }}>
      <GameBoard
        key={table}
        room={room}
        busy={false}
        error=""
        notice=""
        brand={brand}
        connection={
          <>
            <span className="connection-status online"><span className="connection-dot" />{practice ? "练习局" : "新手教程"}</span>
            <button className="quiet-button" type="button" onClick={practice ? onExit : leave}>退出教程</button>
          </>
        }
        theme={theme}
        themeToggle={themeToggle}
        chat={null}
        onCommand={(command: GameCommand) => tutorial.onCommand(command)}
        onRematch={() => undefined}
        onDissolve={() => undefined}
        watchId={TUTORIAL_SELF}
        onWatch={() => undefined}
        onLeave={onExit}
        selfMemberId={SELF_MEMBER}
        mode={practice ? "practice" : "tutorial"}
        onSelection={setSelection}
        sidePanel={<Checklist index={index} practice={practice} waitingRoom={waitingRoom} />}
        {...(practice
          ? {
              finalActions: (
                <>
                  <button className="quiet-button gjd-btn" type="button" onClick={onExit}>结束教程</button>
                  <button className="primary-button gjd-btn" type="button" onClick={newPractice}>再练一局</button>
                </>
              ),
            }
          : {})}
      />
      {view && <Coach view={view} />}
    </div>
  );
}

/** 侧栏：剧本进行中列出这次学哪几样；练习局只留一句话。 */
function Checklist({ index, practice, waitingRoom }: { index: number; practice: boolean; waitingRoom: string | undefined }) {
  const lessons = TUTORIAL_STEPS.map((step, at) => ({ step, at })).filter(({ step }) => step.lesson);
  const done = lessons.filter(({ at }) => at < index).length;
  return (
    <section className="gjs-panel tut-checklist" aria-label="新手教程进度">
      {practice ? (
        <>
          <h3>练习局 <small>教程学完了</small></h3>
          <p>拿不准就点「提示」（键盘 H），我告诉你我会怎么出。</p>
        </>
      ) : (
        <>
          <h3>新手教程 <small>{done}/{lessons.length}</small></h3>
          <ul>
            {lessons.map(({ step, at }) => {
              const nextLesson = lessons.find((item) => item.at > at)?.at ?? TUTORIAL_STEPS.length;
              const state = index >= nextLesson ? "done" : index >= at ? "now" : "";
              return (
                <li key={step.id} className={state}>
                  <i aria-hidden="true">{state === "done" ? "✓" : state === "now" ? "▶" : "·"}</i>
                  {step.lesson}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {waitingRoom && <p>你还在房间 {waitingRoom} 里，房主一开局就自动回到牌桌。</p>}
    </section>
  );
}
