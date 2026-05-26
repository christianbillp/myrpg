import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";

const ACCENT = "#88ccaa";

/**
 * Shown the first time `GameState.chapterComplete` flips true during an
 * adventure. The chapter is **resolved** at this point — the player can
 * still wander the map, search corpses, talk, equip gear, etc.
 *
 * Two CTAs:
 *   • CONTINUE EXPLORING — dismisses the overlay and reveals the persistent
 *     Next Chapter Button at the top-center of the screen, so the player
 *     can wrap up at their own pace.
 *   • NEXT CHAPTER (or FINISH ADVENTURE on the last chapter) — fires the
 *     advance immediately for players who don't need to linger.
 *
 * Closing via the × button or backdrop click is equivalent to CONTINUE
 * EXPLORING — the player can never accidentally skip past the encounter
 * resolution.
 */
export class ChapterCompleteOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    encounterTitle: string,
    chapterIndex: number,
    totalChapters: number,
    onDismiss: () => void,
    onAdvance: () => void,
  ) {
    super(scale, 600, 360, ACCENT, () => onDismiss());

    const isFinal = chapterIndex >= totalChapters - 1;
    const advanceLabel = isFinal ? "FINISH ADVENTURE" : "NEXT CHAPTER";

    this.panelEl.insertAdjacentHTML("beforeend", `
      <div style="text-align:center;padding:36px 32px 0;">
        <div style="font-size:11px;color:${ACCENT};letter-spacing:2px;margin-bottom:10px;">
          WRAP UP LOOSE ENDS
        </div>
        <div style="font-size:22px;color:#e8e8f8;margin-bottom:6px;">${encounterTitle || "Encounter Complete"}</div>
        <div style="font-size:11px;color:#556677;margin-bottom:24px;">
          Chapter ${chapterIndex + 1} of ${totalChapters}
        </div>
        <div style="height:1px;background:#334455;margin:0 24px 22px;"></div>
        <div style="font-size:13px;color:#c8d8e8;line-height:1.7;margin-bottom:28px;padding:0 16px;">
          ${isFinal
            ? "The journey ends here. Take a moment to wander and reflect, or press FINISH ADVENTURE to return to the menu."
            : "The chapter has resolved. Continue exploring to wrap up loose ends — search corpses, talk to survivors, equip recovered gear — or press NEXT CHAPTER to move on now."}
        </div>
        <div style="display:flex;gap:18px;justify-content:center;">
          <button data-dismiss style="
            padding:10px 22px;
            background:#1a2a3a;
            color:#c8d8e8;
            border:2px solid #345566;
            font-family:monospace;
            font-size:13px;
            letter-spacing:1px;
            cursor:pointer;
          ">CONTINUE EXPLORING</button>
          <button data-advance style="
            padding:10px 22px;
            background:#1a3a2a;
            color:#fff4d8;
            border:2px solid #2a6655;
            font-family:monospace;
            font-size:13px;
            letter-spacing:1px;
            cursor:pointer;
          ">${advanceLabel}</button>
        </div>
      </div>
    `);

    const dismissBtn = this.panelEl.querySelector('[data-dismiss]') as HTMLButtonElement;
    const advanceBtn = this.panelEl.querySelector('[data-advance]') as HTMLButtonElement;
    dismissBtn.onclick = () => { onDismiss(); this.destroy(); };
    advanceBtn.onclick = () => { onAdvance(); this.destroy(); };
  }
}
