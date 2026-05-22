export type EncounterType = "simple_combat" | "social_interaction" | "exploration";

export type QuestGoalType = 'kill' | 'collect' | 'explore' | 'talk';

export interface QuestDef {
  id: string;
  title: string;
  goal: { type: QuestGoalType; target: number };
  rewardXp: number;
  rewardGp: number;
}

export type SecretReward =
  | { type: "gold"; amount: number }
  | { type: "item"; itemId: string }
  | { type: "lore"; text: string };

export interface SecretDef {
  id: string;
  dc: number;
  reward: SecretReward;
  successText: string;
  failureText: string;
}

export interface Riddle {
  question: string;
  options: [string, string, string];
  correctIndex: 0 | 1 | 2;
}

export interface PremadeEncounterDef {
  id: string;
  title: string;
  description: string;
  encounterTypes: EncounterType[];
  mapId: string;
  npcIds?: string[];
}

export interface EncounterContext {
  introduction: string;
  context: string;
  enemyCount: number;
  secrets: SecretDef[];
  riddle: Riddle | null;
  quests: QuestDef[];
  npcIds?: string[];
}
