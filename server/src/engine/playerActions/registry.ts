/**
 * PlayerAction registry — typed dispatch table that replaces the
 * monolithic switch in `GameEngine.processAction`.
 *
 * Each entry maps a `PlayerAction.type` discriminator to a handler that
 * receives the `GameContext`, the narrowed action, the events buffer,
 * and a small `EngineRef` for the few cases that need engine-only state
 * (devCompleteEncounter, EndTurn's tether check, etc.).
 *
 * Adding a new player action = drop a line here + add the variant to
 * `PlayerAction` in shared/types/playerActions.ts. No central edit to
 * GameEngine.
 *
 * Why typed: the generic over `K extends PlayerAction['type']` makes
 * the handler's `action` parameter narrow to the exact discriminated
 * variant, so `a.dx` only exists for `move`, `a.targetId` only exists
 * for `attack`, etc. Adding a variant without registering it is a
 * compile error.
 */
import type { GameContext } from '../GameContext.js';
import type { GameEvent } from '../types.js';
import type { PlayerAction } from '../../../../shared/types.js';

// Delegated imports — same set the old switch used.
import { doMove as exDoMove, doMoveTo as exDoMoveTo, doSearch as exDoSearch, doShortRest as exDoShortRest, doUsePotion as exDoUsePotion } from '../ExplorationActions.js';
import { doAttack as caDoAttack, doDash as caDoDash, doDodge as caDoDodge, doDisengage as caDoDisengage, doDetach as caDoDetach, doHide as caDoHide, throwItem as caThrowItem, doResolveReroll as caDoResolveReroll } from '../CombatActions.js';
import { doCastSpell as spDoCastSpell } from '../SpellSystem.js';
import { doEquip as ivDoEquip, doUnequip as ivDoUnequip } from '../InventoryActions.js';
import { doCommandSummon, checkSummonTether } from '../SummonSystem.js';
import { doResolveReaction as cfDoResolveReaction, endPlayerTurn as cfEndPlayerTurn, doRollDeathSave as cfDoRollDeathSave } from '../CombatFlow.js';
import { doUseFeature } from '../FeatureRegistry.js';
import { endConcentration } from '../ConcentrationSystem.js';
import { startConversation as cnStartConversation, advanceConversation as cnAdvanceConversation, endConversation as cnEndConversation } from '../ConversationSystem.js';
import { runCompanionTick } from '../WorldTick.js';
import { doDisarmTrap, doDeployGear } from '../TrapSystem.js';

/** The thin slice of `GameEngine` the handlers need. Keeping this
 *  explicit lets us test handlers without instantiating the whole
 *  engine — pass an `{ devCompleteEncounter() {} }` stub. */
export interface EngineRef {
  devCompleteEncounter(events: GameEvent[]): void;
}

type Handler<K extends PlayerAction['type']> = (
  ctx: GameContext,
  action: Extract<PlayerAction, { type: K }>,
  events: GameEvent[],
  engine: EngineRef,
) => void;

type Registry = { [K in PlayerAction['type']]: Handler<K> };

export const PLAYER_ACTIONS: Registry = {
  move:                 (ctx, a, events) => exDoMove(ctx, a.dx, a.dy, events),
  moveTo:               (ctx, a, events) => exDoMoveTo(ctx, a.tileX, a.tileY, events),
  attack:               (ctx, a, events) => caDoAttack(ctx, a.targetId, events),
  throw:                (ctx, a, events) => {
    if (ctx.state.phase === 'exploring' || ctx.state.phase === 'player_turn') {
      events.push(...caThrowItem(ctx, a.itemId, a.targetId));
    }
  },
  castSpell:            (ctx, a, events) => spDoCastSpell(
    ctx, a.spellId, a.slotLevel, a.targetIds, a.tile, !!a.asRitual, events,
    a.damageTypeChoice, a.onFailChoice, a.abilityChoice,
  ),
  releaseConcentration: (ctx)            => endConcentration(ctx, 'released by caster'),
  hide:                 (ctx)            => caDoHide(ctx),
  useFeature:           (ctx, a, events) => doUseFeature(ctx, a.featureId, { targetId: a.targetId, tile: a.tile }, events),
  resolveReaction:      (ctx, a, events) => cfDoResolveReaction(ctx, a.accept, events),
  resolveReroll:        (ctx, a, events) => caDoResolveReroll(ctx, a.accept, events),
  dash:                 (ctx)            => caDoDash(ctx),
  dodge:                (ctx)            => caDoDodge(ctx),
  disengage:            (ctx)            => caDoDisengage(ctx),
  detach:               (ctx)            => caDoDetach(ctx),
  commandSummon:        (ctx, a, events) => doCommandSummon(ctx, a.summonNpcId, a.tile, events),
  endTurn:              (ctx, _a, events) => {
    if (ctx.state.phase === 'player_turn') {
      // SRD Mage Hand: vanishes if the caster ends a turn > 30 ft away.
      checkSummonTether(ctx);
      cfEndPlayerTurn(ctx, events);
    }
  },
  rollDeathSave:        (ctx, _a, events) => cfDoRollDeathSave(ctx, events),
  shortRest:            (ctx)            => exDoShortRest(ctx),
  search:               (ctx)            => exDoSearch(ctx),
  disarmTrap:           (ctx, a, events) => doDisarmTrap(ctx, a.tileX, a.tileY, events),
  deployGear:           (ctx, a, events) => doDeployGear(ctx, a.itemId, a.tileX, a.tileY, events),
  usePotion:            (ctx)            => exDoUsePotion(ctx),
  equip:                (ctx, a)         => ivDoEquip(ctx, a.slot, a.itemId),
  unequip:              (ctx, a)         => ivDoUnequip(ctx, a.slot),
  selectTarget:         (ctx, a)         => { ctx.state.selectedTargetId = a.entityId; },
  scrollLog:            (ctx, a)         => {
    const s = ctx.state;
    const maxOffset = Math.max(0, s.eventLog.length - 6);
    s.logScrollOffset = Math.max(0, Math.min(maxOffset, s.logScrollOffset + (a.delta > 0 ? -1 : 1)));
  },
  startConversation:    (ctx, a)         => cnStartConversation(ctx, a.npcRef, a.conversationId),
  conversationChoice:   (ctx, a)         => cnAdvanceConversation(ctx, a.choiceIndex),
  conversationEnd:      (ctx)            => cnEndConversation(ctx),
  companionCommand:     (ctx, a, events) => {
    // Set the override on the named companion, then fire ONE sim tick
    // immediately so the companion starts acting on the new command in
    // the same response frame the client receives. Without this, the
    // player has to wait up to 6 s (the world-tick interval) before the
    // companion notices the new command — a MOVE TO click feels broken.
    //
    // Only meaningful for movement-flavoured commands (move_to, follow)
    // during exploration; wait / attack / cast don't need an immediate
    // tick — wait is stationary by definition, and attack / cast are
    // combat-only.
    const target = ctx.state.npcs.find((n) => n.id === a.npcId);
    if (!target?.companion) return;
    target.companion.override = a.command;
    if (a.command.kind === 'follow') {
      target.companion.followMode = a.command.mode;
    }
    if (ctx.state.phase === 'exploring'
      && (a.command.kind === 'move_to' || a.command.kind === 'follow')) {
      runCompanionTick(ctx, target, ctx.state.worldTickCount, events);
    }
  },
  devCompleteEncounter: (_ctx, _a, events, engine) => engine.devCompleteEncounter(events),
};

/**
 * Dispatch a single player action. Returns `true` when a handler was
 * found, `false` when the action type isn't registered (which is a
 * compile error in practice — the `Registry` type covers every
 * `PlayerAction.type` — but the runtime guard protects against forged
 * client payloads).
 */
export function dispatchPlayerAction(
  ctx: GameContext,
  action: PlayerAction,
  events: GameEvent[],
  engine: EngineRef,
): boolean {
  const handler = PLAYER_ACTIONS[action.type] as Handler<PlayerAction['type']> | undefined;
  if (!handler) return false;
  handler(ctx, action, events, engine);
  return true;
}
