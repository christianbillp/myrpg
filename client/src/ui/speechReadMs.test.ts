/**
 * Reading dwell for queued npc_speech beats (the Vane arrest beat plays four
 * back-to-back lines): per-character pacing clamped so short combat barks
 * don't stall the animation queue and long monologues stay inside the speech
 * bubble's 6 s lifetime.
 */
import { describe, it, expect } from 'vitest';
import { speechReadMs } from './SpeechBubbles';

describe('speechReadMs', () => {
  it('clamps short barks to the floor', () => {
    expect(speechReadMs('Far enough!')).toBe(1600);
  });

  it('scales with text length for mid-size lines', () => {
    const line = 'x'.repeat(60); // 600 + 60*32 = 2520
    expect(speechReadMs(line)).toBe(2520);
  });

  it('caps long monologues below the bubble lifetime', () => {
    expect(speechReadMs('x'.repeat(400))).toBe(4500);
  });
});
