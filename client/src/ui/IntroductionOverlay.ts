import { marked } from "marked";
import { BaseOverlay } from "./BaseOverlay";
import { PlayerDef } from "../../../shared/types";
import { UIScale } from "./UIScale";

const ACCENT = "#e2b96f";

export class IntroductionOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    encounterTitle: string,
    player: PlayerDef,
    introduction: string,
    onClose: () => void,
  ) {
    super(scale, 680, 460, ACCENT, onClose);

    const introHtml = String(marked.parse(introduction));

    this.panelEl.insertAdjacentHTML('beforeend', `
      <div style="text-align:center;padding:24px 32px 0;">
        <div style="font-size:16px;color:${ACCENT};letter-spacing:1px;margin-bottom:12px;">
          ${encounterTitle}
        </div>
        <div style="font-size:20px;color:#e8e8f8;margin-bottom:6px;">${player.name}</div>
        <div style="font-size:11px;color:#556677;margin-bottom:16px;">
          ${player.speciesName}  ·  ${player.className}
        </div>
        <div style="height:1px;background:#334455;margin:0 4px 16px;"></div>
        <div style="font-size:13px;color:#c8d8e8;line-height:1.7;text-align:left;
          height:290px;overflow-y:auto;padding:0 4px 24px;
          scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;">
          ${introHtml}
        </div>
      </div>
    `);
  }
}
