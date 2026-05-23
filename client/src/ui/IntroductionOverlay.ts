import { marked } from "marked";
import { BaseOverlay } from "./BaseOverlay";
import { EncounterContext, EncounterType } from "../data/encounterContext";
import { PlayerDef } from "../data/player";
import { UIScale } from "./UIScale";

const ACCENT = "#e2b96f";

const TYPE_LABEL: Record<EncounterType, string> = {
  simple_combat:      "Combat",
  social_interaction: "Social Interaction",
  exploration:        "Exploration",
};

export class IntroductionOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    encounterTypes: EncounterType[],
    player: PlayerDef,
    context: EncounterContext,
    onContinue: () => void,
  ) {
    super(scale, 680, 400, ACCENT, onContinue);

    const typeChips = encounterTypes.map((t) => TYPE_LABEL[t]).join("  ·  ");
    const introHtml = String(marked.parse(context.introduction));

    this.panelEl.insertAdjacentHTML('beforeend', `
      <div style="text-align:center;padding:24px 32px 0;">
        <div style="font-size:10px;color:${ACCENT};letter-spacing:1px;margin-bottom:12px;">
          ${typeChips}
        </div>
        <div style="font-size:20px;color:#e8e8f8;margin-bottom:6px;">${player.name}</div>
        <div style="font-size:11px;color:#556677;margin-bottom:16px;">
          ${player.speciesName}  ·  ${player.className}
        </div>
        <div style="height:1px;background:#334455;margin:0 4px 16px;"></div>
        <div style="font-size:13px;color:#c8d8e8;line-height:1.7;text-align:left;
          height:220px;overflow-y:auto;padding:0 4px;
          scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;">
          ${introHtml}
        </div>
      </div>
    `);
  }
}
