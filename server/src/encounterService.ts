import type { StartingZonesLayer, EncounterEnvironment, EncounterPlacement } from './engine/types.js';
import type { SecretReward, SecretDef } from '../../shared/types.js';
export type { SecretReward, SecretDef };

export interface EncounterContext {
  introduction: string;
  context: string;
  mapName: string;
  secrets: SecretDef[];
  /** Player-facing one-line objective for this encounter. Falls back to a generic "Complete the encounter" when not supplied. */
  objective: string;
  npcIds?: string[];
  allyIds?: string[];
  enemyIds?: string[];
  /** GMPC `PlayerDef` ids (US-130) — full player characters the GM controls and
   *  roleplays. Spawned as party members with their complete kit. */
  gmpcIds?: string[];
  startingZones?: StartingZonesLayer;
  /** Mirrors `EncounterDef.placementMode` — see that field for the rules. */
  placementMode?: 'zones' | 'exact';
  /** Mirrors `EncounterDef.placements`. */
  placements?: EncounterPlacement[];
  /** Environmental flags consulted by combat resolvers (e.g. sunlit → triggers Sunlight Sensitivity). */
  environment?: EncounterEnvironment;
  /** Mirror of `EncounterDef.allowsLongRest`. Drives the engine's `canLongRest` guard. */
  allowsLongRest?: boolean;
  /**
   * Per-encounter override for the global faction-relation matrix. Layered
   * over `defs.factions[*].defaultRelations` at session boot. See
   * `EncounterDef.factionRelations` for the JSON shape.
   */
  factionRelations?: Record<string, Record<string, number>>;
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
  gmpcIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  customObjective?: string;
  startingZones?: StartingZonesLayer;
  placementMode?: 'zones' | 'exact';
  placements?: EncounterPlacement[];
  environment?: EncounterEnvironment;
  factionRelations?: Record<string, Record<string, number>>;
  allowsLongRest?: boolean;
}

const SECRET_POOL: SecretDef[] = [
  { id: 'loose_stone',    dc: 10, reward: { type: 'coins', cp: 1200 }, successText: 'A loose stone conceals a small coin stash. (+12 GP)',              failureText: 'The stones look old and undisturbed.' },
  { id: 'hidden_vial',    dc: 12, reward: { type: 'item', itemId: 'health_potion' }, successText: 'Tucked in a crevice, you find a small healing vial.', failureText: 'The crevice holds only dust and cobwebs.' },
  { id: 'inscription',    dc: 15, reward: { type: 'lore', text: "An inscription reads: 'The strongest walls fall from within.'" }, successText: 'You make out a faint inscription on the surface.', failureText: 'The surface feels smooth and unremarkable.' },
  { id: 'coin_in_dust',   dc: 10, reward: { type: 'coins', cp: 500 },  successText: 'A single gold coin glints in the dust. (+5 GP)',                   failureText: 'The floor here is dusty and undisturbed.' },
  { id: 'worn_satchel',   dc: 12, reward: { type: 'coins', cp: 2000 }, successText: 'Behind a fallen beam, a worn satchel holds coins. (+20 GP)',        failureText: 'Nothing catches your eye in this area.' },
  { id: 'scrap_parchment',dc: 12, reward: { type: 'lore', text: "A scrap of parchment reads: 'They came from the east and did not leave.'" }, successText: 'You find a scrap of parchment wedged in a crack.', failureText: 'A thorough search reveals only worn stone.' },
  { id: 'healing_cache',  dc: 15, reward: { type: 'item', itemId: 'health_potion' }, successText: 'A hidden niche in the wall holds a carefully wrapped vial.', failureText: 'The walls show signs of age but nothing stands out.' },
];

function shuffle<T>(arr: T[]): T[] { return [...arr].sort(() => Math.random() - 0.5); }
function pickSecrets(count: number): SecretDef[] { return shuffle(SECRET_POOL).slice(0, count); }

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
    objective,
    npcIds:        req.npcIds,
    allyIds:       req.allyIds,
    enemyIds:      req.enemyIds,
    gmpcIds:       req.gmpcIds,
    startingZones: req.startingZones,
    placementMode: req.placementMode,
    placements:    req.placements,
    environment:   req.environment,
    factionRelations: req.factionRelations,
    allowsLongRest: req.allowsLongRest,
  };
}
