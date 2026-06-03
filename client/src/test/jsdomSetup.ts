/**
 * Polyfills for jsdom — the production UI uses browser APIs (mainly
 * ResizeObserver) that jsdom doesn't ship. Tests import this once at
 * the top to enable instantiation of UI components.
 *
 * Keep this small and honest: stubs do NOT simulate the browser, they
 * just satisfy `new ResizeObserver()` so constructors don't throw.
 * Tests that depend on actual resize-observer behaviour should not
 * exist at this layer — they belong in a Playwright/browser test.
 */

class StubResizeObserver {
  constructor(_callback: ResizeObserverCallback) { /* no-op */ }
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}

if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
}

/** A canvas wired to the document so panels that read its bounding
 *  rect during construction (UIScale.canvasRect) get a real element. */
export function makeFakeCanvas(width = 800, height = 600): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.appendChild(canvas);
  return canvas;
}

/** Count children of document.body that LOOK like they came from a UI
 *  panel — they have a known class. Cheap proxy for "leak detection". */
export function countUiPanels(): number {
  return document.body.querySelectorAll('.gui-panel').length;
}

/** Snapshot of body children for diffing. */
export function bodyChildIds(): string[] {
  return Array.from(document.body.children).map((c) => {
    const tag = c.tagName.toLowerCase();
    const cls = c.className ? `.${c.className.split(/\s+/).join('.')}` : '';
    return `${tag}${cls}`;
  });
}
