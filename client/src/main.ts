import Phaser from "phaser";
import { CharSelectScene } from "./scenes/CharSelectScene";
import { GameScene } from "./scenes/GameScene";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "./constants";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH,
  height: GRID_ROWS * TILE_SIZE + HUD_HEIGHT,
  backgroundColor: "#000000",
  scene: [CharSelectScene, GameScene],
};

new Phaser.Game(config);
