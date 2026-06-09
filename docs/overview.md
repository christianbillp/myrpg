> **Audience:** everyone — read this first (5 minutes). · **Status:** current.

# MyRPG — Overview

## What it is

MyRPG is a **browser-based, single-player role-playing game** that plays a
faithful implementation of the **Dungeons & Dragons 5e SRD 5.2.1** ruleset on a
2D tile map, paired with an **AI Game Master (the "AIGM")** that narrates,
adjudicates, and voices the world around the deterministic rules engine. It runs
entirely in the browser against a small REST backend; there is no account system
and no multiplayer.

The default fiction is the setting **"The Sundered Reach."**

## The goal

Deliver the feeling of a tabletop D&D session — *correct rules you can trust* and
*a Dungeon Master who improvises with you* — for one player, in a browser, with
no group to schedule and no rulebook to arbitrate. Every mechanic resolves the
way the SRD says it should; everything the rules don't cover, the AIGM handles in
fiction.

## Design pillars

1. **SRD-faithful by default.** Movement, combat, the action economy, checks,
   saves, conditions, classes, and spells follow SRD 5.2.1. When the engine
   diverges or simplifies, it says so. The rulebook itself ships in the repo
   (`/dnd.srd.5.2.1/`) and the code links back to it.
2. **Deterministic engine, generative GM.** The engine resolves anything with
   defined rules (dice, damage, conditions, turn order) so outcomes are
   reproducible and inspectable in the Event Log. The AIGM owns everything the
   rules leave open — narration, NPC voice, social adjudication, improvised
   consequences — and acts on the world through a fixed catalog of tools rather
   than by fiat.
3. **Content is data, not code.** Characters, monsters, NPCs, items, spells,
   maps, encounters, and adventures are JSON. Adding content is a file drop;
   adding a *mechanic* is the rare case that touches the engine. This is what
   keeps the game easy to expand and easy to shrink.
4. **Authoring is first-class.** The same engine that plays an encounter can
   generate, edit, and save maps, NPCs, encounters, and multi-chapter adventures
   from the browser.
5. **Readable for humans and AI agents.** Named concepts have canonical names
   (see the [glossary](./glossary.md)) used consistently in docs, prompts, and
   code, so a reader can find the code for a concept by searching for its name.

## How the pieces fit (one paragraph)

A **Phaser.js** client renders the map, panels, and overlays and talks to a
**Fastify** server that serves all content from JSON and runs the rules engine.
A player picks a character and an **encounter** (or a multi-chapter
**adventure**), then explores and fights on a tile map where each tile is 5 feet.
The engine drives turn order, attacks, conditions, and triggers; the **AIGM**
layer narrates and adjudicates on top. State is saved server-side after every
encounter transition. See [design/architecture.md](./design/architecture.md) for
the full shape.

## Who this documentation is for

| Audience | Wants | Entry point |
|---|---|---|
| **Product managers** | What the game can do and will do | [product/capabilities.md](./product/capabilities.md) |
| **Developers** | How a system works; how to add content | [design/architecture.md](./design/architecture.md), [guides/](./guides/) |
| **AI agents** | Operating rules, canonical names, data/tool contracts | [glossary.md](./glossary.md), [design/aigm.md](./design/aigm.md) |

The [documentation index](./README.md) maps every doc.
