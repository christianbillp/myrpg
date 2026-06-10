/**
 * shared/types — barrel re-export. Public surface stays identical; every type
 * actually lives in a per-domain module under `shared/types/`. Adding a new
 * domain means creating the file and adding one line here.
 */
export * from "./types/modifiers.js";
export * from "./types/reference.js";
export * from "./types/entities.js";
export * from "./types/conversation.js";
export * from "./types/npcSave.js";
export * from "./types/equipment.js";
export * from "./types/classes.js";
export * from "./types/spells.js";
export * from "./types/encounter.js";
export * from "./types/engineEvents.js";
export * from "./types/triggers.js";
export * from "./types/narration.js";
export * from "./types/factions.js";
export * from "./types/adventures.js";
export * from "./types/quests.js";
export * from "./types/combatLog.js";
export * from "./types/gameState.js";
export * from "./types/levelUp.js";
export * from "./types/longRest.js";
export * from "./types/npcState.js";
export * from "./types/reaction.js";
export * from "./types/animation.js";
export * from "./types/playerActions.js";
export * from "./types/wsProtocol.js";
export * from "./types/session.js";
export * from "./types/save.js";
