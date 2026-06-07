/**
 * CharacterCreatorScene (US-122) — a multi-step character-creation flow.
 *
 * Steps: Concept (AI assist) → Origin (species/background/class) → Abilities
 * (Standard Array / Point Buy / Roll) → Skills → Spells (casters) → Review.
 * The AI-assist step calls `POST /generate/character`, which honours the active
 * setting's lore, and pre-fills the form; the player can edit anything. CREATE
 * posts the choices to `POST /characters`; on success the new character joins
 * the roster and we return to the setup scene.
 *
 * Built as a single full-screen DOM panel (consistent with the overlay style)
 * rather than the absolute-positioned creator-scene helpers — the content area
 * re-renders per step. Defs are read from the Phaser registry (loaded at boot).
 */
import Phaser from "phaser";
import { gameClient } from "../net/GameClient";
import {
  STANDARD_ARRAY, POINT_BUY_BUDGET, POINT_BUY_MIN, POINT_BUY_MAX,
  pointBuyCost, pointBuyTotalCost, abilityModifier, ABILITY_KEYS,
  type AbilityScores, type AbilityScoreMethod, type AbilityKey, type BackgroundAbilityChoice,
} from "../../../shared/abilityScores";
import { STANDARD_LANGUAGES, STANDARD_LANGUAGE_CHOICES, COMMON } from "../../../shared/languages";
import type { ClassDef, SpeciesDef, BackgroundDef, SpellDef, FeatDef, ItemDef } from "../../../shared/types";

const ACCENT = "#e2b96f";
const ABILITY_LABEL: Record<AbilityKey, string> = {
  str: "STR", dex: "DEX", con: "CON", int: "INT", wis: "WIS", cha: "CHA",
};

interface CreatorState {
  step: number;
  prompt: string;
  rationale: string;
  name: string;
  shortDescription: string;
  description: string;
  speciesId: string;
  /** Chosen subspecies — lineage (Elf/Gnome/Goliath) or ancestry (Dragonborn).
   *  Stored on `PlayerDef.speciesLineage`. Null when the species has none. */
  speciesLineage: string | null;
  backgroundId: string;
  classId: string;
  method: AbilityScoreMethod;
  scores: AbilityScores;
  /** Player's chosen background ability-increase distribution (SRD: +2/+1 to
   *  two of the background's three abilities, or +1 to all three). */
  backgroundAbility: BackgroundAbilityChoice;
  /** Source values to assign (Standard Array / rolled set). */
  pool: number[];
  skillPicks: Set<string>;
  /** Species-granted skill picks (Human "Skillful"). */
  speciesSkillPicks: Set<string>;
  /** Species-granted Origin feat id (Human "Versatile"); "" when none/unset. */
  speciesFeat: string;
  /** Skills chosen for each feat that grants skill proficiencies (Skilled → 3),
   *  keyed by feat id. */
  featSkillPicks: Map<string, Set<string>>;
  languagePicks: Set<string>;
  cantripPicks: Set<string>;
  spellPicks: Set<string>;
  /** SRD Magic Initiate picks per granting feat (background-pinned or Versatile),
   *  keyed by feat id: the chosen spell list, two cantrips, one L1 spell, ability. */
  magicInitiatePicks: Map<string, { spellList: string; cantripIds: Set<string>; spellId: string; ability: string }>;
  equipmentChoice: string;
  classEquipmentChoice: string;
}

const STEPS = ["Concept", "Origin", "Abilities", "Skills", "Spells", "Review"] as const;

/** One subspecies option — covers lineage (Elf/Gnome), legacy (Tiefling),
 *  draconic ancestry (Dragonborn), and giant ancestry (Goliath) shapes. */
interface SubspeciesOption {
  id?: string;
  name?: string;
  dragon?: string;       // draconic ancestry
  damageType?: string;   // draconic ancestry
  effect?: Record<string, unknown>;  // giant ancestry
  level1?: SubspeciesLevelBlock;
  level3?: SubspeciesLevelBlock;
  level5?: SubspeciesLevelBlock;
}
interface SubspeciesLevelBlock {
  cantrip?: string;
  damageResistance?: string[];
  preparedSpell?: string;
  darkvisionOverride?: { feet: number };
  cantripSwapOnLongRest?: { list: string };
  speedBonus?: number;
}

/** Example character concepts for the Concept step — written to fit the active
 *  setting (The Sundered Reach: a post-collapse authoritarian empire built on
 *  keeping magic quiet, the White Capes who hunt illegal casters, the Quota on
 *  elves, and the ruins of the Old Empire). Clicking a card copies its prompt
 *  into the concept textarea for editing, mirroring the Generator scene's
 *  example-prompt cards. */
const CONCEPT_EXAMPLES: ReadonlyArray<{ title: string; prompt: string }> = [
  { title: "The Licensed Battlemage",
    prompt: "A human war-mage who holds one of the Empire's rare casting licences and dreads every spell she throws — each one a knock on the same door that ended the world the first time." },
  { title: "Born Illegal",
    prompt: "An elf whose magic is inborn and impossible to license, surviving one Adjustment at a time and always a step ahead of the White Capes." },
  { title: "The Ruin-Engineer",
    prompt: "A dwarf who delves the ruins of the Old Empire to salvage and safely disarm its broken spellwork, selling what the holdfasts will pay for and trusting no enchantment to hold." },
  { title: "The Last Believer",
    prompt: "A cleric who still hears a god that everyone agrees withdrew a century ago — unsure whether it's faith, madness, or something worse answering back." },
  { title: "The Powers' Fixer",
    prompt: "A halfling broker for one of the great trade Powers who settles debts across the holdfasts with a ledger in one hand and a knife in the other." },
  { title: "Cape Deserter",
    prompt: "A human wizard who deserted the White Capes — the Empire's human-only magical enforcers — after one Adjustment too many, now hunted by the same order she once cast for." },
];

/** The 18 SRD skill ids (for the species "any skill" pick). */
const ALL_SKILLS: readonly string[] = [
  "acrobatics", "animalHandling", "arcana", "athletics", "deception", "history",
  "insight", "intimidation", "investigation", "medicine", "nature", "perception",
  "performance", "persuasion", "religion", "sleightOfHand", "stealth", "survival",
];

export class CharacterCreatorScene extends Phaser.Scene {
  private root: HTMLDivElement | null = null;
  private content: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private classes: ClassDef[] = [];
  private species: SpeciesDef[] = [];
  private backgrounds: BackgroundDef[] = [];
  private spells: SpellDef[] = [];
  private feats: FeatDef[] = [];
  private items: ItemDef[] = [];
  private busy = false;

  private state: CreatorState = {
    step: 0, prompt: "", rationale: "", name: "", shortDescription: "", description: "",
    speciesId: "", speciesLineage: null, backgroundId: "", classId: "",
    method: "standard-array",
    scores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    backgroundAbility: { kind: "one-one-one" },  // replaced with the bg's first two on load
    pool: [...STANDARD_ARRAY],
    skillPicks: new Set(), speciesSkillPicks: new Set(), speciesFeat: "", featSkillPicks: new Map(),
    languagePicks: new Set(), cantripPicks: new Set(), spellPicks: new Set(),
    magicInitiatePicks: new Map(),
    equipmentChoice: "A",
    classEquipmentChoice: "A",
  };

  /** The setup scene that launched the creator — we return there on CREATE or
   *  CANCEL so the player lands back where they started (Encounter or Adventure). */
  private returnScene = "EncounterSetupScene";

  constructor() { super("CharacterCreatorScene"); }

  init(data?: { returnScene?: string }): void {
    this.returnScene = data?.returnScene ?? "EncounterSetupScene";
  }

  create(): void {
    this.input.keyboard?.disableGlobalCapture();
    this.input.keyboard?.clearCaptures();
    this.classes = (this.registry.get("classes") as ClassDef[]) ?? [];
    this.species = (this.registry.get("species") as SpeciesDef[]) ?? [];
    this.backgrounds = (this.registry.get("backgrounds") as BackgroundDef[]) ?? [];
    this.spells = (this.registry.get("spells") as SpellDef[]) ?? [];
    this.feats = (this.registry.get("feats") as FeatDef[]) ?? [];
    this.items = (this.registry.get("equipment") as ItemDef[]) ?? [];
    // Sensible defaults so a player can click straight through manually.
    this.state.speciesId ||= this.species[0]?.id ?? "";
    this.state.backgroundId ||= this.backgrounds[0]?.id ?? "";
    this.state.classId ||= this.classes[0]?.id ?? "";
    this.state.backgroundAbility = this.defaultBackgroundAbility();
    this.resetSpeciesGrants();

    this.buildShell();
    this.renderStep();

    this.events.once("shutdown", () => this.teardown());
    this.events.once("destroy", () => this.teardown());
  }

  private teardown(): void {
    this.root?.remove();
    this.root = null;
  }

  // ── Shell ───────────────────────────────────────────────────────────────
  private buildShell(): void {
    const root = document.createElement("div");
    root.style.cssText = `
      position:fixed; inset:0; z-index:50; background:#0d0d1e; color:#c8dae8;
      font-family:monospace; display:flex; flex-direction:column; padding:24px 32px; box-sizing:border-box; overflow:auto;`;
    root.innerHTML = `
      <div style="font-size:22px;color:${ACCENT};letter-spacing:1px;text-align:center;">CREATE A CHARACTER</div>
      <div style="height:1px;background:#334455;margin:12px 0;"></div>
      <div data-rail style="display:flex;gap:8px;justify-content:center;font-size:11px;margin-bottom:14px;"></div>
      <div data-content style="flex:1;max-width:900px;width:100%;margin:0 auto;"></div>
      <div data-status style="font-size:11px;color:#aa8855;text-align:center;min-height:16px;margin:8px 0;"></div>
      <div data-bar style="display:flex;gap:10px;justify-content:center;padding-top:8px;"></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.content = root.querySelector("[data-content]");
    this.statusEl = root.querySelector("[data-status]");
  }

  private isCaster(): boolean {
    return !!this.classOf(this.state.classId)?.spellcasting;
  }
  private visibleSteps(): number[] {
    // Show the Spells step for casters AND for non-casters who gained a
    // spell-granting feat (Magic Initiate via background or Versatile).
    const showSpells = this.isCaster() || this.featsGrantingSpells().length > 0;
    return STEPS.map((_, i) => i).filter((i) => i !== 4 || showSpells);
  }

  /** Feats that grant spells (Magic Initiate). Each carries its allowed lists,
   *  the list pinned by a background that fixes it, the cantrip count, and the
   *  ability options. Mirrors `featsGrantingSkills`. */
  private featsGrantingSpells(): Array<{ feat: FeatDef; pinnedList?: string; lists: string[]; cantripCount: number; abilityChoices: string[] }> {
    const bg = this.backgrounds.find((b) => b.id === this.state.backgroundId);
    return this.characterFeats().map((feat) => {
      const e = feat.effects as { learnedCantrips?: { count: number; lists: string[] }; preparedSpell?: { lists: string[] }; spellcastingAbility?: { choices: string[] } };
      if (!e.learnedCantrips || !e.preparedSpell) return null;
      const pinnedList = feat.id === bg?.feat?.id ? (bg?.feat?.options as { spellList?: string } | null)?.spellList : undefined;
      return { feat, pinnedList, lists: e.learnedCantrips.lists, cantripCount: e.learnedCantrips.count, abilityChoices: e.spellcastingAbility?.choices ?? ["int", "wis", "cha"] };
    }).filter((x): x is NonNullable<typeof x> => !!x);
  }

  /** Get (or create) the Magic Initiate pick entry for a granting feat,
   *  defaulting the list (pinned or first), ability, and empty spell picks. */
  private miPick(g: { feat: FeatDef; pinnedList?: string; lists: string[]; abilityChoices: string[] }): { spellList: string; cantripIds: Set<string>; spellId: string; ability: string } {
    let pick = this.state.magicInitiatePicks.get(g.feat.id);
    const list = g.pinnedList ?? pick?.spellList ?? g.lists[0] ?? "";
    if (!pick || pick.spellList !== list) {
      // New feat, or the list changed (Versatile re-pick): reset the spell picks.
      pick = { spellList: list, cantripIds: new Set(), spellId: "", ability: pick?.ability ?? g.abilityChoices[0] ?? "int" };
      this.state.magicInitiatePicks.set(g.feat.id, pick);
    }
    return pick;
  }
  private classOf(id: string) { return this.classes.find((c) => c.id === id); }

  private setStatus(msg: string, error = false): void {
    if (this.statusEl) { this.statusEl.textContent = msg; this.statusEl.style.color = error ? "#e89090" : "#aa8855"; }
  }

  private renderStep(): void {
    if (!this.content || !this.root) return;
    // Step rail — clickable tabs; jump to any step freely (changes on every
    // step take effect immediately, so there's no apply/confirm gate).
    const rail = this.root.querySelector("[data-rail]") as HTMLDivElement;
    rail.innerHTML = "";
    for (const i of this.visibleSteps()) {
      const chip = document.createElement("button");
      chip.textContent = STEPS[i];
      const active = i === this.state.step;
      chip.style.cssText = `padding:4px 10px;border:1px solid ${active ? ACCENT : "#334455"};background:${active ? "#2a2416" : "#11111e"};color:${active ? ACCENT : "#889aaa"};font-family:monospace;font-size:11px;cursor:pointer;`;
      chip.addEventListener("click", () => { this.state.step = i; this.renderStep(); });
      rail.appendChild(chip);
    }
    this.content.innerHTML = "";
    switch (this.state.step) {
      case 0: this.renderConcept(); break;
      case 1: this.renderOrigin(); break;
      case 2: this.renderAbilities(); break;
      case 3: this.renderSkills(); break;
      case 4: this.renderSpells(); break;
      case 5: this.renderReview(); break;
    }
    this.renderBar();
  }

  // ── Step 0 — Concept / AI assist ─────────────────────────────────────────
  private renderConcept(): void {
    const c = this.content!;
    const help = document.createElement("div");
    help.style.cssText = "font-size:12px;color:#88aacc;line-height:1.6;margin-bottom:10px;";
    help.textContent = "Describe the character you have in mind. The GM's AI will suggest a setting-consistent species, background, class, name, and backstory — which you can then edit. Or skip this and build manually.";
    c.appendChild(help);

    const ta = document.createElement("textarea");
    ta.value = this.state.prompt;
    ta.placeholder = "e.g. A disgraced temple guard seeking redemption on the frontier…";
    ta.style.cssText = "width:100%;height:90px;background:#11111e;border:1px solid #334455;color:#c8dae8;font-family:monospace;font-size:12px;padding:8px;box-sizing:border-box;";
    ta.addEventListener("input", () => { this.state.prompt = ta.value; });

    // Example concept cards — click to drop a setting-fitting concept into the
    // textarea below, then edit it (or hand it straight to the AI).
    const exHead = document.createElement("div");
    exHead.style.cssText = "font-size:11px;color:#778899;margin-bottom:6px;";
    exHead.textContent = "Need a starting point? Pick an example, then edit it:";
    c.appendChild(exHead);
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;";
    for (const ex of CONCEPT_EXAMPLES) {
      const card = document.createElement("button");
      card.type = "button";
      card.style.cssText = "display:block;text-align:left;background:#14141f;border:1px solid #334455;color:#c8dae8;font-family:monospace;padding:8px 10px;cursor:pointer;transition:border-color 0.08s,background 0.08s;";
      card.innerHTML = `<div style="font-size:12px;color:${ACCENT};margin-bottom:3px;">${esc(ex.title)}</div><div style="font-size:10px;color:#9aabbc;line-height:1.4;">${esc(ex.prompt)}</div>`;
      card.addEventListener("mouseenter", () => { card.style.borderColor = ACCENT; card.style.background = "#1b1b2a"; });
      card.addEventListener("mouseleave", () => { card.style.borderColor = "#334455"; card.style.background = "#14141f"; });
      card.addEventListener("click", () => { this.state.prompt = ex.prompt; ta.value = ex.prompt; ta.focus(); });
      grid.appendChild(card);
    }
    c.appendChild(grid);

    c.appendChild(ta);

    const genBtn = this.button("✦ ASK THE AI", "#2a3a5a", async () => {
      if (this.state.prompt.trim().length < 4) { this.setStatus("Write a short concept first.", true); return; }
      await this.runAiAssist();
    });
    genBtn.style.marginTop = "10px";
    c.appendChild(genBtn);

    if (this.state.rationale) {
      const r = document.createElement("div");
      r.style.cssText = "margin-top:12px;padding:10px;border:1px solid #3a4a3a;background:#14201a;font-size:11px;color:#a8ccb0;line-height:1.5;";
      r.textContent = `AI: ${this.state.rationale}`;
      c.appendChild(r);
    }
  }

  private async runAiAssist(): Promise<void> {
    this.busy = true; this.setStatus("Consulting the GM…");
    try {
      const s = await gameClient.suggestCharacter({ prompt: this.state.prompt });
      this.state.name = s.name;
      this.state.shortDescription = s.shortDescription;
      this.state.description = s.description;
      if (this.classes.some((x) => x.id === s.classId)) this.state.classId = s.classId;
      if (this.species.some((x) => x.id === s.speciesId)) this.state.speciesId = s.speciesId;
      if (this.backgrounds.some((x) => x.id === s.backgroundId)) this.state.backgroundId = s.backgroundId;
      this.resetSpeciesGrants();  // lineage + species Origin-feat defaults for the new species
      this.state.backgroundAbility = this.defaultBackgroundAbility();  // keep valid for the (possibly new) background
      this.state.rationale = s.rationale;
      // Auto-assign the Standard Array along the AI's ability priority.
      this.state.method = "standard-array";
      this.state.pool = [...STANDARD_ARRAY];
      const priority = (s.abilityPriority as AbilityKey[]).filter((k) => ABILITY_KEYS.includes(k));
      const next: AbilityScores = { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
      priority.forEach((k, i) => { next[k] = STANDARD_ARRAY[i] ?? 8; });
      this.state.scores = next;
      // Apply the AI's thematic build picks (validated server-side against the
      // chosen class/background), then top up anything short with deterministic
      // defaults so the build is always complete and CREATE-able.
      this.applyAiBuildPicks(s);
      this.autoFillRequiredChoices();
      this.setStatus("Suggestion applied — a complete build is ready. Review the steps or CREATE now.");
      this.renderStep();
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : "AI assist failed.", true);
    } finally {
      this.busy = false;
    }
  }

  /** Generate one or more identity fields (name / tagline / backstory) from the
   *  whole build, honouring the setting lore. Used by the Review-step buttons. */
  private async genIdentity(fields: Array<"name" | "shortDescription" | "description">): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setStatus("Generating…");
    try {
      const bonuses = this.backgroundBonuses();
      const topAbilities = [...ABILITY_KEYS]
        .sort((a, b) => (this.state.scores[b] + (bonuses[b] ?? 0)) - (this.state.scores[a] + (bonuses[a] ?? 0)))
        .slice(0, 3);
      const out = await gameClient.generateCharacterIdentity({
        speciesId: this.state.speciesId,
        backgroundId: this.state.backgroundId,
        classId: this.state.classId,
        fields,
        current: { name: this.state.name, shortDescription: this.state.shortDescription, description: this.state.description },
        topAbilities,
        skills: [...this.state.skillPicks],
        languages: [...this.state.languagePicks],
      });
      if (out.name !== undefined) this.state.name = out.name;
      if (out.shortDescription !== undefined) this.state.shortDescription = out.shortDescription;
      if (out.description !== undefined) this.state.description = out.description;
      this.setStatus("Generated.");
      this.renderStep();
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : "Generation failed.", true);
    } finally {
      this.busy = false;
    }
  }

  // ── Step 1 — Origin ──────────────────────────────────────────────────────
  private renderOrigin(): void {
    const c = this.content!;
    c.appendChild(this.selectRow("Species", this.species.map((s) => ({ value: s.id, label: s.name })), this.state.speciesId, (v) => {
      this.state.speciesId = v;
      this.resetSpeciesGrants();  // species grants (Skillful skill, Versatile feat, lineage) reset with the species
      this.renderStep();
    }));
    const sub = this.subspeciesChoice();
    if (sub) {
      c.appendChild(this.selectRow(sub.label, sub.options, this.state.speciesLineage ?? sub.options[0]?.value ?? "", (v) => { this.state.speciesLineage = v; this.renderStep(); }));
    }
    c.appendChild(this.speciesPanel());
    c.appendChild(this.originFeatPicker());
    c.appendChild(this.selectRow("Background", this.backgrounds.map((b) => ({ value: b.id, label: b.name })), this.state.backgroundId, (v) => {
      this.state.backgroundId = v;
      this.state.backgroundAbility = this.defaultBackgroundAbility();  // keep the bonus choice valid for the new bg
      this.state.featSkillPicks = new Map();  // background feat (a skill source) changed
      this.renderStep();
    }));
    c.appendChild(this.backgroundPanel());
    c.appendChild(this.selectRow("Class", this.classes.map((cl) => ({ value: cl.id, label: cl.name })), this.state.classId, (v) => {
      this.state.classId = v;
      this.state.skillPicks = new Set();
      this.state.cantripPicks = new Set();
      this.state.spellPicks = new Set();
      this.renderStep();  // class change alters later steps
    }));

    // Languages (US-123): every character knows Common; choose two more.
    const langHead = document.createElement("div");
    langHead.style.cssText = "font-size:12px;color:" + ACCENT + ";margin:14px 0 6px;";
    const langCount = () => `Languages — you know ${COMMON}; choose ${STANDARD_LANGUAGE_CHOICES} more (${this.state.languagePicks.size}/${STANDARD_LANGUAGE_CHOICES}):`;
    langHead.textContent = langCount();
    c.appendChild(langHead);
    for (const lang of STANDARD_LANGUAGES) {
      if (lang === COMMON) continue;
      c.appendChild(this.checkRow(lang, this.state.languagePicks.has(lang), (on) => {
        if (on) { if (this.state.languagePicks.size >= STANDARD_LANGUAGE_CHOICES) return false; this.state.languagePicks.add(lang); }
        else this.state.languagePicks.delete(lang);
        langHead.textContent = langCount();
        return true;
      }));
    }
  }

  // ── Step 2 — Abilities ───────────────────────────────────────────────────
  private renderAbilities(): void {
    const c = this.content!;
    const methods: AbilityScoreMethod[] = ["standard-array", "point-buy", "roll"];
    const toggle = document.createElement("div");
    toggle.style.cssText = "display:flex;gap:8px;margin-bottom:12px;";
    for (const m of methods) {
      toggle.appendChild(this.button(m.replace("-", " ").toUpperCase(), this.state.method === m ? "#3a2a1a" : "#1a1a2a", () => {
        this.state.method = m;
        if (m === "standard-array") this.state.pool = [...STANDARD_ARRAY];
        if (m === "roll") this.state.pool = rollSet();
        if (m === "point-buy") this.state.scores = { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
        this.renderStep();
      }));
    }
    c.appendChild(toggle);

    // Keep the array/roll assignment a valid one-each permutation before we
    // read the scores to derive the origin bonus.
    if (this.state.method !== "point-buy") this.ensurePoolAssigned();

    // Origin bonus picker — the player chooses how the background's SRD ability
    // increase is distributed (+2/+1 to two of its abilities, or +1 to all
    // three). Drives the final scores shown below.
    c.appendChild(this.backgroundAbilityPicker());
    const bonuses = this.backgroundBonuses();

    if (this.state.method === "point-buy") {
      const total = pointBuyTotalCost(this.state.scores);
      const remaining = POINT_BUY_BUDGET - total;
      const budget = document.createElement("div");
      budget.style.cssText = `font-size:12px;margin-bottom:8px;color:${remaining < 0 ? "#e89090" : ACCENT};`;
      budget.textContent = `Points remaining: ${remaining} / ${POINT_BUY_BUDGET}`;
      c.appendChild(budget);
      for (const k of ABILITY_KEYS) c.appendChild(this.pointBuyRow(k, bonuses));
    } else {
      // Assignment of the pool values via per-ability dropdowns — kept as a
      // one-each permutation of the pool (each array value used exactly once).
      const poolNote = document.createElement("div");
      poolNote.style.cssText = "font-size:11px;color:#88aacc;margin-bottom:8px;";
      poolNote.textContent = `Assign these values (each used once): ${[...this.state.pool].sort((a, b) => b - a).join(", ")}`;
      c.appendChild(poolNote);
      if (this.state.method === "roll") {
        c.appendChild(this.button("⟳ REROLL", "#1a1a2a", () => { this.state.pool = rollSet(); this.renderStep(); }));
      }
      for (const k of ABILITY_KEYS) c.appendChild(this.assignRow(k, bonuses));
    }
  }

  private pointBuyRow(k: AbilityKey, bonuses: Partial<Record<AbilityKey, number>>): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;margin:4px 0;font-size:12px;";
    const score = this.state.scores[k];
    row.innerHTML = `<span style="width:40px;color:${ACCENT};">${ABILITY_LABEL[k]}</span>`;
    const dec = this.miniBtn("−", () => { if (score > POINT_BUY_MIN) { this.state.scores[k]--; this.renderStep(); } });
    const val = document.createElement("span");
    val.textContent = String(score);
    val.style.cssText = "width:24px;text-align:center;";
    const inc = this.miniBtn("+", () => {
      if (score < POINT_BUY_MAX && pointBuyTotalCost({ ...this.state.scores, [k]: score + 1 }) <= POINT_BUY_BUDGET) {
        this.state.scores[k]++; this.renderStep();
      }
    });
    const mod = document.createElement("span");
    mod.style.cssText = "color:#88aacc;margin-left:8px;";
    mod.innerHTML = `(cost ${pointBuyCost(score)})${this.finalSuffix(k, score, bonuses)}`;
    row.appendChild(dec); row.appendChild(val); row.appendChild(inc); row.appendChild(mod);
    return row;
  }

  /** A sensible default distribution for the current background: +2 to its
   *  first ability, +1 to its second. */
  private defaultBackgroundAbility(): BackgroundAbilityChoice {
    const a = (this.backgrounds.find((b) => b.id === this.state.backgroundId)?.abilityScores ?? []) as AbilityKey[];
    return a.length >= 2 ? { kind: "two-one", plusTwo: a[0], plusOne: a[1] } : { kind: "one-one-one" };
  }

  /** The background ability-score increase per ability, from the player's chosen
   *  distribution (SRD: +2/+1 to two of the background's three abilities, or +1
   *  to all three). Drives the displayed final scores AND what `submit()` sends. */
  private backgroundBonuses(): Partial<Record<AbilityKey, number>> {
    const bg = this.backgrounds.find((b) => b.id === this.state.backgroundId);
    if (!bg) return {};
    const allowed = bg.abilityScores as AbilityKey[];
    const choice = this.state.backgroundAbility;
    const out: Partial<Record<AbilityKey, number>> = {};
    if (choice.kind === "one-one-one") {
      for (const k of allowed) out[k] = 1;
    } else if (allowed.includes(choice.plusTwo) && allowed.includes(choice.plusOne) && choice.plusTwo !== choice.plusOne) {
      out[choice.plusTwo] = 2;
      out[choice.plusOne] = 1;
    }
    return out;
  }

  /** SRD background ability-increase picker: choose +2/+1 to two of the
   *  background's three abilities, or +1 to all three. Renders a mode toggle
   *  plus (for the +2/+1 mode) two dropdowns constrained to the background's
   *  abilities and kept distinct. */
  private backgroundAbilityPicker(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:12px;padding:8px 10px;border:1px solid #2a4a3a;background:#11201a;";
    const bg = this.backgrounds.find((b) => b.id === this.state.backgroundId);
    if (!bg) return wrap;
    const allowed = bg.abilityScores as AbilityKey[];

    const head = document.createElement("div");
    head.style.cssText = "font-size:11px;color:#9ac6a0;margin-bottom:6px;line-height:1.5;";
    head.innerHTML = `Origin bonus — <b>${esc(bg.name)}</b>: distribute its ability increase across ${allowed.map((a) => a.toUpperCase()).join("/")} (included in the final scores below).`;
    wrap.appendChild(head);

    const choice = this.state.backgroundAbility;
    // Mode toggle.
    const modes = document.createElement("div");
    modes.style.cssText = "display:flex;gap:8px;margin-bottom:6px;";
    modes.appendChild(this.button("+2 / +1", choice.kind === "two-one" ? "#3a2a1a" : "#1a1a2a", () => {
      const [a, b] = allowed;
      this.state.backgroundAbility = { kind: "two-one", plusTwo: a, plusOne: b };
      this.renderStep();
    }));
    modes.appendChild(this.button("+1 / +1 / +1", choice.kind === "one-one-one" ? "#3a2a1a" : "#1a1a2a", () => {
      this.state.backgroundAbility = { kind: "one-one-one" };
      this.renderStep();
    }));
    wrap.appendChild(modes);

    if (choice.kind === "two-one") {
      const opts = allowed.map((a) => ({ value: a, label: ABILITY_LABEL[a] }));
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:14px;align-items:center;font-size:11px;color:#aabbcc;";
      row.appendChild(this.miniSelect("+2 to", opts, choice.plusTwo, (v) => {
        const plusTwo = v as AbilityKey;
        const plusOne = choice.plusOne === plusTwo ? (allowed.find((a) => a !== plusTwo)!) : choice.plusOne;
        this.state.backgroundAbility = { kind: "two-one", plusTwo, plusOne };
        this.renderStep();
      }));
      row.appendChild(this.miniSelect("+1 to", opts.filter((o) => o.value !== choice.plusTwo), choice.plusOne, (v) => {
        this.state.backgroundAbility = { kind: "two-one", plusTwo: choice.plusTwo, plusOne: v as AbilityKey };
        this.renderStep();
      }));
      wrap.appendChild(row);
    }
    return wrap;
  }

  // ── Species grants (Human Skillful + Versatile, US-122) ──────────────────
  private currentSpecies(): SpeciesDef | undefined { return this.species.find((s) => s.id === this.state.speciesId); }
  /** Number of free skill proficiencies the species grants (Human = 1). */
  private speciesSkillCount(): number {
    return this.currentSpecies()?.traits.map((t) => t.effects.skillProficiency).find(Boolean)?.count ?? 0;
  }
  /** Skills the species pick may choose from (`["any"]` → all 18). */
  private speciesSkillChoices(): string[] {
    const choices = this.currentSpecies()?.traits.map((t) => t.effects.skillProficiency).find(Boolean)?.choices ?? [];
    return choices.includes("any") ? [...ALL_SKILLS] : choices;
  }
  private speciesGrantsOriginFeat(): boolean {
    return !!this.currentSpecies()?.traits.some((t) => t.effects.originFeat);
  }
  private originFeats(): FeatDef[] { return this.feats.filter((f) => f.category === "origin"); }
  /** The species' subspecies trait, if any — a lineage (Elf/Gnome), ancestry
   *  (Dragonborn/Goliath), or legacy (Tiefling). Returns the trait + its raw
   *  option objects. Null when the species has none. */
  private activeSubspecies(): { trait: SpeciesDef["traits"][number]; options: SubspeciesOption[] } | null {
    const sp = this.currentSpecies();
    if (!sp) return null;
    for (const t of sp.traits) {
      const e = t.effects as { lineageChoice?: { options: SubspeciesOption[] }; ancestryChoice?: { options: SubspeciesOption[] }; legacyChoice?: { options: SubspeciesOption[] } };
      const choice = e.lineageChoice ?? e.ancestryChoice ?? e.legacyChoice;
      if (choice?.options?.length) return { trait: t, options: choice.options };
    }
    return null;
  }

  /** Stable id for a subspecies option (`id` for lineage/legacy/giant ancestry,
   *  `dragon` for draconic ancestry). */
  private subspeciesId(o: SubspeciesOption): string { return o.id ?? o.dragon ?? ""; }

  /** Subspecies dropdown options for the current species, normalised to
   *  {value,label}. Null when the species has no subspecies. */
  private subspeciesChoice(): { label: string; options: Array<{ value: string; label: string }> } | null {
    const sub = this.activeSubspecies();
    if (!sub) return null;
    return {
      label: sub.trait.name,
      options: sub.options.map((o) => ({
        value: this.subspeciesId(o),
        label: o.name ?? `${prettify(o.dragon ?? "")}${o.damageType ? ` (${o.damageType})` : ""}`,
      })),
    };
  }

  /** The currently-selected raw subspecies option, if any. */
  private selectedSubspecies(): SubspeciesOption | null {
    const sub = this.activeSubspecies();
    if (!sub) return null;
    return sub.options.find((o) => this.subspeciesId(o) === this.state.speciesLineage) ?? null;
  }

  /** Walking speed including the selected subspecies' speed bonus (e.g. Wood
   *  Elf +5 → 35). Mirrors what `applySpecies` bakes onto the built character. */
  private effectiveSpeed(): number {
    const sp = this.currentSpecies();
    if (!sp) return 0;
    let speed = sp.speed;
    const sel = this.selectedSubspecies();
    if (sel) for (const lvl of ["level1", "level3", "level5"] as const) {
      if (sel[lvl]?.speedBonus) speed += sel[lvl]!.speedBonus!;
    }
    return speed;
  }

  /** Human-readable lines describing the selected subspecies' features, so the
   *  species panel can explain what the lineage/ancestry/legacy grants. */
  private subspeciesFeatureLines(o: SubspeciesOption): string[] {
    const lines: string[] = [];
    if (o.damageType) lines.push(`Breath Weapon &amp; Resistance — ${esc(o.damageType)} damage.`);
    if (o.effect) lines.push(this.describeGiantGift(o.effect));
    for (const [lvl, label] of [["level1", "Level 1"], ["level3", "Level 3"], ["level5", "Level 5"]] as const) {
      const b = o[lvl];
      if (!b) continue;
      const parts: string[] = [];
      if (b.cantrip) parts.push(`cantrip <i>${esc(prettify(b.cantrip))}</i>`);
      if (b.speedBonus) parts.push(`+${b.speedBonus} ft Speed`);
      if (b.damageResistance?.length) parts.push(`Resistance to ${b.damageResistance.map(esc).join("/")}`);
      if (b.darkvisionOverride) parts.push(`Darkvision ${b.darkvisionOverride.feet} ft`);
      if (b.cantripSwapOnLongRest) parts.push(`swap that cantrip on a Long Rest`);
      if (b.preparedSpell) parts.push(`<i>${esc(prettify(b.preparedSpell))}</i> always prepared`);
      if (parts.length) lines.push(`${label}: ${parts.join(", ")}.`);
    }
    return lines.filter(Boolean);
  }

  /** Format a Goliath Giant-ancestry effect (uses = PB / Long Rest). */
  private describeGiantGift(e: Record<string, unknown>): string {
    const tp = e.teleport as { feet: number; action: string } | undefined;
    if (tp) return `Teleport ${tp.feet} ft as a ${tp.action.replace(/-/g, " ")}.`;
    const bd = e.bonusDamageOnHit as { dice: string; damageType: string } | undefined;
    if (bd) {
      const sr = e.speedReduction as { feet: number } | undefined;
      return `Once per turn on a hit: +${bd.dice} ${bd.damageType} damage${sr ? ` and the target's Speed drops ${sr.feet} ft` : ""}.`;
    }
    const co = e.conditionOnHit as { condition: string } | undefined;
    if (co) return `Once per turn on a hit: impose the ${co.condition} condition.`;
    const dr = e.damageReduction as { roll: string } | undefined;
    if (dr) return `Reaction when you take damage: reduce it by ${dr.roll}.`;
    const rt = e.retaliationDamage as { dice: string; damageType: string } | undefined;
    if (rt) return `Reaction when hurt by a creature within 60 ft: deal ${rt.dice} ${rt.damageType} to it.`;
    return `A Giant-ancestry benefit (uses = Proficiency Bonus per Long Rest).`;
  }

  /** Seed the build with the AI's thematic picks (US-122). Resets every pick set
   *  to a clean slate, then fills the AI-provided categories — class skills,
   *  languages, and caster cantrips/spells — keeping only entries that validate
   *  against the chosen class/background and the SRD counts. The species bonus
   *  skill and feat skills (which the AI doesn't pick) are left empty for
   *  `autoFillRequiredChoices` to top up. */
  private applyAiBuildPicks(s: { skillProficiencies?: string[]; languages?: string[]; cantrips?: string[]; preparedSpells?: string[] }): void {
    this.state.skillPicks = new Set();
    this.state.speciesSkillPicks = new Set();
    this.state.featSkillPicks = new Map();
    this.state.languagePicks = new Set();
    this.state.cantripPicks = new Set();
    this.state.spellPicks = new Set();
    this.state.magicInitiatePicks = new Map();

    const cls = this.classOf(this.state.classId);
    if (cls) {
      const bgTaken = new Set(this.backgrounds.find((b) => b.id === this.state.backgroundId)?.skillProficiencies ?? []);
      const options = new Set(cls.skillChoices.options.filter((sk) => !bgTaken.has(sk)));
      this.seedFromValid(this.state.skillPicks, s.skillProficiencies, options, cls.skillChoices.count);
    }
    const langs = new Set(STANDARD_LANGUAGES.filter((l) => l !== COMMON));
    this.seedFromValid(this.state.languagePicks, s.languages, langs, STANDARD_LANGUAGE_CHOICES);

    const sc = cls?.spellcasting;
    if (cls && sc) {
      const cantrips = new Set(this.spells.filter((x) => x.level === 0 && x.classes.includes(cls.id)).map((x) => x.id));
      const l1 = new Set(this.spells.filter((x) => x.level === 1 && x.classes.includes(cls.id)).map((x) => x.id));
      this.seedFromValid(this.state.cantripPicks, s.cantrips, cantrips, sc.cantripsKnownByLevel?.[0] ?? 0);
      this.seedFromValid(this.state.spellPicks, s.preparedSpells, l1, sc.preparedSpellsByLevel?.[0] ?? 0);
    }
  }

  /** Add the valid, de-duplicated entries of `raw` into `target`, capped at `max`. */
  private seedFromValid(target: Set<string>, raw: string[] | undefined, valid: Set<string>, max: number): void {
    for (const id of raw ?? []) {
      if (target.size >= max) break;
      if (valid.has(id)) target.add(id);
    }
  }

  /** Top every required creation choice up to its SRD count with deterministic
   *  defaults, WITHOUT clearing existing picks — so it completes whatever the AI
   *  (or the player) already chose. Covers class skills, the species bonus skill
   *  (Skillful), feat skills (Skilled), languages, and caster cantrips/spells.
   *  Honours the no-stacking rule; everything stays editable on its step. */
  private autoFillRequiredChoices(): void {
    const cls = this.classOf(this.state.classId);

    // Class skills — first options not already granted by the background.
    if (cls) {
      const bgTaken = new Set(this.backgrounds.find((b) => b.id === this.state.backgroundId)?.skillProficiencies ?? []);
      for (const sk of cls.skillChoices.options) {
        if (this.state.skillPicks.size >= cls.skillChoices.count) break;
        if (!bgTaken.has(sk) && !this.state.skillPicks.has(sk)) this.state.skillPicks.add(sk);
      }
    }

    // Species bonus skill (Human "Skillful") — first choices not already taken.
    const speciesCount = this.speciesSkillCount();
    if (speciesCount > 0) {
      const taken = this.takenSkills({ species: true });
      for (const sk of this.speciesSkillChoices()) {
        if (this.state.speciesSkillPicks.size >= speciesCount) break;
        if (!taken.has(sk) && !this.state.speciesSkillPicks.has(sk)) this.state.speciesSkillPicks.add(sk);
      }
    }

    // Feat-granted skills (e.g. Skilled → 3) — first skills not already taken.
    // Set each feat's picks into state before the next feat so later feats see
    // them via `takenSkills`.
    for (const { feat, count } of this.featsGrantingSkills()) {
      const picks = this.state.featSkillPicks.get(feat.id) ?? new Set<string>();
      const taken = this.takenSkills({ featId: feat.id });
      for (const sk of ALL_SKILLS) {
        if (picks.size >= count) break;
        if (!taken.has(sk) && !picks.has(sk)) picks.add(sk);
      }
      this.state.featSkillPicks.set(feat.id, picks);
    }

    // Languages — Common is implicit (and must be skipped, matching the picker),
    // so choose the required number of extras from the rest.
    for (const lang of STANDARD_LANGUAGES) {
      if (this.state.languagePicks.size >= STANDARD_LANGUAGE_CHOICES) break;
      if (lang === COMMON || this.state.languagePicks.has(lang)) continue;
      this.state.languagePicks.add(lang);
    }

    // Caster cantrips + L1 spells — fill to the class's known/prepared counts.
    const sc = cls?.spellcasting;
    if (cls && sc) {
      const cantripCount = sc.cantripsKnownByLevel?.[0] ?? 0;
      const prepCount = sc.preparedSpellsByLevel?.[0] ?? 0;
      for (const sp of this.spells.filter((x) => x.level === 0 && x.classes.includes(cls.id))) {
        if (this.state.cantripPicks.size >= cantripCount) break;
        if (!this.state.cantripPicks.has(sp.id)) this.state.cantripPicks.add(sp.id);
      }
      for (const sp of this.spells.filter((x) => x.level === 1 && x.classes.includes(cls.id))) {
        if (this.state.spellPicks.size >= prepCount) break;
        if (!this.state.spellPicks.has(sp.id)) this.state.spellPicks.add(sp.id);
      }
    }

    // Magic Initiate feat picks — list (pinned/first), ability, cantrips + spell.
    for (const g of this.featsGrantingSpells()) {
      const p = this.miPick(g);
      for (const sp of this.spells.filter((x) => x.level === 0 && x.classes.includes(p.spellList))) {
        if (p.cantripIds.size >= g.cantripCount) break;
        if (!p.cantripIds.has(sp.id)) p.cantripIds.add(sp.id);
      }
      if (!p.spellId) {
        const l1 = this.spells.find((x) => x.level === 1 && x.classes.includes(p.spellList));
        if (l1) p.spellId = l1.id;
      }
    }
    // Equipment (`classEquipmentChoice` / `equipmentChoice`) already defaults to "A".
  }

  /** Reset species-granted picks when the species changes (or on load). */
  private resetSpeciesGrants(): void {
    this.state.speciesSkillPicks = new Set();
    this.state.speciesFeat = this.speciesGrantsOriginFeat() ? (this.originFeats()[0]?.id ?? "") : "";
    this.state.featSkillPicks = new Map();  // granting feats changed
    this.state.magicInitiatePicks = new Map();  // spell-granting feats changed
    this.state.speciesLineage = this.subspeciesChoice()?.options[0]?.value ?? null;
  }

  /** The feats the character will have at creation (background feat + species
   *  Origin feat). */
  private characterFeats(): FeatDef[] {
    const ids = new Set<string>();
    const bgFeat = this.backgrounds.find((b) => b.id === this.state.backgroundId)?.feat?.id;
    if (bgFeat) ids.add(bgFeat);
    if (this.state.speciesFeat) ids.add(this.state.speciesFeat);
    return [...ids].map((id) => this.feats.find((f) => f.id === id)).filter((f): f is FeatDef => !!f);
  }

  /** Feats that grant a number of free skill proficiencies (e.g. Skilled → 3). */
  private featsGrantingSkills(): Array<{ feat: FeatDef; count: number }> {
    return this.characterFeats()
      .map((feat) => ({ feat, count: (feat.effects as { skillOrToolProficiencies?: { count: number } }).skillOrToolProficiencies?.count ?? 0 }))
      .filter((x) => x.count > 0);
  }

  /** Skills already proficient from every source (class picks, background,
   *  species Skillful, feat picks). SRD: a Proficiency Bonus is never added
   *  twice (Playing the Game), so a skill granted by one source can't be picked
   *  again by another — each picker greys out skills `taken` elsewhere. Pass the
   *  picker's own source in `exclude` so it still shows its own picks as
   *  togglable rather than locked. */
  private takenSkills(exclude: { class?: boolean; species?: boolean; featId?: string } = {}): Set<string> {
    const t = new Set<string>();
    if (!exclude.class) for (const s of this.state.skillPicks) t.add(s);
    for (const s of this.backgrounds.find((b) => b.id === this.state.backgroundId)?.skillProficiencies ?? []) t.add(s);
    if (!exclude.species) for (const s of this.state.speciesSkillPicks) t.add(s);
    for (const [fid, picks] of this.state.featSkillPicks) {
      if (fid !== exclude.featId) for (const s of picks) t.add(s);
    }
    return t;
  }

  /** Origin-feat picker shown under the Species panel when the species grants
   *  one (Human "Versatile"): a dropdown of Origin-category feats + the chosen
   *  feat's description. */
  private originFeatPicker(): HTMLElement {
    const wrap = document.createElement("div");
    if (!this.speciesGrantsOriginFeat()) return wrap;
    wrap.style.cssText = "margin:4px 0 12px;padding:8px 10px;border:1px solid #2a4a3a;background:#11201a;";
    const feats = this.originFeats();
    const head = document.createElement("div");
    head.style.cssText = "font-size:11px;color:#9ac6a0;margin-bottom:6px;";
    head.innerHTML = `Origin feat — <b>${esc(this.currentSpecies()?.name ?? "Species")}</b> grants an Origin feat of your choice:`;
    wrap.appendChild(head);
    wrap.appendChild(this.miniSelect("Feat", feats.map((f) => ({ value: f.id, label: f.name })), this.state.speciesFeat, (v) => { this.state.speciesFeat = v; this.state.featSkillPicks = new Map(); this.renderStep(); }));
    const sel = feats.find((f) => f.id === this.state.speciesFeat);
    if (sel) {
      const d = document.createElement("div");
      d.style.cssText = "font-size:11px;color:#aabbcc;line-height:1.5;margin-top:6px;";
      d.textContent = sel.description;
      wrap.appendChild(d);
    }
    return wrap;
  }

  /** Feature description panel shown under the Species dropdown (US-122). Lists
   *  the selected species' traits (Darkvision, resistances, etc.). */
  private speciesPanel(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin:4px 0 12px;padding:8px 10px;border-left:2px solid #334455;background:#11111e;";
    const sp = this.species.find((s) => s.id === this.state.speciesId);
    if (!sp) return wrap;
    const size = typeof sp.size === "string" ? sp.size : "Small or Medium";
    const head = document.createElement("div");
    head.style.cssText = "font-size:11px;color:#88aacc;margin-bottom:4px;";
    head.textContent = `${sp.name} — ${size}, Speed ${this.effectiveSpeed()} ft`;
    wrap.appendChild(head);
    for (const t of sp.traits) {
      const row = document.createElement("div");
      row.style.cssText = "font-size:11px;line-height:1.5;margin-top:4px;";
      row.innerHTML = `<b style="color:${ACCENT};">${esc(t.name)}.</b> <span style="color:#aabbcc;">${esc(t.description)}</span>`;
      wrap.appendChild(row);
    }

    // When a subspecies is selected, explain what THAT choice grants — the
    // lineage/ancestry/legacy's specific features.
    const subChoice = this.subspeciesChoice();
    const selected = this.selectedSubspecies();
    if (subChoice && selected) {
      const label = subChoice.options.find((o) => o.value === this.state.speciesLineage)?.label ?? this.state.speciesLineage;
      const subHead = document.createElement("div");
      subHead.style.cssText = `font-size:11px;color:#9ac6a0;margin-top:8px;border-top:1px solid #223;padding-top:6px;`;
      subHead.innerHTML = `<b>${esc(subChoice.label)}: ${esc(label ?? "")}</b>`;
      wrap.appendChild(subHead);
      const feats = this.subspeciesFeatureLines(selected);
      if (feats.length === 0) feats.push("(no additional mechanical features)");
      for (const line of feats) {
        const row = document.createElement("div");
        row.style.cssText = "font-size:11px;line-height:1.5;margin-top:3px;color:#aabbcc;";
        row.innerHTML = line;
        wrap.appendChild(row);
      }
    }
    return wrap;
  }

  /** Feature description panel shown under the Background dropdown (US-122).
   *  Lists skill/tool proficiencies, the granted feat, the ability options, and
   *  the equipment packages. */
  private backgroundPanel(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin:4px 0 12px;padding:8px 10px;border-left:2px solid #334455;background:#11111e;";
    const bg = this.backgrounds.find((b) => b.id === this.state.backgroundId);
    if (!bg) return wrap;
    const tool = typeof bg.toolProficiency === "string"
      ? prettify(bg.toolProficiency)
      : bg.toolProficiency ? `choose ${bg.toolProficiency.count} of ${bg.toolProficiency.choices.map(prettify).join(", ")}` : "—";
    const feat = this.feats.find((f) => f.id === bg.feat?.id);
    const lines: string[] = [
      `<b style="color:${ACCENT};">Skill Proficiencies.</b> ${bg.skillProficiencies.map(prettify).join(", ")}`,
      `<b style="color:${ACCENT};">Tool Proficiency.</b> ${tool}`,
      `<b style="color:${ACCENT};">Ability Scores.</b> ${(bg.abilityScores as string[]).map((a) => a.toUpperCase()).join(", ")} — you choose the +2/+1 (or +1/+1/+1) split on the Abilities step`,
      feat
        ? `<b style="color:${ACCENT};">Feat — ${esc(feat.name)}.</b> <span style="color:#aabbcc;">${esc(feat.description)}</span>`
        : (bg.feat?.id ? `<b style="color:${ACCENT};">Feat.</b> ${prettify(bg.feat.id)}` : ""),
      `<b style="color:${ACCENT};">Equipment.</b> ${bg.equipmentOptions.map((o) => `${o.label}: ${(o.items.map((i) => i.name ?? i.itemId).filter(Boolean).join(", ") || "—")}${o.gold ? ` + ${o.gold} gp` : ""}`).join("  ·  ")}`,
    ].filter(Boolean);
    for (const l of lines) {
      const row = document.createElement("div");
      row.style.cssText = "font-size:11px;line-height:1.5;margin-top:4px;color:#aabbcc;";
      row.innerHTML = l;
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** "→ final (mod)" suffix for an ability row, annotating any origin bonus and
   *  the resulting final score (capped at 20, matching the builder). */
  private finalSuffix(k: AbilityKey, base: number, bonuses: Partial<Record<AbilityKey, number>>): string {
    const bonus = bonuses[k] ?? 0;
    const final = Math.min(20, base + bonus);
    const bgName = this.backgrounds.find((b) => b.id === this.state.backgroundId)?.name ?? "background";
    const src = bonus > 0 ? ` <span style="color:#9ac6a0;">+${bonus} (${bgName})</span>` : "";
    return `${src} → <b style="color:#e8e8f8;">${final}</b> (${fmtMod(abilityModifier(final))})`;
  }

  /** Make `state.scores` a valid one-each assignment of `state.pool`. Keeps the
   *  current assignment when it already is one (preserves the AI's priority
   *  assignment or the player's prior swaps); otherwise assigns the pool to the
   *  six abilities in order (e.g. after switching from Point Buy or a reroll). */
  private ensurePoolAssigned(): void {
    const pool = [...this.state.pool].sort((a, b) => a - b);
    const cur = ABILITY_KEYS.map((k) => this.state.scores[k]).sort((a, b) => a - b);
    const isPermutation = pool.length === cur.length && pool.every((v, i) => v === cur[i]);
    if (isPermutation) return;
    ABILITY_KEYS.forEach((k, i) => { this.state.scores[k] = this.state.pool[i] ?? 8; });
  }

  /** Assign `value` to ability `k`. If another ability currently holds `value`,
   *  give it `k`'s old value (a swap) so the assignment stays a permutation of
   *  the pool — i.e. each array value is selectable only once. */
  private swapAssign(k: AbilityKey, value: number): void {
    const old = this.state.scores[k];
    if (old === value) return;
    const other = ABILITY_KEYS.find((a) => a !== k && this.state.scores[a] === value);
    if (other) this.state.scores[other] = old;
    this.state.scores[k] = value;
  }

  private assignRow(k: AbilityKey, bonuses: Partial<Record<AbilityKey, number>>): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;margin:4px 0;font-size:12px;";
    row.innerHTML = `<span style="width:40px;color:${ACCENT};">${ABILITY_LABEL[k]}</span>`;
    const sel = document.createElement("select");
    sel.style.cssText = "background:#11111e;border:1px solid #334455;color:#c8dae8;font-family:monospace;padding:3px;";
    const uniqueVals = Array.from(new Set(this.state.pool)).sort((a, b) => b - a);
    for (const v of uniqueVals) {
      const opt = document.createElement("option");
      opt.value = String(v); opt.textContent = String(v);
      if (this.state.scores[k] === v) opt.selected = true;
      sel.appendChild(opt);
    }
    // Single-use: picking a value another ability already holds swaps them, so
    // the six abilities always remain a one-each assignment of the array/pool.
    sel.addEventListener("change", () => { this.swapAssign(k, Number(sel.value)); this.renderStep(); });
    const mod = document.createElement("span");
    mod.style.cssText = "color:#88aacc;";
    mod.innerHTML = this.finalSuffix(k, this.state.scores[k], bonuses);
    row.appendChild(sel); row.appendChild(mod);
    return row;
  }

  // ── Step 3 — Skills ──────────────────────────────────────────────────────
  private renderSkills(): void {
    const c = this.content!;
    const cls = this.classOf(this.state.classId);
    if (!cls) return;
    const count = cls.skillChoices.count;
    const head = document.createElement("div");
    head.style.cssText = "font-size:12px;color:#88aacc;margin-bottom:8px;";
    head.textContent = `Choose ${count} ${cls.name} skill proficiencies (${this.state.skillPicks.size}/${count}):`;
    c.appendChild(head);
    // Skills already granted by the background/species/feats are shown but
    // locked — SRD proficiencies don't stack, so they can't be chosen again.
    const classTaken = this.takenSkills({ class: true });
    for (const sk of cls.skillChoices.options) {
      const locked = classTaken.has(sk);
      c.appendChild(this.skillRow(sk, locked || this.state.skillPicks.has(sk), locked, (on) => {
        if (on) {
          if (this.state.skillPicks.size >= count) return false;
          this.state.skillPicks.add(sk);
        } else this.state.skillPicks.delete(sk);
        head.textContent = `Choose ${count} ${cls.name} skill proficiencies (${this.state.skillPicks.size}/${count}):`;
        return true;
      }));
    }

    // Species skill grant (Human "Skillful") — an extra proficiency in any skill
    // not already granted by another source. The full list is shown; already-
    // proficient skills are greyed so nothing looks missing.
    const speciesCount = this.speciesSkillCount();
    if (speciesCount > 0) {
      const sHead = document.createElement("div");
      sHead.style.cssText = "font-size:12px;color:#9ac6a0;margin:14px 0 6px;";
      const label = () => `${this.currentSpecies()?.name ?? "Species"} bonus skill (Skillful) — choose ${speciesCount} (${this.state.speciesSkillPicks.size}/${speciesCount}):`;
      sHead.textContent = label();
      c.appendChild(sHead);
      const taken = this.takenSkills({ species: true });
      for (const sk of this.speciesSkillChoices()) {
        const locked = taken.has(sk);
        c.appendChild(this.skillRow(sk, locked || this.state.speciesSkillPicks.has(sk), locked, (on) => {
          if (on) { if (this.state.speciesSkillPicks.size >= speciesCount) return false; this.state.speciesSkillPicks.add(sk); }
          else this.state.speciesSkillPicks.delete(sk);
          sHead.textContent = label();
          return true;
        }));
      }
    }

    // Feat-granted skill proficiencies (e.g. the Skilled feat → 3). One labeled
    // section per granting feat so the player can see exactly why they have the
    // extra picks. Again the whole list is shown with locked skills greyed.
    for (const { feat, count } of this.featsGrantingSkills()) {
      let picks = this.state.featSkillPicks.get(feat.id);
      if (!picks) { picks = new Set(); this.state.featSkillPicks.set(feat.id, picks); }
      const fHead = document.createElement("div");
      fHead.style.cssText = "font-size:12px;color:#caa6e6;margin:14px 0 6px;";
      const label = () => `${feat.name} feat — choose ${count} skill ${count === 1 ? "proficiency" : "proficiencies"} (${picks!.size}/${count}):`;
      fHead.textContent = label();
      c.appendChild(fHead);
      const taken = this.takenSkills({ featId: feat.id });
      for (const sk of ALL_SKILLS) {
        const locked = taken.has(sk);
        c.appendChild(this.skillRow(sk, locked || picks.has(sk), locked, (on) => {
          if (on) { if (picks!.size >= count) return false; picks!.add(sk); }
          else picks!.delete(sk);
          fHead.textContent = label();
          return true;
        }));
      }
    }
  }

  /** A skill checkbox row that prettifies the skill id for display and supports
   *  a `locked` state (already proficient from another source): rendered checked
   *  + disabled + greyed with an "already proficient" note, per the SRD no-stack
   *  rule. */
  private skillRow(skillId: string, checked: boolean, locked: boolean, onToggle: (on: boolean) => boolean | void): HTMLElement {
    const row = document.createElement("label");
    row.style.cssText = `display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px;cursor:${locked ? "default" : "pointer"};color:${locked ? "#5d6b78" : "#c8dae8"};`;
    const box = document.createElement("input");
    box.type = "checkbox"; box.checked = checked; box.disabled = locked;
    box.addEventListener("change", () => {
      const res = onToggle(box.checked);
      if (res === false) box.checked = false;  // pick rejected (limit reached)
    });
    const span = document.createElement("span");
    span.textContent = prettify(skillId);
    row.appendChild(box); row.appendChild(span);
    if (locked) {
      const note = document.createElement("span");
      note.textContent = "— already proficient";
      note.style.cssText = "color:#4f5d6a;font-style:italic;";
      row.appendChild(note);
    }
    return row;
  }

  // ── Step 4 — Spells (casters) ────────────────────────────────────────────
  private renderSpells(): void {
    const c = this.content!;
    const cls = this.classOf(this.state.classId);
    const sc = cls?.spellcasting;
    const miFeats = this.featsGrantingSpells();
    if (!cls || !sc) {
      if (miFeats.length === 0) { c.textContent = "This class has no spells to prepare."; return; }
    } else {
      const cantripCount = sc.cantripsKnownByLevel?.[0] ?? 0;
      const prepCount = sc.preparedSpellsByLevel?.[0] ?? 0;
      const classCantrips = this.spells.filter((s) => s.level === 0 && s.classes.includes(cls.id));
      const classL1 = this.spells.filter((s) => s.level === 1 && s.classes.includes(cls.id));

      const ch = document.createElement("div");
      ch.style.cssText = "font-size:12px;color:" + ACCENT + ";margin:6px 0;";
      ch.textContent = `Cantrips (${this.state.cantripPicks.size}/${cantripCount}):`;
      c.appendChild(ch);
      for (const sp of classCantrips) {
        c.appendChild(this.checkRow(sp.name, this.state.cantripPicks.has(sp.id), (on) => {
          if (on) { if (this.state.cantripPicks.size >= cantripCount) return false; this.state.cantripPicks.add(sp.id); }
          else this.state.cantripPicks.delete(sp.id);
          ch.textContent = `Cantrips (${this.state.cantripPicks.size}/${cantripCount}):`;
          return true;
        }));
      }
      const ph = document.createElement("div");
      ph.style.cssText = "font-size:12px;color:" + ACCENT + ";margin:10px 0 6px;";
      ph.textContent = `Level-1 spells (${this.state.spellPicks.size}/${prepCount}):`;
      c.appendChild(ph);
      for (const sp of classL1) {
        c.appendChild(this.checkRow(sp.name, this.state.spellPicks.has(sp.id), (on) => {
          if (on) { if (this.state.spellPicks.size >= prepCount) return false; this.state.spellPicks.add(sp.id); }
          else this.state.spellPicks.delete(sp.id);
          ph.textContent = `Level-1 spells (${this.state.spellPicks.size}/${prepCount}):`;
          return true;
        }));
      }
    }

    // Magic Initiate sections (background-pinned or Versatile-chosen feat): pick
    // the spell list (if not pinned), an ability, two cantrips and one L1 spell.
    for (const g of miFeats) this.renderMagicInitiateSection(c, g);
  }

  /** One Magic Initiate feat's picker — list (pinned or chosen), ability, two
   *  cantrips, one always-prepared level-1 spell, all from the chosen list. */
  private renderMagicInitiateSection(
    c: HTMLElement,
    g: { feat: FeatDef; pinnedList?: string; lists: string[]; cantripCount: number; abilityChoices: string[] },
  ): void {
    const pick = this.miPick(g);
    const head = document.createElement("div");
    head.style.cssText = "font-size:12px;color:#caa6e6;margin:16px 0 6px;border-top:1px solid #334455;padding-top:10px;";
    head.textContent = `${g.feat.name} — choose ${g.cantripCount} cantrips + 1 level-1 spell:`;
    c.appendChild(head);

    // Spell list — fixed label when pinned by the background, else a dropdown.
    if (g.pinnedList) {
      const lbl = document.createElement("div");
      lbl.style.cssText = "font-size:11px;color:#88aacc;margin:2px 0 6px;";
      lbl.innerHTML = `Spell list: <b style="color:#c8dae8;">${prettify(g.pinnedList)}</b> (set by your background)`;
      c.appendChild(lbl);
    } else {
      c.appendChild(this.selectRow("Spell list", g.lists.map((l) => ({ value: l, label: prettify(l) })), pick.spellList, (v) => {
        pick.spellList = v; pick.cantripIds = new Set(); pick.spellId = ""; this.renderStep();
      }));
    }
    c.appendChild(this.selectRow("Ability", g.abilityChoices.map((a) => ({ value: a, label: ABILITY_LABEL[a as AbilityKey] ?? a.toUpperCase() })), pick.ability, (v) => { pick.ability = v; }));

    const list = pick.spellList;
    const cantrips = this.spells.filter((s) => s.level === 0 && s.classes.includes(list));
    const l1 = this.spells.filter((s) => s.level === 1 && s.classes.includes(list));

    const ch = document.createElement("div");
    ch.style.cssText = "font-size:11px;color:#9ac6a0;margin:8px 0 4px;";
    const chLabel = () => `Cantrips (${pick.cantripIds.size}/${g.cantripCount}):`;
    ch.textContent = chLabel();
    c.appendChild(ch);
    for (const sp of cantrips) {
      c.appendChild(this.checkRow(sp.name, pick.cantripIds.has(sp.id), (on) => {
        if (on) { if (pick.cantripIds.size >= g.cantripCount) return false; pick.cantripIds.add(sp.id); }
        else pick.cantripIds.delete(sp.id);
        ch.textContent = chLabel();
        return true;
      }));
    }
    const ph = document.createElement("div");
    ph.style.cssText = "font-size:11px;color:#9ac6a0;margin:8px 0 4px;";
    ph.textContent = "Level-1 spell (always prepared, 1 free cast per long rest):";
    c.appendChild(ph);
    for (const sp of l1) {
      // Single-select: choosing one replaces the prior pick (re-render to update).
      c.appendChild(this.checkRow(sp.name, pick.spellId === sp.id, (on) => {
        pick.spellId = on ? sp.id : "";
        this.renderStep();
        return true;
      }));
    }
  }

  // ── Step 5 — Review + Create ─────────────────────────────────────────────
  private renderReview(): void {
    const c = this.content!;

    // AI identity generation (US-122) — generate name + tagline + backstory from
    // the whole build, or any one field individually. Honours the setting lore.
    const genRow = document.createElement("div");
    genRow.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;align-items:center;";
    genRow.innerHTML = `<span style="font-size:11px;color:#88aacc;">AI:</span>`;
    genRow.appendChild(this.button("✦ GENERATE ALL", "#2a3a5a", () => this.genIdentity(["name", "shortDescription", "description"])));
    genRow.appendChild(this.button("✦ NAME", "#1a1a2a", () => this.genIdentity(["name"])));
    genRow.appendChild(this.button("✦ TAGLINE", "#1a1a2a", () => this.genIdentity(["shortDescription"])));
    genRow.appendChild(this.button("✦ BACKSTORY", "#1a1a2a", () => this.genIdentity(["description"])));
    c.appendChild(genRow);

    c.appendChild(this.inputRow("Name", this.state.name, (v) => { this.state.name = v; }));
    c.appendChild(this.inputRow("Tagline", this.state.shortDescription, (v) => { this.state.shortDescription = v; }));
    const descLabel = document.createElement("div");
    descLabel.style.cssText = "font-size:11px;color:#88aacc;margin:8px 0 2px;";
    descLabel.textContent = "Backstory";
    c.appendChild(descLabel);
    const ta = document.createElement("textarea");
    ta.value = this.state.description;
    ta.style.cssText = "width:100%;height:70px;background:#11111e;border:1px solid #334455;color:#c8dae8;font-family:monospace;font-size:11px;padding:6px;box-sizing:border-box;";
    ta.addEventListener("input", () => { this.state.description = ta.value; });
    c.appendChild(ta);

    // SRD: class AND background each offer an A/B[/C] starting-equipment choice.
    // Show every option's full contents + gold so the player sees what they
    // start with and what the alternatives are, and a combined gold total.
    const clsEq = this.classOf(this.state.classId);
    const bg = this.backgrounds.find((b) => b.id === this.state.backgroundId);
    const classOpts = clsEq?.equipmentOptions ?? [];
    if (classOpts.length > 0) {
      this.renderEquipmentChooser(c, "Class equipment", classOpts.map((o) => ({
        label: o.label, gold: o.gold, contents: this.describeClassOption(o),
      })), this.state.classEquipmentChoice, (label) => { this.state.classEquipmentChoice = label; this.renderStep(); });
    }
    if (bg && bg.equipmentOptions.length > 0) {
      this.renderEquipmentChooser(c, "Background equipment", bg.equipmentOptions.map((o) => ({
        label: o.label, gold: o.gold, contents: this.describeBackgroundOption(o),
      })), this.state.equipmentChoice, (label) => { this.state.equipmentChoice = label; this.renderStep(); });
    }

    // Combined starting gold = the selected class option + the selected
    // background option (matches the CharacterBuilder summing both).
    const classGold = (classOpts.find((o) => o.label === this.state.classEquipmentChoice) ?? classOpts[0])?.gold ?? 0;
    const bgGold = (bg?.equipmentOptions.find((o) => o.label === this.state.equipmentChoice) ?? bg?.equipmentOptions[0])?.gold ?? 0;
    if (classOpts.length > 0 || (bg && bg.equipmentOptions.length > 0)) {
      const goldLine = document.createElement("div");
      goldLine.style.cssText = "margin-top:10px;font-size:12px;color:#caa86a;";
      goldLine.innerHTML = `<b>Total starting gold:</b> ${classGold + bgGold} gp <span style="color:#7e8a96;">(${classGold} class + ${bgGold} background)</span>`;
      c.appendChild(goldLine);
    }

    const summary = document.createElement("div");
    summary.style.cssText = "margin-top:14px;font-size:11px;color:#a8b8c8;line-height:1.7;border-top:1px solid #334455;padding-top:10px;";
    const cls = this.classOf(this.state.classId);
    // Final scores = assigned base + origin bonus (capped at 20), matching what
    // the server builds.
    const bonuses = this.backgroundBonuses();
    summary.innerHTML =
      `<b style="color:${ACCENT};">${this.species.find((s) => s.id === this.state.speciesId)?.name ?? "?"} ${cls?.name ?? "?"}</b> · ${bg?.name ?? "?"}<br/>` +
      ABILITY_KEYS.map((k) => {
        const final = Math.min(20, this.state.scores[k] + (bonuses[k] ?? 0));
        return `${ABILITY_LABEL[k]} ${final} (${fmtMod(abilityModifier(final))})`;
      }).join(" · ");
    c.appendChild(summary);
  }

  /** Render a labelled starting-equipment chooser. Each option lists its full
   *  contents + gold; the selected one is highlighted. A single fixed option is
   *  shown as a non-interactive row (no choice to make). */
  private renderEquipmentChooser(
    c: HTMLElement, title: string,
    options: Array<{ label: string; gold: number; contents: string[] }>,
    selectedLabel: string, onSelect: (label: string) => void,
  ): void {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:12px;";
    const h = document.createElement("div");
    h.style.cssText = "font-size:12px;color:#88aacc;margin-bottom:4px;";
    h.textContent = title;
    wrap.appendChild(h);
    const single = options.length === 1;
    for (const opt of options) {
      const selected = single || opt.label === selectedLabel;
      const text = opt.contents.length ? opt.contents.map(esc).join(", ") : "—";
      const row = document.createElement(single ? "div" : "button");
      row.style.cssText = `display:block;width:100%;text-align:left;margin:3px 0;padding:6px 8px;box-sizing:border-box;font-family:monospace;font-size:11px;line-height:1.4;
        background:${selected ? "#2a2416" : "#11111e"};border:1px solid ${selected ? ACCENT : "#334455"};color:#c8dae8;cursor:${single ? "default" : "pointer"};`;
      const prefix = single ? "" : `<b style="color:${selected ? ACCENT : "#8899aa"};">${opt.label}</b> — `;
      row.innerHTML = `${prefix}${text} <span style="color:#caa86a;">· ${opt.gold} gp</span>`;
      if (!single) row.addEventListener("click", () => onSelect(opt.label));
      wrap.appendChild(row);
    }
    c.appendChild(wrap);
  }

  /** Display name for an item id — the registry name, else a prettified id. */
  private itemName(id: string): string {
    return this.items.find((it) => it.id === id)?.name ?? prettify(id);
  }
  /** "<name> ×N" for a count > 1, else just the name. `name` overrides the
   *  registry lookup (backgrounds carry their own display names). */
  private itemLabel(id: string | undefined, count?: number, name?: string): string {
    const base = name ?? (id ? this.itemName(id) : "");
    return count && count > 1 ? `${base} ×${count}` : base;
  }
  /** Class option contents: the equipped armor/weapon/shield, then loose items. */
  private describeClassOption(opt: NonNullable<ClassDef["equipmentOptions"]>[number]): string[] {
    const parts: string[] = [];
    if (opt.armorId) parts.push(this.itemName(opt.armorId));
    if (opt.weaponId) parts.push(this.itemName(opt.weaponId));
    if (opt.shieldId) parts.push(this.itemName(opt.shieldId));
    for (const it of opt.items ?? []) parts.push(this.itemLabel(it.itemId, it.count));
    return parts;
  }
  /** Background option contents — loose inventory items only (no equip slots). */
  private describeBackgroundOption(opt: BackgroundDef["equipmentOptions"][number]): string[] {
    return (opt.items ?? []).map((it) => this.itemLabel(it.itemId, it.count, it.name)).filter(Boolean);
  }

  private async submit(): Promise<void> {
    this.busy = true; this.setStatus("Creating…");
    try {
      const cls = this.classOf(this.state.classId);
      // SRD background ability increase — the player's chosen distribution
      // (the Abilities-step picker), sent through as-is.
      const choices = {
        name: this.state.name,
        speciesId: this.state.speciesId,
        speciesLineage: this.state.speciesLineage,
        backgroundId: this.state.backgroundId,
        classId: this.state.classId,
        abilityMethod: this.state.method,
        baseAbilityScores: this.state.scores,
        backgroundAbility: this.state.backgroundAbility,
        skillProficiencies: [...this.state.skillPicks],
        speciesSkills: [...this.state.speciesSkillPicks],
        speciesFeat: this.state.speciesFeat || undefined,
        featSkills: [...this.state.featSkillPicks.values()].flatMap((s) => [...s]),
        languages: [...this.state.languagePicks],
        equipmentChoice: this.state.equipmentChoice,
        classEquipmentChoice: this.state.classEquipmentChoice,
        cantripIds: cls?.spellcasting ? [...this.state.cantripPicks] : undefined,
        preparedSpellIds: cls?.spellcasting ? [...this.state.spellPicks] : undefined,
        magicInitiate: this.featsGrantingSpells().map((g) => {
          const p = this.miPick(g);
          return { featId: g.feat.id, spellList: p.spellList, cantripIds: [...p.cantripIds], spellId: p.spellId, ability: p.ability };
        }),
        shortDescription: this.state.shortDescription,
        description: this.state.description,
      };
      const created = await gameClient.createCharacter(choices);
      // Refresh the roster so the new character appears in the carousel, and
      // mark it as the last-selected character so the setup scene centres and
      // selects it on return (no reload needed).
      const chars = await gameClient.fetchCharacters();
      this.registry.set("characters", chars);
      localStorage.setItem("myrpg_last_character", created.id);
      this.scene.start(this.returnScene);
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : "Create failed.", true);
      this.busy = false;
    }
  }

  // ── Bottom bar ───────────────────────────────────────────────────────────
  // Tabs (the step rail) handle navigation, so the bar only carries CANCEL +
  // CREATE — both available from any tab. A previous/next pair stays for
  // convenience but isn't required to reach any step.
  private renderBar(): void {
    const bar = this.root!.querySelector("[data-bar]") as HTMLDivElement;
    bar.innerHTML = "";
    bar.appendChild(this.button("CANCEL", "#2a1a1a", () => this.scene.start(this.returnScene)));
    const steps = this.visibleSteps();
    const pos = steps.indexOf(this.state.step);
    if (pos > 0) bar.appendChild(this.button("‹ PREV", "#1a1a2a", () => { this.state.step = steps[pos - 1]; this.renderStep(); }));
    if (pos < steps.length - 1) bar.appendChild(this.button("NEXT ›", "#1a1a2a", () => { this.state.step = steps[pos + 1]; this.renderStep(); }));
    bar.appendChild(this.button("✓ CREATE", "#1a4a2a", () => { if (!this.busy) void this.submit(); }));
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────
  private button(label: string, bg: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `background:${bg};border:1px solid #445566;color:#c8dae8;font-family:monospace;font-size:12px;padding:8px 14px;cursor:pointer;`;
    b.addEventListener("click", onClick);
    return b;
  }
  private miniBtn(label: string, onClick: () => void): HTMLButtonElement {
    const b = this.button(label, "#1a1a2a", onClick);
    b.style.padding = "2px 8px";
    return b;
  }
  /** A compact inline "<label> [select]" used by the background-ability picker. */
  private miniSelect(label: string, opts: Array<{ value: string; label: string }>, value: string, onChange: (v: string) => void): HTMLElement {
    const span = document.createElement("span");
    span.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
    span.innerHTML = `<span style="color:#88aacc;">${label}</span>`;
    const sel = document.createElement("select");
    sel.style.cssText = "background:#11111e;border:1px solid #334455;color:#c8dae8;font-family:monospace;padding:2px 4px;";
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.value; opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    span.appendChild(sel);
    return span;
  }

  private selectRow(label: string, opts: Array<{ value: string; label: string }>, value: string, onChange: (v: string) => void): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;margin:6px 0;font-size:12px;";
    row.innerHTML = `<span style="width:100px;color:${ACCENT};">${label}</span>`;
    const sel = document.createElement("select");
    sel.style.cssText = "flex:1;background:#11111e;border:1px solid #334455;color:#c8dae8;font-family:monospace;padding:5px;";
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.value; opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    row.appendChild(sel);
    return row;
  }
  private inputRow(label: string, value: string, onInput: (v: string) => void): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;margin:6px 0;font-size:12px;";
    row.innerHTML = `<span style="width:100px;color:${ACCENT};">${label}</span>`;
    const inp = document.createElement("input");
    inp.value = value;
    inp.style.cssText = "flex:1;background:#11111e;border:1px solid #334455;color:#c8dae8;font-family:monospace;padding:5px;";
    inp.addEventListener("input", () => onInput(inp.value));
    row.appendChild(inp);
    return row;
  }
  private checkRow(label: string, checked: boolean, onToggle: (on: boolean) => boolean | void): HTMLElement {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px;cursor:pointer;";
    const box = document.createElement("input");
    box.type = "checkbox"; box.checked = checked;
    box.addEventListener("change", () => {
      const res = onToggle(box.checked);
      if (res === false) box.checked = false;  // pick rejected (limit reached)
    });
    const span = document.createElement("span");
    span.textContent = label;
    row.appendChild(box); row.appendChild(span);
    return row;
  }
}

function fmtMod(m: number): string { return m >= 0 ? `+${m}` : String(m); }

/** Escape text for safe innerHTML insertion. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Turn an id like `animalHandling` / `thieves-tools` into "Animal Handling". */
function prettify(id: string): string {
  const spaced = id.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Client-side 4d6-drop-lowest set (the 'roll' method isn't strictly validated
 *  server-side, which accepts any 3..18 assignment). */
function rollSet(): number[] {
  const one = () => {
    const r = [d6(), d6(), d6(), d6()].sort((a, b) => a - b);
    return r[1] + r[2] + r[3];
  };
  return Array.from({ length: 6 }, one);
}
function d6(): number { return 1 + Math.floor(Math.random() * 6); }
