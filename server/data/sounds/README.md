# Sounds

Drop audio assets here. They're served by the Fastify route
`server/src/index.ts` → `GET /sounds/:filename` with these constraints:

- Filename must match `^[A-Za-z0-9_-]+\.(mp3|ogg|wav)$`. No subdirectories.
- Supported extensions: `.mp3` (served as `audio/mpeg`), `.ogg` (served as
  `audio/ogg`), `.wav` (served as `audio/wav`).
- Client requests the file at `http://localhost:3000/sounds/<filename>`.

## Currently expected files

| Filename | Used by | Notes |
| -------- | ------- | ----- |
| `supertitle.mp3` | `client/src/ui/ScreenEffects.ts` → `playSupertitleSound()` | Cinematic stinger played at the moment every supertitle appears (encounter title card, AIGM `show_supertitle` tool call, the editor PREVIEW button). If the file is missing the visual still plays, but in silence. Keep it short — the supertitle is on screen for ~3 s total. |

You can use any of the supported formats — change the extension referenced in
[ScreenEffects.ts](../../../client/src/ui/ScreenEffects.ts) (the
`SUPERTITLE_SOUND_URL` constant) if you ship `.ogg` or `.wav` instead.
