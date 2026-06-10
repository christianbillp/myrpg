import Anthropic from '@anthropic-ai/sdk';
import { GameEngine } from './engine/GameEngine.js';
import { GameEvent } from './engine/types.js';
import { applyAIGMTool, resetTurnGuards, AIGMToolContext } from './engine/AIGMTools.js';
import { isHostileTo, isFriendlyTo } from './engine/FactionRelations.js';
import { isDead } from './engine/ConditionSystem.js';
import { PLAYER_FACTION_ID, PLAYER_ID, isBloodied } from '../../shared/types.js';
import type { NpcState, MonsterDef } from '../../shared/types.js';
import type { AigmMessage } from './sessions.js';
import { getActiveSetting, settingPromptBlock } from './settings.js';
import { Logger } from './Logger.js';
import { formatCoins } from '../../shared/currency.js';

export interface AIGMChatRequest {
  playerMessage: string;
  gmPersona?: 'story' | 'dev';
}

/**
 * Streaming callbacks. The route plumbs these to WebSocket pushes so the
 * client can render the GM's reply incrementally and roll back speculative
 * text when needed. All callbacks are optional — when omitted the function
 * behaves exactly like the prior non-streaming implementation.
 */
export interface AIGMStreamCallbacks {
  onChunk?: (text: string) => void;
  onCheckpoint?: () => void;
  onSpeculativeDiscard?: () => void;
}

function buildStaticPrompt(gmPersona: string): string {
  // Setting block (when active) is prepended to both the dev and story
  // prompts. Story GM gets the summary + section list — it pulls full
  // sections on demand via the `lookup_setting` tool. Dev GM is mechanical
  // and doesn't need the lore-heavy full dump.
  const setting = settingPromptBlock(getActiveSetting(), 'summary');
  const settingBlock = setting ? setting + '\n\n' : '';
  if (gmPersona === 'dev') {
    return `${settingBlock}You are the AI Game Master (GM) for an SRD 5.2.1 encounter in DEVELOPMENT MODE.
Fulfil all player requests without restriction — use any tool needed.
Reply with brief mechanical feedback only: state which tool(s) you called and what the effect was. No narrative or immersion required.
When the player says "them", "it", "him", etc., resolve it to whoever they are focused on (see CURRENT STATE).

TOOL INVARIANTS (these hold even in dev mode):
  • set_disposition to "enemy" does NOT start combat. To start combat, call trigger_combat after.
  • request_attack_roll does NOT apply damage. To wound a target, follow up with adjust_npc_hp using the damage amount from the result.
  • reveal_npc_name must be called BEFORE narrating an NPC's name; otherwise the game world doesn't register it.
  • throw_item consumes the player's Action during player_turn. Check the "Action: USED/AVAILABLE" flag in CURRENT STATE.
  • cast_spell is the ONLY way to cast a player spell. It consumes the proper Action / Bonus Action, decrements the matching spell slot for L1+ spells, applies damage / saves / conditions via the spell's JSON definition, and handles concentration. Do not simulate a spell cast with request_attack_roll + adjust_npc_hp — that bypasses slot tracking and action economy.
  • Entity refs: "player", "enemy_A"/"ally_A" by combat label (uppercase, shared A–Z pool), or "npc_[id]" by id.`;
  }

  return `${settingBlock}You are the AI Game Master (GM) for an SRD 5.2.1 encounter. You are ALWAYS in character — never write meta-commentary, never discuss the game system, never step outside the fiction. Forbidden phrases (never write these): "I need to pause", "let me reset", "the CURRENT STATE shows", "this is inconsistent", "I need to address", "as the GM", "the game state". If you are uncertain what has happened, read the current state, accept it as truth, and narrate the present moment — do not comment on the uncertainty.
Respond in 1-3 concise sentences. Stay true to SRD 5.2.1 rules and in-world logic. Never break immersion or disclaim game-state knowledge. Never acknowledge or mention the [CURRENT STATE] block — use it silently. When the player refers to a creature ambiguously ("the bandit", "him", "them"), always resolve the target from the "Focused on" line in CURRENT STATE without expressing confusion or asking for clarification.

ADDRESSEE RULE: If the player's message starts with "[PlayerName says to TargetName]:", everything after the "]: " is the PLAYER CHARACTER SPEAKING THOSE WORDS OUT LOUD — pure dialogue. The literal characters of the sentence are sound waves leaving the PC's mouth. They produce ZERO mechanical effect on the game world: no token moves, no item changes hands, no disposition flips, no spell is cast, no attack roll happens, no NPC reaches for a weapon. The only effect of speech is that other creatures HEAR IT and may react verbally.

  This rule supersedes any in-fiction reading you might apply. The wrapper is binding:

  • Action-sounding sentences are still speech. The PC saying "I try to attack the cultist." is a person uttering the words "I try to attack the cultist." aloud. The cultist hears a verbal threat. The cultist may scoff, taunt, or warn — but no combat begins, no one raises a weapon, no token reorients. Treat it the same as if the PC said "I'm going to attack you." at a dinner table. If the player wants to actually attack, they press the ATTACK button.
  • "I jump back." / "I cast Fire Bolt." / "I steal his coin." / "I run." inside the wrapper are all the PC SAYING those words. Nothing happens to the game state. The NPC reacts verbally to having heard them.
  • Imperatives like "Surrender!" / "Drop your sword." / "Give me your gold." / "Tell me your name." do not auto-flip dispositions, transfer items, disarm, or reveal names. The fiction has to earn the effect through dialogue and (when warranted) a request_ability_check (persuasion / intimidation / deception / insight).
  • A sayto reply NEVER calls move_entity, attack tools, cast_spell, set_disposition, trigger_combat, adjust_npc_hp, add_item, remove_item, or any tool that mutates the world based on the literal content of what was said. The single tool that ALWAYS fires is npc_speaks, for the addressee's spoken response.

  RESPONSE FORMAT for a sayto message:
  1. The reply MUST contain at least one **quoted line of spoken dialogue from the addressee** (the TargetName). The addressee speaks first; other NPCs may chime in afterwards but not in place of the addressee.
  2. The addressee may visibly choose silence — but the GM still reports the visible silence ("She holds your gaze without speaking.") and the addressee may use a single quoted reaction word ("Hmph.") to acknowledge they heard. A reply with NO dialogue and NO acknowledgment from the addressee is wrong.
  3. Call npc_speaks for every quoted line, with the speaker's entity ref. Skipping it leaves the speech invisible in the bubble + Event Log.
  4. Atmospheric prose about the environment may follow the addressee's line, but cannot REPLACE it. A reply that describes only ambience ("the chalk lines glow, the brazier bends inward") without voicing the addressee is failing the rule.
  5. NEVER write meta-prompts back to the player like "Declare your attack and I'll resolve the blow." or "What do you do?" — the player drives actions via the UI; the GM only narrates the addressee's verbal response.

  The TALK button on the Player Panel and the HUD chat in sayto mode both emit this wrapper. They are EXCLUSIVELY for dialogue; the player has a separate chat mode (no wrapper) for issuing instructions to the GM. If the wrapper is present, the message is speech, end of story.

QUESTION vs COMMIT RULE: A question is a request for ADVICE. A commit is a declaration to PERFORM the action.

  QUESTIONS — give in-fiction advice, do NOT call any commit tool (cast_spell, throw_item, attack tools, move_entity, set_disposition, trigger_combat):
    • "Can I…?" / "Could I…?" / "Am I able to…?" / "Is it possible to…?"
    • "What if I…?" / "If I were to…?" / "If I cast…?" / "Would it…?"
    • "Should I…?" / "Would that work?" / "How does X work?"
    • "How far does X reach?" / "Can I hit both of them with X?"
    • "What happens if…?" / "What would X do?"
    • Anything ending with a question mark addressed to the GM (not via sayto).

  Answer with a short in-fiction observation (e.g. "Burning Hands is a 15-ft cone — at this range it would catch both cultists. Tap CAST to commit.") and STOP. No state mutation.

  COMMITS — perform the action by calling the matching commit tool. A commit is unambiguous declaration of intent to act:
    • "I cast Burning Hands." / "I throw the dagger." / "I attack the bandit."
    • Affirmative follow-ups to a question the GM just confirmed possible: "do it", "yes", "yes do it", "go ahead", "cast it", "I want to do it", "make it happen", "fire", "yes cast", "yeah", "ok do that".

  When the previous turn was a question and the player's next message is an affirmative follow-up, COMMIT the action that was just discussed. The earlier question doesn't immunise the follow-up; "I want to do it" after "can I cast Burning Hands?" is a commit to cast Burning Hands — call cast_spell.

  When committing a spell, you MUST call cast_spell. NEVER narrate a spell going off (flames erupting, smoke billowing, targets hit or missed) without cast_spell. The engine resolves who is hit and what damage lands; you only describe the in-fiction result AFTER the tool returns its outcome. A reply that narrates spell flames without a cast_spell call is a bug: the player wastes nothing because the engine never ran, but the prose lies about what happened.

  Prefer the in-game button (CAST / ATTACK / THROW) when the player is at the keyboard — those routes are deterministic and let the player pick the exact target via the on-map preview. Commit tools through the GM are valid but a heavier-handed route.

  When in doubt between question and commit, treat as a question.

SPATIAL ACCURACY RULE: NEVER invent a spatial outcome — range, area coverage, line-of-sight, who-is-hit-by-what. The engine owns geometry; the player sees the targeting preview overlay on the map and the engine resolves who lands inside any spell area.

  • Spell range / AOE coverage advice (response to a QUESTION): paraphrase the spell's own properties from SRD knowledge — "Burning Hands is a 15-ft cone from the caster", "Sleep is a 20-ft-radius sphere", "Thunderwave is a 15-ft cube originating from the caster" — and let the player confirm against the on-map preview. Do NOT claim "the cultists stand just beyond the cone" or "the cone catches nothing but scorched earth" — you cannot read the grid the way the player can, and the engine will contradict you.
  • Spell COMMIT: call cast_spell and read the engine's result. If the result says creatures were hit, narrate the hits. If the result says "no creatures in area", narrate that no targets were caught. NEVER make up a miss; if the player positioned themselves to catch enemies, the engine will agree.
  • Consistency: if you advised "the cone catches both cultists" in a previous turn, you cannot then narrate a miss on the commit. Either the engine confirms the hit (good — narrate it) or the engine reports no creatures in area (your earlier advice was wrong — own it briefly: "the cone goes wide of the figures — they had drifted out of reach"). Don't fabricate a miss out of the air.
  • For distance / cover / movement questions, describe the in-fiction layout ("two strides away, behind the brazier") without claiming engine-decided outcomes.

NARRATIVE-MIRROR RULE: The player only sees your text reply — they never see your tool calls. Therefore every player-visible effect you enact with a tool MUST also appear in the narrative reply, in-fiction:
  • reveal_npc_name → have the NPC speak their name in dialogue ("'I'm Mira,' she answers softly.") so the player learns it. A silent reveal that only changes the label is invisible to the player and counts as a failure.
  • award_coins / adjust_player_hp / add_item / remove_item → describe the transaction or change ("She presses a small purse into your hand.").
  • set_disposition (to enemy) → describe the hostile shift ("His friendly mask drops and his hand goes to his sword.").
  • apply_condition / remove_condition → describe the in-world cause and effect ("The poison sears your veins.").
  • move_entity / despawn_npc → describe the movement or departure.
If a tool changes something the player can perceive, the reply must reflect it. Silence after a tool call is a bug.

TOOL-FIRST RULE: Every game effect you describe must be enacted via the corresponding tool before you narrate it. The game world is the source of truth — narrate ONLY what the tool result confirms.
  • Weapon throw → call throw_item (removes item from inventory, resolves attack).
  • Spell cast (player) → call cast_spell with the spell id from the player's prepared/cantrip list shown in CURRENT STATE. Routes through the engine resolver: consumes Action / Bonus Action per the spell's casting time, decrements the matching spell slot for L1+ spells, applies damage / saves / conditions. NEVER simulate a spell cast with request_attack_roll + adjust_npc_hp — it bypasses slot tracking and action economy.
  • Damage to the player or any NPC → call adjust_npc_hp (entity: "player", "enemy_A", "ally_A", or "npc_[id]"). When request_attack_roll reports a HIT or CRITICAL HIT against a creature, you MUST immediately follow up with adjust_npc_hp using the damage amount from the result — request_attack_roll does not apply damage automatically.
  • ANY creature movement on the map — the player, an ally, a neutral NPC, an enemy — must be enacted with move_entity BEFORE you narrate it. This covers walking across a bridge, stepping aside, crossing a room, fleeing a few tiles, climbing onto something, repositioning to safety, going to investigate something, taking cover, joining the player, peeling off — anything that changes a token's tile. The player can see the token; narrating "she crosses the bridge" without calling move_entity leaves a token frozen mid-scene and breaks immersion immediately. If the destination is off the current map (an NPC leaves the encounter entirely), use despawn_npc instead. If no tool can place them where the fiction requires, change the fiction — don't lie about the token.
  • Coins gained or spent → call award_coins with whichever of pp/gp/ep/sp/cp apply (negative amounts spend). The SRD coin denominations: 1 PP = 10 GP, 1 GP = 100 CP, 1 SP = 10 CP, 1 EP = 50 CP. Never narrate a coin transaction without the tool confirming it.
  • Item gained or lost → call add_item or remove_item.
  • Condition applied or removed → call apply_condition or remove_condition.
  • Creature disposition change → call set_disposition. If you change any NPC to "enemy" disposition while the phase is "exploring", you MUST call trigger_combat immediately after all disposition changes are complete — set_disposition does not start combat on its own.
  • Creature attitude change (social) → call set_attitude. Attitude (friendly / indifferent / hostile) is the SOCIAL axis — it reflects how the NPC feels about the party and affects Influence-check Advantage/Disadvantage. **Attitude is distinct from disposition**: a hostile-attitude shopkeeper can still be neutral-disposition (won't draw a blade but resists persuasion); a successful Persuasion shifts attitude, not disposition. Call set_attitude after a successful Persuasion / Deception / Intimidation / Performance / Animal Handling check shifts the NPC's feelings, or after a botched social interaction sours them. Never use set_attitude as a shortcut to start combat — use set_disposition + trigger_combat for that.
  • Stealth change → call set_player_hidden.
  • Anything noteworthy during combat → call add_log_entry so it appears in the event log.
  • NPC departure, fleeing, or leaving the scene → call despawn_npc to remove them from the map, or move_entity to reposition them. Never narrate an NPC as gone unless the tool confirms it.
  • NPC (or the player) speaks aloud → call npc_speaks with the entity ref AND the exact quoted text for EVERY quoted line of dialogue you write. The tool spawns a speech bubble above the speaker AND writes "<speaker>: <quote>" to the Event Log; skipping it leaves the speech invisible in both surfaces. Use a separate call per speaker if multiple characters speak in one reply. Quoted dialogue in prose without a matching npc_speaks call is a bug.
  • NPC says their name → call reveal_npc_name with the entity ref from CURRENT STATE BEFORE writing any dialogue that contains the name. Skipping the tool leaves the game world unaware of the name regardless of what you narrate.
  • Player tells an ally to stay back, not fight, or stand down → call set_npc_passive (passive: true). Call set_npc_passive (passive: false) if the player later asks the ally to fight. A passive ally skips their combat turn automatically — do not narrate them acting or attacking.
If you cannot enact an effect with the available tools, do not narrate it as happening.

ACTION ECONOMY: During the player's turn, each character has one Action and one Bonus Action per round. Action-consuming activities: attack, throw_item, dash, dodge, disengage, cast a spell, study, influence, utilize, hide (default — see exception below). Bonus-action-consuming activities: second wind, drink potion (in combat), hide IF the character is a Rogue of level 2+ (Cunning Action). A Level 1 Rogue's Hide still costs the Action. Server enforces these strictly.

CURRENT STATE shows the player's action economy as literal fields: "Action: AVAILABLE" or "Action: USED", "Bonus: AVAILABLE" or "Bonus: USED", and "N moves left". These fields are AUTHORITATIVE for the current turn — they reset every time a new player turn begins (you will see a line like "── Aldric's turn — Action & Bonus refreshed ──" in RECENT EVENT LOG marking each transition). Do not infer from conversation history that the player has already acted this turn; only the current flags matter. If "Action: AVAILABLE" is shown, the action IS available — do not refuse it.

NO MECHANICAL TEXT IN STORY MODE: The action-economy flags are a private cue for YOU to know what to allow, not something to recite to the player. The UI's Player Panel already shows action/bonus/movement state. NEVER write phrases like "Your action is spent", "Your Action is used this turn", "You still have your Bonus Action available", "You have N moves left", "Your action economy is depleted", "You can use Second Wind, or you can end your turn", "feel free to move or end your turn" — or any equivalent that names a resource, button, or rules concept. Likewise never coach the player on what they CAN do mechanically next. Mechanical guidance lives in the Player Panel; your prose carries story only.

After a successful action: narrate the in-fiction outcome and stop. Do not add a coda telling the player what they spent or have left.

When the player REQUESTS something the current flags forbid: refuse IN-FICTION without naming the resource, the rule, or the button. The player reads the panel for numbers; they read story from you. Examples (the desired flavour — not a script):
  • Player asks to attack again while Action is USED: *"Your sword won't be back in line until you draw another breath — you've already committed to your swing this round."*
  • Player asks for Second Wind while Bonus is USED: *"You've already pulled what reserves you can muster this moment — there's nothing more left to call on until the fight turns."*
  • Player asks to move further with 0 moves left: *"Your feet are planted; you've pressed as far as this exchange allows."*

If a tool you call returns an "already spent" or "not performed" message, relay it the same way — translate to in-world cause and effect, never repeat the mechanical terminology.

TURN ORDER: When PHASE is "player_turn", the player acts first — do NOT narrate or simulate enemy turns. Never say "It is now [enemy]'s turn" or describe enemies attacking or moving on their own turns. The combat engine resolves enemy AI automatically when the player ends their turn. You may describe enemies reacting to the player's action (flinching, snarling, drawing a weapon), but stop there.

SEARCHING CORPSES: Three resolution paths exist; pick the one that matches CURRENT STATE.
  (1) If the corpse is tagged "[SEARCHED — do NOT roll a second Perception check on this body]" in the CORPSES section, the deterministic SEARCH action has already resolved it. DO NOT call request_ability_check on this body. The Event Log already contains the find/no-find line; narrate based on that outcome — do not roll a second check.
  (2) If the corpse is tagged "[UNSEARCHED — authored loot at Perception DC X]", an authored corpseSearch payload is waiting. Either invite the player to press SEARCH (preferred — keeps mechanics consistent) or call request_ability_check yourself with the same DC X; both routes are mechanically equivalent.
  (3) If the corpse carries no tag (no authored payload), follow the legacy rule: call request_ability_check (skill: "perception", DC 10 for a straightforward search, DC 15 if items are concealed) before narrating what is found.
Use "investigation" only for tasks that require deduction or study — clues, written documents, traps, hidden mechanisms — not for rifling through pockets. On a success, describe what the player finds and use add_item or award_coins to deliver any rewards. On a failure, narrate that the player finds nothing of note — they may try again or look elsewhere.

EVENT LOG: The RECENT EVENT LOG in CURRENT STATE is the complete log for this encounter. If the player asks to "see", "read", or "show" the event log, direct them to the Event Log panel in their UI — it has better formatting than anything you can narrate.

CHAPTER COMPLETION: When CURRENT STATE shows a CHAPTER COMPLETION FLAG line, the encounter belongs to an adventure chapter. The moment the chapter's core business resolves in the fiction (the parley succeeds, the artifact is recovered, the sage has given counsel — see the encounter CONTEXT for what counts), you MUST call set_world_flag with that flag name set to true. Do it as part of the same turn that delivers the resolution — do not wait for the player to ask, do not defer to the next message. Story can continue after the flag is set; the flag only signals that the chapter has reached its meaningful conclusion. Skipping it leaves the player stuck on a finished chapter.

WORLD GROUNDING: Only reference creatures, items, and events that exist in CURRENT STATE or have been established in this conversation. Never invent NPCs, companions, or off-screen events that are not reflected in the game state. If no creature fled or was despawned, no creature fled. Do not assert specific physical details about creatures (embedded weapons, wounds, clothing) that are not tracked in CURRENT STATE — the game state tracks HP and conditions only; everything else is unknown.

STATE IS AUTHORITATIVE: CURRENT STATE is always the ground truth. If it appears to conflict with something in the conversation history, trust the current state and narrate the present moment from it — do not verbalise the inconsistency, name the CURRENT STATE block, question what happened, or attempt to reset the narrative. Never say "I need to pause", "this is inconsistent", "let me reset", or any equivalent. If the phase is "exploring" and no enemies are alive, the encounter is over — narrate that reality and respond to the player's action.

SPATIAL GROUNDING: The player's PLAYER tile and every NPC's tile in CURRENT STATE are authoritative for where each token physically stands RIGHT NOW. The encounter's opening introduction described where things STARTED — players move, and after the first turn the introduction is past tense. Before describing the player's surroundings, posture, or proximity to anything (a doorway, a table, an NPC, a piece of cover), check the player's current tile. If the player has moved out of the room the encounter opened in, they are no longer in that room — narrate from their current location, not where they were when the encounter started. The same applies to NPCs: if an NPC's tile is on the path outside the cottage, do not describe them as standing in the cottage doorway. When the player addresses an NPC who is not adjacent, describe the distance in the narration rather than collapsing the geography.

PLAYER AGENCY: The player has the right to take any action that is mechanically possible, including attacking neutral NPCs or doing things that are morally questionable in-world. You may warn the player once about likely consequences (guards arriving, reputational cost, etc.), but if they confirm or persist, enact the action immediately using the appropriate tools — do NOT refuse, repeat the warning, or add further resistance. Never use phrases like "Are you sure?", "I'd advise against…", or "Perhaps reconsider…" more than once per declared intention.

PROHIBITED — reject these and suggest a realistic in-world alternative instead:
  • add_item or spawn_enemy simply because the player requests an item or creature (they must exist in the world).
  • Any action requiring magic the player does not possess, teleportation, or instantaneous creation from nothing.

When the player attempts anything tied to a skill — Performance, Persuasion, Deception, Athletics, Stealth, Investigation, etc. — call request_ability_check. The roll determines quality and narrative colour, not just success or failure; even an action that cannot catastrophically fail still benefits from a die (a low Performance roll is an awkward tune, a high one is moving). Only skip the check for purely declarative statements ("I walk north") that involve no skill and no uncertainty.
After receiving a SUCCESS from request_ability_check, if the outcome causes a creature to surrender, flee, or change behavior, you MUST call the appropriate tools to enact that outcome (set_disposition, despawn_npc, move_entity) before narrating it — exactly as the TOOL-FIRST RULE requires. A success result alone does not change the game state.`;
}

/** SRD stat-block flavour (skills / languages / gear) for a combatant line —
 *  AIGM-facing only: lets the GM roll authentic monster checks and narrate
 *  gear. Empty string when the def carries none of the three. */
export function monsterStatBlockBits(def: Pick<MonsterDef, 'skills' | 'languages' | 'gear'>): string {
  return [
    def.skills ? `Skills: ${Object.entries(def.skills).map(([k, v]) => `${k} +${v}`).join(', ')}` : '',
    def.languages?.length ? `Languages: ${def.languages.join(', ')}` : '',
    def.gear?.length ? `Gear: ${def.gear.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
}

/** Stat-block Spellcasting summary with LIVE remaining uses (US-117) — e.g.
 *  `Spells DC 14: fireball(1/2)@L4, invisibility(2/2) · Misty Step(3/3) ·
 *  Protective Magic(2/3) · At will: light, mage-hand`. The engine resolves
 *  these casts itself; the GM narrates them and must respect the counts.
 *  Empty string for non-casters. */
export function monsterSpellsLine(
  def: Pick<MonsterDef, 'spellcasting' | 'reactions'>,
  npc: Pick<NpcState, 'spellUses' | 'reactionUses'>,
): string {
  const sc = def.spellcasting;
  if (!sc) return '';
  const fmt = (spellId: string, max: number, castLevel?: number) =>
    `${spellId}(${npc.spellUses?.[spellId] ?? max}/${max})${castLevel ? `@L${castLevel}` : ''}`;
  const perDay = (sc.perDay ?? []).map((e) => fmt(e.spellId, e.uses, e.castLevel)).join(', ');
  const bonus = (sc.bonusAction ?? []).map((e) => `${fmt(e.spellId, e.uses)} (bonus action)`).join(', ');
  const protective = (def.reactions ?? []).find((r) => r.kind === 'protective-magic');
  const reaction = protective
    ? `Protective Magic(${npc.reactionUses?.['protective-magic'] ?? protective.usesPerDay}/${protective.usesPerDay})`
    : '';
  const atWill = sc.atWill?.length ? `At will: ${sc.atWill.join(', ')}` : '';
  return [`Spells DC ${sc.saveDC}: ${perDay}`, bonus, reaction, atWill].filter(Boolean).join(' · ');
}

function buildStateMessage(engine: GameEngine): string {
  const s = engine.getState();
  const p = s.player;

  // Explicit AVAILABLE/USED rather than absence-implies-available — the model
  // hallucinates "you already acted" otherwise, pattern-matching on conversation
  // history. Showing the resource state as a literal field removes ambiguity.
  const slotsLine = p.spellSlots.length > 0
    ? p.spellSlots.map((n, i) => n > 0 ? `L${i + 1}:${n}` : '').filter(Boolean).join(',')
    : '';
  const flags = [
    p.conditions.includes('hidden') ? 'HIDDEN' : '',
    s.phase === 'player_turn' ? `Action: ${p.actionUsed ? 'USED' : 'AVAILABLE'}` : '',
    s.phase === 'player_turn' ? `Bonus: ${p.bonusActionUsed ? 'USED' : 'AVAILABLE'}` : '',
    s.phase === 'player_turn' ? `${p.movesLeft} moves left` : '',
    ...Object.entries(p.resources)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${id} ×${n}`),
    slotsLine ? `Slots ${slotsLine}` : '',
    p.concentratingOn ? `Concentrating: ${p.concentratingOn}` : '',
    // Once-per-turn / once-per-rest gates — surface so the GM doesn't
    // narrate (or invite) a feature that the engine has already locked.
    s.phase === 'player_turn' && p.sneakAttackUsedThisTurn ? 'SneakAttack: USED THIS TURN' : '',
    p.arcaneRecoveryUsed ? 'ArcaneRecovery: USED' : '',
  ].filter(Boolean).join(' · ');

  // Class / subclass / scaling tracks. `playerDef.className` and
  // `subclassId` are always present; `tracks` is the resolved per-level
  // scaling map (Sneak Attack dice, Extra Attacks, Weapon Mastery count,
  // …) — surfaced as a one-line `id=value` list so the GM knows the
  // character's mechanical posture without having to infer from level.
  const playerDef = engine.getPlayerDef();
  const trackEntries = Object.entries(playerDef.tracks ?? {})
    .filter(([, v]) => (typeof v === 'number' ? v > 0 : !!v));
  const classLine = [
    `Class: ${playerDef.className} L${playerDef.level}`,
    playerDef.subclassId ? `Subclass: ${playerDef.subclassId}` : '',
    trackEntries.length > 0 ? `Tracks: ${trackEntries.map(([k, v]) => `${k}=${v}`).join(', ')}` : '',
    playerDef.languages && playerDef.languages.length > 0 ? `Languages: ${playerDef.languages.join(', ')}` : '',
  ].filter(Boolean).join(' · ');

  // Warlock Pact Magic + Mystic Arcanum (absent for non-Warlocks).
  const pactLine = p.pactMagic
    ? `Pact Magic: ${p.pactMagic.remaining}/${p.pactMagic.max} @ L${p.pactMagic.level}`
    : '';
  const arcanumLine = p.mysticArcanum && Object.keys(p.mysticArcanum).length > 0
    ? `Mystic Arcanum: ${Object.entries(p.mysticArcanum).map(([lvl, slot]) => `L${lvl}=${slot.spellId}${slot.used ? ' [used]' : ''}`).join(', ')}`
    : '';

  const partyView = { id: PLAYER_ID, factionId: PLAYER_FACTION_ID } as const;
  const isHostileNpc = (n: NpcState) =>
    isHostileTo(s, partyView, { id: n.id, factionId: n.factionId });
  const isFriendlyNpc = (n: NpcState) =>
    isFriendlyTo(s, partyView, { id: n.id, factionId: n.factionId });
  const entityRefFor = (n: NpcState): string => {
    if (isHostileNpc(n) && n.combatLabel) return `enemy_${n.combatLabel}`;
    if (isFriendlyNpc(n) && n.combatLabel) return `ally_${n.combatLabel}`;
    return `npc_${n.id}`;
  };

  const focusLine = s.selectedTargetId
    ? (() => {
        const npc = s.npcs.find((n) => n.id === s.selectedTargetId);
        if (npc) {
          return `Focused on: ${npc.defId} [${entityRefFor(npc)}] (${npc.disposition})`;
        }
        return 'Focused on: nothing';
      })()
    : 'Focused on: nothing';

  // Hidden NPCs (engine Vision system — `set_npc_hidden` trigger action,
  // cleared by passive Perception sweep on movement) are filtered out of
  // the combatant + neutral lists shown to the AIGM. The player can't see
  // them yet, so the GM shouldn't narrate them either; encounter authors
  // who want the GM to allude to their presence carry that context in the
  // encounter's `customContext` instead.
  const livingCombatants = s.npcs.filter((n) => n.hp > 0 && !n.conditions.includes('hidden') && (isHostileNpc(n) || isFriendlyNpc(n)));
  const combatantLines = livingCombatants.length > 0
    ? livingCombatants.map((n) => {
        const entityRef = entityRefFor(n);
        const hostile = isHostileNpc(n);
        const knownAs = n.revealedName ? ` (known as: ${n.revealedName})` : !hostile ? ' [NAME UNKNOWN — call reveal_npc_name if they give their name]' : '';
        const cFlags = [
          n.isActive ? 'ACTIVE TURN' : '',
          n.combatPassive ? 'PASSIVE (skips combat turn)' : '',
          n.conditions.includes('vexed') ? 'VEXED' : '',
          n.conditions.includes('hidden') ? 'HIDDEN' : '',
          isBloodied(n.hp, n.maxHp) ? 'BLOODIED' : '',
          // Reactions refresh at the start of each creature's own turn. USED
          // means this creature has spent its Reaction (e.g. an Opportunity
          // Attack against the player or another NPC) and cannot take another
          // until its next turn comes around.
          s.phase !== 'exploring' ? `Reaction: ${n.reactionUsed ? 'USED' : 'AVAILABLE'}` : '',
        ].filter(Boolean).join(', ');
        const def = engine.getMonsterDef(n.defId);
        const attackStr = def?.attacks.map(a =>
          `${a.name} (${a.attackType}, +${a.bonus} to hit, ${a.damageDice}d${a.damageSides}+${a.damageBonus} ${a.damageType})`
        ).join('; ') ?? 'unknown';
        const statBlockBits = def ? monsterStatBlockBits(def) : '';
        const spellsLine = def ? monsterSpellsLine(def, n) : '';
        return `  [${entityRef}] ${n.defId}${knownAs} (${n.disposition} disp · ${n.attitude ?? 'indifferent'} att): ${n.hp}/${n.maxHp} HP, tile (${n.tileX},${n.tileY})${cFlags ? ` [${cFlags}]` : ''}\n    Attacks: ${attackStr}${statBlockBits ? `\n    ${statBlockBits}` : ''}${spellsLine ? `\n    ${spellsLine}` : ''}`;
      }).join('\n')
    : '  None';

  const livingNeutrals = s.npcs.filter((n) => n.hp > 0 && !n.conditions.includes('hidden') && !isHostileNpc(n) && !isFriendlyNpc(n));
  const neutralNpcLines = livingNeutrals.length > 0
    ? livingNeutrals.map((n) => {
        const knownAs = n.revealedName ? ` (known as: ${n.revealedName})` : '';
        return `  ${n.defId} [npc_${n.id}] (${n.attitude ?? 'indifferent'} att) at tile (${n.tileX},${n.tileY})${knownAs}`;
      }).join('\n')
    : '  None';

  const corpses = s.npcs.filter((n) => isDead(n));
  const corpseLines = corpses.length > 0
    ? corpses.map((n) => {
        // `[SEARCHED]` means the engine has already resolved the corpse via
        // the SEARCH action — the GM must NOT call request_ability_check
        // again on this body. `[UNSEARCHED — authored loot DC X]` flags an
        // unresolved authored corpseSearch payload — the GM may either let
        // the player drive it with the SEARCH button or call
        // request_ability_check itself (the result is mechanically
        // equivalent since both roll against the same DC).
        const tag = n.corpseSearched
          ? ' [SEARCHED — do NOT roll a second Perception check on this body]'
          : n.corpseSearch
            ? ` [UNSEARCHED — authored loot at Perception DC ${n.corpseSearch.dc}]`
            : '';
        return `  ${n.name} at tile (${n.tileX},${n.tileY})${tag}`;
      }).join('\n')
    : '  None';

  const itemLines = s.mapItems.length > 0
    ? s.mapItems.map((i) => `  ${i.defId} at tile (${i.tileX},${i.tileY})`).join('\n')
    : '  None on the ground';

  const personaLines = s.npcPersonas.length > 0
    ? s.npcPersonas.map((n) => `  ${n.name}: ${n.persona}`).join('\n\n')
    : '  None';

  const recentLog = s.eventLog.map((e) => e.right ? `${e.left}  [${e.right}]` : e.left).join('\n  ') || 'No entries yet.';

  const itemIds = engine.getItemIds().join(', ');
  const monsterIds = engine.getMonsterIds().join(', ');

  // Scripted events authored on the encounter (via TriggerSystem's
  // `send_aigm_message` action). Surfaced here so Claude can weave them into
  // the next reply. The server clears `pendingAigmEvents` once the API call
  // returns successfully.
  const scriptedEvents = s.pendingAigmEvents.length > 0
    ? `\nSCRIPTED EVENTS (incorporate into your next reply, then they are cleared):\n${s.pendingAigmEvents.map((m) => `  • ${m}`).join('\n')}\n`
    : '';

  // Faction standings + rumors — long-term world memory. Helps the GM remember
  // who likes the player and what the world has heard about.
  const factionLines = Object.entries(s.factionStandings).filter(([, v]) => v !== 0);
  const factionsBlock = factionLines.length > 0
    ? `\nFACTION STANDINGS (player's reputation, −100..+100):\n${factionLines.map(([id, v]) => `  ${id}: ${v >= 0 ? '+' : ''}${v}`).join('\n')}\n`
    : '';
  const rumorsBlock = s.rumors.length > 0
    ? `\nRUMORS (world memory, newest first — reference when narratively apt):\n${[...s.rumors].sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 8).map((r) => `  • [${r.id}] (sal ${r.salience}) ${r.text}`).join('\n')}\n`
    : '';

  // World clock — surfaces the off-camera tick counter + current day phase
  // from the NPC sim layer (US-094). Helps the GM let time-of-day inflect
  // descriptions (morning crowd, late-evening hush) without having to
  // calculate it from the event log.
  const worldClockBlock = `\nWORLD: tick=${s.worldTickCount ?? 0}, dayPhase=${s.dayPhase ?? 'morning'}\n`;

  // NPC alertness — any living NPC currently above `calm`. The GM should
  // explain visible motion / pauses / changes in posture by referencing
  // these states (e.g. an NPC walking across the map is probably heading
  // toward a `lastAlertTile`).
  const alertedNpcs = s.npcs.filter((n) => n.hp > 0 && (n.alertness ?? 'calm') !== 'calm');
  const alertnessBlock = alertedNpcs.length > 0
    ? `\nNPC ALERTNESS (sim-layer awareness, hidden from the player UI unless the Target Panel is open):\n${alertedNpcs.map((n) => {
        const t = n.memory?.lastAlertTile;
        const where = t ? `from (${t.x},${t.y})` : '';
        const kind = n.memory?.lastAlertKind ?? '?';
        return `  • ${n.revealedName ?? n.name} [npc_${n.id}] — ${n.alertness} · heard ${kind} ${where}`.replace(/\s+$/, '');
      }).join('\n')}\n`
    : '';

  // Adventure framing — when this session is a chapter of an adventure,
  // surface the chapter index and short summaries of prior chapters so the
  // GM can reference earlier scenes ("word of what you did at the bridge
  // has travelled ahead of you").
  const adventureBlock = s.adventureContext
    ? `\nADVENTURE: ${s.adventureContext.adventureTitle} — ${s.adventureContext.chapterTitle} (chapter ${s.adventureContext.chapterIndex + 1} of ${s.adventureContext.totalChapters})${s.adventureContext.completionFlag ? `\nCHAPTER COMPLETION FLAG: "${s.adventureContext.completionFlag}" — call set_world_flag with this name set to true at the moment the chapter's core business is resolved (see encounter CONTEXT for the resolution criteria). Combat encounters auto-complete on enemy defeat; non-combat chapters depend on this flag.${s.encounterComplete ? ' [ALREADY SET — do not call again.]' : ''}` : ''}${s.adventureContext.priorChapterSummaries.length > 0 ? `\nPRIOR CHAPTERS:\n${s.adventureContext.priorChapterSummaries.map((c) => `  • ${c.chapterTitle}: ${c.summary}`).join('\n')}` : ''}\n`
    : '';

  // ACTIVE QUESTS — gives the GM the quest_id + step_id vocabulary so it can call
  // advance_quest / complete_quest / fail_quest with valid ids. The current step
  // is marked with a `*`. Completed/failed quests are omitted.
  const activeQuests = s.quests.filter((q) => q.status === 'active');
  const questsBlock = activeQuests.length > 0
    ? '\nACTIVE QUESTS (advance/complete/fail by quest_id as the fiction resolves them):\n' + activeQuests.map((q) => {
        const def = s.runtimeQuestDefs.find((d) => d.id === q.questId) ?? engine.getQuestDef(q.questId);
        if (!def) return `  • [id ${q.questId}] (definition missing)`;
        const cur = def.steps.find((st) => st.id === q.currentStepId);
        const stepList = def.steps.map((st) => `${st.id}${st.id === q.currentStepId ? '*' : ''}`).join(', ');
        return `  • ${def.title} [id ${q.questId}] — current step ${cur ? `${cur.id} "${cur.text}"` : '—'} (steps: ${stepList})`;
      }).join('\n') + '\n'
    : '';

  return `SETTING: ${s.mapName} | PHASE: ${s.phase}
CONTEXT: ${s.encounterContext}${adventureBlock}${questsBlock}${scriptedEvents}${factionsBlock}${rumorsBlock}${worldClockBlock}${alertnessBlock}

PLAYER: tile (${p.tileX},${p.tileY}) · HP ${p.hp}/${playerDef.maxHp}${isBloodied(p.hp, playerDef.maxHp) ? ' (BLOODIED)' : ''} · ${formatCoins(p.balanceCp)} · ${flags || 'no flags'}
  ${classLine}
  ${pactLine}
  ${arcanumLine}
  Inventory: ${p.inventoryIds.join(', ') || 'empty'}
  Equipped: armor=${p.equippedSlots.armorId ?? 'none'} weapon=${p.equippedSlots.weaponId ?? 'none'} shield=${p.equippedSlots.shieldId ?? 'none'}
  ${p.preparedSpellIds.length > 0 ? `Prepared spells: ${p.preparedSpellIds.join(', ')}` : ''}
  ${focusLine}

COMBATANTS (enemies & allies):
${combatantLines}

NEUTRAL NPCs:
${neutralNpcLines}

CORPSES (dead — on the map, can be searched but cannot act):
${corpseLines}

ITEMS ON THE GROUND:
${itemLines}
  Secrets remaining: ${s.secrets.length}

NPC PERSONAS:
${personaLines}

REFERENCE DATA (valid IDs for add_item / spawn_enemy):
  ITEMS: ${itemIds}
  MONSTERS: ${monsterIds}

RECENT EVENT LOG:
  ${recentLog}`;
}

export async function processAIGMChat(
  engine: GameEngine,
  body: AIGMChatRequest,
  anthropic: Anthropic,
  history: AigmMessage[],
  archive?: AigmMessage[],   // full unsummarized history; consumed by D (memory tool)
  streamCallbacks?: AIGMStreamCallbacks,
): Promise<{ reply: string; events: GameEvent[]; rollResults: string[] }> {
  const s = engine.getState();

  // Seed history with introduction on the first exchange so Claude has narrative context.
  // Anthropic requires conversations to start with a user message, so pair it with a prompt.
  if (history.length === 0 && s.introduction) {
    history.push({ role: 'user', content: 'Begin the encounter.' });
    history.push({ role: 'assistant', content: s.introduction });
  }

  // Reset per-turn guards (e.g. award_xp / complete_quest double-credit detection).
  resetTurnGuards();

  // D. Bound the working history. If it exceeds the threshold, summarize the
  // oldest pairs into a single [SUMMARY] assistant turn. The archive remains
  // intact for the recall_memory tool to search.
  await maybeSummarizeHistory(history, anthropic);

  const stateMessage = buildStateMessage(engine);
  const currentUserContent = `[CURRENT STATE]\n${stateMessage}\n\n[PLAYER]\n${body.playerMessage}`;

  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [
    ...history.map((m) => {
      if (m.role !== 'user') return { role: m.role, content: m.content };
      const match = /\[PLAYER\]\n([\s\S]+)$/.exec(m.content);
      return { role: 'user' as const, content: match ? match[1].trim() : m.content };
    }),
    { role: 'user' as const, content: currentUserContent },
  ];

  // Send the system prompt as a content-block array with a cache_control marker
  // so Anthropic's prompt cache (5-minute TTL) covers the static instructions and
  // tool list across turns. The dynamic CURRENT STATE block lives in the user
  // message and is not cached.
  const system = [
    {
      type: 'text' as const,
      text: buildStaticPrompt(body.gmPersona ?? 'story'),
      cache_control: { type: 'ephemeral' as const },
    },
  ];
  const rawTools = engine.getAIGMTools();
  // Mark the last tool's input_schema with cache_control so the entire tools
  // block is treated as cacheable prefix material.
  const tools = rawTools.map((t, i) =>
    i === rawTools.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t,
  );
  const allEvents: GameEvent[] = [];
  const rollResults: string[] = [];
  let narrativeText = '';

  const model = body.gmPersona === 'dev' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';

  // Tools whose result is unknown until the server rolls — text written alongside
  // these is speculative and must not be shown to the player.
  const SPECULATIVE_TOOLS = new Set([
    'request_attack_roll', 'request_ability_check', 'request_saving_throw',
  ]);

  // A. Cap loop iterations so a degenerate tool chain can't run away.
  const MAX_TOOL_ITERATIONS = 8;

  // E. Streaming: track whether the currently-streaming response's chunks are
  // speculative (i.e. accompany a roll-tool). Chunks are forwarded eagerly to
  // the client; we only learn it was speculative when the response completes.
  // If so, we tell the client to discard them via onSpeculativeDiscard.
  let currentResponseEmittedChunks = false;
  const onChunkForward = streamCallbacks?.onChunk
    ? (text: string) => {
        currentResponseEmittedChunks = true;
        streamCallbacks.onChunk!(text);
      }
    : undefined;

  let response = await callClaudeWithRetry(anthropic, { model, max_tokens: 600, system, tools, messages }, onChunkForward);
  let iteration = 0;

  while (true) {
    // Capture any narrative text from this response. Skip the text only if this
    // response also calls a roll-requesting tool — in that case the text is a
    // guess written before the roll result is known.
    const hasSpeculativeTool = response.content.some(
      (b) => b.type === 'tool_use' && SPECULATIVE_TOOLS.has(b.name),
    );
    if (!hasSpeculativeTool) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          if (narrativeText && !narrativeText.endsWith('\n')) narrativeText += '\n';
          narrativeText += block.text;
        }
      }
      // Tell the client: these chunks are canonical — advance the discard baseline.
      if (currentResponseEmittedChunks) streamCallbacks?.onCheckpoint?.();
    } else if (currentResponseEmittedChunks) {
      // Roll back the speculative chunks on the client.
      streamCallbacks?.onSpeculativeDiscard?.();
    }
    currentResponseEmittedChunks = false;

    if (response.stop_reason !== 'tool_use') break;

    iteration++;
    const overBudget = iteration >= MAX_TOOL_ITERATIONS;
    Logger.log('aigm.loop_iteration', { iteration, overBudget, maxIterations: MAX_TOOL_ITERATIONS });
    if (overBudget) Logger.warn('anomaly.aigm_budget_exhausted', { iteration, maxIterations: MAX_TOOL_ITERATIONS });

    const toolResults: { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: { type: 'ephemeral' } }[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        let content: string;
        let rollResult: string | undefined;
        if (overBudget) {
          // A. On the last allowed iteration, override every tool with a budget-exhausted
          // signal. This forces the model to finalize its reply instead of looping further.
          content = 'TOOL BUDGET EXHAUSTED. Do not call any more tools this turn. Write the final narrative reply to the player now, summarising the actions you have already taken.';
        } else {
          const toolCtx: AIGMToolContext = { archive };
          const result = applyAIGMTool(engine, block.name, block.input as Record<string, unknown>, toolCtx);
          allEvents.push(...result.events);
          content = result.toolResultContent;
          rollResult = result.rollResult;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
        if (rollResult) rollResults.push(rollResult);
      }
    }

    // N. Cache breakpoint on the most-recent tool_result block. The previous
    // assistant turn + this tool_result become the new cacheable prefix on the
    // next iteration, so a long tool chain doesn't re-pay all preceding tokens.
    //
    // Anthropic caps cache_control markers at 4 per request (system + tools +
    // recent tool_result + …). To stay under the limit on long tool chains we
    // strip cache_control from *every previously-set* tool_result before
    // marking the current one — only the freshest breakpoint matters; the
    // older ones have already done their job for cache lookup and just bloat
    // the marker count on subsequent iterations.
    for (const m of messages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const block of m.content as Array<{ type?: string; cache_control?: unknown }>) {
        if (block && block.type === 'tool_result' && 'cache_control' in block) {
          delete block.cache_control;
        }
      }
    }
    if (toolResults.length > 0) {
      toolResults[toolResults.length - 1].cache_control = { type: 'ephemeral' };
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    // C. Rebuild CURRENT STATE on the most-recent user message (the original
    // turn user message) — the model should reason from fresh state each loop.
    refreshStateInMessages(messages, engine, body.playerMessage);

    if (overBudget) {
      // Force the model to stop calling tools by removing the tool definitions
      // for the final response. We still need to issue a request so the model
      // can produce its closing narrative.
      response = await callClaudeWithRetry(anthropic, { model, max_tokens: 600, system, tools: [], messages }, onChunkForward);
      // One more pass through the loop to capture text, then break.
      const finalText = response.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text).join('');
      if (finalText) {
        if (narrativeText && !narrativeText.endsWith('\n')) narrativeText += '\n';
        narrativeText += finalText;
      }
      if (!narrativeText.trim()) {
        narrativeText = '(The Game Master pauses, gathering their thoughts.)';
      }
      break;
    }

    response = await callClaudeWithRetry(anthropic, { model, max_tokens: 600, system, tools, messages }, onChunkForward);
  }

  // Scripted events were folded into this reply — clear them so they aren't
  // re-injected on the next turn.
  engine.getState().pendingAigmEvents.length = 0;

  // Persist the exchange into server-side history (clean user/assistant pairs only).
  history.push({ role: 'user', content: currentUserContent });
  history.push({ role: 'assistant', content: narrativeText.trim() });

  // D. Append to the archive too — the archive is what recall_memory searches.
  if (archive) {
    archive.push({ role: 'user', content: currentUserContent });
    archive.push({ role: 'assistant', content: narrativeText.trim() });
  }

  return { reply: narrativeText.trim(), events: allEvents, rollResults };
}

/**
 * Rebuilds the [CURRENT STATE] block on the last user message that contains
 * a fresh CURRENT STATE marker (the original turn message — tool_result
 * messages are arrays and skipped). Called between tool-loop iterations.
 */
function refreshStateInMessages(
  messages: { role: 'user' | 'assistant'; content: unknown }[],
  engine: GameEngine,
  playerMessage: string,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    if (!m.content.startsWith('[CURRENT STATE]')) continue;
    m.content = `[CURRENT STATE]\n${buildStateMessage(engine)}\n\n[PLAYER]\n${playerMessage}`;
    return;
  }
}

/**
 * I. Retry transient Anthropic errors (network failures, 429, 5xx) once with
 * a short backoff. Non-transient errors (400 schema mismatches, auth) are
 * re-thrown immediately.
 */
/**
 * D. Sliding-window history summarization.
 *
 * Keeps the working `history` array bounded. When it grows past
 * HISTORY_WINDOW_THRESHOLD messages, summarizes the oldest SUMMARIZE_BATCH
 * messages into a single [SUMMARY] assistant turn via Haiku and replaces
 * them in place. The first entry is preserved if it's the seeded
 * "Begin the encounter." / introduction pair so opening context is kept.
 *
 * The full archive (`aigmArchive` in sessions.ts) is untouched and remains
 * searchable via the recall_memory tool.
 */
const HISTORY_WINDOW_THRESHOLD = 40;   // total messages (user + assistant)
const HISTORY_TRIM_TARGET      = 20;   // keep this many recent messages after summarizing
const SUMMARY_PREFIX           = '[SUMMARY OF EARLIER TURNS]';

async function maybeSummarizeHistory(history: AigmMessage[], anthropic: Anthropic): Promise<void> {
  if (history.length <= HISTORY_WINDOW_THRESHOLD) return;

  // Determine the slice to summarize. Always keep the last HISTORY_TRIM_TARGET messages
  // verbatim; collapse everything before into a single summary.
  const tailStart = history.length - HISTORY_TRIM_TARGET;
  const toSummarize = history.slice(0, tailStart);
  if (toSummarize.length === 0) return;

  // If the head is already a summary, fold it in; otherwise summarize from scratch.
  const transcript = toSummarize.map((m) => {
    let content = m.content;
    // Strip CURRENT STATE blocks from prior user messages — they are stale snapshots.
    const stripped = /\[PLAYER\]\n([\s\S]+)$/.exec(content);
    if (stripped) content = stripped[1].trim();
    return `${m.role === 'user' ? 'PLAYER' : 'GM'}: ${content}`;
  }).join('\n\n');

  let summaryText: string;
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: `You summarize a section of a D&D encounter transcript into a compact recap. Preserve: NPC names revealed, quest hooks, promises made or broken, items gained or lost, important player choices, current relationships and dispositions, and any unresolved threads. Drop: tactical combat detail (specific HP numbers, individual dice rolls, mechanical minutiae). Write 4-8 dense bullet points in past tense. No preamble — output bullets only.`,
      messages: [{ role: 'user', content: `Summarize the following encounter transcript:\n\n${transcript}` }],
    });
    const block = res.content.find((b) => b.type === 'text');
    summaryText = block && block.type === 'text' ? block.text.trim() : '';
  } catch {
    // If summarization fails, fall back to a trivial heuristic so the loop still bounds.
    summaryText = `Encounter so far covered ${Math.floor(toSummarize.length / 2)} earlier exchanges. Detail is preserved in the recall_memory archive.`;
  }
  if (!summaryText) {
    summaryText = `Earlier exchanges (${Math.floor(toSummarize.length / 2)}) are preserved in the recall_memory archive.`;
  }

  // Anthropic API requires conversation to start with a user message. The summary
  // is delivered as an assistant message preceded by a synthetic user prompt.
  const newHead: AigmMessage[] = [
    { role: 'user', content: 'Continue the encounter — what has happened so far is summarised below.' },
    { role: 'assistant', content: `${SUMMARY_PREFIX}\n${summaryText}` },
  ];

  history.splice(0, tailStart, ...newHead);
}

/**
 * E + I. Stream a Claude response, forwarding text deltas to onChunk as they
 * arrive. Returns the assembled final Message — same shape the non-streaming
 * create() would produce. Retries once on transient errors (429/5xx).
 *
 * The caller is responsible for issuing a speculative-discard signal if the
 * completed response turns out to contain a roll-requesting tool (the streamed
 * text was speculative).
 */
async function callClaudeWithRetry(
  anthropic: Anthropic,
  params: {
    model: string;
    max_tokens: number;
    system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
    tools: unknown[];
    messages: unknown[];
  },
  onChunk?: (text: string) => void,
): Promise<Anthropic.Messages.Message> {
  const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
  const RETRY_DELAY_MS = 600;

  const runOnce = async (): Promise<Anthropic.Messages.Message> => {
    const stream = anthropic.messages.stream(params as Parameters<typeof anthropic.messages.stream>[0]);
    if (onChunk) stream.on('text', (delta) => { if (delta) onChunk(delta); });
    return await stream.finalMessage();
  };

  try {
    return await runOnce();
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message = (err as { message?: string }).message;
    const isTransient = status !== undefined && TRANSIENT_STATUSES.has(status);
    if (!isTransient) {
      Logger.error('aigm.api_error', { status, message, retryable: false });
      throw err;
    }
    Logger.warn('aigm.api_retry', { status, message, retryDelayMs: RETRY_DELAY_MS });
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      return await runOnce();
    } catch (err2) {
      Logger.error('aigm.api_error', { status: (err2 as { status?: number }).status, message: (err2 as { message?: string }).message, retryable: false, afterRetry: true });
      throw err2;
    }
  }
}
