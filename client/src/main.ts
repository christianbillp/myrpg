import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from './constants';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: GRID_COLS * TILE_SIZE,
  height: GRID_ROWS * TILE_SIZE,
  backgroundColor: '#000000',
  scene: [GameScene],
};

new Phaser.Game(config);
