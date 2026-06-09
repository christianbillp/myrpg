> **Audience:** product managers · **Status:** current · What the game can do today, in plain language. The per-feature requirement list is [requirements.md](./requirements.md).

# What MyRPG Can Do Today

A plain-language tour of shipped capabilities by area. No implementation detail —
follow the links into [requirements.md](./requirements.md) for the per-story
breakdown and into the design spec for the *how*.

## Characters & setup
- Pick a character from a roster, see its save state on the selection card, and
  choose an encounter or a full adventure before play.
- Inspect a character sheet (stats, gear, prepared spells) without leaving the
  encounter; manage equipment and review spells there.
- Multiple AIGM personas to set the tone.

## Exploration
- Move on a tile map (1 tile = 5 ft) with keyboard; click creatures to inspect
  them; zoom the map.
- Hand-crafted tilemap levels; hidden secrets and exploration encounters.

## Combat (SRD 5.2.1)
- Full turn-based combat on the map: independent initiative for every combatant,
  the Action / Bonus Action / Reaction / free-interaction economy, attack rolls,
  critical hits, and death saving throws.
- Tactical actions — Attack, Dash, Dodge, Disengage, Hide — plus Opportunity
  Attacks for every creature, Surprise, and a formal Advantage/Disadvantage
  system.
- Weapon properties and masteries, ranged weapons with ammunition, thrown items,
  and a full conditions framework (Blinded, Prone, Charmed, Grappled, …).
- Resistance / vulnerability / immunity per monster stat block; multi-enemy
  fights with allies that fight alongside you.

## Spellcasting
- Cast prepared spells and cantrips from the character sheet; targeting modes for
  single-target, area (cone/disc preview), and self/utility spells.
- Spell slots, concentration, ritual casting, and a broad shipped spellbook
  (wizard cantrips–L3 and the cleric list) with damage, saves, healing, zones,
  summons, buffs, and conditions wired mechanically.

## Social play & the AI Game Master
- Open a free-form conversation with the AI Game Master at any time; it narrates,
  voices NPCs, and adjudicates with dice (ability checks and saves) when an
  outcome isn't automatic.
- NPCs have a combat **disposition** and a social **attitude** that can shift in
  play; factions react together.
- An AI Dialogue encounter type for pure conversation.

## Adventures & story
- Multi-chapter adventures where choices carry across chapters.
- A Story Log: AI-generated prose recaps of completed encounters, building a
  narrative record of your character.

## Content authoring (in-browser)
- Generate a one-off encounter from a free-text scene description.
- A dedicated Map Editor and an NPC Creator; open and edit existing encounters
  (title, monsters, starting zones, triggers); reuse a saved map for new
  encounters.
- The Adjudicator can roll a complete encounter for you to inspect, edit, and
  save.

## Persistence & platform
- Runs entirely in a modern browser; auto-saves server-side and resumes where you
  left off; UI fits any window size.
