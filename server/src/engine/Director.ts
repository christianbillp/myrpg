import type { GameContext } from './GameContext.js';

/**
 * Director (Phase E — pacing layer) — watches the bus and emits `custom`
 * events that encounter triggers can subscribe to. Holds simple thresholds;
 * default behavior is "do nothing." Authors write triggers like
 * `when: { event: 'custom', name: 'director_offer_help' }` to react to the
 * Director's calls.
 *
 * Truth flows down: the Director only emits events. It never spawns enemies,
 * adjusts standings, or writes flags itself — encounter triggers handle the
 * actual world changes. This keeps Director rules portable across encounters
 * and lets one encounter ignore the Director entirely (just don't listen).
 *
 * Per-encounter tracking lives in `GameState.worldFlags` under reserved
 * `director:*` keys so it persists across save/load alongside everything else.
 */

const F_ROUND_COUNT = 'director:round';
const F_ASSIST_FIRED = 'director:assist_fired';
const F_PRESSURE_FIRED = 'director:pressure_fired';

export function registerDirector(ctx: GameContext): void {
  // Round counter — bumped on each combat_started + each player turn_started.
  // Used by threshold rules below.
  ctx.bus.subscribe('combat_started', () => {
    ctx.state.worldFlags[F_ROUND_COUNT] = 0;
    delete ctx.state.worldFlags[F_ASSIST_FIRED];
    delete ctx.state.worldFlags[F_PRESSURE_FIRED];
  }, /*priority*/ 50);

  ctx.bus.subscribe('turn_started', (e) => {
    if (e.combatantId !== 'player') return;
    const r = (ctx.state.worldFlags[F_ROUND_COUNT] as number | undefined) ?? 0;
    ctx.state.worldFlags[F_ROUND_COUNT] = r + 1;
    evaluateDirectorRules(ctx);
  }, /*priority*/ 50);

  ctx.bus.subscribe('damage_dealt', (e) => {
    if (e.target !== 'player') return;
    evaluateDirectorRules(ctx);
  }, /*priority*/ 50);
}

function evaluateDirectorRules(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase !== 'player_turn' && s.phase !== 'enemy_turn' && s.phase !== 'death_saves') return;

  const round = (s.worldFlags[F_ROUND_COUNT] as number | undefined) ?? 0;
  const hpRatio = s.player.hp / Math.max(1, ctx.playerDef.maxHp);
  const enemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0).length;
  const allies = s.npcs.filter((n) => n.disposition === 'ally' && n.hp > 0).length;

  // Assist rule — the fight is going badly, hint to encounter triggers that
  // it's time to spawn help / lower the heat. Authors who want this listen
  // for `director_offer_help`; encounters that don't, ignore it.
  if (!s.worldFlags[F_ASSIST_FIRED] && round >= 3 && hpRatio < 0.4 && enemies >= 1 && allies === 0) {
    s.worldFlags[F_ASSIST_FIRED] = true;
    ctx.publish({
      type: 'custom',
      name: 'director_offer_help',
      payload: { round, hpRatio, enemies },
    });
  }

  // Pressure rule — the fight is too easy, hint that the encounter could use
  // a reinforcement wave. Default behavior is still "do nothing"; only fires
  // when an author has authored a reinforcement trigger keyed on this event.
  if (!s.worldFlags[F_PRESSURE_FIRED] && round >= 4 && hpRatio > 0.9 && enemies <= 1) {
    s.worldFlags[F_PRESSURE_FIRED] = true;
    ctx.publish({
      type: 'custom',
      name: 'director_apply_pressure',
      payload: { round, enemies },
    });
  }
}
