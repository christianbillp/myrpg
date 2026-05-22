import Phaser from "phaser";
import { Enemy } from "../entities/Enemy";
import { NPC } from "../entities/NPC";
import { Player } from "../entities/Player";
import { MonsterDef } from "../data/monsters";
import { ItemDef } from "../data/items";
import { GameMap } from "./MapGenerator";
import { EncounterManager } from "./EncounterManager";
import { QuestManager } from "./QuestManager";
import { AIDMAction } from "../ui/AIDMOverlay";
import { d20 } from "./Dice";

export interface AIDMActionContext {
  readonly scene: Phaser.Scene;
  readonly combat: EncounterManager;
  readonly quests: QuestManager;
  readonly mapContainer: Phaser.GameObjects.Container;
  readonly highlightLayer: Phaser.GameObjects.Graphics;
  getPlayer: () => Player;
  getGameMap: () => GameMap;
  getEnemies: () => Enemy[];
  setEnemies: (v: Enemy[]) => void;
  getNpc: () => NPC | null;
  setNpc: (v: NPC | null) => void;
  getPassiveNpcs: () => NPC[];
  setPassiveNpcs: (v: NPC[]) => void;
  getSelectedNpc: () => NPC | null;
  setSelectedNpc: (v: NPC | null) => void;
  setSelectedEnemy: (v: Enemy | null) => void;
  selectEnemy: (enemy: Enemy | null) => void;
  hideTargetPanel: () => void;
  handleEnemyKilled: (enemy: Enemy) => void;
  updateHUD: () => void;
  findFreeTileNear: (tx: number, ty: number, excludeNpc?: NPC) => [number, number];
}

export class AIDMActionHandler {
  constructor(private readonly ctx: AIDMActionContext) {}

  apply(action: AIDMAction): string | void {
    const { combat, quests, mapContainer, highlightLayer } = this.ctx;

    switch (action.type) {
      case "adjust_player_hp": {
        const delta = action["delta"] as number;
        const reason = action["reason"] as string;
        combat.addLogs([`[DM] ${delta >= 0 ? "+" : ""}${delta} HP — ${reason}`]);
        combat.adjustPlayerHp(delta);
        break;
      }
      case "award_xp": {
        const amount = action["amount"] as number;
        const reason = action["reason"] as string;
        combat.addLogs([`[DM] +${amount} XP — ${reason}`]);
        combat.awardXP(amount);
        break;
      }
      case "award_gold": {
        const amount = action["amount"] as number;
        const reason = action["reason"] as string;
        combat.addLogs([`[DM] +${amount} GP — ${reason}`]);
        combat.awardGold(amount);
        break;
      }
      case "set_enemy_hp": {
        const label = action["enemy_label"] as string;
        const hp = action["hp"] as number;
        const reason = action["reason"] as string;
        const enemy = this.ctx.getEnemies().find((e) => e.label === label);
        if (!enemy) break;
        const wasAlive = !enemy.isDead();
        enemy.setHp(hp);
        combat.addLogs([`[DM] ${enemy.def.name} HP → ${enemy.hp}/${enemy.maxHp} — ${reason}`]);
        if (enemy.isDead() && wasAlive) this.ctx.handleEnemyKilled(enemy);
        break;
      }
      case "add_log_entry": {
        const text = action["text"] as string;
        combat.addLogs([`[DM] ${text}`]);
        break;
      }
      case "move_entity": {
        const entity = action["entity"] as string;
        const tx = action["tile_x"] as number;
        const ty = action["tile_y"] as number;
        const reason = action["reason"] as string;
        const gameMap = this.ctx.getGameMap();
        if (!gameMap.passable[ty]?.[tx]) break;
        if (entity === "player") {
          this.ctx.getPlayer().teleport(tx, ty);
          combat.addLogs([`[DM] ${combat.playerDef.name} moved — ${reason}`]);
        } else if (entity.startsWith("enemy_")) {
          const ref = entity.slice(6);
          const enemies = this.ctx.getEnemies();
          let e = enemies.find((en) => en.label !== "" && en.label === ref);
          if (!e) { const idx = parseInt(ref, 10); if (!isNaN(idx)) e = enemies[idx]; }
          if (e && !e.isDead()) { e.moveTo(tx, ty, () => {}); combat.addLogs([`[DM] ${e.def.name} moved — ${reason}`]); }
        } else if (entity.startsWith("npc_")) {
          const id = entity.slice(4);
          let npc: NPC | undefined;
          if (this.ctx.getNpc()?.def.id === id) {
            npc = this.ctx.getNpc()!;
          } else if (id.startsWith("passive_")) {
            const idx = parseInt(id.slice(8), 10);
            if (!isNaN(idx)) npc = this.ctx.getPassiveNpcs()[idx];
          } else {
            npc = this.ctx.getPassiveNpcs().find((n) => n.def.id === id);
          }
          if (npc) {
            const [ftx, fty] = this.ctx.findFreeTileNear(tx, ty, npc);
            npc.teleport(ftx, fty);
            combat.addLogs([`[DM] ${npc.def.name} moved — ${reason}`]);
          }
        }
        break;
      }
      case "despawn_npc": {
        const entity = action["entity"] as string;
        const reason = action["reason"] as string;
        if (!entity.startsWith("npc_")) break;
        const id = entity.slice(4);
        let npc: NPC | null = null;
        if (this.ctx.getNpc()?.def.id === id) {
          npc = this.ctx.getNpc()!;
          this.ctx.setNpc(null);
        } else if (id.startsWith("passive_")) {
          const idx = parseInt(id.slice(8), 10);
          const passiveNpcs = this.ctx.getPassiveNpcs();
          if (!isNaN(idx) && passiveNpcs[idx]) {
            npc = passiveNpcs[idx];
            passiveNpcs.splice(idx, 1);
          }
        } else {
          const found = this.ctx.getPassiveNpcs().find((n) => n.def.id === id);
          if (found) {
            npc = found;
            this.ctx.setPassiveNpcs(this.ctx.getPassiveNpcs().filter((n) => n !== found));
          }
        }
        if (npc) {
          if (this.ctx.getSelectedNpc() === npc) {
            this.ctx.setSelectedNpc(null);
            this.ctx.hideTargetPanel();
          }
          combat.addLogs([`[DM] ${npc.def.name} departs — ${reason}`]);
          npc.destroy();
        }
        break;
      }
      case "add_item": {
        const itemId = action["item_id"] as string;
        const reason = action["reason"] as string;
        const items = this.ctx.scene.registry.get("items") as ItemDef[];
        const item = items.find((i) => i.id === itemId);
        if (item) {
          combat.addItem(item);
          combat.addLogs([`[DM] ${item.name} added to inventory — ${reason}`]);
          quests.onItemCollected();
        }
        break;
      }
      case "remove_item": {
        const itemId = action["item_id"] as string;
        const reason = action["reason"] as string;
        const items = this.ctx.scene.registry.get("items") as ItemDef[];
        const item = items.find((i) => i.id === itemId);
        if (item && combat.removeItem(itemId)) {
          combat.addLogs([`[DM] ${item.name} removed from inventory — ${reason}`]);
        }
        break;
      }
      case "spawn_enemy": {
        const monsterId = action["monster_id"] as string;
        const reason = action["reason"] as string;
        const monsters = this.ctx.scene.registry.get("monsters") as MonsterDef[];
        const def = monsters.find((m) => m.id === monsterId);
        if (!def) break;
        const player = this.ctx.getPlayer();
        const [sx, sy] = this.ctx.findFreeTileNear(player.tileX, player.tileY);
        const newEnemy = new Enemy(this.ctx.scene, def, sx, sy);
        const enemies = this.ctx.getEnemies();
        const nextLabel = String.fromCharCode(65 + enemies.length);
        newEnemy.setLabel(nextLabel);
        enemies.push(newEnemy);
        mapContainer.add(newEnemy.gameObject);
        combat.addCombatant(newEnemy);
        combat.addLogs([`[DM] ${def.name} (${nextLabel}) appears — ${reason}`]);
        break;
      }
      case "end_combat": {
        const reason = action["reason"] as string;
        combat.addLogs([`[DM] ${reason}`]);
        for (const enemy of [...this.ctx.getEnemies()]) {
          enemy.destroy();
        }
        this.ctx.setEnemies([]);
        this.ctx.setSelectedEnemy(null);
        this.ctx.hideTargetPanel();
        highlightLayer.clear();
        combat.endCombat();
        break;
      }
      case "trigger_combat": {
        const reason = action["reason"] as string;
        if (combat.mode !== "exploring") break;
        const enemies = this.ctx.getEnemies();
        if (enemies.length === 0) {
          const npcToConvert = this.ctx.getNpc();
          const passivesToConvert = this.ctx.getPassiveNpcs();
          const npcsToConvert = [...(npcToConvert ? [npcToConvert] : []), ...passivesToConvert];
          if (npcsToConvert.length === 0) break;
          for (const npc of npcsToConvert) {
            const enemy = new Enemy(this.ctx.scene, npc.def, npc.tileX, npc.tileY);
            enemies.push(enemy);
            mapContainer.add(enemy.gameObject);
            npc.destroy();
          }
          this.ctx.setNpc(null);
          this.ctx.setPassiveNpcs([]);
          this.ctx.setSelectedNpc(null);
        }
        if (enemies.length === 0) break;
        enemies.forEach((e, i) => e.setLabel(String.fromCharCode(65 + i)));
        combat.addLogs([`[DM] ${reason}`]);
        combat.startCombat(enemies);
        const first = enemies.find((e) => !e.isDead()) ?? null;
        if (first) this.ctx.selectEnemy(first);
        break;
      }
      case "complete_quest": {
        const questId = action["quest_id"] as string;
        const reason = action["reason"] as string;
        combat.addLogs([`[DM] ${reason}`]);
        quests.forceComplete(questId);
        break;
      }
      case "set_player_hidden": {
        const hidden = action["hidden"] as boolean;
        const reason = action["reason"] as string;
        combat.addLogs([`[DM] ${combat.playerDef.name} is now ${hidden ? "hidden" : "revealed"} — ${reason}`]);
        combat.setPlayerHidden(hidden);
        break;
      }
      case "request_ability_check": {
        const skill = action["skill"] as string;
        const dc = action["dc"] as number;
        const reason = action["reason"] as string;
        const bonus = combat.playerDef.skills[skill] ?? 0;
        const roll = d20();
        const total = roll + bonus;
        const success = total >= dc;
        const sign = bonus >= 0 ? "+" : "";
        const label = skill.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^\w/, c => c.toUpperCase());
        combat.addLogs([
          `[DM] ${label} check (DC ${dc}) — ${reason}`,
          `d20(${roll})${sign}${bonus} = ${total} vs DC ${dc} — ${success ? "SUCCESS ✓" : "FAILURE ✗"}`,
        ]);
        this.ctx.updateHUD();
        return `[Ability Check Result — ${label}, DC ${dc}: d20(${roll})${sign}${bonus} = ${total} — ${success ? "SUCCESS" : "FAILURE"}. ${reason}]`;
      }
    }

    this.ctx.updateHUD();
  }
}
