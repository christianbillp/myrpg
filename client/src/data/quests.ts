export type QuestGoalType = 'kill' | 'collect' | 'explore' | 'talk';

export interface QuestDef {
  id: string;
  title: string;
  goal: { type: QuestGoalType; target: number };
  rewardXp: number;
  rewardGp: number;
}

export interface QuestDisplay {
  title: string;
  progress: number;
  target: number;
  completed: boolean;
}

export function combatQuests(enemyCount: number): QuestDef[] {
  const quests: QuestDef[] = [
    { id: 'first_blood', title: 'First Blood', goal: { type: 'kill', target: 1 }, rewardXp: 10, rewardGp: 5 },
    { id: 'treasure_hunt', title: 'Treasure Hunt', goal: { type: 'collect', target: 2 }, rewardXp: 10, rewardGp: 5 },
  ];
  if (enemyCount > 1) {
    quests.push({ id: 'slay_all', title: 'Slay All', goal: { type: 'kill', target: enemyCount }, rewardXp: 25, rewardGp: 15 });
  }
  return quests;
}

export function explorationQuests(): QuestDef[] {
  return [
    { id: 'keen_eye', title: 'Keen Eye', goal: { type: 'explore', target: 2 }, rewardXp: 15, rewardGp: 10 },
  ];
}

export function socialQuests(): QuestDef[] {
  return [
    { id: 'make_contact', title: 'Make Contact', goal: { type: 'talk', target: 1 }, rewardXp: 10, rewardGp: 5 },
  ];
}
