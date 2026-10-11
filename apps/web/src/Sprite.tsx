/** 横排精灵图：background-size N×100%，steps(N, jump-none) 逐帧走；只按整数倍放大。 */
import type { CSSProperties } from "react";
import { SPRITES, type SpriteName } from "./art.js";

export default function Sprite({ name, scale, className, delay = 0, style }: { readonly name: SpriteName; readonly scale: number; readonly className?: string; readonly delay?: number; readonly style?: CSSProperties }) {
  const sprite = SPRITES[name];
  return (
    <span
      className={["gj-sprite", sprite.loop ? "loop" : "once", className].filter(Boolean).join(" ")}
      aria-hidden="true"
      style={{
        width: sprite.w * scale,
        height: sprite.h * scale,
        backgroundImage: `url(${sprite.src})`,
        backgroundSize: `${sprite.frames * 100}% 100%`,
        animationDuration: `${sprite.frames * sprite.ms}ms`,
        animationTimingFunction: `steps(${sprite.frames}, jump-none)`,
        animationDelay: `${delay}ms`,
        ...style,
      }}
    />
  );
}
