import { ConnectionLostOverlay } from '../ui/ConnectionLostOverlay';
import { gameClient } from './GameClient';

const POLL_MS = 5000;

class ConnectionMonitorClass {
  private overlay: ConnectionLostOverlay | null = null;
  private timer: number | null = null;

  start(): void {
    gameClient.setDisconnectHandler(() => this.notifyDisconnected());
  }

  notifyDisconnected(): void {
    if (this.overlay) return;
    this.overlay = new ConnectionLostOverlay(() => this.probe());
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    this.timer = window.setTimeout(() => this.probe(), POLL_MS);
  }

  private async probe(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const ok = await gameClient.checkHealth();
    if (ok) {
      this.overlay?.destroy();
      this.overlay = null;
      // Only reload when there's an active game session to recover —
      // otherwise the player is on a creator / setup / main-menu scene
      // that doesn't depend on the WebSocket, and a forced reload would
      // throw away in-progress form state (typing a persona, painting an
      // encounter map, etc.) for no benefit. The disconnect was caused by
      // a server restart or a brief network blip; the next user action
      // that needs the server will succeed naturally.
      if (gameClient.getSessionId()) {
        window.location.reload();
      }
    } else {
      this.scheduleProbe();
    }
  }
}

export const ConnectionMonitor = new ConnectionMonitorClass();
