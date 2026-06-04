/**
 * Mission generator — composes a procedural outdoor map plus a thin
 * `EncounterDefJson` wrapper so the Bureau-office mission cycle can
 * surface fresh content on every contract roll.
 *
 * Three flavours, each authored around one enemy pool from the SRD
 * starter set Vask is allowed to hire blades against:
 *
 *   • bandit   — grassland, 1-2 bandits at the east edge.
 *   • goblin   — forest,    1-2 goblin_minions at the east edge.
 *   • skeleton — grassland (will gain ruined buildings later), 1-2 skeletons
 *                at the east edge.
 *
 * Output shape mirrors what `loadEncounterDef` returns from disk — the
 * transition endpoint treats a generated mission the same as a hand-
 * authored one. The composed map is materialised to a `SavedMapDef`
 * (SessionBuilder's expected shape) and surfaced as `savedMap` on the
 * `GeneratedMission` envelope; the transition endpoint passes it
 * through to `GameEngine.createSession` instead of looking up a disk
 * map via `defs.maps`.
 *
 * Reward is computed up-front so Vask can quote it in the contract
 * offer (per the user's "show rewards before" decision) — bandit pays
 * the base rate, goblins slightly less (faster fights, weaker drops),
 * skeletons more (relentless, immune to poison, harder to put down).
 */
import { randomUUID } from "crypto";
import { composeOutdoor } from "../engine/maps/outdoor.js";
import type { ComposedMap } from "../engine/mapTypes.js";
import type { SavedMapDef } from "../engine/types.js";
import type { MapTilesetInfo } from "../../../shared/types.js";

export type MissionFlavour = 'bandit' | 'goblin' | 'skeleton';

export interface MissionReward {
  cpDelta: number;  // 100 cp = 1 gp, so 2000 = 20 gp
  xp: number;
}

export interface GeneratedMission {
  /** Stable id of the form `mission_gen_<uuid>`. Used as the encounter
   *  id (state.currentEncounterId) and as the registry key. */
  missionId: string;
  flavour: MissionFlavour;
  enemyCount: 1 | 2;
  reward: MissionReward;
  /** EncounterDefJson-shape — passed wherever a hand-authored encounter
   *  def would normally be passed. */
  encounterDef: MissionEncounterDef;
  /** Materialised SavedMapDef ready for SessionBuilder. */
  savedMap: SavedMapDef;
}

/** Trimmed local copy of the disk-side EncounterDefJson — the generator
 *  doesn't need every authored field. Transition endpoint code expects
 *  these exact field names so it doesn't have to know about the source. */
export interface MissionEncounterDef {
  id: string;
  encounterTitle: string;
  description?: string;
  mapId: string;
  npcIds?: string[];
  allyIds?: string[];
  enemyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  objective?: string;
  allowsLongRest?: boolean;
  completionFlag?: string;
  placementMode?: 'zones' | 'exact';
  placements?: Array<{ role: 'player' | 'enemy' | 'ally' | 'neutral'; index?: number; x: number; y: number }>;
  triggers?: unknown[];  // shape unchecked here; same as authored triggers
  conversationOverrides?: Record<string, string>;
}

/** Reward table — keep it boring and SRD-vibe. Per-enemy units; total
 *  is `perEnemy.cpDelta * count` plus a small flat completion bonus. */
const REWARD_TABLE: Record<MissionFlavour, { cpDelta: number; xp: number }> = {
  bandit:   { cpDelta: 1000, xp: 50 },   // 10 gp + 50 xp per bandit
  goblin:   { cpDelta:  750, xp: 35 },   //  7.5 gp + 35 xp per goblin (CR 1/8, faster fights)
  skeleton: { cpDelta: 1250, xp: 60 },   // 12.5 gp + 60 xp per skeleton (CR 1/4, harder to put down)
};
const COMPLETION_BONUS_CP = 500;  // 5 gp for the job, regardless of count

function calculateReward(flavour: MissionFlavour, count: 1 | 2): MissionReward {
  const per = REWARD_TABLE[flavour];
  return {
    cpDelta: per.cpDelta * count + COMPLETION_BONUS_CP,
    xp: per.xp * count,
  };
}

const ENEMY_DEF_ID: Record<MissionFlavour, string> = {
  bandit:   'bandit',
  goblin:   'goblin_minion',
  skeleton: 'skeleton',
};

const FLAVOUR_PROSE: Record<MissionFlavour, {
  title: (count: number) => string;
  intro: string;
  context: string;
}> = {
  bandit: {
    title: (n) => n === 1 ? "Bandit on the East Road" : "Bandit Raid — East Road",
    intro: "The east road runs straight out of the station and into open ground. About a quarter-mile out you spot them — figures crouched at the side of the road, watching the wagon-track. They mark you the moment you mark them.",
    context: "BANDIT CONTRACT — SIMPLE FIGHT. Bandits hostile from the start, no parley, no surrender, no reinforcements. Player completes when all are dead.",
  },
  goblin: {
    title: (n) => n === 1 ? "Goblin in the Wardstone Wood" : "Goblin Pair — Wardstone Wood",
    intro: "The wood is thick and mossy. You hear them before you see them — chittering low to each other in their hissed scrap of trade tongue. Goblins, scouting line, weapons drawn.",
    context: "GOBLIN CONTRACT — SIMPLE FIGHT. Goblins will use Nimble Escape to skirmish. No parley, no reinforcements.",
  },
  skeleton: {
    title: (n) => n === 1 ? "Risen at the Old Ward" : "Risen Pair — Old Ward",
    intro: "Cracked stone in a field of dead grass. You can see them as you approach: dry figures picking themselves up out of the rubble with the patient persistence of things that have no use for pain. They mark you and begin to walk.",
    context: "SKELETON CONTRACT — SIMPLE FIGHT. Skeletons never flee, never parley. Vulnerable to bludgeoning, immune to poison. Player completes when all are down.",
  },
};

/** Pick a flavour uniformly. Exported for the trigger so the same code
 *  path can be re-used from tests. */
export function pickMissionFlavour(rng: () => number = Math.random): MissionFlavour {
  const choices: MissionFlavour[] = ['bandit', 'goblin', 'skeleton'];
  return choices[Math.floor(rng() * choices.length)];
}

/** Compose the procedural map for the chosen flavour. */
function composeMissionMap(flavour: MissionFlavour, rng: () => number): ComposedMap {
  // Allocator stub — generated mission maps don't surface zones to the
  // editor, so we ignore the zone-id arg. Allocate uniques to keep the
  // shared `reserved` machinery happy.
  let zoneSeq = 0;
  const allocZoneId = (_kind: string): string => `z${++zoneSeq}`;
  return composeOutdoor({
    width: 20,
    height: 14,
    terrain: flavour === 'goblin' ? 'forest' : 'grassland',
    features: ['path'],
    rng,
    allocZoneId,
  });
}

/** Convert a `ComposedMap` to the disk-format `SavedMapDef` so it
 *  flows through SessionBuilder unchanged. The tileset info comes from
 *  `tilesetInfoForGeneratedMaps` — read once from defs.maps at startup
 *  and reused for every generated mission. */
function composedToSavedMap(
  composed: ComposedMap,
  missionId: string,
  tilesets: MapTilesetInfo[],
): SavedMapDef {
  const { width, height, terrainData, objectData, name, description, zones } = composed;
  const toGrid = (flat: number[]): number[][] => {
    const grid: number[][] = [];
    for (let y = 0; y < height; y++) {
      const row: number[] = [];
      for (let x = 0; x < width; x++) row.push(flat[y * width + x]);
      grid.push(row);
    }
    return grid;
  };
  return {
    id: missionId,
    name,
    mapdescription: description,
    cols: width,
    rows: height,
    gidGrid: toGrid(terrainData),
    objectGidGrid: toGrid(objectData),
    tilesets,
    ...(zones && zones.length > 0 ? { zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, cells: z.cells })) } : {}),
  };
}

/** Build the EncounterDef-shape object for the rolled mission. The
 *  placements column-shift the player to the far west, enemies to the
 *  east, so the player always walks into the engagement zone the same
 *  way regardless of which flavour rolled. */
function buildEncounterDef(
  missionId: string,
  flavour: MissionFlavour,
  count: 1 | 2,
  width: number,
  height: number,
  reward: MissionReward,
): MissionEncounterDef {
  const prose = FLAVOUR_PROSE[flavour];
  const enemyDefId = ENEMY_DEF_ID[flavour];
  const playerY = Math.floor(height / 2);
  const enemyAnchorX = width - 3;
  const placements: MissionEncounterDef['placements'] = [
    { role: 'player', x: 2, y: playerY },
    { role: 'enemy', index: 0, x: enemyAnchorX, y: playerY - 1 },
  ];
  if (count === 2) {
    placements.push({ role: 'enemy', index: 1, x: enemyAnchorX, y: playerY + 1 });
  }
  return {
    id: missionId,
    encounterTitle: prose.title(count),
    description: `Procedurally generated ${flavour} contract issued by Vask. ${count} enemy${count > 1 ? 'ies' : 'y'}.`,
    mapId: missionId,
    npcIds: [],
    allyIds: [],
    enemyIds: Array.from({ length: count }, () => enemyDefId),
    customIntroduction: prose.intro,
    customContext: prose.context,
    objective: `Defeat the ${flavour}${count > 1 ? 's' : ''}. Return to Vask.`,
    allowsLongRest: false,
    placementMode: 'exact',
    placements,
    triggers: [
      {
        id: 'mission_intro',
        when: { event: 'encounter_started' },
        then: [
          { type: 'send_aigm_message', message: `Open the encounter. One short paragraph describing the ${flavour}${count > 1 ? 's' : ''}, then the fight starts on the player's next move.` },
        ],
        once: true,
      },
      {
        id: 'mission_done',
        when: { event: 'npc_killed' },
        if: [{ type: 'enemies_alive', op: 'eq', count: 0 }],
        then: [
          { type: 'set_flag', name: 'mission_complete', value: true },
          { type: 'set_flag', name: 'mission_pending', value: false },
          { type: 'set_flag', name: 'mission_reward_cp', value: reward.cpDelta },
          { type: 'set_flag', name: 'mission_reward_xp', value: reward.xp },
          { type: 'show_log', message: 'Contract complete. Return to Vask to turn it in.' },
        ],
        once: true,
      },
      {
        id: 'mission_done_aigm',
        when: { event: 'flag_set', name: 'mission_complete' },
        then: [
          { type: 'send_aigm_message', message: 'Last enemy down. One-line cleanup beat, then point the player at the LEAVE MISSION button to walk it back to Vask.' },
        ],
        once: true,
      },
    ],
  };
}

export interface GenerateMissionOpts {
  /** Tileset metadata for the generated map — see
   *  `tilesetInfoForGeneratedMaps` in `missionRegistry.ts`. Required
   *  because reading tileset .tsj files is async and the registry
   *  reads them ONCE at startup. */
  tilesets: MapTilesetInfo[];
  /** Optional flavour override for testing. Random when omitted. */
  flavour?: MissionFlavour;
  /** Optional enemy count override for testing. 1 or 2; rolled when omitted. */
  count?: 1 | 2;
  /** RNG override for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /** Optional flavour to EXCLUDE — used by the "no repeats" guard so
   *  Vask doesn't hand out the same contract twice in a row. */
  excludeFlavour?: MissionFlavour;
}

export function generateMission(opts: GenerateMissionOpts): GeneratedMission {
  const rng = opts.rng ?? Math.random;
  let flavour = opts.flavour ?? pickMissionFlavour(rng);
  // Honour the exclude guard. With three flavours, this never starves —
  // we always have at least two options.
  if (opts.excludeFlavour && flavour === opts.excludeFlavour) {
    const choices: MissionFlavour[] = (['bandit', 'goblin', 'skeleton'] as MissionFlavour[])
      .filter((f) => f !== opts.excludeFlavour);
    flavour = choices[Math.floor(rng() * choices.length)];
  }
  const count: 1 | 2 = opts.count ?? (rng() < 0.5 ? 1 : 2);
  const missionId = `mission_gen_${randomUUID()}`;
  const composed = composeMissionMap(flavour, rng);
  const savedMap = composedToSavedMap(composed, missionId, opts.tilesets);
  const reward = calculateReward(flavour, count);
  const encounterDef = buildEncounterDef(missionId, flavour, count, composed.width, composed.height, reward);
  return { missionId, flavour, enemyCount: count, reward, encounterDef, savedMap };
}
