import type { StartingZonesLayer, EncounterEnvironment } from './engine/types.js';

export type QuestGoalType = 'kill' | 'collect' | 'explore' | 'talk';

export interface EncounterContext {
  introduction: string;
  context: string;
  mapName: string;
  secrets: SecretDef[];
  quests: QuestDef[];
  /** Player-facing one-line objective for this encounter. Falls back to a generic "Complete the encounter" when not supplied. */
  objective: string;
  npcIds?: string[];
  allyIds?: string[];
  enemyIds?: string[];
  startingZones?: StartingZonesLayer;
  /** Environmental flags consulted by combat resolvers (e.g. sunlit → triggers Sunlight Sensitivity). */
  environment?: EncounterEnvironment;
  /**
   * Per-encounter override for the global faction-relation matrix. Layered
   * over `defs.factions[*].defaultRelations` at session boot. See
   * `EncounterDef.factionRelations` for the JSON shape.
   */
  factionRelations?: Record<string, Record<string, number>>;
}

export type SecretReward =
  | { type: 'gold'; amount: number }
  | { type: 'item'; itemId: string }
  | { type: 'lore'; text: string };

export interface SecretDef {
  id: string; dc: number; reward: SecretReward; successText: string; failureText: string;
}

export interface QuestDef {
  id: string; title: string; goal: { type: QuestGoalType; target: number }; rewardXp: number; rewardGp: number;
}

export interface EncounterStartRequest {
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  playerName: string;
  playerSpeciesName: string;
  playerClassName: string;
  playerLevel: number;
  playerMaxHp: number;
  playerAc: number;
  savedMapName?: string;
  savedMapDescription?: string;
  npcIds?: string[];
  allyIds?: string[];
  enemyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  customObjective?: string;
  startingZones?: StartingZonesLayer;
  environment?: EncounterEnvironment;
  factionRelations?: Record<string, Record<string, number>>;
}

const SECRET_POOL: SecretDef[] = [
  { id: 'loose_stone',    dc: 10, reward: { type: 'gold', amount: 12 }, successText: 'A loose stone conceals a small coin stash. (+12 GP)',              failureText: 'The stones look old and undisturbed.' },
  { id: 'hidden_vial',    dc: 12, reward: { type: 'item', itemId: 'health_potion' }, successText: 'Tucked in a crevice, you find a small healing vial.', failureText: 'The crevice holds only dust and cobwebs.' },
  { id: 'inscription',    dc: 15, reward: { type: 'lore', text: "An inscription reads: 'The strongest walls fall from within.'" }, successText: 'You make out a faint inscription on the surface.', failureText: 'The surface feels smooth and unremarkable.' },
  { id: 'coin_in_dust',   dc: 10, reward: { type: 'gold', amount: 5 },  successText: 'A single gold coin glints in the dust. (+5 GP)',                   failureText: 'The floor here is dusty and undisturbed.' },
  { id: 'worn_satchel',   dc: 12, reward: { type: 'gold', amount: 20 }, successText: 'Behind a fallen beam, a worn satchel holds coins. (+20 GP)',        failureText: 'Nothing catches your eye in this area.' },
  { id: 'scrap_parchment',dc: 12, reward: { type: 'lore', text: "A scrap of parchment reads: 'They came from the east and did not leave.'" }, successText: 'You find a scrap of parchment wedged in a crack.', failureText: 'A thorough search reveals only worn stone.' },
  { id: 'healing_cache',  dc: 15, reward: { type: 'item', itemId: 'health_potion' }, successText: 'A hidden niche in the wall holds a carefully wrapped vial.', failureText: 'The walls show signs of age but nothing stands out.' },
];

function shuffle<T>(arr: T[]): T[] { return [...arr].sort(() => Math.random() - 0.5); }
function pickSecrets(count: number): SecretDef[] { return shuffle(SECRET_POOL).slice(0, count); }

/**
 * Build a small default quest list from what the encounter actually contains.
 * Hand-picked enemies generate kill quests, hand-picked NPCs generate a "make
 * contact" quest, and an exploration-style "keen eye" quest is always added
 * since secrets are always seeded.
 */
function buildQuests(enemyCount: number, npcCount: number): QuestDef[] {
  const quests: QuestDef[] = [];
  if (enemyCount > 0) {
    quests.push({ id: 'first_blood',  title: 'First Blood',   goal: { type: 'kill',    target: 1 },          rewardXp: 10, rewardGp: 5  });
    quests.push({ id: 'treasure_hunt',title: 'Treasure Hunt', goal: { type: 'collect', target: 2 },          rewardXp: 10, rewardGp: 5  });
    if (enemyCount > 1)
      quests.push({ id: 'slay_all',   title: 'Slay All',      goal: { type: 'kill',    target: enemyCount }, rewardXp: 25, rewardGp: 15 });
  }
  if (npcCount > 0)
    quests.push({ id: 'make_contact', title: 'Make Contact', goal: { type: 'talk',    target: 1 }, rewardXp: 10, rewardGp: 5 });
  quests.push({ id: 'keen_eye', title: 'Keen Eye', goal: { type: 'explore', target: 2 }, rewardXp: 15, rewardGp: 10 });
  return quests;
}

export function buildEncounter(req: EncounterStartRequest): EncounterContext {
  const mapDescription =
    req.mapType === 'saved' && req.savedMapDescription ? req.savedMapDescription
    : req.mapType === 'rooms' ? 'a labyrinth of stone corridors and shadowed chambers'
    : 'an open expanse of field and scrubland';
  const mapLabel =
    req.mapType === 'saved' && req.savedMapName ? req.savedMapName
    : req.mapType === 'rooms' ? 'dungeon' : 'open terrain';

  const enemyCount = (req.enemyIds ?? []).length;
  const npcCount   = (req.npcIds ?? []).length;
  const allyCount  = (req.allyIds ?? []).length;

  // Default opening — author-supplied `customIntroduction` always wins.
  const charOpener = enemyCount > 0
    ? `${req.playerName} the ${req.playerClassName} enters ${mapDescription}, senses sharp and weapon ready.`
    : `${req.playerName} the ${req.playerClassName} steps into ${mapDescription}.`;
  const introduction = req.customIntroduction ?? charOpener;

  // Default GM context — assembled from the encounter's actual contents.
  const contents: string[] = [];
  if (enemyCount > 0) contents.push(`${enemyCount} hostile creature${enemyCount === 1 ? '' : 's'} on the map`);
  if (npcCount > 0)   contents.push(`${npcCount} neutral NPC${npcCount === 1 ? '' : 's'} available for conversation`);
  if (allyCount > 0)  contents.push(`${allyCount} ally combatant${allyCount === 1 ? '' : 's'}`);
  const contentsLine = contents.length > 0
    ? `Encounter contains: ${contents.join('; ')}.`
    : 'No combatants on the map at start — pure exploration / social scene.';
  const context = req.customContext ?? [
    `Player: ${req.playerName}, ${req.playerSpeciesName} ${req.playerClassName} (Level ${req.playerLevel}, ${req.playerMaxHp} HP, AC ${req.playerAc}).`,
    `Setting: ${mapLabel} — ${mapDescription}.`,
    contentsLine,
  ].join(' ');

  const objective = req.customObjective ?? 'Complete the encounter';

  return {
    introduction,
    context,
    mapName: mapLabel,
    secrets:  pickSecrets(4),
    quests:   buildQuests(enemyCount, npcCount),
    objective,
    npcIds:        req.npcIds,
    allyIds:       req.allyIds,
    enemyIds:      req.enemyIds,
    startingZones: req.startingZones,
    environment:   req.environment,
    factionRelations: req.factionRelations,
  };
}
