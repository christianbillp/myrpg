import Phaser from 'phaser';
import { Player } from '../entities/Player';
import { Enemy } from '../entities/Enemy';
import { TILE_SIZE, GRID_COLS, GRID_ROWS, HUD_HEIGHT } from '../constants';
import { ALDRIC, PlayerDef } from '../data/player';
import { GOBLIN_MINION } from '../data/enemies';
import {
  rollInitiative,
  playerMeleeAttack,
  playerHide,
  enemyDaggerAttack,
  tryNimbleEscape,
  playerSecondWind,
  rollDeathSave,
} from '../systems/CombatSystem';

const GRID_H = GRID_ROWS * TILE_SIZE;
const W = GRID_COLS * TILE_SIZE;
const ENEMY_SPEED = 6;
const DPR = window.devicePixelRatio;

type GameMode = 'exploring' | 'player_turn' | 'enemy_turn' | 'death_saves' | 'defeat';

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private enemies: Enemy[] = [];
  private activeEnemy: Enemy | null = null;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };

  // Per-run state — initialised in init()
  private playerDef: PlayerDef = ALDRIC;
  private playerHp = ALDRIC.maxHp;
  private secondWindUses = ALDRIC.secondWindMaxUses;
  private playerXp = ALDRIC.xp;
  private playerSpeed = ALDRIC.speed;
  private playerHidden = false;
  private enemyVexed = false;
  private mode: GameMode = 'exploring';
  private movesLeft = 0;
  private enemyHidden = false;
  private deathSaveSuccesses = 0;
  private deathSaveFailures = 0;
  private combatLog: string[] = [];

  private playerHpBar!: Phaser.GameObjects.Graphics;
  private playerHpText!: Phaser.GameObjects.Text;
  private enemyInfoText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private logText!: Phaser.GameObjects.Text;
  private attackBtn!: Phaser.GameObjects.Container;
  private secondWindBtn!: Phaser.GameObjects.Container;
  private hideBtn!: Phaser.GameObjects.Container;
  private endTurnBtn!: Phaser.GameObjects.Container;
  private deathSaveBtn!: Phaser.GameObjects.Container;

  private highlightLayer!: Phaser.GameObjects.Graphics;

  constructor() {
    super({ key: 'GameScene' });
  }

  init(data: { playerDef?: PlayerDef }): void {
    const def = data?.playerDef ?? ALDRIC;
    this.playerDef = def;
    this.playerHp = def.maxHp;
    this.secondWindUses = def.secondWindMaxUses;
    this.playerXp = def.xp;
    this.playerSpeed = def.speed;
    this.playerHidden = false;
    this.enemyVexed = false;
    this.mode = 'exploring';
    this.movesLeft = 0;
    this.enemyHidden = false;
    this.deathSaveSuccesses = 0;
    this.deathSaveFailures = 0;
    this.combatLog = [];
    this.activeEnemy = null;
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
      this.playerDef.color,
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
    if (this.mode !== 'exploring' && this.mode !== 'player_turn') return;

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
    if (this.mode === 'player_turn' && this.movesLeft <= 0) return;

    this.player.move(dx, dy, GRID_COLS, GRID_ROWS);

    if (this.mode === 'player_turn') {
      this.movesLeft--;
      this.updateHUD();
      this.drawHighlights();
    } else {
      this.checkCombatTrigger();
    }
  }

  private checkCombatTrigger(): void {
    for (const enemy of this.enemies) {
      if (chebyshev(this.player.tileX, this.player.tileY, enemy.tileX, enemy.tileY) <= 2) {
        this.startCombat(enemy);
        return;
      }
    }
  }

  private startCombat(enemy: Enemy): void {
    this.activeEnemy = enemy;
    this.enemyHidden = false;
    this.enemyVexed = false;
    this.playerHidden = false;
    this.deathSaveSuccesses = 0;
    this.deathSaveFailures = 0;

    const { playerFirst, logs } = rollInitiative(this.playerDef, enemy.def);
    this.addLogs(logs);

    if (playerFirst) {
      this.enterPlayerTurn();
    } else {
      this.mode = 'enemy_turn';
      this.updateHUD();
      this.time.delayedCall(800, () => this.runEnemyTurn());
    }
  }

  private enterPlayerTurn(): void {
    this.mode = 'player_turn';
    this.movesLeft = this.playerSpeed;
    this.updateHUD();
    this.drawHighlights();
  }

  private onAttack(): void {
    if (!this.activeEnemy || this.mode !== 'player_turn') return;
    if (chebyshev(this.player.tileX, this.player.tileY, this.activeEnemy.tileX, this.activeEnemy.tileY) > 1) return;

    const { damage, logs, vexApplied } = playerMeleeAttack(
      this.playerDef,
      this.activeEnemy.def,
      this.playerHidden,
    );
    this.playerHidden = false;
    this.addLogs(logs);

    this.activeEnemy.takeDamage(damage);
    this.addLogs([`${this.activeEnemy.def.name} HP: ${this.activeEnemy.hp}/${this.activeEnemy.maxHp}`]);

    if (vexApplied) {
      this.enemyVexed = true;
      this.addLogs([`Vex! ${this.activeEnemy.def.name} has Disadvantage on its next attack.`]);
    }

    if (this.activeEnemy.isDead()) {
      this.playerXp += this.activeEnemy.def.xp;
      this.addLogs([
        `☠ ${this.activeEnemy.def.name} is slain! +${this.activeEnemy.def.xp} XP`,
        `Total XP: ${this.playerXp}`,
      ]);
      this.activeEnemy.destroy();
      this.enemies = this.enemies.filter(e => e !== this.activeEnemy);
      this.activeEnemy = null;
      this.enemyVexed = false;
      this.mode = 'exploring';
      this.highlightLayer.clear();
      this.updateHUD();
      return;
    }

    this.mode = 'enemy_turn';
    this.highlightLayer.clear();
    this.updateHUD();
    this.time.delayedCall(900, () => this.runEnemyTurn());
  }

  private onHide(): void {
    if (this.mode !== 'player_turn' || !this.activeEnemy) return;

    const { hidden, logs } = playerHide(this.playerDef, this.activeEnemy.def.passivePerception);
    this.playerHidden = hidden;
    this.addLogs(logs);
    this.mode = 'enemy_turn';
    this.highlightLayer.clear();
    this.updateHUD();
    this.time.delayedCall(600, () => this.runEnemyTurn());
  }

  private onSecondWind(): void {
    if (this.mode !== 'player_turn' || this.secondWindUses <= 0 || this.playerHp >= this.playerDef.maxHp) return;

    const { healed, logs } = playerSecondWind(this.playerDef.level);
    const before = this.playerHp;
    this.playerHp = Math.min(this.playerDef.maxHp, this.playerHp + healed);
    this.secondWindUses--;
    this.addLogs([...logs, `HP: ${before} → ${this.playerHp}/${this.playerDef.maxHp} (${this.secondWindUses} uses left)`]);
    this.updateHUD();
  }

  private onEndTurn(): void {
    if (this.mode !== 'player_turn') return;
    this.mode = 'enemy_turn';
    this.highlightLayer.clear();
    this.updateHUD();
    this.time.delayedCall(600, () => this.runEnemyTurn());
  }

  private onDeathSave(): void {
    if (this.mode !== 'death_saves') return;

    const { roll, outcome } = rollDeathSave();
    const logs: string[] = [`${this.playerDef.name} death save: d20 = ${roll}`];
    let nextMode: GameMode = 'death_saves';

    switch (outcome) {
      case 'nat20':
        this.playerHp = 1;
        this.deathSaveSuccesses = 0;
        this.deathSaveFailures = 0;
        logs.push(`Natural 20! ${this.playerDef.name} regains 1 HP!`);
        nextMode = 'player_turn';
        break;

      case 'nat1':
        this.deathSaveFailures = Math.min(3, this.deathSaveFailures + 2);
        logs.push(`Natural 1! Two failures. (${this.deathSaveFailures}/3)`);
        nextMode = this.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
        if (nextMode === 'defeat') logs.push(`${this.playerDef.name} has died.`);
        break;

      case 'success':
        this.deathSaveSuccesses++;
        logs.push(`Success! (${this.deathSaveSuccesses}/3)`);
        if (this.deathSaveSuccesses >= 3) {
          logs.push(`${this.playerDef.name} stabilizes.`);
          nextMode = 'defeat';
        } else {
          nextMode = 'enemy_turn';
        }
        break;

      case 'failure':
        this.deathSaveFailures++;
        logs.push(`Failure! (${this.deathSaveFailures}/3)`);
        nextMode = this.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
        if (nextMode === 'defeat') logs.push(`${this.playerDef.name} has died.`);
        break;
    }

    this.addLogs(logs);
    this.mode = nextMode;
    this.updateHUD();

    if (nextMode === 'player_turn') {
      this.movesLeft = this.playerSpeed;
      this.drawHighlights();
    } else if (nextMode === 'enemy_turn') {
      this.time.delayedCall(900, () => this.runEnemyTurn());
    }
  }

  private runEnemyTurn(): void {
    if (!this.activeEnemy) {
      this.enterPlayerTurn();
      return;
    }

    const enemy = this.activeEnemy;
    this.addLogs([`--- ${enemy.def.name}'s turn ---`]);

    const belowHalf = enemy.hp <= enemy.maxHp / 2;
    if (!this.enemyHidden && (belowHalf || Math.random() < 0.3)) {
      const passivePerc = 10 + this.playerDef.perceptionBonus;
      const { hidden, logs } = tryNimbleEscape(enemy.def, passivePerc);
      this.addLogs(logs);
      this.enemyHidden = hidden;
    }

    this.updateHUD();
    this.enemyMoveStep(enemy, ENEMY_SPEED, () => this.enemyAttackPhase(enemy));
  }

  private enemyMoveStep(enemy: Enemy, stepsLeft: number, onDone: () => void): void {
    if (stepsLeft <= 0 || chebyshev(enemy.tileX, enemy.tileY, this.player.tileX, this.player.tileY) <= 1) {
      onDone();
      return;
    }

    const absDx = Math.abs(this.player.tileX - enemy.tileX);
    const absDy = Math.abs(this.player.tileY - enemy.tileY);
    const stepX = absDx >= absDy ? Math.sign(this.player.tileX - enemy.tileX) : 0;
    const stepY = absDx < absDy ? Math.sign(this.player.tileY - enemy.tileY) : 0;
    const tx = enemy.tileX + stepX;
    const ty = enemy.tileY + stepY;

    if (tx < 0 || ty < 0 || tx >= GRID_COLS || ty >= GRID_ROWS) { onDone(); return; }
    if (tx === this.player.tileX && ty === this.player.tileY) { onDone(); return; }

    enemy.moveTo(tx, ty, () => {
      this.enemyMoveStep(enemy, stepsLeft - 1, onDone);
    });
  }

  private enemyAttackPhase(enemy: Enemy): void {
    const dist = chebyshev(enemy.tileX, enemy.tileY, this.player.tileX, this.player.tileY);

    if (dist > 1) {
      this.addLogs([`${enemy.def.name} is too far to attack.`]);
      this.enemyHidden = false;
      this.endEnemyTurn();
      return;
    }

    // Goblin: advantage when hidden, disadvantage when player is hidden (unseen target)
    // or when the player's Vex condition is active. Advantage + Disadvantage cancel.
    const withAdvantage = this.enemyHidden;
    const withDisadvantage = this.playerHidden || this.enemyVexed;
    this.enemyHidden = false;
    this.enemyVexed = false;

    const { damage, isHit, isCrit, logs } = enemyDaggerAttack(
      enemy.def,
      this.playerDef.ac,
      withAdvantage,
      withDisadvantage,
    );
    this.addLogs(logs);

    if (isHit) {
      if (this.playerHp <= 0) {
        const failures = isCrit ? 2 : 1;
        this.deathSaveFailures = Math.min(3, this.deathSaveFailures + failures);
        this.addLogs([
          `Strikes unconscious ${this.playerDef.name}!${isCrit ? ' CRITICAL — 2 failures!' : ' 1 failure.'}`,
          `Death saves: ${this.deathSaveSuccesses} ✓  ${this.deathSaveFailures} ✗`,
        ]);
        if (this.deathSaveFailures >= 3) {
          this.addLogs([`${this.playerDef.name} has died.`]);
          this.mode = 'defeat';
          this.updateHUD();
          return;
        }
        this.mode = 'death_saves';
        this.updateHUD();
        return;
      }

      this.playerHp = Math.max(0, this.playerHp - damage);
      this.addLogs([`${this.playerDef.name} HP: ${this.playerHp}/${this.playerDef.maxHp}`]);

      if (this.playerHp <= 0) {
        this.addLogs([`${this.playerDef.name} falls unconscious!`]);
        this.mode = 'death_saves';
        this.updateHUD();
        return;
      }
    }

    this.endEnemyTurn();
  }

  private endEnemyTurn(): void {
    if (this.mode === 'defeat') return;
    this.playerHidden = false;
    if (this.playerHp <= 0) {
      this.mode = 'death_saves';
      this.updateHUD();
    } else {
      this.enterPlayerTurn();
    }
  }

  // --- HUD ---

  private buildHUD(): void {
    const y = GRID_H;

    this.add.rectangle(W / 2, y + HUD_HEIGHT / 2, W, HUD_HEIGHT, 0x0d0d1e).setDepth(10);
    this.add.rectangle(W / 2, y + 1, W, 2, 0x445566).setDepth(10);

    this.add.text(12, y + 10, this.playerDef.name, {
      fontSize: '13px', color: '#' + this.playerDef.color.toString(16).padStart(6, '0'),
      fontFamily: 'monospace', resolution: DPR,
    }).setDepth(11);

    this.enemyInfoText = this.add.text(W - 12, y + 10, '', {
      fontSize: '12px', color: '#e74c3c', fontFamily: 'monospace', resolution: DPR,
    }).setOrigin(1, 0).setDepth(11);

    this.playerHpBar = this.add.graphics().setDepth(11);

    this.playerHpText = this.add.text(12, y + 40, '', {
      fontSize: '11px', color: '#cccccc', fontFamily: 'monospace', resolution: DPR,
    }).setDepth(11);

    this.phaseText = this.add.text(W / 2, y + 56, '', {
      fontSize: '13px', color: '#e2b96f', fontFamily: 'monospace', resolution: DPR,
    }).setOrigin(0.5, 0).setDepth(11);

    this.logText = this.add.text(12, y + 76, '', {
      fontSize: '11px', color: '#aabbcc', fontFamily: 'monospace', resolution: DPR,
      wordWrap: { width: W - 24 },
      lineSpacing: 4,
    }).setDepth(11);

    this.add.rectangle(W / 2, y + 126, W, 1, 0x334455).setDepth(11);

    const btnY = y + 148;
    this.attackBtn = this.makeButton(130, btnY, 'ATTACK', 0x1a4a1e, () => this.onAttack());
    this.secondWindBtn = this.makeButton(W / 2, btnY, 'SECOND WIND', 0x1a3a5a, () => this.onSecondWind());
    this.hideBtn = this.makeButton(W / 2, btnY, 'HIDE', 0x1a3a1a, () => this.onHide());
    this.endTurnBtn = this.makeButton(W - 130, btnY, 'END TURN', 0x3a3020, () => this.onEndTurn());
    this.deathSaveBtn = this.makeButton(W / 2, btnY, 'ROLL DEATH SAVE', 0x5a1a1a, () => this.onDeathSave());
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

  private updateHUD(): void {
    const y = GRID_H;

    this.drawHpBar(this.playerHpBar, 12, y + 26, 240, this.playerHp, this.playerDef.maxHp);

    const swPart = this.playerDef.secondWindMaxUses > 0
      ? `    SW: ${this.secondWindUses}/${this.playerDef.secondWindMaxUses}`
      : '';
    this.playerHpText.setText(
      `${this.playerHp}/${this.playerDef.maxHp} HP${swPart}    XP: ${this.playerXp}`,
    );

    if (this.activeEnemy) {
      const vexedPart = this.enemyVexed ? '  [VEXED]' : '';
      const hiddenPart = this.enemyHidden ? '  [HIDDEN]' : '';
      this.enemyInfoText.setText(
        `${this.activeEnemy.def.name}  ${this.activeEnemy.hp}/${this.activeEnemy.maxHp} HP${hiddenPart}${vexedPart}`,
      );
    } else {
      this.enemyInfoText.setText('');
    }

    this.logText.setText(this.combatLog.slice(-3).join('\n'));

    this.attackBtn.setVisible(false);
    this.secondWindBtn.setVisible(false);
    this.hideBtn.setVisible(false);
    this.endTurnBtn.setVisible(false);
    this.deathSaveBtn.setVisible(false);
    this.phaseText.setColor('#e2b96f');

    switch (this.mode) {
      case 'exploring':
        this.phaseText.setText('Exploring — WASD / arrow keys to move');
        break;

      case 'player_turn': {
        const hiddenLabel = this.playerHidden ? '  [HIDDEN]' : '';
        this.phaseText.setText(`Your turn — ${this.movesLeft}/${this.playerSpeed} moves${hiddenLabel}`);
        this.endTurnBtn.setVisible(true);

        const adjEnemy = this.activeEnemy !== null &&
          chebyshev(this.player.tileX, this.player.tileY, this.activeEnemy.tileX, this.activeEnemy.tileY) <= 1;
        if (adjEnemy) this.attackBtn.setVisible(true);

        if (this.playerDef.secondWindMaxUses > 0 && this.secondWindUses > 0 && this.playerHp < this.playerDef.maxHp) {
          this.secondWindBtn.setVisible(true);
        }
        if (this.playerDef.sneakAttackDice > 0 && !this.playerHidden && this.activeEnemy) {
          this.hideBtn.setVisible(true);
        }
        break;
      }

      case 'enemy_turn':
        this.phaseText.setText(`${this.activeEnemy?.def.name ?? 'Enemy'}'s turn...`);
        break;

      case 'death_saves':
        this.phaseText.setColor('#ff7777');
        this.phaseText.setText(
          `${this.playerDef.name} is unconscious!  ✓ ${this.deathSaveSuccesses}/3  ✗ ${this.deathSaveFailures}/3`,
        );
        this.deathSaveBtn.setVisible(true);
        break;

      case 'defeat':
        this.phaseText.setColor('#ff4444');
        this.phaseText.setText(
          this.deathSaveSuccesses >= 3 ? '💀 Stabilized — combat over.' : '☠ You have died.',
        );
        break;
    }
  }

  private drawHpBar(
    g: Phaser.GameObjects.Graphics,
    x: number, y: number, width: number,
    hp: number, maxHp: number,
  ): void {
    const pct = maxHp > 0 ? hp / maxHp : 0;
    g.clear();
    g.fillStyle(0x222233);
    g.fillRect(x, y, width, 11);
    const color = pct > 0.5 ? 0x27ae60 : pct > 0.25 ? 0xf39c12 : 0xe74c3c;
    g.fillStyle(color);
    g.fillRect(x, y, Math.floor(width * pct), 11);
  }

  private drawHighlights(): void {
    this.highlightLayer.clear();
    if (this.mode !== 'player_turn' || this.movesLeft <= 0) return;

    this.highlightLayer.fillStyle(0x4fc3f7, 0.15);
    const px = this.player.tileX;
    const py = this.player.tileY;

    for (let col = 0; col < GRID_COLS; col++) {
      for (let row = 0; row < GRID_ROWS; row++) {
        const dist = Math.abs(col - px) + Math.abs(row - py);
        if (dist > 0 && dist <= this.movesLeft) {
          this.highlightLayer.fillRect(col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        }
      }
    }
  }

  private addLogs(lines: string[]): void {
    this.combatLog.push(...lines);
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
        g.fillRect(col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
    }
  }
}

function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}
