---
id: example
name: Example Setting
version: 1
ruleset: srd-5.2.1
summary: |
  One paragraph that the AI sees on every prompt. Cover tone, central
  conflict, and one or two specific cues so generated content reads as part
  of this world rather than generic fantasy.
sections:
  - tone
  - cosmology
  - geography
  - factions
  - npcs
  - glossary
  - tropes-to-avoid
---

> Author guide — copy this folder, rename it to your setting's id, and edit
> each section below. The loader reads `setting.md` only; companion files in
> the same folder are ignored for now. Anything before the first `## ` heading
> is discarded (it shows up only via the `summary` frontmatter).

## Tone

What the world FEELS like at the table. Bleak / heroic / weird / horror /
political. List a handful of touchstone media or one-line vibes the GM
should evoke. Mark tropes the setting embraces vs ones it deliberately
sidesteps (the dedicated `tropes-to-avoid` section can list the latter in
detail).

## Cosmology

Magic, gods, planes, afterlife. Even a one-paragraph "magic is rare and
political" beats no answer when the GM has to improvise a divine
intervention.

## Geography

Continents, kingdoms, regions of interest. Don't enumerate every village —
hit the major polities and the rough relationships between them. The
gazetteer can grow over time.

## Factions

Every important faction the player might encounter. Each as its own
sub-paragraph with: who they are, what they want, who they oppose. Stat
mechanics live in `server/data/factions/*.json`; this section is for
flavour and motive.

## NPCs

Named, recurring characters. Statblocks live elsewhere — write the
personality, voice, motivations, and how the player might already know of
them. The dev AI will reach for these names when generating encounters.

## Glossary

Setting-specific terms — names of common items, oaths, slurs, slang,
calendar months, currency. Pulls the world together by giving the GM
consistent vocabulary.

## Tropes-To-Avoid

Concrete don'ts. "No paladins (they were extinct in this world after the
Sundering)." "No elves." "Never name a new god — gods are a closed list
defined in Cosmology." Saves the AI from confidently inventing things you'd
have to retcon.
