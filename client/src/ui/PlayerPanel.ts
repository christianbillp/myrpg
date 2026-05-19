import Phaser from 'phaser';
import { PANEL_WIDTH } from '../constants';
import { PlayerDef } from '../data/player';

const DPR = window.devicePixelRatio;

export class PlayerPanel {
  private hpBar: Phaser.GameObjects.Graphics;
  private hpText: Phaser.GameObjects.Text;
  private xpText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, def: PlayerDef) {
    const colorHex = '#' + def.color.toString(16).padStart(6, '0');
    const className = `${def.speciesName} · ${def.className} ${def.level}`;
    const statMod = (v: number) => Math.floor((v - 10) / 2);

    scene.add.rectangle(PANEL_WIDTH / 2, scene.scale.height / 2, PANEL_WIDTH, scene.scale.height, 0x080810).setDepth(10);
    scene.add.rectangle(PANEL_WIDTH, scene.scale.height / 2, 2, scene.scale.height, 0x334455).setDepth(10);

    scene.add.text(12, 14, def.name, { fontSize: '12px', color: colorHex, fontFamily: 'monospace', resolution: DPR }).setDepth(11);
    scene.add.text(12, 32, className, { fontSize: '10px', color: '#667788', fontFamily: 'monospace', resolution: DPR }).setDepth(11);
    scene.add.rectangle(PANEL_WIDTH / 2, 50, PANEL_WIDTH - 16, 1, 0x334455).setDepth(11);

    scene.add.text(12, 56, 'HP', { fontSize: '10px', color: '#889aaa', fontFamily: 'monospace', resolution: DPR }).setDepth(11);
    this.hpBar = scene.add.graphics().setDepth(11);
    this.hpText = scene.add.text(12, 92, '', { fontSize: '10px', color: '#cccccc', fontFamily: 'monospace', resolution: DPR }).setDepth(11);
    scene.add.rectangle(PANEL_WIDTH / 2, 110, PANEL_WIDTH - 16, 1, 0x334455).setDepth(11);

    const initBonus = statMod(def.dex);
    scene.add.text(12, 116, [
      `AC     ${def.ac}`,
      `Speed  ${def.speedFt} ft`,
      `Prof   +${def.proficiencyBonus}`,
      `Init   ${initBonus >= 0 ? '+' : ''}${initBonus}`,
    ].join('\n'), { fontSize: '10px', color: '#aabbcc', fontFamily: 'monospace', resolution: DPR, lineSpacing: 6 }).setDepth(11);
    scene.add.rectangle(PANEL_WIDTH / 2, 192, PANEL_WIDTH - 16, 1, 0x334455).setDepth(11);

    const abilities: [string, number][] = [
      ['STR', def.str], ['DEX', def.dex], ['CON', def.con],
      ['INT', def.int], ['WIS', def.wis], ['CHA', def.cha],
    ];
    scene.add.text(12, 198, abilities.map(([name, val]) => {
      const m = statMod(val);
      return `${name}  ${String(val).padStart(2)}  (${m >= 0 ? '+' : ''}${m})`;
    }).join('\n'), { fontSize: '10px', color: '#99aabb', fontFamily: 'monospace', resolution: DPR, lineSpacing: 6 }).setDepth(11);
    scene.add.rectangle(PANEL_WIDTH / 2, 312, PANEL_WIDTH - 16, 1, 0x334455).setDepth(11);

    this.xpText = scene.add.text(12, 318, '', { fontSize: '10px', color: '#aabbcc', fontFamily: 'monospace', resolution: DPR }).setDepth(11);
  }

  refresh(hp: number, maxHp: number, xp: number): void {
    const pct = maxHp > 0 ? hp / maxHp : 0;
    const width = PANEL_WIDTH - 24;
    this.hpBar.clear();
    this.hpBar.fillStyle(0x222233);
    this.hpBar.fillRect(12, 68, width, 11);
    const color = pct > 0.5 ? 0x27ae60 : pct > 0.25 ? 0xf39c12 : 0xe74c3c;
    this.hpBar.fillStyle(color);
    this.hpBar.fillRect(12, 68, Math.floor(width * pct), 11);
    this.hpText.setText(`${hp} / ${maxHp}`);
    this.xpText.setText(`XP  ${xp}`);
  }
}
