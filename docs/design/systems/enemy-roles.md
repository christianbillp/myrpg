# Enemy roles & tactics

> **Audience:** developers, content authors, AI agents · **Status:** shipped — brute · skirmisher · artillery · leader (v1); controller · support (v2). Tactical Crucible #35.

Enemies fight to a **combat role** so positioning and target choice matter — foes
you have to read, not just out-roll. Grounded in the SRD bestiary's recurring
archetypes (see the taxonomy below). A role drives **positioning** and **target
priority**; it **composes** with existing traits (Pack Tactics, Nimble Escape,
Multiattack) rather than replacing them.

## Roles

`MonsterDef.role` (`shared/types/monsterRoles.ts`). When omitted, a role is
**inferred** from the stat block (`MonsterRoles.resolveMonsterRole`).

| Role | Target priority | Positioning | v1 |
|---|---|---|---|
| **soldier** (default) | nearest | advance & fight (today's AI) | ✅ |
| **brute** | most-**wounded** foe (finish them) | charge; never kite | ✅ |
| **skirmisher** | nearest | holds its weapon's range; kites out of melee (with a ranged option) | ✅ |
| **artillery** | **weakest** foe (squishy backline) | holds max range; kites out of melee | ✅ |
| **leader** | nearest | **anchors squad morale** — allies hold while it lives; its death breaks them | ✅ |
| **controller** | most-**dangerous** foe — sticks to a target it has grappled, else fixates the player | opens with its grapple/restrain/paralyze rider, then locks the target down | ✅ |
| **support** | nearest | **heals the most-wounded ally** (`supportHeal`); holds range & kites (with a ranged option) | ✅ |

### Inference (untagged content)
`inferMonsterRole` is deliberately conservative — only the clear signals:
pure shooter (ranged, no melee) → **artillery**; strong melee-only striker
(best single-hit ≥ ~9 avg dmg) → **brute**; everything else → **soldier**.
Leader / controller / support are author-tagged (a captain or a grappler is a
content decision). Shipped tags: `skeleton`/`mage` → artillery, `bugbear_warrior`
→ brute, `goblin_warrior`/`scout` → skirmisher, `bandit_captain`/`goblin_boss` →
leader, `ghoul` → controller, `goblin_shaman` → support.

## How it works

- **Target priority** — `pickEnemyAttackTarget` sorts candidates by role: brute &
  artillery pick the lowest-HP foe (tiebreak nearest); a **controller** stays on a
  target it has already grappled, else fixates the player (the spellcaster threat),
  tiebreak nearest; others target nearest.
- **Movement** — `runEnemyTurn`: `rolePrefersRange` (artillery, or a skirmisher /
  back-rank support with a ranged weapon) sets `desiredDist = rangeNormalTiles` so
  the shooter advances only to its range and, if a melee foe closed on it,
  **kites** away via `stepAwayFrom` with its remaining movement.
- **Controller opener** — no role-specific code: the generic `riderAttack`
  selection already makes any creature with a save/condition onHit rider (the
  Ghoul's Claw → Paralyzed, a grappler's grab) lead with it while the target lacks
  the condition. The role only adds the most-dangerous, sticky targeting above.
- **Support heal** — `NpcSupportRole.tryNpcRoleHeal` runs before the attack phase:
  a `support` creature with a `MonsterDef.supportHeal` ability mends its
  most-wounded bloodied ally in reach (capped by `supportHeal.uses`, tracked on
  `NpcState.supportHealUsed`) and ends its turn. This is the **non-spell** twin of
  `NpcSpellcasting.tryNpcSupportCast` (Healing Word / Bless) — spellcaster healers
  still go through that path.
- **Leader morale** — `factionHasLivingLeader` adds a large loyalty floor in
  `NpcBrain.scoreBehaviors` (suppresses flee) and short-circuits `npcWouldYield`
  (suppresses surrender). When the leader dies, the floor vanishes and the
  bloodied rank-and-file break — composing with the morale system (#34).

## SRD grounding

The taxonomy comes from surveying all 236 SRD stat blocks. Recurring archetypes
and their exemplars: **brute** (ogre, troll, owlbear, ettin, minotaurs,
berserker); **controller** — very common, grapple/restrain/paralyze/charm/
frighten (chuul, grick, roper, ghoul, gorgon, harpy, mummy); **skirmisher** with
Nimble Escape/flyby (goblin, scout, spy, gargoyle, will-o'-wisp); **artillery**
(giants, dragon breath, mage/lich, medusa, skeleton archer); **leader** (hobgoblin
& bandit captains, goblin boss); **support/healer** (priest, deva, couatl,
unicorn); plus lurker, pack, minion, and solo-boss tiers.

## Files

| File | Role |
|---|---|
| `shared/types/monsterRoles.ts` | `MonsterRole`; `MonsterDef.role`. |
| `shared/types/entities.ts` | `MonsterDef.supportHeal`. |
| `shared/types/npcState.ts` | `NpcState.supportHealUsed`. |
| `server/src/engine/MonsterRoles.ts` | `resolveMonsterRole` / `inferMonsterRole`, `rolePrefersRange`, `factionHasLivingLeader`. |
| `server/src/engine/NpcSupportRole.ts` | `tryNpcRoleHeal` — non-spell support heal. |
| `server/src/engine/EnemyAI.ts` | `role` config; range-hold + `stepAwayFrom` kite. |
| `server/src/engine/NpcTurnRunners.ts` | role target-priority in `pickEnemyAttackTarget`; support-heal + leader gates. |
| `server/src/engine/NpcBrain.ts` | leader loyalty floor in `scoreBehaviors`. |
| `server/src/engine/MonsterRoles.test.ts` | Tests (incl. controller targeting + support heal). |
| `server/data/.../encounters/demo_enemy_roles.json` | Demo (brute + skirmisher + artillery + leader). |
| `server/data/.../encounters/demo_directors_cut.json` | Demo (controller + support + mutators + twist). |

## v2+ (pending — see `plans/narrative-feature-ideas.md`)

- **true skirmisher kite for melee-only** — attack-then-retreat (Nimble Escape
  disengage) for skirmishers without a ranged weapon (today they hold range only
  when they have one).
- **lurker** — stealth opener on an isolated target, then re-hide.
