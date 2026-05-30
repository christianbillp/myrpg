---
id: default
name: Default (Core SRD)
version: 1
ruleset: srd-5.2.1
summary: |
  A generic SRD 5.2.1 world with no setting-specific flavour. Use core mechanics only — do not invent named factions, locations, or cosmology. Treat NPCs as generic archetypes and locations as their literal descriptions (a tavern is just a tavern). This setting exists as a baseline so the engine works when no richer worldbuilding is active; bespoke content lives in other settings.
sections:
  - notes
---

## Notes

This setting is the catch-all home for content authored before the per-setting folder structure existed — pregenerated characters, the legacy adventure / encounter / map / NPC / faction libraries, and any save files from the pre-migration era. New content should be authored inside a setting that has its own worldbuilding (see `the_sundered_reach/` for an example) rather than added here.

If you want a richer experience, set the `ACTIVE_SETTING_ID` environment variable to the id of any other loaded setting before starting the server.
