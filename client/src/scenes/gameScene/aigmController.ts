/**
 * AIGMController — the AIGM streaming + speech-bubble surface, extracted from
 * `GameScene.ts`. Owns the per-target "GM is typing" indicator clear-fn and
 * provides ready-to-pass callbacks for HUD construction + GameClient's
 * streaming-handler installer.
 *
 * The scene constructs one of these once `HUD` and `SpeechBubbles` exist,
 * calls `installStreamHandlers()` to wire the WS protocol, and passes
 * `onSendAIGM` / `onPlayerSays` into the HUD constructor. `dispose()` clears
 * any active typing indicator.
 */
import type { HUD } from '../../ui/HUD';
import type { SpeechBubbles } from '../../ui/SpeechBubbles';
import type { GameClient } from '../../net/GameClient';
import { DevMode } from '../../devMode';
import type { GMPersona } from '../../ui/AIGMOverlay';

export interface AIGMControllerDeps {
  /** Live getter — HUD doesn't exist yet when the controller is constructed
   *  (it's built first so its callbacks can be passed INTO the HUD ctor). */
  getHud(): HUD;
  speechBubbles: SpeechBubbles;
  client: GameClient;
  /** Live reader for the scene's currently-selected entity. Returns the
   *  entity id (`'player'` or `npc.id`) the player is targeting, or null. */
  getSelectedTargetId(): string | null;
}

export class AIGMController {
  /** Cleanup for the active "GM is typing" bubble above the selected
   *  target. Null when nothing is currently typing. */
  private gmTypingIndicatorClear: (() => void) | null = null;

  constructor(private readonly deps: AIGMControllerDeps) {}

  /** Wire the AIGM streaming protocol through to the HUD's chat panel. */
  installStreamHandlers(): void {
    this.deps.client.setAIGMStreamHandlers({
      onStart:              () => this.deps.getHud().aigmStart(),
      onChunk:              (text) => this.deps.getHud().aigmChunk(text),
      onCheckpoint:         () => this.deps.getHud().aigmCheckpoint(),
      onSpeculativeDiscard: () => this.deps.getHud().aigmSpeculativeDiscard(),
      onDone:               (reply, rollResults) => {
        this.deps.getHud().aigmDone(reply, rollResults);
        this.clearTypingIndicator();
      },
    });
  }

  /** Callback for the HUD's "send AIGM message" button. Short-circuits to a
   *  canned silent reply when `DevMode.disableAIGM` is set (encounters still
   *  play end-to-end on the deterministic layer alone — US-068 criterion). */
  onSendAIGM = (msg: string, persona: GMPersona): Promise<{ reply: string; rollResults: string[] }> => {
    if (DevMode.disableAIGM) {
      this.deps.getHud().aigmStart();
      this.deps.getHud().aigmDone('(The Game Master is silent. The world responds only to your actions.)', []);
      return Promise.resolve({ reply: '', rollResults: [] });
    }
    return this.deps.client.sendAIGMMessage(msg, persona);
  };

  /** Callback for the HUD's "player says X to selected target" input. Spawns
   *  a speech bubble above the player, then a typing-indicator bubble above
   *  the target so the player sees the NPC "thinking" while the GM reply
   *  streams in. The indicator is cleared by `installStreamHandlers`' onDone. */
  onPlayerSays = (text: string): void => {
    const targetId = this.deps.getSelectedTargetId() ?? undefined;
    this.deps.speechBubbles.spawn('player', text, { avoidEntityId: targetId });
    this.clearTypingIndicator();
    if (targetId) {
      this.gmTypingIndicatorClear = this.deps.speechBubbles.spawnTypingIndicator(targetId);
    }
  };

  /** Idempotent — safe to call from scene shutdown. */
  dispose(): void {
    this.clearTypingIndicator();
  }

  private clearTypingIndicator(): void {
    if (this.gmTypingIndicatorClear) {
      this.gmTypingIndicatorClear();
      this.gmTypingIndicatorClear = null;
    }
  }
}
