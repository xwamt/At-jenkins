import { describe, expect, it } from 'vitest';

describe('at-jenkins scaffold', () => {
  it('exports activate', async () => {
    const mod = await import('../src/extension.js');
    expect(typeof mod.activate).toBe('function');
    expect(typeof mod.deactivate).toBe('function');
  });
});
