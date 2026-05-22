import { QuestDef, QuestGoalType } from '../data/encounterContext';

export interface QuestState {
  def: QuestDef;
  progress: number;
  completed: boolean;
}

export class QuestManager {
  readonly quests: QuestState[];
  private readonly onComplete: (quest: QuestDef) => void;
  private readonly onChange: () => void;

  constructor(
    defs: QuestDef[],
    onComplete: (quest: QuestDef) => void,
    onChange: () => void,
  ) {
    this.quests = defs.map(def => ({ def, progress: 0, completed: false }));
    this.onComplete = onComplete;
    this.onChange = onChange;
  }

  onKill(): void { this.advance('kill'); }
  onItemCollected(): void { this.advance('collect'); }
  onSecretFound(): void { this.advance('explore'); }
  onNPCTalkedTo(): void { this.advance('talk'); }

  forceComplete(questId: string): void {
    const q = this.quests.find((qs) => qs.def.id === questId && !qs.completed);
    if (!q) return;
    q.progress = q.def.goal.target;
    q.completed = true;
    this.onComplete(q.def);
    this.onChange();
  }

  private advance(type: QuestGoalType): void {
    for (const q of this.quests) {
      if (q.def.goal.type !== type || q.completed) continue;
      q.progress = Math.min(q.progress + 1, q.def.goal.target);
      if (q.progress >= q.def.goal.target) {
        q.completed = true;
        this.onComplete(q.def);
      }
      this.onChange();
    }
  }
}
