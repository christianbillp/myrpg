import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { EncounterSetupScene } from "./scenes/EncounterSetupScene";
import { GameScene } from "./scenes/GameScene";
import { gameClient } from "./net/GameClient";
import { ConnectionMonitor } from "./net/ConnectionMonitor";
import { injectGameUIStyles } from "./ui/UIScale";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "./constants";

function startPhaser(): void {
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH,
    height: GRID_ROWS * TILE_SIZE + HUD_HEIGHT,
    backgroundColor: "#000000",
    scale: {
      parent: 'game',
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [BootScene, EncounterSetupScene, GameScene],
  };
  new Phaser.Game(config);
}

async function boot(): Promise<void> {
  injectGameUIStyles();
  ConnectionMonitor.start();
  const online = await gameClient.checkHealth();
  if (!online) {
    ConnectionMonitor.notifyDisconnected();
    // ConnectionMonitor will reload the page when the server comes back,
    // which re-runs boot() and starts Phaser normally.
    return;
  }
  startPhaser();
}

void boot();
