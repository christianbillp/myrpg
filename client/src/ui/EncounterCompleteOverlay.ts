import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";

const ACCENT = "#88ccaa";

/**
 * Shown the first time `GameState.encounterComplete` flips true. The
 * encounter is **resolved** at this point — the player can still wander
 * the map, search corpses, talk, equip gear, etc.
 *
 * Two modes:
 *   • Adventure — `chapter` is provided; the overlay shows chapter X of Y
 *     and the advance CTA is NEXT CHAPTER / FINISH ADVENTURE.
 *   • Single encounter — `chapter` is omitted; the overlay drops the chapter
 *     line and the advance CTA is RETURN TO MENU.
 *
 * Two CTAs:
 *   • CONTINUE EXPLORING — dismisses the overlay and reveals the persistent
 *     advance button at the top-center of the screen, so the player can
 *     wrap up at their own pace.
 *   • Advance CTA (varies by mode) — fires the advance immediately for
 *     players who don't need to linger.
 *
 * Closing via the × button or backdrop click is equivalent to CONTINUE
 * EXPLORING — the player can never accidentally skip past the resolution.
 */
export interface EncounterCompleteChapter {
  index: number;
  total: number;
}

export class EncounterCompleteOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    encounterTitle: string,
    chapter: EncounterCompleteChapter | null,
    onDismiss: () => void,
    onAdvance: () => void,
  ) {
    super(scale, 600, 360, ACCENT, () => onDismiss());

    const isFinal = chapter ? chapter.index >= chapter.total - 1 : false;
    const advanceLabel = !chapter
      ? "RETURN TO MENU"
      : isFinal
        ? "FINISH ADVENTURE"
        : "NEXT CHAPTER";
    const chapterLine = chapter
      ? `<div style="font-size:11px;color:#556677;margin-bottom:24px;">Chapter ${chapter.index + 1} of ${chapter.total}</div>`
      : `<div style="font-size:11px;color:#556677;margin-bottom:24px;">Single Encounter</div>`;
    const body = !chapter
      ? "The encounter has resolved. Continue exploring to wrap up loose ends — search corpses, talk to survivors, equip recovered gear — or press RETURN TO MENU to head back now."
      : isFinal
        ? "The journey ends here. Take a moment to wander and reflect, or press FINISH ADVENTURE to return to the menu."
        : "The chapter has resolved. Continue exploring to wrap up loose ends — search corpses, talk to survivors, equip recovered gear — or press NEXT CHAPTER to move on now.";

    this.panelEl.insertAdjacentHTML("beforeend", `
      <div style="text-align:center;padding:36px 32px 0;">
        <div style="font-size:11px;color:${ACCENT};letter-spacing:2px;margin-bottom:10px;">
          WRAP UP LOOSE ENDS
        </div>
        <div style="font-size:22px;color:#e8e8f8;margin-bottom:6px;">${encounterTitle || "Encounter Complete"}</div>
        ${chapterLine}
        <div style="height:1px;background:#334455;margin:0 24px 22px;"></div>
        <div style="font-size:13px;color:#c8d8e8;line-height:1.7;margin-bottom:28px;padding:0 16px;">
          ${body}
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
