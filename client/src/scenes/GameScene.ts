import Phaser from 'phaser';
import { Player } from '../entities/Player';
import { Enemy } from '../entities/Enemy';
import { PlayerPanel } from '../ui/PlayerPanel';
import { TILE_SIZE, GRID_COLS, GRID_ROWS, HUD_HEIGHT, PANEL_WIDTH } from '../constants';
import { ALDRIC, PlayerDef } from '../data/player';
import { GOBLIN_MINION } from '../data/enemies';
import { CombatManager } from '../systems/CombatManager';
import { EnemyAI, chebyshev } from '../systems/EnemyAI';

const GRID_H = GRID_ROWS * TILE_SIZE;
const GRID_W = GRID_COLS * TILE_SIZE;
const W = PANEL_WIDTH + GRID_W;
const DPR = window.devicePixelRatio;

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private enemies: Enemy[] = [];
  private combat!: CombatManager;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };

  private enemyInfoText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private logText!: Phaser.GameObjects.Text;
  private logScrollHint!: Phaser.GameObjects.Text;
  private attackBtn!: Phaser.GameObjects.Container;
  private secondWindBtn!: Phaser.GameObjects.Container;
  private hideBtn!: Phaser.GameObjects.Container;
  private endTurnBtn!: Phaser.GameObjects.Container;
  private deathSaveBtn!: Phaser.GameObjects.Container;

  private highlightLayer!: Phaser.GameObjects.Graphics;
  private playerPanel!: PlayerPanel;

  constructor() {
    super({ key: 'GameScene' });
  }

  init(data: { playerDef?: PlayerDef }): void {
    const def = data?.playerDef ?? ALDRIC;
    this.combat = new CombatManager(
      def,
      () => this.updateHUD(),
      (delay) => this.time.delayedCall(delay, () => this.runEnemyTurn()),
      (enemy) => {
        enemy.destroy();
        this.enemies = this.enemies.filter(e => e !== enemy);
        this.highlightLayer.clear();
      },
    );
  }

  create(): void {
    this.enemies = [];
    this.drawGrid();
    this.highlightLayer = this.add.graphics().setDepth(0.5);
    this.spawnEnemies();
    this.player = new Player(
      this,
      Math.floor(GRID_COLS / 2),
      Math.floor(GRID_ROWS / 2),
      this.combat.playerDef.color,
    );

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    this.buildHUD();
    this.updateHUD();
  }

  update(): void {
    if (this.combat.mode !== 'exploring' && this.combat.mode !== 'player_turn') return;

    let dx = 0;
    let dy = 0;

    if (Phaser.Input.Keyboard.JustDown(this.cursors.left) || Phaser.Input.Keyboard.JustDown(this.wasd.left)) dx = -1;
    else if (Phaser.Input.Keyboard.JustDown(this.cursors.right) || Phaser.Input.Keyboard.JustDown(this.wasd.right)) dx = 1;
    else if (Phaser.Input.Keyboard.JustDown(this.cursors.up) || Phaser.Input.Keyboard.JustDown(this.wasd.up)) dy = -1;
    else if (Phaser.Input.Keyboard.JustDown(this.cursors.down) || Phaser.Input.Keyboard.JustDown(this.wasd.down)) dy = 1;

    if (dx === 0 && dy === 0) return;

    const nx = this.player.tileX + dx;
    const ny = this.player.tileY + dy;

    if (nx < 0 || ny < 0 || nx >= GRID_COLS || ny >= GRID_ROWS) return;
    if (this.enemies.some(e => e.tileX === nx && e.tileY === ny)) return;
    if (this.combat.mode === 'player_turn' && this.combat.movesLeft <= 0) return;

    this.player.move(dx, dy, GRID_COLS, GRID_ROWS);

    if (this.combat.mode === 'player_turn') {
      this.combat.movesLeft--;
      this.updateHUD();
    } else {
      this.checkCombatTrigger();
    }
  }

  private checkCombatTrigger(): void {
    for (const enemy of this.enemies) {
      if (chebyshev(this.player.tileX, this.player.tileY, enemy.tileX, enemy.tileY) <= 2) {
        this.combat.startCombat(enemy);
        return;
      }
    }
  }

  private runEnemyTurn(): void {
    if (!this.combat.activeEnemy) {
      this.combat.enterPlayerTurn();
      return;
    }

    EnemyAI.runTurn(
      this.combat.activeEnemy,
      {
        playerTileX: this.player.tileX,
        playerTileY: this.player.tileY,
        playerAc: this.combat.playerDef.ac,
        playerHp: this.combat.playerHp,
        playerHidden: this.combat.playerHidden,
        enemyVexed: this.combat.enemyVexed,
        enemyCurrentlyHidden: this.combat.enemyHidden,
        passivePerception: 10 + this.combat.playerDef.perceptionBonus,
      },
      (result) => this.combat.applyEnemyTurnResult(result),
    );
  }

  // --- Action Button Handlers ---

  private onAttack(): void {
    if (!this.combat.activeEnemy || this.combat.mode !== 'player_turn') return;
    if (chebyshev(this.player.tileX, this.player.tileY, this.combat.activeEnemy.tileX, this.combat.activeEnemy.tileY) > 1) return;
    this.combat.onAttack();
  }

  private onHide(): void {
    this.combat.onHide();
  }

  private onSecondWind(): void {
    this.combat.onSecondWind();
  }

  private onEndTurn(): void {
    this.combat.onEndTurn();
  }

  private onDeathSave(): void {
    this.combat.onDeathSave();
  }

  // --- HUD ---

  private buildHUD(): void {
    const y = GRID_H;
    const cx = PANEL_WIDTH + GRID_W / 2;
    const lx = PANEL_WIDTH + 12;

    this.playerPanel = new PlayerPanel(this, this.combat.playerDef);

    this.add.rectangle(W / 2, y + HUD_HEIGHT / 2, W, HUD_HEIGHT, 0x0d0d1e).setDepth(10);
    this.add.rectangle(W / 2, y + 1, W, 2, 0x445566).setDepth(10);

    this.enemyInfoText = this.add.text(W - 12, y + 10, '', {
      fontSize: '12px', color: '#e74c3c', fontFamily: 'monospace', resolution: DPR,
    }).setOrigin(1, 0).setDepth(11);

    this.phaseText = this.add.text(cx, y + 10, '', {
      fontSize: '13px', color: '#e2b96f', fontFamily: 'monospace', resolution: DPR,
    }).setOrigin(0.5, 0).setDepth(11);

    this.logText = this.add.text(lx, y + 30, '', {
      fontSize: '11px', color: '#aabbcc', fontFamily: 'monospace', resolution: DPR,
      wordWrap: { width: GRID_W - 24 },
      lineSpacing: 4,
    }).setDepth(11);

    this.logScrollHint = this.add.text(W - 12, y + 114, '', {
      fontSize: '10px', color: '#445566', fontFamily: 'monospace', resolution: DPR,
    }).setOrigin(1, 0).setDepth(12);

    const logZone = this.add.zone(cx, y + 72, GRID_W, 90).setInteractive().setDepth(13);
    logZone.on('wheel', (_p: unknown, _dx: number, dy: number) => {
      this.combat.scrollLog(dy > 0 ? -1 : 1);
      this.updateLogDisplay();
    });

    this.add.rectangle(W / 2, y + 122, W, 1, 0x334455).setDepth(11);

    const btnY = y + 148;
    this.attackBtn    = this.makeButton(PANEL_WIDTH + 130, btnY, 'ATTACK',          0x1a4a1e, () => this.onAttack());
    this.secondWindBtn = this.makeButton(cx,               btnY, 'SECOND WIND',     0x1a3a5a, () => this.onSecondWind());
    this.hideBtn       = this.makeButton(cx,               btnY, 'HIDE',            0x1a3a1a, () => this.onHide());
    this.endTurnBtn    = this.makeButton(W - 130,          btnY, 'END TURN',        0x3a3020, () => this.onEndTurn());
    this.deathSaveBtn  = this.makeButton(cx,               btnY, 'ROLL DEATH SAVE', 0x5a1a1a, () => this.onDeathSave());
  }

  private makeButton(
    x: number, y: number, label: string, color: number, onClick: () => void,
  ): Phaser.GameObjects.Container {
    const bg = this.add.rectangle(0, 0, 160, 34, color).setStrokeStyle(1, 0x556677);
    const text = this.add.text(0, 0, label, {
      fontSize: '12px', color: '#ffffff', fontFamily: 'monospace', resolution: DPR,
    }).setOrigin(0.5);
    const container = this.add.container(x, y, [bg, text]).setDepth(12);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setAlpha(0.75));
    bg.on('pointerout', () => bg.setAlpha(1));
    bg.on('pointerdown', onClick);
    return container;
  }

  private updatePanel(): void {
    this.playerPanel.refresh(this.combat.playerHp, this.combat.playerDef.maxHp, this.combat.playerXp);
  }

  private updateHUD(): void {
    this.updatePanel();

    if (this.combat.activeEnemy) {
      const vexedPart  = this.combat.enemyVexed  ? '  [VEXED]'  : '';
      const hiddenPart = this.combat.enemyHidden  ? '  [HIDDEN]' : '';
      this.enemyInfoText.setText(
        `${this.combat.activeEnemy.def.name}  ${this.combat.activeEnemy.hp}/${this.combat.activeEnemy.maxHp} HP${hiddenPart}${vexedPart}`,
      );
    } else {
      this.enemyInfoText.setText('');
    }

    this.updateLogDisplay();
    this.drawHighlights();

    this.attackBtn.setVisible(false);
    this.secondWindBtn.setVisible(false);
    this.hideBtn.setVisible(false);
    this.endTurnBtn.setVisible(false);
    this.deathSaveBtn.setVisible(false);
    this.phaseText.setColor('#e2b96f');

    switch (this.combat.mode) {
      case 'exploring':
        this.phaseText.setText('Exploring — WASD / arrow keys to move');
        break;

      case 'player_turn': {
        const hiddenLabel = this.combat.playerHidden ? '  [HIDDEN]' : '';
        this.phaseText.setText(`Your turn — ${this.combat.movesLeft}/${this.combat.playerDef.speed} moves${hiddenLabel}`);
        this.endTurnBtn.setVisible(true);

        const adjEnemy = this.combat.activeEnemy !== null &&
          chebyshev(this.player.tileX, this.player.tileY, this.combat.activeEnemy.tileX, this.combat.activeEnemy.tileY) <= 1;
        if (adjEnemy) this.attackBtn.setVisible(true);

        if (this.combat.playerDef.secondWindMaxUses > 0 && this.combat.secondWindUses > 0 && this.combat.playerHp < this.combat.playerDef.maxHp) {
          this.secondWindBtn.setVisible(true);
        }
        if (this.combat.playerDef.sneakAttackDice > 0 && !this.combat.playerHidden && this.combat.activeEnemy) {
          this.hideBtn.setVisible(true);
        }
        break;
      }

      case 'enemy_turn':
        this.phaseText.setText(`${this.combat.activeEnemy?.def.name ?? 'Enemy'}'s turn...`);
        break;

      case 'death_saves':
        this.phaseText.setColor('#ff7777');
        this.phaseText.setText(
          `${this.combat.playerDef.name} is unconscious!  ✓ ${this.combat.deathSaveSuccesses}/3  ✗ ${this.combat.deathSaveFailures}/3`,
        );
        this.deathSaveBtn.setVisible(true);
        break;

      case 'defeat':
        this.phaseText.setColor('#ff4444');
        this.phaseText.setText(
          this.combat.deathSaveSuccesses >= 3 ? '💀 Stabilized — combat over.' : '☠ You have died.',
        );
        break;
    }
  }

  private updateLogDisplay(): void {
    const total = this.combat.combatLog.length;
    const offset = Math.min(this.combat.logScrollOffset, Math.max(0, total - 6));
    this.combat.logScrollOffset = offset;
    const end = total - offset;
    const start = Math.max(0, end - 6);
    this.logText.setText(this.combat.combatLog.slice(start, end).join('\n'));

    if (offset > 0) {
      this.logScrollHint.setText(`▼ ${offset} newer`);
    } else if (total > 6) {
      this.logScrollHint.setText('↑ scroll for history');
    } else {
      this.logScrollHint.setText('');
    }
  }

  private drawHighlights(): void {
    this.highlightLayer.clear();
    if (this.combat.mode !== 'player_turn' || this.combat.movesLeft <= 0) return;

    this.highlightLayer.fillStyle(0x4fc3f7, 0.15);
    const px = this.player.tileX;
    const py = this.player.tileY;

    for (let col = 0; col < GRID_COLS; col++) {
      for (let row = 0; row < GRID_ROWS; row++) {
        const dist = Math.abs(col - px) + Math.abs(row - py);
        if (dist > 0 && dist <= this.combat.movesLeft) {
          this.highlightLayer.fillRect(PANEL_WIDTH + col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        }
      }
    }
  }

  private spawnEnemies(): void {
    for (const pos of [{ x: 10, y: 3 }, { x: 4, y: 8 }]) {
      this.enemies.push(new Enemy(this, GOBLIN_MINION, pos.x, pos.y));
    }
  }

  private drawGrid(): void {
    const g = this.add.graphics();
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        g.fillStyle(0x16213e);
        g.fillRect(PANEL_WIDTH + col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
    }
  }
}
