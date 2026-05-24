import { GameState, QuestGoalType, LogEntry } from './types.js';

export function advanceQuest(state: GameState, type: QuestGoalType): LogEntry[] {
  const logs: LogEntry[] = [];
  for (const q of state.quests) {
    if (q.goalType !== type || q.completed) continue;
    q.progress = Math.min(q.progress + 1, q.goalTarget);
    if (q.progress >= q.goalTarget) {
      q.completed = true;
      state.player.xp += q.rewardXp;
      state.player.gold += q.rewardGp;
      logs.push({ left: `Quest complete: ${q.title}! +${q.rewardXp} XP  +${q.rewardGp} GP`, style: 'status' });
    }
  }
  return logs;
}

export function completeQuest(state: GameState, questId: string): LogEntry[] {
  const q = state.quests.find((qs) => qs.id === questId && !qs.completed);
  if (!q) return [];
  q.progress = q.goalTarget;
  q.completed = true;
  state.player.xp += q.rewardXp;
  state.player.gold += q.rewardGp;
  return [{ left: `Quest complete: ${q.title}! +${q.rewardXp} XP  +${q.rewardGp} GP`, style: 'status' }];
}
