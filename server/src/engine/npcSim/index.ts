/**
 * Public surface of the NPC simulation engine. Consumers import from
 * `./npcSim` and get the spine — runner, interfaces, RNG, default tasks.
 *
 * Architecture notes for new contributors:
 *   • Every NPC decision flows through `NpcTickRunner.run(sim, registry, simState)`.
 *   • Tasks live under `./tasks/` and conform to `NpcTask`.
 *   • Atomic per-tick steps live under `./actions/` and conform to `NpcAction`.
 *     (No actions today — IdleTask synthesises its own.)
 *   • RNG comes from `SimRng.forNpcTick(tickId, npcId)` — never `Math.random`.
 *   • Determinism contract: given the same world state + same registry +
 *     same tick id, every NPC's decision is reproducible.
 */
export { SimRng } from './SimRng.js';
export type { NpcAction, NpcTask, SimContext, TaskPriority, TaskStep } from './NpcAction.js';
export {
  NpcTickRunner,
  type NpcTaskRegistry,
  type NpcSimState,
  type CommandOverride,
} from './NpcTickRunner.js';
export { IdleTask } from './tasks/IdleTask.js';
export { FollowPlayerTask, type FollowMode } from './tasks/FollowPlayerTask.js';
export { WaitHereTask } from './tasks/WaitHereTask.js';
export { WalkToTask } from './tasks/WalkToTask.js';
export { InvestigateTask } from './tasks/InvestigateTask.js';
export { AlertTask } from './tasks/AlertTask.js';
export { tasksForRoutine, taskFromRoutineEntry } from './tasks/RoutineRegistry.js';
export { WalkOneTileAction } from './actions/WalkOneTileAction.js';
export {
  pingFactionAlert, registerAwarenessHooks,
  FACTION_ALERT_RADIUS,
} from './Awareness.js';
export { registerCompanionFollowHooks } from './CompanionFollow.js';
export { runAmbientConversations } from './Banter.js';
