import { GameEvent, NpcState, LogEntry, CombatMode } from './types.js';
import type { GameContext } from './GameContext.js';
import { rollOneInitiative, rollDeathSave, type RolledBonusDamage } from './CombatSystem.js';
import { chebyshev } from './EnemyAI.js';
import { isIncapacitated, hasSpeedZero, proneStandCost, speedAfterExhaustion, TURN_CONDITIONS, clearHide } from './ConditionSystem.js';
import { Logger } from '../Logger.js';
import { applyEquipment } from './EquipmentSystem.js';
import { playerArmorSpeedPenaltyFt } from './ActionGuards.js';
import { runFlamingSphereEndOfTurnSaves } from './SummonSystem.js';
import { runPerceptionSweep } from './Vision.js';
import { mod, d20 as d20Local } from './Dice.js';
import { runSingleEnemyTurn, runSingleAllyTurn } from './NpcTurnRunners.js';
import { applyMonsterAttachToPlayer } from './OngoingEffectsSystem.js';
import { hasAdvantageOn } from './Modifiers.js';
import { tickActiveZones, tickZoneEnterSaves, runGustOfWindEndOfTurnSaves } from './SpellSystem.js';
import { endConcentration } from './ConcentrationSystem.js';
import { recomputeBuffs, removeBuffsForSpell } from './Buffs.js';
import { pingFactionAlert } from './npcSim/index.js';

// ── Combat lifecycle ────────────────────────────────────────────────────────

export function endCombat(ctx: GameContext): GameEvent[] {
  const s = ctx.state;
  Logger.log('combat.phase_changed', { from: s.phase, to: 'exploring', reason: 'combat_ended' });
  Logger.log('combat.combat_ended', { livingNpcs: s.npcs.filter((n) => n.hp > 0).length });
  s.phase = 'exploring';
  s.npcs = s.npcs.filter((n) => n.disposition !== 'enemy' || n.hp === 0);
  s.npcs.filter((n) => n.disposition === 'ally' && n.hp > 0).forEach((n) => { n.disposition = 'neutral'; });
  s.npcs.forEach((n) => { n.initiativeRoll = undefined; n.isActive = false; });
  s.player.initiativeRoll = 0;
  s.activeNpcIndex = 0;
  s.turnOrderIds = [];
  clearHide(s.player);
  ctx.publish({ type: 'combat_ended' });
  return [];
}

export function autoEndCombatIfNoEnemies(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase === 'exploring' || s.phase === 'defeat') return;
  if (s.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0)) return;
  endCombat(ctx);
}

export function triggerCombat(ctx: GameContext): GameEvent[] {
  const s = ctx.state;
  if (s.phase !== 'exploring' || !s.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0)) return [];
  const events: GameEvent[] = [];
  doStartCombat(ctx, events);
  return events;
}

/**
 * Start combat: detect surprised combatants, roll Initiative for everyone,
 * sort turnOrderIds by descending Initiative, and dispatch the first turn.
 *
 * Surprise (SRD): any enemy who didn't know combat was starting has
 * Disadvantage on Initiative. Heuristically we say: an enemy is Surprised iff
 * the player was Hidden at the moment combat triggered (i.e. attacked from
 * stealth or hidden movement that crossed the trigger range). Allies and the
 * player are never Surprised in player-initiated combat.
 */
export function doStartCombat(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  const enemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
  if (enemies.length === 0) return;
  Logger.log('combat.phase_changed', { from: s.phase, to: 'player_turn', reason: 'combat_started' });
  Logger.log('combat.combat_started', {
    enemies: enemies.map((n) => ({ id: n.id, defId: n.defId, hp: n.hp })),
    playerHidden: s.player.conditions.includes('hidden'),
  });

  // Sim-awareness propagation. Every faction with a living member
  // engaged in this fight pings its OTHER same-faction members so an
  // ambient bandit out of sight knows the captain just got hit. Only
  // fires for NPCs that aren't already combat-eligible — combatants
  // pick targets through the existing AI; the awareness ping is purely
  // for the sim-layer NPCs (routine-bearing + future ambient).
  const seenFactions = new Set<string>();
  for (const enemy of enemies) {
    if (seenFactions.has(enemy.factionId)) continue;
    seenFactions.add(enemy.factionId);
    pingFactionAlert(ctx, { x: enemy.tileX, y: enemy.tileY }, enemy.factionId, {
      sourceId: 'player',
      tickId: s.worldTickCount,
    });
  }

  // Read playerWasHidden BUT keep the condition active. A hidden opener should
  // grant Advantage on the very first attack (which is what triggered combat
  // in many cases). The attack resolver clears `hidden` as part of normal
  // post-attack cleanup, so we don't strip it here.
  const playerWasHidden = s.player.conditions.includes('hidden');
  s.player.deathSaveSuccesses = 0;
  s.player.deathSaveFailures = 0;

  // Skip summons (Mage Hand, Unseen Servant) — they act only when the
  // caster commands them, never roll initiative, and don't take their own
  // turns.
  const combatNpcs = s.npcs.filter((n) => n.disposition !== 'neutral' && n.hp > 0 && !n.summonSpellId);
  for (const npc of combatNpcs.filter((n) => !n.combatLabel)) ctx.assignCombatLabel(npc);

  // ── Roll Initiative for every combatant ─────────────────────────────────
  const logs: LogEntry[] = [{ left: '⚔ Combat begins', style: 'header' }];

  // Advantage on Initiative from any source that contributes an
  // `advantage: { on: 'initiative' }` modifier (Remarkable Athlete, Alert, …).
  const initAdvantage = hasAdvantageOn(ctx.playerDef, 'initiative');
  const playerInit = rollOneInitiative(mod(ctx.playerDef.dex), /*surprised*/false, /*invisible*/false, initAdvantage);
  s.player.initiativeRoll = playerInit.total;
  logs.push({
    left: `${ctx.playerDef.name} rolls Initiative`,
    right: `${playerInit.rollStr}=${playerInit.total}`,
    style: 'normal',
  });

  for (const npc of combatNpcs) {
    const def = ctx.resolveMonsterDef(npc.defId);
    if (!def) continue;
    const isEnemy = npc.disposition === 'enemy';
    const surprised = isEnemy && playerWasHidden;
    const invisible = npc.conditions.includes('invisible');
    const init = rollOneInitiative(def.initiativeBonus, surprised, invisible);
    npc.initiativeRoll = init.total;
    const note = surprised ? ' [SURPRISED]' : invisible ? ' [INVISIBLE]' : '';
    logs.push({
      left: `${combatantDisplayName(npc, s.npcs)} rolls Initiative${note}`,
      right: `${init.rollStr}=${init.total}`,
      style: surprised ? 'miss' : 'normal',
    });
  }

  // ── Build sorted turn order ─────────────────────────────────────────────
  type Slot = { id: string; total: number; tiebreak: number };
  const slots: Slot[] = [];
  slots.push({ id: 'player', total: s.player.initiativeRoll, tiebreak: mod(ctx.playerDef.dex) });
  for (const npc of combatNpcs) {
    const def = ctx.resolveMonsterDef(npc.defId);
    slots.push({ id: npc.id, total: npc.initiativeRoll ?? 0, tiebreak: def?.initiativeBonus ?? 0 });
  }
  slots.sort((a, b) => (b.total - a.total) || (b.tiebreak - a.tiebreak));
  s.turnOrderIds = slots.map((s) => s.id);
  ctx.addLogs(logs);

  ctx.addLog({
    left: `Turn order: ${slots.map((sl) => {
      if (sl.id === 'player') return ctx.playerDef.name;
      const n = s.npcs.find((nn) => nn.id === sl.id);
      return n ? combatantDisplayName(n, s.npcs) : sl.id;
    }).join(' → ')}`,
    style: 'normal',
  });

  ctx.publish({ type: 'combat_started' });

  // ── Faction identification (Insight check) ─────────────────────────────
  // Pass 3b: for every faction the player hasn't yet discovered that is
  // represented in this fight, roll a hidden Insight check against the
  // faction's renown-derived DC (`max(1, renown)`). On a pass, the faction
  // is added to `discoveredFactions` and the Target Panel will render its
  // name from now on. Factions absent from `defs.factions` (faction-of-one
  // raw monster spawns) have nothing identifiable about them and are
  // skipped — the player just sees the creature name.
  runFactionIdentificationChecks(ctx, combatNpcs);

  // ── Start the first combatant's turn ────────────────────────────────────
  s.activeNpcIndex = -1;
  if (ctx.isConstructing) {
    // The encounter just started and we're still inside `GameEngine`'s
    // constructor (an `encounter_started` combat trigger fired this call).
    // Don't auto-advance — the client needs a chance to play the intro
    // overlay / supertitle / focused announcement first. The deferred
    // `runPendingTurnAdvance` on the engine drains this once the client
    // releases the world pause.
    s.pendingTurnAdvance = true;
    return;
  }
  advanceTurn(ctx, events);
}

/**
 * Roll one Insight check per unidentified faction represented in the fight.
 * Factories: faction id → DC = `max(1, renown)`. Pass adds to
 * `discoveredFactions`. Roll detail intentionally NOT logged so failed
 * identifications don't leak which factions are present.
 */
function runFactionIdentificationChecks(ctx: GameContext, combatNpcs: NpcState[]): void {
  const factionsInFight = new Set<string>();
  for (const npc of combatNpcs) factionsInFight.add(npc.factionId);

  const insightBonus = ctx.playerDef.skills['insight'] ?? 0;
  for (const factionId of factionsInFight) {
    if (ctx.state.discoveredFactions.includes(factionId)) continue;
    const def = ctx.defs.factions.find((f) => f.id === factionId);
    if (!def) continue; // raw-monster faction-of-one — nothing to identify
    const dc = Math.max(1, def.renown);
    const roll = d20Local();
    if (roll + insightBonus >= dc) {
      ctx.state.discoveredFactions.push(factionId);
      ctx.addLog({
        left: `You recognise them — ${def.name}.`,
        style: 'status',
      });
    }
  }
}

/**
 * Advance to the next combatant in turnOrderIds and resolve their turn.
 * If the next combatant is the player, sets phase='player_turn' and returns
 * (waits for player input). If it's an NPC, runs their AI and then recurses
 * to the next combatant. Skips dead combatants entirely.
 */
export function advanceTurn(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  // Paused on a reaction prompt — the next player action must be `resolveReaction`.
  // Once resolved, doResolveReaction will call back into advanceTurn to continue.
  if (s.pendingReaction) return;
  if (s.phase === 'defeat' || s.phase === 'death_saves') return;
  if (s.turnOrderIds.length === 0) return;

  // Auto-end if all enemies are down before we tick further.
  if (!s.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0)) {
    endCombat(ctx);
    return;
  }

  // Find the next live combatant.
  for (let step = 0; step < s.turnOrderIds.length + 1; step++) {
    s.activeNpcIndex = (s.activeNpcIndex + 1) % s.turnOrderIds.length;
    const id = s.turnOrderIds[s.activeNpcIndex];
    if (id === 'player') {
      // The player always gets a turn (even at 0 HP — that's the death save).
      enterPlayerTurn(ctx);
      return;
    }
    const npc = s.npcs.find((n) => n.id === id);
    if (!npc || npc.hp <= 0) continue;
    // Mark this NPC as active and run their turn.
    s.npcs.forEach((n) => { n.isActive = false; });
    npc.isActive = true;
    s.phase = 'enemy_turn';
    if (npc.disposition === 'enemy') {
      runSingleEnemyTurn(ctx, npc, events);
    } else if (npc.disposition === 'ally') {
      runSingleAllyTurn(ctx, npc, events);
    }
    npc.isActive = false;
    // Recurse to the next combatant unless something during the NPC's turn
    // changed phase (defeat / death_saves / exploring after auto-end).
    // Read through `as string` to defeat TS narrowing from the earlier
    // s.phase = 'enemy_turn' assignment — the NPC turn can mutate phase.
    const newPhase = s.phase as string;
    if (newPhase === 'defeat' || newPhase === 'death_saves' || newPhase === 'exploring') return;
    return advanceTurn(ctx, events);
  }
}

export function enterPlayerTurn(ctx: GameContext): void {
  const s = ctx.state;
  const wasPlayerTurn = s.phase === 'player_turn';
  const fromPhase = s.phase;
  // If the player is unconscious, their "turn" is rolling a death save.
  s.phase = s.player.hp <= 0 ? 'death_saves' : 'player_turn';
  if (fromPhase !== s.phase) {
    Logger.log('combat.phase_changed', { from: fromPhase, to: s.phase, reason: 'enter_player_turn' });
  }
  s.npcs.filter((n) => n.disposition !== 'neutral' && n.hp > 0).forEach((n) => {
    n.isActive = false;
    // NOTE: NPC reactions AND turn-scoped conditions (Dodge / Dash /
    // Disengage / Slowed) reset at the START of THAT NPC's own next turn —
    // see runSingleEnemyTurn / runSingleAllyTurn. Clearing those here would
    // cut Dodge / Disengage short before the player's attacks resolve,
    // making them useless against the player.
  });
  s.player.actionUsed = false;
  s.player.bonusActionUsed = false;
  s.player.reactionUsed = false;
  s.player.freeObjectInteractionUsed = false;
  // Per-turn flags reset at the start of every player turn. `movedThisTurn`
  // gates Rogue Steady Aim; `steadyAim` is the one-shot Advantage flag the
  // attack resolvers consume — clear it as a safety net so an unused
  // Steady Aim doesn't leak into next turn.
  s.player.movedThisTurn = false;
  s.player.steadyAim = false;
  // SRD Sneak Attack — "Once per turn". Reset at the start of every player
  // turn so the next eligible hit can ride.
  s.player.sneakAttackUsedThisTurn = false;
  // SRD Shield: the +5 AC bonus ends at the start of the caster's next
  // turn. Drop the flag and recompute AC so the bonus disappears before
  // anything reads it this turn.
  if (s.player.shieldActive) {
    s.player.shieldActive = false;
    applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, s.player.mageArmor, false);
    s.player.ac = ctx.playerDef.ac;
  }
  s.player.conditions = s.player.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  if (hasSpeedZero(s.player.conditions) || s.player.hp <= 0) {
    s.player.movesLeft = 0;
  } else {
    // Longstrider and other self-buffs add a flat ft bonus to the player's
    // base speed. Expeditious Retreat additionally grants a free Dash each
    // turn while active (added once movement is computed, mirroring
    // CombatActions' Dash semantics).
    // SRD armor Strength requirement (US-111): −10 ft when wearing armor whose
    // minStr exceeds the player's Strength.
    const baseFt = Math.max(
      0,
      speedAfterExhaustion(ctx.playerDef.speed + s.player.speedBonus, s.player.exhaustionLevel ?? 0)
        - playerArmorSpeedPenaltyFt(ctx),
    );
    const tileSpeed = baseFt / 5;
    const standCost = proneStandCost(s.player.conditions, tileSpeed);
    s.player.movesLeft = Math.max(0, tileSpeed - standCost);
    if (s.player.expeditiousRetreat) {
      s.player.movesLeft += Math.floor(baseFt / 5);
    }
    if (standCost > 0) s.player.conditions = s.player.conditions.filter((c) => c !== 'prone');
  }
  if (!wasPlayerTurn && s.phase === 'player_turn') {
    Logger.log('combat.turn_started', { combatantId: 'player', hp: s.player.hp, movesLeft: s.player.movesLeft });
    ctx.addLog({ left: `── ${ctx.playerDef.name}'s turn — Action & Bonus refreshed ──`, style: 'header' });
    ctx.publish({ type: 'turn_started', combatantId: 'player' });
    // Persistent AOE zones (Fog Cloud, Web, Darkness, Grease, …) age one
    // round at the top of every player turn. Expired zones are removed
    // and their conditions stripped from any creature still inside.
    tickActiveZones(ctx);
    // SRD Web: a creature starting its turn in the webs rolls the save.
    tickZoneEnterSaves(ctx, 'player');
  }
}

/**
 * Player presses End Turn. Hand off to the next combatant in the initiative
 * order via advanceTurn.
 */
export function endPlayerTurn(ctx: GameContext, events: GameEvent[]): void {
  // SRD Flaming Sphere — any creature ending its turn within 5 ft of the
  // sphere makes a DEX save vs the spell's damage. Resolve before the
  // turn-end event so log lines order naturally (the sphere acts at the
  // very end of the player's turn).
  runFlamingSphereEndOfTurnSaves(ctx, 'player');
  // SRD Gust of Wind: any creature ending its turn in the Line re-rolls
  // the STR save and is pushed 15 ft away on failure. Same trigger
  // moment as Flaming Sphere.
  runGustOfWindEndOfTurnSaves(ctx, 'player', events);
  // Tick spell-imposed conditions whose duration is keyed to the caster's
  // own turns (Color Spray's Blinded, future "until the start/end of your
  // next turn" effects). Decrement `turnsRemaining`; when it hits 0 strip
  // the condition from the NPC and drop the effect record.
  tickSpellConditionExpiries(ctx);
  ctx.publish({ type: 'turn_ended', combatantId: 'player' });
  advanceTurn(ctx, events);
}

export function tickSpellConditionExpiries(ctx: GameContext): void {
  const s = ctx.state;
  for (const npc of s.npcs) {
    if (!npc.ongoingEffects || npc.ongoingEffects.length === 0) continue;
    const remaining: typeof npc.ongoingEffects = [];
    for (const oe of npc.ongoingEffects) {
      if (oe.kind !== 'spell-condition') { remaining.push(oe); continue; }
      const next = oe.turnsRemaining - 1;
      if (next > 0) { remaining.push({ ...oe, turnsRemaining: next }); continue; }
      npc.conditions = npc.conditions.filter((c) => c !== oe.condition);
      ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} recovers from ${oe.spellId}`, style: 'status' });
    }
    npc.ongoingEffects = remaining;
  }
}

/**
 * Backwards-compat wrapper used in a few code paths (e.g. death-save resolution
 * legacy fallback). Now just advances to the next combatant.
 */
export function enterEnemyPhase(ctx: GameContext, events: GameEvent[]): void {
  advanceTurn(ctx, events);
}

// ── Death saves ─────────────────────────────────────────────────────────────

export function doRollDeathSave(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'death_saves') return;

  const { roll, outcome } = rollDeathSave();
  const logs: LogEntry[] = [{ left: `${ctx.playerDef.name} death save: d20 = ${roll}`, style: 'normal' }];
  let nextPhase: CombatMode = 'death_saves';

  switch (outcome) {
    case 'nat20':
      s.player.hp = 1;
      logs.push({ left: `Natural 20! ${ctx.playerDef.name} regains 1 HP!`, style: 'heal' });
      nextPhase = 'player_turn';
      break;
    case 'nat1':
      s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + 2);
      logs.push({ left: `Natural 1 — two failures (${s.player.deathSaveFailures}/3)`, style: 'miss' });
      nextPhase = s.player.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
      if (nextPhase === 'defeat') logs.push({ left: `${ctx.playerDef.name} has died.`, style: 'kill' });
      break;
    case 'success':
      s.player.deathSaveSuccesses++;
      logs.push({ left: `Success (${s.player.deathSaveSuccesses}/3)`, style: 'hit' });
      if (s.player.deathSaveSuccesses >= 3) {
        s.player.hp = 1;
        s.player.deathSaveSuccesses = 0;
        s.player.deathSaveFailures = 0;
        logs.push({ left: `${ctx.playerDef.name} stabilizes and regains consciousness with 1 HP!`, style: 'heal' });
        nextPhase = 'player_turn';
      } else {
        nextPhase = 'enemy_turn';
      }
      break;
    case 'failure':
      s.player.deathSaveFailures++;
      logs.push({ left: `Failure (${s.player.deathSaveFailures}/3)`, style: 'miss' });
      nextPhase = s.player.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
      if (nextPhase === 'defeat') logs.push({ left: `${ctx.playerDef.name} has died.`, style: 'kill' });
      break;
  }

  ctx.addLogs(logs);

  if (nextPhase === 'player_turn') {
    // nat20 or stabilize-on-3rd-success: wake up and take what remains of this turn.
    s.player.movesLeft = speedAfterExhaustion(ctx.playerDef.speed, s.player.exhaustionLevel ?? 0) / 5;
    s.phase = 'player_turn';
  } else if (nextPhase === 'enemy_turn') {
    // Advance to the next combatant in initiative order.
    advanceTurn(ctx, events);
  } else {
    s.phase = nextPhase;
  }
}

// ── Per-NPC turn execution ────────────────────────────────────────────────

/**
 * Returns the display name to use in turn-bar / combat-log lines for the given
 * NPC: bare name when unique, "Name (Label)" when more than one NPC in the
 * current encounter shares the same base name and the NPC has a combat label.
 */
export function combatantDisplayName(npc: NpcState, allNpcs: NpcState[]): string {
  const base = npc.revealedName ?? npc.name;
  const duplicates = allNpcs.filter((n) => (n.revealedName ?? n.name) === base && n.disposition !== 'neutral').length;
  if (duplicates > 1 && npc.combatLabel) return `${base} (${npc.combatLabel})`;
  return base;
}


/** Does the player meet basic reaction eligibility (not used, conscious, not incapacitated)? */
export function playerCanReact(ctx: GameContext): boolean {
  const p = ctx.state.player;
  return !p.reactionUsed && p.hp > 0 && !isIncapacitated(p.conditions);
}

/** Can the player cast Shield right now (reaction + L1 slot + knows the spell)? Whether it would actually help is the player's call, not ours. */
export function shieldAvailable(ctx: GameContext): boolean {
  if (!playerCanReact(ctx)) return false;
  if ((ctx.state.player.spellSlots[0] ?? 0) <= 0) return false;
  return ctx.state.player.preparedSpellIds.includes('shield')
    || (ctx.playerDef.defaultSpellbookIds?.includes('shield') ?? false);
}

/**
 * Apply an enemy hit's damage to the player, including death-save accrual when
 * the player is already at 0 HP. Factored out so it can be re-run from the
 * Shield resolver after a "decline" decision.
 */
export function applyEnemyHitToPlayer(
  ctx: GameContext,
  npc: NpcState,
  result: { damage: number; isCrit: boolean; finalTileX: number; finalTileY: number; bonusComponents: RolledBonusDamage[]; damageType?: string; attackOnHit?: import('./types.js').AttackOnHitEffect[] },
  events: GameEvent[],
): void {
  const s = ctx.state;
  // SRD Mirror Image — when a creature hits the caster with an attack roll,
  // roll a d6 for each remaining image. If any rolls ≥ 3 the hit lands on
  // an image instead, the image is destroyed, and the player takes no
  // damage from the attack. Blindsight / Truesight / Blinded attackers
  // ignore the spell per SRD (descriptive only — we don't model attacker
  // sense types yet). When all three images are destroyed the spell ends.
  const mirrorBuff = s.player.activeBuffs?.find((b) => b.spellId === 'mirror-image');
  if (mirrorBuff && (mirrorBuff.charges ?? 0) > 0) {
    const count = mirrorBuff.charges!;
    const rolls: number[] = [];
    for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * 6) + 1);
    const anyHit = rolls.some((r) => r >= 3);
    if (anyHit) {
      // Decrement the buff's charges; remove it (and reset the derived
      // `mirrorImages`) when the last duplicate is spent.
      mirrorBuff.charges = count - 1;
      if (mirrorBuff.charges <= 0) removeBuffsForSpell(ctx, 'mirror-image');
      else recomputeBuffs(ctx);
      ctx.addLog({
        left: `↪ Mirror Image — one duplicate absorbs the hit (${s.player.mirrorImages} remaining)`,
        right: `${count}d6[${rolls.join(',')}]`,
        style: 'status',
      });
      if ((s.player.mirrorImages ?? 0) === 0) {
        ctx.addLog({ left: `Mirror Image fades — all duplicates destroyed`, style: 'status' });
      }
      // The hit is voided — no damage, no bonus damage, no on-hit riders.
      return;
    }
    ctx.addLog({
      left: `↪ Mirror Image — every duplicate dodges; the hit lands on ${ctx.playerDef.name}`,
      right: `${count}d6[${rolls.join(',')}]`,
      style: 'status',
    });
  }
  if (s.player.hp <= 0) {
    const adjacentToPlayer = chebyshev(result.finalTileX, result.finalTileY, s.player.tileX, s.player.tileY) <= 1;
    const effectivelyCrit = result.isCrit || adjacentToPlayer;
    const failures = effectivelyCrit ? 2 : 1;
    s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + failures);
    ctx.addLogs([
      { left: `Strikes unconscious ${ctx.playerDef.name}!${effectivelyCrit ? ' CRITICAL — 2 failures!' : ' 1 failure.'}`, style: 'status' },
      { left: `Death saves: ${s.player.deathSaveSuccesses} ✓  ${s.player.deathSaveFailures} ✗`, style: 'status' },
    ]);
    if (s.player.deathSaveFailures >= 3) {
      ctx.addLog({ left: `${ctx.playerDef.name} has died.`, style: 'kill' });
      s.phase = 'defeat';
    } else {
      s.phase = 'death_saves';
    }
  } else {
    ctx.applyDamageToPlayer(result.damage, events, result.damageType);
    // Secondary damage riders from the attack (e.g. cultist's necrotic add-on).
    // Each component carries its own damage type, so species resistances
    // (US-108) apply per-component; logged separately so the player sees
    // exactly what hit them.
    for (const bd of result.bonusComponents) {
      ctx.addLog({ left: `+ ${bd.damage} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
      ctx.applyDamageToPlayer(bd.damage, events, bd.damageType);
    }
    // Apply on-hit effects (attach, etc.) authored on the attack.
    applyMonsterAttachToPlayer(ctx, npc, result.attackOnHit);
  }
}

export function finalizeNpcTurn(ctx: GameContext, npc: NpcState, events?: GameEvent[]): void {
  const s = ctx.state;
  // SRD Flaming Sphere — any creature ending its turn within 5 ft of the
  // sphere makes a DEX save vs the spell's damage. Resolve before the
  // hide/perception sweep so the log reads in narrative order.
  runFlamingSphereEndOfTurnSaves(ctx, npc.id);
  // SRD Gust of Wind end-of-turn save for this NPC. Same shape as
  // Flaming Sphere — a creature ending its turn on a zone tile rolls
  // STR vs the spell's DC and is pushed 15 ft away on failure.
  runGustOfWindEndOfTurnSaves(ctx, npc.id, events);
  // SRD: Hide / Invisible only ends when an enemy FINDS the hider — i.e. an
  // active Perception roll opposes their hideDC and wins. Run a sweep here
  // so the finishing NPC (and every other observer) gets one chance to spot
  // the player using their actual senses + vision rules. Blanket-clearing
  // hidden on every NPC turn-end was the pre-Vision-module hack and broke
  // the Hide-then-attack-with-Advantage opener.
  if (s.player.conditions.includes('hidden')) {
    runPerceptionSweep(ctx, 'player');
  }

  // Delayed-self-damage ongoing effects (Acid Arrow's lingering 2d4). The
  // effect was scheduled with `turnsRemaining = 1` at cast time; at the end
  // of the target's next turn (this hook) `turnsRemaining` decrements to 0
  // and the damage fires. After firing, the effect is removed. We tick
  // through a copy so an effect that fires can be filtered out cleanly.
  const tickEffects = npc.ongoingEffects.filter((oe) => oe.kind === 'delayed-self-damage');
  if (tickEffects.length > 0) {
    const remaining: typeof npc.ongoingEffects = [];
    for (const oe of npc.ongoingEffects) {
      if (oe.kind !== 'delayed-self-damage') { remaining.push(oe); continue; }
      const next = oe.turnsRemaining - 1;
      if (next > 0) { remaining.push({ ...oe, turnsRemaining: next }); continue; }
      // Fire the damage. Roll the dice + apply via resistMod path so resistance
      // / vulnerability / immunity still apply correctly.
      const rolls: number[] = [];
      for (let i = 0; i < oe.dice; i++) rolls.push(Math.floor(Math.random() * oe.sides) + 1);
      const rawTotal = rolls.reduce((a, b) => a + b, 0) + oe.bonus;
      const def = ctx.resolveMonsterDef(npc.defId);
      let finalDamage = rawTotal;
      if (def) {
        const { finalDamage: fd, log } = ctx.resistMod(rawTotal, oe.damageType, def, npc.name);
        finalDamage = fd;
        if (log) ctx.addLog(log);
      }
      if (npc.hp > 0 && finalDamage > 0) {
        npc.hp = Math.max(0, npc.hp - finalDamage);
        ctx.addLog({
          left: `${npc.name} suffers lingering ${oe.spellId} — ${finalDamage} ${oe.damageType}`,
          right: `${oe.dice}d${oe.sides}${oe.bonus ? `+${oe.bonus}` : ''}[${rolls.join(',')}]=${rawTotal}`,
          style: 'hit',
        });
      }
      // Effect removed regardless of outcome (one-shot).
    }
    npc.ongoingEffects = remaining;
  }

  // Generic concentration repeat-save (Hideous Laughter, Hold Person, future
  // Eyebite / Otto's Irresistible Dance / etc.). At the end of each affected
  // creature's turn, roll a save vs the spell's DC; on success, strip the
  // conditions the spell applied so the creature returns to baseline. Sleep's
  // bespoke Incapacitated→Unconscious transition is below — it can't fit
  // this shape because failure progresses to a different condition.
  if (s.player.concentratingOn) {
    const spellId = s.player.concentratingOn;
    const spell = ctx.defs.spells.find((sp) => sp.id === spellId);
    if (spell?.repeatSave) {
      const triggerConds = spell.repeatSave.removeOnSuccess;
      const isAffected = triggerConds.every((c) => npc.conditions.includes(c));
      const def = ctx.resolveMonsterDef(npc.defId);
      if (isAffected && def) {
        const dc = 8 + ctx.playerDef.proficiencyBonus + (
          ctx.playerDef.spellcastingAbility ? mod(ctx.playerDef[ctx.playerDef.spellcastingAbility]) : 0
        );
        const ability = spell.repeatSave.ability;
        const saveMod = (def.savingThrows && def.savingThrows[ability] !== undefined)
          ? def.savingThrows[ability]
          : mod(def[ability]);
        const roll = d20Local();
        const total = roll + saveMod;
        const success = total >= dc;
        const verb = success ? 'shakes off' : 'remains under';
        ctx.addLog({
          left: `${combatantDisplayName(npc, s.npcs)} ${verb} ${spell.name}`,
          right: `${ability.toUpperCase()} d20(${roll})+${saveMod}=${total} vs DC ${dc}`,
          style: success ? 'status' : 'miss',
        });
        if (success) {
          const drop = new Set(triggerConds);
          npc.conditions = npc.conditions.filter((c) => !drop.has(c));
          // SRD: a concentration spell ends when nobody is still affected.
          // For single-target shapes (Hold Person, Hideous Laughter) the
          // one creature shaking off the effect leaves the spell with no
          // referents — drop concentration so the slot isn't wasted on a
          // ghost spell. The check scans the full NPC list so upcast
          // multi-target Hold Person also auto-ends only when the last
          // target frees themselves.
          const someoneStillAffected = s.npcs.some((other) =>
            other.hp > 0 && triggerConds.every((c) => other.conditions.includes(c))
          );
          const playerStillAffected = triggerConds.every((c) => s.player.conditions.includes(c));
          if (!someoneStillAffected && !playerStillAffected) {
            endConcentration(ctx, `${spell.name} has no remaining target`);
          }
        }
      }
    }
  }

  // Sleep re-save: per SRD, the Incapacitated condition from Sleep ends at
  // the end of the target's next turn, at which point they re-save vs the
  // original DC. Success ends the spell on this target; failure replaces
  // Incapacitated with Unconscious **for the duration** — once unconscious
  // there are no further saves until the spell ends, so the re-save only
  // fires while the target is still in the Incapacitated stage.
  if (s.player.concentratingOn === 'sleep'
    && npc.conditions.includes('incapacitated')
    && !npc.conditions.includes('unconscious')) {
    const def = ctx.resolveMonsterDef(npc.defId);
    if (def) {
      const dc = 8 + ctx.playerDef.proficiencyBonus + (
        ctx.playerDef.spellcastingAbility ? mod(ctx.playerDef[ctx.playerDef.spellcastingAbility]) : 0
      );
      const saveMod = (def.savingThrows && def.savingThrows['wis'] !== undefined)
        ? def.savingThrows['wis']
        : mod(def.wis);
      const roll = d20Local();
      const total = roll + saveMod;
      const success = total >= dc;
      ctx.addLog({
        left: `${combatantDisplayName(npc, s.npcs)} ${success ? 'shakes off Sleep' : 'sinks deeper into Sleep'}`,
        right: `WIS d20(${roll})+${saveMod}=${total} vs DC ${dc}`,
        style: success ? 'status' : 'miss',
      });
      if (success) {
        npc.conditions = npc.conditions.filter((c) => c !== 'incapacitated');
      } else {
        npc.conditions = npc.conditions.filter((c) => c !== 'incapacitated');
        npc.conditions.push('unconscious');
      }
    }
  }
}

/**
 * Resolve a pending player reaction. Applies the deferred outcome (fires the
 * Opportunity Attack or negates the incoming damage with Shield) when the
 * player accepts; otherwise skips the reaction entirely. Either way the NPC's
 * turn cleanup runs and the turn loop resumes via `advanceTurn`.
 */
export function doResolveReaction(ctx: GameContext, accept: boolean, events: GameEvent[]): void {
  const s = ctx.state;
  const pending = s.pendingReaction;
  if (!pending) return;
  s.pendingReaction = null;

  if (pending.kind === 'opportunity_attack') {
    const npc = s.npcs.find((n) => n.id === pending.npcId);
    if (npc) {
      if (accept) {
        ctx.doPlayerOpportunityAttack(npc, events);
      } else {
        ctx.addLog({ left: `${ctx.playerDef.name} holds — no Opportunity Attack`, style: 'status' });
      }
      finalizeNpcTurn(ctx, npc, events);
    }
  } else if (pending.kind === 'shield') {
    const attacker = s.npcs.find((n) => n.id === pending.attackerId);
    if (accept) {
      // Consume slot + reaction; flag the +5 AC so any further attack
      // before the start of the player's next turn also faces it (SRD
      // wording: "+5 bonus to AC, including against the triggering attack,
      // until the start of your next turn").
      if ((s.player.spellSlots[0] ?? 0) > 0) s.player.spellSlots[0] -= 1;
      s.player.reactionUsed = true;
      s.player.shieldActive = true;
      applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, s.player.mageArmor, s.player.shieldActive);
      s.player.ac = ctx.playerDef.ac;
      ctx.addLog({ left: `⚡ ${ctx.playerDef.name} casts Shield (reaction) — AC ${s.player.ac} until next turn`, style: 'status' });
      // SRD: crits bypass AC entirely, so Shield can't turn the triggering
      // attack into a miss when it was a critical hit. The +5 AC still
      // applies to subsequent attacks this round. Apply the saved damage.
      if (pending.isCrit && attacker) {
        ctx.addLog({ left: `The critical hit still lands — Shield can't block it`, style: 'miss' });
        const synthResult = {
          damage: pending.incomingDamage,
          isCrit: true,
          finalTileX: attacker.tileX,
          finalTileY: attacker.tileY,
          bonusComponents: pending.incomingBonusComponents,
          damageType: pending.incomingDamageType,
        };
        applyEnemyHitToPlayer(ctx, attacker, synthResult, events);
      } else if (pending.attackTotal < pending.shieldedAc) {
        // The +5 AC would convert this hit to a miss — Shield prevented it.
        ctx.addLog({ left: `The attack glances off the magical barrier — miss`, style: 'miss' });
      } else if (attacker) {
        // Shield's +5 AC isn't enough to negate this attack (attackTotal
        // ≥ shielded AC). The hit still lands; the buff persists for
        // future attacks this round.
        ctx.addLog({ left: `Shield holds, but the blow lands anyway — AC ${s.player.ac} wasn't enough`, style: 'miss' });
        const synthResult = {
          damage: pending.incomingDamage,
          isCrit: false,
          finalTileX: attacker.tileX,
          finalTileY: attacker.tileY,
          bonusComponents: pending.incomingBonusComponents,
          damageType: pending.incomingDamageType,
        };
        applyEnemyHitToPlayer(ctx, attacker, synthResult, events);
      }
    } else if (attacker) {
      // Decline → apply the damage we saved when deferring.
      const synthResult = {
        damage: pending.incomingDamage,
        isCrit: false,
        finalTileX: attacker.tileX,
        finalTileY: attacker.tileY,
        bonusComponents: pending.incomingBonusComponents,
        damageType: pending.incomingDamageType,
      };
      applyEnemyHitToPlayer(ctx, attacker, synthResult, events);
    }
    if (attacker) finalizeNpcTurn(ctx, attacker, events);
  }

  // Resume the turn loop.
  advanceTurn(ctx, events);
}
