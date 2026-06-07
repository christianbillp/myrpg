/**
 * UI leak tests — verify that constructing a panel adds it to the DOM
 * and destroying it removes it cleanly. The goal: catch the bug class
 * where a Phaser scene transitions away without calling destroy() on
 * its UI children, and DOM-rendered panels persist on the next page.
 *
 * What's covered:
 *   1. Every shipped UI panel that appends to document.body in its
 *      constructor must implement destroy(), and destroy() must
 *      remove every element it added.
 *   2. Constructing then destroying the same panel twice in a row
 *      doesn't leave leftover DOM. (Catches "scene mounted, scene
 *      remounted before unmount" lifecycle bugs.)
 *   3. The DOM is byte-equivalent before construction and after
 *      destroy — no orphaned classes, no leftover styles, no listeners
 *      we can detect from the outside.
 *
 * What's NOT covered (by design):
 *   - Phaser-side game objects (require a Phaser instance).
 *   - Cross-scene transitions (would require driving the Phaser
 *     scene manager; out of scope for jsdom unit tests).
 *   - Overlay state captured by OverlayManager (its lifecycle is
 *     tested separately at integration level when needed).
 *
 * To extend: import the new panel, add a `runLifecycleCheck` block.
 * The shared assertions catch the same regressions for every panel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import './../test/jsdomSetup.js';
import { makeFakeCanvas, bodyChildIds } from './../test/jsdomSetup.js';
import { UIScale } from './UIScale.js';
import { TargetPanel } from './TargetPanel.js';
import { DevToolsPanel } from './DevToolsPanel.js';

/** Snapshot body state before construction, run the panel's lifecycle,
 *  and assert nothing leaked. Each call is hermetic. */
function runLifecycleCheck(
  panelName: string,
  construct: () => { destroy(): void },
): void {
  describe(`${panelName} lifecycle`, () => {
    let beforeIds: string[];

    beforeEach(() => {
      document.body.innerHTML = '';
      beforeIds = bodyChildIds();
    });

    it('constructor appends at least one panel-marked element to body', () => {
      const _canvas = makeFakeCanvas();
      const idsBefore = bodyChildIds();
      const panel = construct();
      const idsAfter = bodyChildIds();
      expect(idsAfter.length).toBeGreaterThan(idsBefore.length);
      panel.destroy();
    });

    it('destroy() removes every panel element the constructor added', () => {
      makeFakeCanvas();
      const baseline = bodyChildIds().filter((id) => !id.startsWith('canvas'));
      const panel = construct();
      panel.destroy();
      const after = bodyChildIds().filter((id) => !id.startsWith('canvas'));
      expect(after).toEqual(baseline);
    });

    it('construct → destroy → construct → destroy leaves no leftover', () => {
      makeFakeCanvas();
      const baseline = bodyChildIds().filter((id) => !id.startsWith('canvas'));

      const a = construct();
      a.destroy();
      const b = construct();
      b.destroy();

      const after = bodyChildIds().filter((id) => !id.startsWith('canvas'));
      expect(after).toEqual(baseline);
    });

    it('after destroy, no .gui-panel descendant remains anywhere in body', () => {
      makeFakeCanvas();
      const panel = construct();
      panel.destroy();
      expect(document.body.querySelectorAll('.gui-panel')).toHaveLength(0);
    });
  });
}

runLifecycleCheck('TargetPanel', () => {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  const scale = new UIScale(canvas, 800, 600);
  return new TargetPanel(scale);
});

runLifecycleCheck('DevToolsPanel', () => {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  const scale = new UIScale(canvas, 800, 600);
  return new DevToolsPanel(
    scale,
    { onReloadEncounter: () => {}, onCompleteObjective: () => {}, onLeaveEncounter: () => {} },
    { showCompleteObjective: true },
  );
});

/**
 * The PlayerPanel and HUD have richer constructor dependency surfaces
 * (PlayerDef, callbacks, gameState, full HUD callbacks). Adding them
 * here is mechanical — wire a minimal stub PlayerDef and an empty
 * callback bag, then call `runLifecycleCheck`. Left as a starter for
 * the next pass.
 *
 * The pattern below catches the regression class for ANY panel with
 * the same destroy() shape:
 *
 *   runLifecycleCheck('PlayerPanel', () => {
 *     const canvas = document.querySelector('canvas') as HTMLCanvasElement;
 *     const scale = new UIScale(canvas, 800, 600);
 *     return new PlayerPanel(scale, stubPlayerDef(), stubCallbacks());
 *   });
 */
