import { gameClient } from "../net/GameClient";
import type { NPCDef, MonsterDef, FactionDef } from "../../../shared/types";
import type { NpcRefineProposed } from "../net/GameClient";
import { createHtmlButton } from "../ui/htmlButtons";
import { NpcPickerOverlay } from "../ui/generate/NpcPickerOverlay";
import { TokenPickerOverlay } from "../ui/generate/TokenPickerOverlay";
import { NpcTestChatOverlay } from "../ui/NpcTestChatOverlay";
import { attachPlacement as sharedAttachPlacement } from "../ui/sceneInputs";
import {
  BaseCreatorScene,
  CREATOR_SCENE_WIDTH as W,
  CREATOR_SCENE_HEIGHT as H,
  CREATOR_CONTENT_TOP as CONTENT_TOP,
  CREATOR_CONTENT_BOTTOM as CONTENT_BOTTOM,
  CREATOR_PANEL_PAD as PANEL_PAD,
  CREATOR_COL_GAP as COL_GAP,
} from "./BaseCreatorScene";

/**
 * NpcCreatorScene — author-side page for building NPCDefs.
 *
 * An NPC is a thin identity wrapper around a monster: the monsterClass field
 * picks which monster's stat block (HP / AC / attacks / saves) the NPC
 * inherits at spawn time; the NPC layer adds a display name, optional faction
 * tag, optional persona blurb the AIGM reads when roleplaying the character,
 * and an optional per-NPC token asset.
 *
 * Layout:
 *   • LEFT column — form inputs (ID, NAME, MONSTER CLASS dropdown, FACTION
 *     dropdown, COLOR, TOKEN ASSET, PERSONA textarea).
 *   • RIGHT column — live preview of the chosen monster's stat block so the
 *     author can confirm what the NPC will actually fight with.
 *   • BOTTOM bar — BACK, LOAD NPC, SAVE NPC.
 */

const LEFT_FRACTION = 0.55;

/** Snapshot of every NPC Creator form field. Stashed in the Phaser registry
 *  whenever the user clicks OPEN TOKEN CREATOR so the in-progress NPC survives
 *  the scene round-trip. */
interface NpcCreatorFormState {
  npcId: string;
  formName: string;
  formMonsterClass: string;
  formFactionId: string;
  formColor: string;
  formTokenAsset: string;
  formPersona: string;
}

export class NpcCreatorScene extends BaseCreatorScene<NpcRefineProposed> {
  // Form state.
  private npcId = "";
  private formName = "";
  private formMonsterClass = "";
  private formFactionId = "";
  private formColor = "#aabbcc";
  private formTokenAsset = "";
  private formPersona = "";
  private formPersistent = false;
  private formConversationId = "";

  // Inputs (held so LOAD NPC can re-seed them).
  private idInput: HTMLInputElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private monsterSelect: HTMLSelectElement | null = null;
  private factionSelect: HTMLSelectElement | null = null;
  private colorInput: HTMLInputElement | null = null;
  private tokenInput: HTMLInputElement | null = null;
  private personaInput: HTMLTextAreaElement | null = null;

  // Right-column preview.
  private previewEl: HTMLDivElement | null = null;

  // Overlays.
  private picker: NpcPickerOverlay | null = null;
  private tokenPicker: TokenPickerOverlay | null = null;
  private testChat: NpcTestChatOverlay | null = null;

  constructor() {
    super({ key: "NpcCreatorScene" });
  }

  init(data?: { presetTokenAsset?: string }): void {
    this.resetCreatorScaffold();
    this.formPersistent = false;
    this.formConversationId = "";
    // Restore form state stashed by the OPEN TOKEN CREATOR navigation so the
    // user's in-progress NPC isn't lost when they detour to the Token Creator.
    const stashed = this.registry.get("npcCreatorFormState") as NpcCreatorFormState | undefined;
    if (stashed) {
      this.npcId = stashed.npcId;
      this.formName = stashed.formName;
      this.formMonsterClass = stashed.formMonsterClass;
      this.formFactionId = stashed.formFactionId;
      this.formColor = stashed.formColor;
      this.formTokenAsset = stashed.formTokenAsset;
      this.formPersona = stashed.formPersona;
      this.registry.remove("npcCreatorFormState");
    } else {
      this.npcId = "";
      this.formName = "";
      this.formMonsterClass = "";
      this.formFactionId = "";
      this.formColor = "#aabbcc";
      this.formTokenAsset = "";
      this.formPersona = "";
    }
    if (data?.presetTokenAsset) this.formTokenAsset = data.presetTokenAsset;
  }

  /** Snapshot every form field so the OPEN TOKEN CREATOR navigation can
   *  detour into TokenCreatorScene without losing the user's work. The
   *  TokenCreatorScene's BACK button routes back here and `init` reads the
   *  snapshot to repopulate inputs. */
  private snapshotFormState(): NpcCreatorFormState {
    return {
      npcId: this.npcId,
      formName: this.formName,
      formMonsterClass: this.formMonsterClass,
      formFactionId: this.formFactionId,
      formColor: this.formColor,
      formTokenAsset: this.formTokenAsset,
      formPersona: this.formPersona,
    };
  }

  create(): void {
    this.clearKeyboardCaptureForHtmlInputs();
    this.buildCreatorHeader(
      "NPC CREATOR",
      "Author an NPC. Pick a monster to inherit stats from; add identity + persona on top.",
    );

    this.buildOuterTabs();
    this.buildLeftColumn();
    this.buildRightColumn();
    this.buildAiProposalPanel({
      promptLabel: "PROMPT  —  describe the NPC you want. The AI sees the current draft + the available monster / faction / conversation pools.",
      promptPlaceholder: "e.g. \"a gruff dwarven blacksmith aligned with the town guard who suspects the player on sight; tie him to the tavern_keeper_chat conversation\".",
      diffPlaceholder:
        "No proposal yet. Describe the NPC and press GENERATE.\n\n" +
        "The AI sees the current draft + the monster / faction / conversation pools, and proposes edits — accept to merge, reject to discard.",
    });
    this.buildStatusLine();
    this.buildBottomBar();
    this.refreshOuterTabVisibility();
    this.refreshPreview();

    this.events.once("shutdown", () => this.teardown());
    this.events.once("destroy",  () => this.teardown());
  }

  // ── Left column — form inputs ────────────────────────────────────────────

  private buildLeftColumn(): void {
    const colW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * LEFT_FRACTION);
    const colX = PANEL_PAD;
    const colY = CONTENT_TOP;
    const colH = CONTENT_BOTTOM - CONTENT_TOP;

    const lineH = 28;
    const gap = 12;
    let y = colY;
    const bucket = this.regularBucket;

    bucket.push(this.makeLabel(colX, y, colW, "ID (snake_case)"));
    y += 18;
    this.idInput = this.buildLineInput(colX, y, colW, lineH, "e.g. tavern_keeper", (val) => { this.npcId = val.trim(); }, bucket);
    this.idInput.value = this.npcId;
    y += lineH + gap;

    bucket.push(this.makeLabel(colX, y, colW, "NAME (shown in-game)"));
    y += 18;
    this.nameInput = this.buildLineInput(colX, y, colW, lineH, "e.g. Bram Holdfast", (val) => {
      this.formName = val;
    }, bucket);
    this.nameInput.value = this.formName;
    y += lineH + gap;

    // Two-column row: MONSTER CLASS | FACTION
    const halfW = Math.floor((colW - 10) / 2);
    bucket.push(this.makeLabel(colX, y, halfW, "MONSTER CLASS"));
    bucket.push(this.makeLabel(colX + halfW + 10, y, halfW, "FACTION (optional)"));
    y += 18;
    this.monsterSelect = this.buildSelect(colX, y, halfW, lineH, [{ value: "", label: "— pick a monster —" }, ...this.monsterOptions()], (val) => {
      this.formMonsterClass = val;
      this.refreshPreview();
    }, bucket);
    this.monsterSelect.value = this.formMonsterClass;
    this.factionSelect = this.buildSelect(colX + halfW + 10, y, halfW, lineH, [{ value: "", label: "— none —" }, ...this.factionOptions()], (val) => {
      this.formFactionId = val;
    }, bucket);
    this.factionSelect.value = this.formFactionId;
    y += lineH + gap;

    // Two-column row: COLOR | TOKEN ASSET (+ token-picker button)
    bucket.push(this.makeLabel(colX, y, halfW, "COLOR (hex)"));
    bucket.push(this.makeLabel(colX + halfW + 10, y, halfW, "TOKEN ASSET PATH"));
    y += 18;
    this.colorInput = this.buildLineInput(colX, y, halfW, lineH, "#aabbcc", (val) => {
      this.formColor = val.trim() || "#aabbcc";
    }, bucket);
    this.colorInput.value = this.formColor;
    const tokenInputW = Math.floor(halfW * 0.66);
    const tokenBtnW = halfW - tokenInputW - 6;
    this.tokenInput = this.buildLineInput(colX + halfW + 10, y, tokenInputW, lineH, "/tokens/npc_<id>.svg", (val) => {
      this.formTokenAsset = val.trim();
    }, bucket);
    this.tokenInput.value = this.formTokenAsset;
    bucket.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: colX + halfW + 10 + tokenInputW + 6, y, w: tokenBtnW, h: lineH,
      label: "PICK", variant: "secondary", fontSize: 10,
      onClick: () => this.openTokenPicker(),
    }));
    y += lineH + gap;

    // PERSONA fills the rest of the column.
    bucket.push(this.makeLabel(colX, y, colW, "PERSONA (AIGM uses this to roleplay the NPC)"));
    y += 18;
    const personaH = Math.max(120, colY + colH - y - 8);
    this.personaInput = this.buildTextarea(colX, y, colW, personaH,
      "How they speak, what they know, who they fear. Short and specific beats long and generic.",
      (val) => { this.formPersona = val; }, bucket);
    this.personaInput.value = this.formPersona;
  }

  /** Monster id → option object for the monster-class dropdown. */
  private monsterOptions(): Array<{ value: string; label: string }> {
    const monsters = (this.registry.get("monsters") as MonsterDef[] | undefined) ?? [];
    return monsters
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => ({ value: m.id, label: `${m.name}  ·  ${m.id}` }));
  }

  /** Faction id → option object for the faction dropdown. */
  private factionOptions(): Array<{ value: string; label: string }> {
    const factions = (this.registry.get("factions") as FactionDef[] | undefined) ?? [];
    return factions
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ value: f.id, label: `${f.name}  ·  ${f.id}` }));
  }

  // ── Right column — monster stat preview ─────────────────────────────────

  private buildRightColumn(): void {
    const leftColW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * LEFT_FRACTION);
    const colX = PANEL_PAD + leftColW + COL_GAP;
    const colW = W - PANEL_PAD - colX;
    const colY = CONTENT_TOP;
    const colH = CONTENT_BOTTOM - colY;

    this.regularBucket.push(this.makeLabel(colX, colY, colW, "INHERITED STAT BLOCK"));
    const preview = document.createElement("div");
    preview.style.cssText = `
      position: absolute;
      background: #0f1320;
      border: 1px solid #334455;
      box-sizing: border-box;
      padding: 14px 16px;
      overflow-y: auto;
      z-index: 9;
      color: #c8d8e8;
      font-family: monospace; font-size: 12px;
      line-height: 1.55;
      scrollbar-width: thin;
      scrollbar-color: #445566 transparent;
    `;
    preview.textContent = "Pick a monster on the left to see its stat block.";
    document.body.appendChild(preview);
    this.previewEl = preview;
    this.regularBucket.push(sharedAttachPlacement(preview, { scene: this, sceneWidth: W, x: colX, y: colY + 22, w: colW, h: colH - 22 }));
  }

  /** Render the stat block of the currently-chosen monster. Called on every
   *  monster-class change so the author always sees an up-to-date preview. */
  private refreshPreview(): void {
    if (!this.previewEl) return;
    if (!this.formMonsterClass) {
      this.previewEl.textContent = "Pick a monster on the left to see its stat block.";
      this.previewEl.style.color = "#667788";
      return;
    }
    const monsters = (this.registry.get("monsters") as MonsterDef[] | undefined) ?? [];
    const m = monsters.find((x) => x.id === this.formMonsterClass);
    if (!m) {
      this.previewEl.textContent = `Unknown monster "${this.formMonsterClass}".`;
      this.previewEl.style.color = "#aa6644";
      return;
    }
    this.previewEl.style.color = "#c8d8e8";
    const stat = (label: string, value: string | number): string =>
      `<div style="display:flex;justify-content:space-between;padding:2px 0;">
         <span style="color:#778899;letter-spacing:1px;">${label}</span>
         <span style="color:#e0e8f0;">${value}</span>
       </div>`;
    const abilityRow = (): string => {
      const abilities: Array<["STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA", number]> = [
        ["STR", m.str], ["DEX", m.dex], ["CON", m.con],
        ["INT", m.int], ["WIS", m.wis], ["CHA", m.cha],
      ];
      const mod = (v: number): string => {
        const x = Math.floor((v - 10) / 2);
        return x >= 0 ? `+${x}` : `${x}`;
      };
      return `<div style="display:flex;gap:4px;margin:6px 0 10px;">${abilities.map(([k, v]) => `
        <div style="flex:1;text-align:center;padding:5px 2px;border:1px solid #334455;background:#0a0a18;">
          <div style="font-size:9px;color:#556677;letter-spacing:1px;">${k}</div>
          <div style="font-size:14px;color:#e8e8f8;margin-top:1px;">${v}</div>
          <div style="font-size:9px;color:#e2b96f;">${mod(v)}</div>
        </div>`).join("")}</div>`;
    };
    const attacks = (m.attacks ?? []).map((a) => {
      const bonus = a.bonus >= 0 ? `+${a.bonus}` : `${a.bonus}`;
      const dmg = `${a.damageDice ?? 1}d${a.damageSides ?? 6}${a.damageBonus ? (a.damageBonus >= 0 ? `+${a.damageBonus}` : a.damageBonus) : ""} ${a.damageType ?? ""}`.trim();
      return `<div style="margin:2px 0;color:#aabbcc;">• ${a.name}: ${bonus} to hit, ${dmg}</div>`;
    }).join("");
    this.previewEl.innerHTML = `
      <div style="color:#e2b96f;font-size:14px;margin-bottom:2px;">${m.name}</div>
      <div style="color:#778899;font-size:10px;margin-bottom:10px;">${m.type ?? ""}</div>
      ${stat("HP",  `${m.maxHp}${m.hpFormula ? `  (${m.hpFormula})` : ""}`)}
      ${stat("AC",  m.ac)}
      ${stat("Speed", `${m.speed ?? 30} ft`)}
      ${stat("CR",  m.cr ?? "—")}
      ${stat("XP",  m.xp ?? 0)}
      ${stat("Init", (m.initiativeBonus ?? 0) >= 0 ? `+${m.initiativeBonus ?? 0}` : `${m.initiativeBonus}`)}
      ${abilityRow()}
      ${attacks ? `<div style="color:#88ccaa;font-size:10px;letter-spacing:1px;margin-top:8px;margin-bottom:4px;">ATTACKS</div>${attacks}` : ""}
    `;
  }

  // ── Generative AI flow ──────────────────────────────────────────────────

  protected runAiGenerate(): Promise<void> {
    return this.runAiRefineRequest({
      emptyPromptMessage: "Describe the NPC (at least a few words).",
      refine: (prompt) => gameClient.refineNpc({
        id: this.npcId,
        name: this.formName,
        monsterClass: this.formMonsterClass,
        factionId: this.formFactionId,
        color: this.formColor,
        tokenAsset: this.formTokenAsset,
        persona: this.formPersona,
        persistent: this.formPersistent,
        conversationId: this.formConversationId,
      }, prompt),
      renderDiff: (rationale, proposed) => this.renderProposalDiff(rationale, proposed),
    });
  }

  private renderProposalDiff(rationale: string, p: NpcRefineProposed): void {
    this.beginProposalDiff(rationale);
    if (p.name           !== undefined) this.appendProposalCard("name",            this.formName,           p.name);
    if (p.monsterClass   !== undefined) this.appendProposalCard("monster class",   this.formMonsterClass,   p.monsterClass);
    if (p.factionId      !== undefined) this.appendProposalCard("faction",         this.formFactionId,      p.factionId);
    if (p.color          !== undefined) this.appendProposalCard("color",           this.formColor,          p.color);
    if (p.tokenAsset     !== undefined) this.appendProposalCard("token asset",     this.formTokenAsset,     p.tokenAsset);
    if (p.persona        !== undefined) this.appendProposalCard("persona",         this.formPersona,        p.persona);
    if (p.persistent     !== undefined) this.appendProposalCard("persistent",      String(this.formPersistent), String(p.persistent));
    if (p.conversationId !== undefined) this.appendProposalCard("conversation id", this.formConversationId, p.conversationId);
    if (Object.keys(p).length === 0) this.appendProposalNoChangesNote();
  }

  protected acceptAiProposal(): void {
    const p = this.aiProposal;
    if (!p) return;
    if (p.name           !== undefined) this.formName           = p.name;
    if (p.monsterClass   !== undefined) this.formMonsterClass   = p.monsterClass;
    if (p.factionId      !== undefined) this.formFactionId      = p.factionId;
    if (p.color          !== undefined) this.formColor          = p.color;
    if (p.tokenAsset     !== undefined) this.formTokenAsset     = p.tokenAsset;
    if (p.persona        !== undefined) this.formPersona        = p.persona;
    if (p.persistent     !== undefined) this.formPersistent     = p.persistent;
    if (p.conversationId !== undefined) this.formConversationId = p.conversationId;

    if (this.nameInput     && p.name         !== undefined) this.nameInput.value     = this.formName;
    if (this.monsterSelect && p.monsterClass !== undefined) {
      this.monsterSelect.value = this.formMonsterClass;
      this.refreshPreview();
    }
    if (this.factionSelect && p.factionId    !== undefined) this.factionSelect.value = this.formFactionId;
    if (this.colorInput    && p.color        !== undefined) this.colorInput.value    = this.formColor;
    if (this.tokenInput    && p.tokenAsset   !== undefined) this.tokenInput.value    = this.formTokenAsset;
    if (this.personaInput  && p.persona      !== undefined) this.personaInput.value  = this.formPersona;

    this.concludeAiProposalAccepted();
  }

  // ── Bottom bar ───────────────────────────────────────────────────────────

  private buildBottomBar(): void {
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    const btnH = 36;
    const y = H - 54;
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: 40, y, w: 140, h: btnH,
      label: "BACK", variant: "ghost", fontSize: 13,
      onClick: () => this.scene.start("MainMenuScene"),
    }));
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: 200, y, w: 200, h: btnH,
      label: "📂 LOAD NPC", variant: "secondary", fontSize: 13,
      onClick: () => this.openPicker(),
    }));
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: 420, y, w: 220, h: btnH,
      label: "💬 CONVERSATION", variant: "secondary", fontSize: 13,
      onClick: () => this.openTestChat(),
    }));
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 360, y, w: 320, h: btnH,
      label: "✓ SAVE NPC", variant: "primary", fontSize: 14,
      onClick: () => this.runSave(),
    }));
  }

  private openTestChat(): void {
    if (this.testChat) return;
    if (!this.formPersona.trim()) {
      if (this.statusEl) this.statusEl.textContent = "Add a PERSONA before testing conversation.";
      return;
    }
    this.testChat = new NpcTestChatOverlay(
      () => ({
        name: this.formName,
        monsterClass: this.formMonsterClass,
        factionId: this.formFactionId,
        persona: this.formPersona,
      }),
      { onClose: () => this.closeTestChat() },
    );
  }

  private closeTestChat(): void {
    if (this.testChat) { this.testChat.destroy(); this.testChat = null; }
  }

  // ── LOAD NPC flow ────────────────────────────────────────────────────────

  private async openPicker(): Promise<void> {
    if (this.picker || this.busy) return;
    // Refresh the npcs registry so a save from another tab / another scene
    // is reflected here without a page reload.
    try {
      const fresh = await gameClient.listNpcs();
      this.registry.set("npcs", fresh);
    } catch { /* fall back to cached */ }
    const npcs = (this.registry.get("npcs") as NPCDef[] | undefined) ?? [];
    const monsters = (this.registry.get("monsters") as MonsterDef[] | undefined) ?? [];
    this.picker = new NpcPickerOverlay(npcs, monsters, {
      onSelect: (npc) => {
        this.loadNpcIntoForm(npc);
        this.closePicker();
      },
      onClose: () => this.closePicker(),
    });
  }

  private closePicker(): void {
    if (this.picker) { this.picker.destroy(); this.picker = null; }
  }

  /** Open the Token Picker overlay so the author can choose an existing
   *  token visually instead of typing a path. On select, the chosen id's
   *  `/tokens/<id>.svg` path is dropped into the TOKEN ASSET PATH input. */
  private async openTokenPicker(): Promise<void> {
    if (this.tokenPicker || this.busy) return;
    try {
      const [files, editableIds] = await Promise.all([
        gameClient.listTokens(),
        gameClient.listTokenSpecs(),
      ]);
      this.tokenPicker = new TokenPickerOverlay(files, editableIds, {
        onSelect: (id) => {
          this.formTokenAsset = `/tokens/${id}.svg`;
          if (this.tokenInput) this.tokenInput.value = this.formTokenAsset;
          this.closeTokenPicker();
        },
        onClose: () => this.closeTokenPicker(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Failed to load tokens: ${msg}`;
    }
  }

  private closeTokenPicker(): void {
    if (this.tokenPicker) { this.tokenPicker.destroy(); this.tokenPicker = null; }
  }

  /** Seed every form input from an existing NPCDef so the user can tweak +
   *  re-save without re-typing. Setting `value` programmatically does NOT
   *  fire `input` events, so we sync the form-state mirror by hand. */
  private loadNpcIntoForm(npc: NPCDef): void {
    this.npcId           = npc.id;
    this.formName        = npc.name;
    this.formMonsterClass = npc.monsterClass;
    this.formFactionId   = npc.factionId ?? "";
    this.formColor       = typeof npc.color === "number" ? "#" + npc.color.toString(16).padStart(6, "0") : "#aabbcc";
    this.formTokenAsset  = npc.tokenAsset ?? "";
    this.formPersona     = npc.persona    ?? "";
    if (this.idInput)        this.idInput.value        = this.npcId;
    if (this.nameInput)      this.nameInput.value      = this.formName;
    if (this.monsterSelect)  this.monsterSelect.value  = this.formMonsterClass;
    if (this.factionSelect)  this.factionSelect.value  = this.formFactionId;
    if (this.colorInput)     this.colorInput.value     = this.formColor;
    if (this.tokenInput)     this.tokenInput.value     = this.formTokenAsset;
    if (this.personaInput)   this.personaInput.value   = this.formPersona;
    this.refreshPreview();
    if (this.statusEl) this.statusEl.textContent = `Loaded ${npc.id}.`;
  }

  // ── SAVE NPC flow ────────────────────────────────────────────────────────

  private async runSave(): Promise<void> {
    if (this.busy) return;
    if (!/^[a-z0-9_]+$/.test(this.npcId)) {
      if (this.statusEl) this.statusEl.textContent = "ID must be snake_case (lowercase letters, digits, underscores).";
      return;
    }
    if (!this.formName.trim()) {
      if (this.statusEl) this.statusEl.textContent = "Name is required.";
      return;
    }
    if (!this.formMonsterClass) {
      if (this.statusEl) this.statusEl.textContent = "Pick a monster class — the NPC inherits its stat block from a monster.";
      return;
    }
    const npc: NPCDef = {
      id: this.npcId,
      name: this.formName.trim(),
      monsterClass: this.formMonsterClass,
      color: parseColor(this.formColor),
      ...(this.formPersona.trim() ? { persona: this.formPersona.trim() } : {}),
      ...(this.formTokenAsset.trim() ? { tokenAsset: this.formTokenAsset.trim() } : {}),
      ...(this.formFactionId ? { factionId: this.formFactionId } : {}),
    };
    this.busy = true;
    if (this.statusEl) this.statusEl.textContent = "Saving NPC…";
    try {
      const { npcId } = await gameClient.saveNpc(npc);
      // Refresh the npcs registry so a subsequent LOAD NPC sees the just-
      // written entry without a page reload.
      try {
        const fresh = await gameClient.listNpcs();
        this.registry.set("npcs", fresh);
      } catch { /* non-fatal */ }
      if (this.statusEl) this.statusEl.textContent = `Saved ${npcId}.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Save failed: ${msg}`;
    } finally {
      this.busy = false;
    }
  }

  private teardown(): void {
    this.disposeCreatorChrome();
    if (this.picker) { this.picker.destroy(); this.picker = null; }
    if (this.tokenPicker) { this.tokenPicker.destroy(); this.tokenPicker = null; }
    if (this.testChat) { this.testChat.destroy(); this.testChat = null; }
  }
}

/** Parse a user-entered hex colour (`"#aabbcc"` or `"aabbcc"`) into a number
 *  the engine stores on NPCDef. Defaults to grey on bad input — the form-side
 *  fallback is rarely worth a user-facing error since it only affects the
 *  token outline. */
function parseColor(raw: string): number {
  const s = raw.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return 0xaabbcc;
  return parseInt(s, 16);
}
