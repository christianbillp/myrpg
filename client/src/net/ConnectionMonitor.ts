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
      window.location.reload();
    } else {
      this.scheduleProbe();
    }
  }
}

export const ConnectionMonitor = new ConnectionMonitorClass();
