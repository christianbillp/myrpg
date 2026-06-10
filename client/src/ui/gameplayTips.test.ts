import { describe, it, expect } from 'vitest';
import { splitGameplayTips } from './gameplayTips';

describe('splitGameplayTips', () => {
  it('returns the whole string as in-character body when there is no tip', () => {
    const r = splitGameplayTips('Free your two kin from the slavers.');
    expect(r.body).toBe('Free your two kin from the slavers.');
    expect(r.tips).toEqual([]);
  });

  it('pulls a [[TIP: …]] out of the body and tidies the spacing', () => {
    const r = splitGameplayTips('Free your kin. [[TIP: Use the Help action on each captive.]]');
    expect(r.body).toBe('Free your kin.');
    expect(r.tips).toEqual(['Use the Help action on each captive.']);
  });

  it('handles multiple tips and trims them', () => {
    const r = splitGameplayTips('Cross the bridge [[TIP:  Walk to the far rail. ]] and ring the bell. [[TIP: Press USE.]]');
    expect(r.body).toBe('Cross the bridge and ring the bell.');
    expect(r.tips).toEqual(['Walk to the far rail.', 'Press USE.']);
  });

  it('tidies punctuation left dangling when a tip sat mid-sentence', () => {
    const r = splitGameplayTips('Defeat the captors [[TIP: any way works]] .');
    expect(r.body).toBe('Defeat the captors.');
  });
});
