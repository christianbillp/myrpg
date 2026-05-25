import type { StartingZonesLayer } from './engine/types.js';

export type EncounterType = 'simple_combat' | 'social_interaction' | 'exploration';
export type QuestGoalType = 'kill' | 'collect' | 'explore' | 'talk';

export interface EncounterContext {
  introduction: string;
  context: string;
  mapName: string;
  enemyCount: number;
  secrets: SecretDef[];
  quests: QuestDef[];
  npcIds?: string[];
  allyIds?: string[];
  startingZones?: StartingZonesLayer;
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
  encounterTypes: EncounterType[];
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
  customIntroduction?: string;
  customContext?: string;
  startingZones?: StartingZonesLayer;
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

function buildQuests(types: EncounterType[], enemyCount: number): QuestDef[] {
  const quests: QuestDef[] = [];
  if (types.includes('simple_combat')) {
    quests.push({ id: 'first_blood',  title: 'First Blood',   goal: { type: 'kill',    target: 1 },          rewardXp: 10, rewardGp: 5  });
    quests.push({ id: 'treasure_hunt',title: 'Treasure Hunt', goal: { type: 'collect', target: 2 },          rewardXp: 10, rewardGp: 5  });
    if (enemyCount > 1)
      quests.push({ id: 'slay_all',   title: 'Slay All',      goal: { type: 'kill',    target: enemyCount }, rewardXp: 25, rewardGp: 15 });
  }
  if (types.includes('exploration'))
    quests.push({ id: 'keen_eye',     title: 'Keen Eye',     goal: { type: 'explore', target: 2 }, rewardXp: 15, rewardGp: 10 });
  if (types.includes('social_interaction'))
    quests.push({ id: 'make_contact', title: 'Make Contact', goal: { type: 'talk',    target: 1 }, rewardXp: 10, rewardGp: 5 });
  return quests;
}

const TYPE_NARRATIVE: Record<EncounterType, string> = {
  simple_combat:      'Hostile figures have been spotted — combat is unavoidable.',
  social_interaction: 'A local NPC is nearby, cautious but willing to speak.',
  exploration:        'Something feels hidden here — secrets reward the observant.',
};

const TYPE_CONTEXT: Record<EncounterType, string> = {
  simple_combat:      'Combat against hostile creatures; the player must defeat all enemies.',
  social_interaction: 'An NPC available for conversation; the player speaks with all creatures through the Dungeon Master overlay.',
  exploration:        'Four hidden secrets on the map, found via Wisdom (Perception) checks.',
};

export function buildEncounter(req: EncounterStartRequest): EncounterContext {
  const mapDescription =
    req.mapType === 'saved' && req.savedMapDescription ? req.savedMapDescription
    : req.mapType === 'rooms' ? 'a labyrinth of stone corridors and shadowed chambers'
    : 'an open expanse of field and scrubland';
  const mapLabel =
    req.mapType === 'saved' && req.savedMapName ? req.savedMapName
    : req.mapType === 'rooms' ? 'dungeon' : 'open terrain';

  const isCombat = req.encounterTypes.includes('simple_combat');
  const charOpener = isCombat
    ? `${req.playerName} the ${req.playerClassName} enters ${mapDescription}, senses sharp and weapon ready.`
    : `${req.playerName} the ${req.playerClassName} steps into ${mapDescription}.`;

  const introduction = req.customIntroduction
    ?? [charOpener, ...req.encounterTypes.map((t) => TYPE_NARRATIVE[t])].join(' ');
  const context = req.customContext
    ?? [
      `Player: ${req.playerName}, ${req.playerSpeciesName} ${req.playerClassName} (Level ${req.playerLevel}, ${req.playerMaxHp} HP, AC ${req.playerAc}).`,
      `Setting: ${mapLabel} — ${mapDescription}.`,
      `Active encounter objectives: ${req.encounterTypes.map((t) => TYPE_CONTEXT[t]).join(' ')}.`,
    ].join(' ');

  const enemyCount = req.encounterTypes.includes('simple_combat')
    ? 2 + Math.floor(Math.random() * 3)
    : 0;

  return {
    introduction,
    context,
    mapName: mapLabel,
    enemyCount,
    secrets:  pickSecrets(4),
    quests:   buildQuests(req.encounterTypes, enemyCount),
    npcIds:        req.npcIds,
    allyIds:       req.allyIds,
    startingZones: req.startingZones,
  };
}
