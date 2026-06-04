/**
 * Typed facade over the Phaser registry. Every static def the server publishes
 * (characters / monsters / spells / equipment / …) gets a typed getter here so
 * scenes and UI components don't repeat `registry.get('spells') as SpellDef[]`
 * casts everywhere.
 *
 * BootScene seeds the registry once; everyone else reads through this module.
 * The registry key list and its value types live in `RegistryMap` — adding a
 * new server-side def means one line here plus the corresponding `set(...)`
 * in BootScene.
 *
 * The class wraps a Phaser.Scene because Phaser's registry is per-game and
 * scenes are the natural seam. `new DefRegistry(this)` inside a scene is the
 * idiomatic call site.
 */
import type Phaser from 'phaser';
import type {
  PlayerDef, MonsterDef, NPCDef, ItemDef, FeatDef, BackgroundDef,
  SpeciesDef, SpellDef, FeatureDef, SavedMapDef, EncounterDef,
  AdventureDef, FactionDef, ConversationDef, ClassDef, SubclassDef,
  TileLegend,
} from '../../../shared/types';

/** Shape of a `/tilesets` entry — image url + sheet slicing info used by the
 *  Map Editor's tile palette. Authored locally because the server hasn't
 *  exported a matching type. */
export interface TilesetDescriptor {
  imageUrl: string;
  tilewidth: number;
  tileheight: number;
  margin: number;
  spacing: number;
  columns?: number;
}

/** Maps every registry key to its stored value type. Keep this in sync with
 *  the `registry.set(...)` calls in `BootScene.ts`. */
export interface RegistryMap {
  adventures:           AdventureDef[];
  backgrounds:          BackgroundDef[];
  characters:           PlayerDef[];
  classes:              ClassDef[];
  conversations:        ConversationDef[];
  encounters:           EncounterDef[];
  equipment:            ItemDef[];
  factions:             FactionDef[];
  feats:                FeatDef[];
  features:             FeatureDef[];
  maps:                 SavedMapDef[];
  monsters:             MonsterDef[];
  npcs:                 NPCDef[];
  species:              SpeciesDef[];
  spells:               SpellDef[];
  subclasses:           SubclassDef[];
  tileLegend:           TileLegend;
  tilesetMeta:          TilesetDescriptor[];
  /** Round-trip scratch the NPC Creator stashes while detouring through the
   *  Token Creator. Untyped on purpose — the contents are scene-private. */
  npcCreatorFormState:  unknown;
}

export type RegistryKey = keyof RegistryMap;

export class DefRegistry {
  constructor(private readonly scene: Phaser.Scene) {}

  /** Raw typed get — returns `undefined` if the key was never set. */
  get<K extends RegistryKey>(key: K): RegistryMap[K] | undefined {
    return this.scene.registry.get(key) as RegistryMap[K] | undefined;
  }

  /** Get-with-fallback for collections that are universally arrays. Callers
   *  that want a non-undefined value pass `[]` (or an empty default object). */
  getOr<K extends RegistryKey>(key: K, fallback: RegistryMap[K]): RegistryMap[K] {
    const value = this.scene.registry.get(key) as RegistryMap[K] | undefined;
    return value ?? fallback;
  }

  set<K extends RegistryKey>(key: K, value: RegistryMap[K]): void {
    this.scene.registry.set(key, value);
  }

  // ── Convenience accessors for every key ─────────────────────────────────
  // Each defaults to the natural empty value so consumers don't have to.

  adventures():    AdventureDef[]                 { return this.getOr('adventures', []); }
  backgrounds():   BackgroundDef[]                { return this.getOr('backgrounds', []); }
  characters():    PlayerDef[]                    { return this.getOr('characters', []); }
  classes():       ClassDef[]                     { return this.getOr('classes', []); }
  conversations(): ConversationDef[]              { return this.getOr('conversations', []); }
  encounters():    EncounterDef[]                 { return this.getOr('encounters', []); }
  equipment():     ItemDef[]                      { return this.getOr('equipment', []); }
  factions():      FactionDef[]                   { return this.getOr('factions', []); }
  feats():         FeatDef[]                      { return this.getOr('feats', []); }
  features():      FeatureDef[]                   { return this.getOr('features', []); }
  maps():          SavedMapDef[]                  { return this.getOr('maps', []); }
  monsters():      MonsterDef[]                   { return this.getOr('monsters', []); }
  npcs():          NPCDef[]                       { return this.getOr('npcs', []); }
  species():       SpeciesDef[]                   { return this.getOr('species', []); }
  spells():        SpellDef[]                     { return this.getOr('spells', []); }
  subclasses():    SubclassDef[]                  { return this.getOr('subclasses', []); }
  tileLegend():    TileLegend                     { return this.getOr('tileLegend', { notes: '', tiles: {} }); }
  tilesetMeta():   TilesetDescriptor[]            { return this.getOr('tilesetMeta', []); }
}
