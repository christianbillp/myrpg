/**
 * PlayerAction wire shapes.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { EntityRef } from "./conversation.js";
import type { NPCDef } from "./entities.js";
import type { PlayerState } from "./gameState.js";

export type PlayerAction =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'moveTo'; tileX: number; tileY: number }
  | { type: 'attack'; targetId?: string }
  | { type: 'throw'; itemId: string; targetId?: string }
  | { type: 'castSpell'; spellId: string; slotLevel: number; targetIds?: string[]; tile?: { x: number; y: number }; asRitual?: boolean; damageTypeChoice?: string; onFailChoice?: string; abilityChoice?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; scrollItemId?: string }
  /** Voluntarily drop the spell currently in `PlayerState.concentratingOn`.
   *  No action cost per SRD. Strips any conditions the spell applied and
   *  clears self-buff flags it set. No-op when not concentrating. */
  | { type: 'releaseConcentration' }
  | { type: 'hide' }
  | { type: 'useFeature'; featureId: string; targetId?: string; tile?: { x: number; y: number } }
  /** Command a player-owned summon (Mage Hand, Unseen Servant) to move to `tile`.
   *  The server validates the move range per spell and ends the spell if the
   *  range / lifecycle conditions are violated. Consumes the player's Action. */
  | { type: 'commandSummon'; summonNpcId: string; tile: { x: number; y: number } }
  | { type: 'resolveReaction'; accept: boolean }
  | { type: 'resolveReroll'; accept: boolean }
  | { type: 'grapple'; targetId?: string }
  | { type: 'shove'; targetId?: string; effect?: 'push' | 'prone' }
  | { type: 'attune'; itemId: string }
  | { type: 'unattune'; itemId: string }
  | { type: 'useScroll'; itemId: string }
  | { type: 'identify'; itemId: string }
  | { type: 'setNonLethal'; on: boolean }
  | { type: 'help'; targetId?: string }
  | { type: 'ready' }
  | { type: 'dash' }
  | { type: 'dodge' }
  | { type: 'disengage' }
  | { type: 'detach' }
  | { type: 'endTurn' }
  | { type: 'rollDeathSave' }
  | { type: 'shortRest' }
  | { type: 'search' }
  /** Attempt to disarm the trap on the given tile (must be discovered, armed,
   *  and within reach). Rolls Dexterity (Sleight of Hand) vs the trap's
   *  `disarmDC`; Thieves' Tools grant Advantage. Failure by 5+ springs it. */
  | { type: 'disarmTrap'; tileX: number; tileY: number }
  /** Deploy a piece of area-denial gear (caltrops, ball bearings) onto `tile`,
   *  creating an `ActiveZone`. Consumes one of the item from inventory. */
  | { type: 'deployGear'; itemId: string; tileX: number; tileY: number }
  | { type: 'usePotion' }
  | { type: 'equip'; slot: 'armor' | 'weapon' | 'shield'; itemId: string }
  | { type: 'unequip'; slot: 'armor' | 'weapon' | 'shield' }
  | { type: 'selectTarget'; entityId: string | null }
  | { type: 'scrollLog'; delta: number }
  // ── Conversation system ─────────────────────────────────────────────
  /** Open a conversation with the named NPC. `npcRef` is a runtime entity
   *  ref (`npc_<id>` or a combat-label ref). `conversationId` defaults to
   *  the NPC's `NPCDef.conversationId` when omitted. */
  | { type: 'startConversation'; npcRef: EntityRef; conversationId?: string }
  /** Advance the active conversation by selecting the choice at the given
   *  index in the current node's choice list. */
  | { type: 'conversationChoice'; choiceIndex: number }
  /** Close the active conversation (cancel / × / "Goodbye"). */
  | { type: 'conversationEnd' }
  // ── Companion commands (NPC sim, step 2) ─────────────────────────────
  /** Issue a command to a companion NPC. The engine writes the override
   *  onto the companion's `CompanionState`; the next world tick's sim
   *  pass consumes it. Sent by the Player Panel's COMPANION chip. `npcId`
   *  defaults to the player's first companion when the panel knows of
   *  only one. */
  | { type: 'companionCommand'; npcId: string; command: import('./longRest.js').CompanionCommand }
  /** Dev-mode shortcut — completes the current encounter so the tester can
   *  fast-forward through an adventure. Server-side this sets the
   *  encounter's `completionFlag` (when authored) AND clears every living
   *  enemy so the combat-end path fires too; clients should only send it
   *  when `devFlags.completePrimaryObjective` is on. */
  | { type: 'devCompleteEncounter' };
