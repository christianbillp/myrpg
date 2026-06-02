/**
 * PlayerStatus — single source of truth for "what conditions and other
 * buffs are currently affecting the player." Builds a structured list of
 * chips from `PlayerState` that the Player Panel and the Character Sheet
 * both render. Putting the derivation here keeps both surfaces in sync —
 * adding a new chip (or a new tone) means editing one file.
 *
 * Tones (drive the chip colour):
 *   • `condition` — neutral SRD condition (poisoned, frightened, prone, …).
 *   • `debuff`    — a condition that's clearly harmful + mechanically severe
 *                   (paralyzed, stunned, unconscious, incapacitated, etc).
 *   • `buff`      — a beneficial status (Mage Armor, Heroic Inspiration,
 *                   Temp HP, Hidden / Invisible when controlled by the
 *                   player's own action).
 *   • `concentration` — the spell the player is currently maintaining.
 */
import type { PlayerState } from "../../../shared/types";

export type PlayerStatusTone = "condition" | "buff" | "debuff" | "concentration";

export interface PlayerStatusChip {
  label: string;
  tone: PlayerStatusTone;
  /** Longer description shown on hover (Character Sheet) — empty in the
   *  compact Player Panel rendering. */
  tooltip: string;
}

/**
 * Mapping from raw condition string (as stored in `PlayerState.conditions`)
 * to its display label, tone, and a short SRD-style summary used as a
 * tooltip / hover description. Conditions not present in this table are
 * still surfaced — they just render Title-Cased with the default tone and
 * no tooltip. (Better to show the chip than to silently drop it when
 * authors add a new condition we haven't catalogued.)
 */
const CONDITION_TABLE: Record<string, { label: string; tone: PlayerStatusTone; tooltip: string }> = {
  blinded:        { label: "Blinded",      tone: "debuff",    tooltip: "Can't see. Attack rolls have Disadvantage; attackers have Advantage against you." },
  charmed:        { label: "Charmed",      tone: "debuff",    tooltip: "Can't attack the charmer; the charmer has Advantage on social checks against you." },
  deafened:       { label: "Deafened",     tone: "condition", tooltip: "Can't hear and auto-fail any ability check that requires hearing." },
  frightened:     { label: "Frightened",   tone: "debuff",    tooltip: "Disadvantage on ability checks and attack rolls while you can see the source of fear; can't willingly move closer." },
  grappled:       { label: "Grappled",     tone: "debuff",    tooltip: "Speed becomes 0. Attack rolls against anyone other than the grappler are at Disadvantage." },
  incapacitated:  { label: "Incapacitated",tone: "debuff",    tooltip: "Can't take Actions, Bonus Actions, or Reactions." },
  invisible:      { label: "Invisible",    tone: "buff",      tooltip: "Attack rolls against you have Disadvantage; your attack rolls have Advantage." },
  paralyzed:      { label: "Paralyzed",    tone: "debuff",    tooltip: "Incapacitated, can't move or speak; attackers have Advantage; melee hits within 5 ft are auto-crits." },
  petrified:      { label: "Petrified",    tone: "debuff",    tooltip: "Transformed to stone. Incapacitated, unaware of surroundings, resistant to all damage." },
  poisoned:       { label: "Poisoned",     tone: "debuff",    tooltip: "Disadvantage on attack rolls and ability checks." },
  prone:          { label: "Prone",        tone: "debuff",    tooltip: "Disadvantage on attack rolls. Attackers within 5 ft have Advantage; ranged attackers have Disadvantage." },
  restrained:     { label: "Restrained",   tone: "debuff",    tooltip: "Speed becomes 0; attack rolls at Disadvantage; attackers have Advantage." },
  stunned:        { label: "Stunned",      tone: "debuff",    tooltip: "Incapacitated, can't move, fail Str/Dex saves; attackers have Advantage." },
  unconscious:    { label: "Unconscious",  tone: "debuff",    tooltip: "Incapacitated, can't move or speak. Drops what you hold, falls Prone. Attacks against you auto-crit within 5 ft." },
  hidden:         { label: "Hidden",       tone: "buff",      tooltip: "Unseen. Attacks against you have Disadvantage; your attacks have Advantage." },
  // Per-turn auras + temporary tactical states from the engine.
  dodging:        { label: "Dodging",      tone: "buff",      tooltip: "Attackers have Disadvantage; you have Advantage on Dex saves until the start of your next turn." },
  disengaged:     { label: "Disengaged",   tone: "buff",      tooltip: "Your movement this turn doesn't provoke Opportunity Attacks." },
  dashing:        { label: "Dashing",      tone: "buff",      tooltip: "Your speed for the turn is doubled." },
  slowed:         { label: "Slowed",       tone: "debuff",    tooltip: "Speed reduced." },
  vexed:          { label: "Vexed",        tone: "debuff",    tooltip: "Next attack against you has Advantage (Vex weapon mastery)." },
  // Effectively-Blinded states applied by spells like Fog Cloud — surfaced
  // so the player understands they have Disadvantage on attacks out and
  // attackers have Disadvantage on attacks against them.
  "heavily-obscured": { label: "Heavily Obscured", tone: "debuff", tooltip: "Treated as Blinded for sight. Your attacks have Disadvantage; attackers against you have Disadvantage." },
  "no-healing":   { label: "No Healing",   tone: "debuff",    tooltip: "Can't regain HP for the duration (Chill Touch rider)." },
  "no-reactions": { label: "No Reactions", tone: "debuff",    tooltip: "Can't take Reactions until the start of your next turn (Shocking Grasp rider)." },
};

/**
 * Resolve the chip list for the given player state + spell-name lookup.
 *
 * `concentratingOnName` is what the rest of the UI already calls "the
 * display name of the spell the player is concentrating on" — passing it in
 * keeps this module pure (no spell-registry lookup) and lets both surfaces
 * reuse the same resolved name.
 */
export function buildPlayerStatusChips(
  player: PlayerState,
  concentratingOnName: string | null,
): PlayerStatusChip[] {
  const chips: PlayerStatusChip[] = [];

  // Concentration — first slot if active, so it stays prominent.
  if (player.concentratingOn && concentratingOnName) {
    chips.push({
      label: `🌀 Concentrating: ${concentratingOnName}`,
      tone: "concentration",
      tooltip: "If you take damage, make a Constitution save (DC = max(10, half damage)) or lose this spell. Lost on Incapacitation too.",
    });
  }

  // Heroic Inspiration — small but mechanically powerful.
  if (player.heroicInspiration) {
    chips.push({
      label: "✨ Heroic Inspiration",
      tone: "buff",
      tooltip: "You can reroll any one d20 before the outcome is determined. Used immediately when you choose to use it.",
    });
  }

  // Temp HP buffer — only visible when > 0.
  if (player.tempHp > 0) {
    chips.push({
      label: `+${player.tempHp} Temp HP`,
      tone: "buff",
      tooltip: "Absorbs damage before HP. Doesn't stack with itself — a new Temp HP value replaces the existing one if higher.",
    });
  }

  // Mage Armor — surfaced because it changes AC math.
  if (player.mageArmor) {
    chips.push({
      label: "Mage Armor",
      tone: "buff",
      tooltip: "Base AC becomes 13 + Dex while unarmored. Lasts 8 hours.",
    });
  }

  // Self-buff spell flags set via SpellSystem's utility branch — surfaced
  // so the player can see the buff is active and tell the engine isn't
  // silently ignoring the cast.
  if (player.speedBonus > 0) {
    chips.push({
      label: `Speed +${player.speedBonus} ft`,
      tone: "buff",
      tooltip: "Speed bonus from Longstrider or similar buff. Applied at the start of each player turn.",
    });
  }
  if (player.expeditiousRetreat) {
    chips.push({
      label: "Expeditious Retreat",
      tone: "buff",
      tooltip: "Dash this turn and on each subsequent turn as a Bonus Action. Concentration, 10 minutes.",
    });
  }
  if (player.jumpMultiplier > 1) {
    chips.push({
      label: `Jump ×${player.jumpMultiplier}`,
      tone: "buff",
      tooltip: "Jump distance multiplier active for the spell's duration.",
    });
  }

  // Exhaustion — only visible when > 0; tone reflects level severity.
  if (player.exhaustionLevel > 0) {
    chips.push({
      label: `Exhaustion ${player.exhaustionLevel}/6`,
      tone: "debuff",
      tooltip: "Each level imposes a −2 penalty to every d20 test. Level 6 is death. One level is removed per Long Rest.",
    });
  }

  // Conditions — preserve the engine's order so per-turn statuses (dodging,
  // disengaged) appear after the long-running ones.
  for (const raw of player.conditions) {
    const meta = CONDITION_TABLE[raw];
    chips.push({
      label: meta?.label ?? toTitleCase(raw),
      tone: meta?.tone ?? "condition",
      tooltip: meta?.tooltip ?? "",
    });
  }

  // Ongoing periodic effects (DoTs, attach bites, …). One chip per effect
  // so the player can see how many sources are biting.
  for (const eff of player.ongoingEffects) {
    if (eff.kind === "attach") {
      const dot = eff.dot;
      const bonus = dot.bonus > 0 ? `+${dot.bonus}` : dot.bonus < 0 ? `${dot.bonus}` : "";
      chips.push({
        label: `Attached: ${dot.dice}d${dot.sides}${bonus} ${dot.damageType}`,
        tone: "debuff",
        tooltip: `Periodic damage at the start of the source's turn. Source NPC id: ${eff.sourceNpcId}.`,
      });
    } else if (eff.kind === "delayed-self-damage") {
      const bonus = eff.bonus > 0 ? `+${eff.bonus}` : eff.bonus < 0 ? `${eff.bonus}` : "";
      chips.push({
        label: `Lingering: ${eff.dice}d${eff.sides}${bonus} ${eff.damageType}`,
        tone: "debuff",
        tooltip: `Damage at the end of your next turn (from ${eff.spellId}).`,
      });
    }
  }

  return chips;
}

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_(.)/g, (_, c) => " " + c.toUpperCase());
}

/** Per-tone palette consumed by the renderers. Centralised so chip colours
 *  stay coherent between Player Panel and Character Sheet. */
export const STATUS_TONE_COLOR: Record<PlayerStatusTone, { bg: string; border: string; text: string }> = {
  condition:     { bg: "#1a1a2e", border: "#445566", text: "#aabbcc" },
  buff:          { bg: "#1a2e1a", border: "#446655", text: "#a8d8b8" },
  debuff:        { bg: "#2e1a1a", border: "#aa4444", text: "#e8a8a8" },
  concentration: { bg: "#1a1a2e", border: "#6655aa", text: "#b8a8e8" },
};
