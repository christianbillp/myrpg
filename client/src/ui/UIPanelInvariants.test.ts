/**
 * Static structural test: every UI module that appends to document.body
 * in its constructor must expose a destroy() method.
 *
 * Why this matters: a scene transition that doesn't call destroy() on
 * its UI children leaks those panels onto the next page. The bug is
 * easy to introduce — write a new panel, forget destroy(), the next
 * dev refactoring scene transitions never knows the panel exists.
 *
 * This is a grep-and-assert test, not a runtime test. It scans the
 * shipped UI source for the bug-shape and fails CI if a regression
 * lands. Companion tests (UILeak.test.ts) verify that the destroy()
 * method, when present, actually cleans up.
 *
 * EXEMPT: modules that intentionally render once and persist across
 * scenes (e.g. ConnectionLostOverlay which lives at the application
 * root, not per-scene). Add their filename to EXEMPT_FILES below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const UI_DIR = join(import.meta.dirname, '..', 'ui');

const EXEMPT_FILES = new Set<string>([
  // App-root overlays — render once at startup, persist across scenes
  // intentionally. They're managed by the bootstrap code, not by any
  // single scene's lifecycle.
  'ConnectionLostOverlay.ts',
  // Helpers / utility modules that build DOM but don't own a lifecycle:
  'htmlButtons.ts',
  'UIScale.ts',                  // its own destroy() exists for the observer
  'sceneInputs.ts',
  // Effects pinned to the canvas — their lifecycle is the canvas's:
  'ScreenEffects.ts',
  'SpeechBubbles.ts',
  'SpeechInputBubble.ts',
  // Picker / one-shot modals — destroy is the close handler, not a method:
  'SpellOptionPicker.ts',
  'SpellTargetSelector.ts',
  'NextChapterButton.ts',
  'RestPromptOverlay.ts',
]);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** A "cleanup method" is anything the owning scene/parent can call to
 *  tear the UI down. We accept any of these names, since both patterns
 *  are in active use across the codebase:
 *     destroy() — convention for scene-managed panels (HUD, PlayerPanel)
 *     close()   — convention for self-dismissing overlays (Storylog,
 *                 picker overlays, modal pickers)
 *  Either is fine as long as the cleanup method exists AND the file
 *  has a `.remove()` call somewhere (the actual DOM teardown). */
/** Matches any method declaration named destroy/close/dispose/cleanup,
 *  with any arguments. We're not parsing — just looking for the pattern
 *  `methodName(...)` anywhere in the source as a method declaration. */
const CLEANUP_METHOD_REGEX = /(?:^|\n)\s*(?:public |private |protected )?(destroy|close|dispose|cleanup)\s*\(/;

describe('UI panel invariants', () => {
  const files = walkTsFiles(UI_DIR);

  it('every UI file that appends to body has a cleanup method (destroy/close/dispose/cleanup)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const basename = f.split('/').pop()!;
      if (EXEMPT_FILES.has(basename)) continue;
      const src = readFileSync(f, 'utf-8');
      if (!/document\.body\.appendChild/.test(src)) continue;
      if (!CLEANUP_METHOD_REGEX.test(src)) {
        offenders.push(basename);
      }
    }
    expect(
      offenders,
      `UI files that append to body but never declare a cleanup method. ` +
      `Add a destroy() / close() that removes the DOM you added, or add ` +
      `the filename to EXEMPT_FILES in this test if it's intentional.`,
    ).toEqual([]);
  });

  it('every UI file that appends to body calls .remove() / removeChild / innerHTML="" somewhere', () => {
    // Catches the bug where cleanup just unregisters listeners but
    // forgets to remove the DOM element itself. We look for ANY DOM
    // removal pattern in the file (it doesn't have to be inside the
    // cleanup method — a close-button handler counts) since multiple
    // valid patterns exist.
    const offenders: string[] = [];
    for (const f of files) {
      const basename = f.split('/').pop()!;
      if (EXEMPT_FILES.has(basename)) continue;
      const src = readFileSync(f, 'utf-8');
      if (!/document\.body\.appendChild/.test(src)) continue;
      const removesFromDom = /\.remove\s*\(\s*\)|\.removeChild\(|\.innerHTML\s*=\s*['"`]['"`]/i.test(src);
      if (!removesFromDom) {
        offenders.push(basename);
      }
    }
    expect(
      offenders,
      `UI files that append to body but never call .remove() — DOM will leak across scene transitions.`,
    ).toEqual([]);
  });
});
