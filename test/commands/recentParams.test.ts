import { describe, expect, it } from 'vitest';
import {
  defaultParameterValues,
  jobParamsKey,
  readRecentParams,
  sanitizeParamsForStorage,
  writeRecentParams,
  clearRecentParamsCache,
  RECENT_PARAMS_STATE_KEY
} from '../../src/commands/recentParams';
import type { ExtensionMemento } from '../../src/config/JenkinsInstanceConfigManager';
import type { JobParameterDefinition } from '../../src/jenkins/types';

function createMemento(): ExtensionMemento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    }
  };
}

describe('recentParams', () => {
  it('drops password and credential parameters before storage', () => {
    const definitions: JobParameterDefinition[] = [
      { name: 'BRANCH', type: 'StringParameterDefinition' },
      { name: 'TOKEN', type: 'PasswordParameterDefinition' },
      { name: 'CREDS', type: 'CredentialsParameterDefinition' }
    ];
    const stored = sanitizeParamsForStorage(
      { BRANCH: 'main', TOKEN: 'secret', CREDS: 'id' },
      definitions
    );
    expect(stored).toEqual({ BRANCH: 'main' });
  });

  it('persists and reads non-secret parameters via memento', async () => {
    clearRecentParamsCache();
    const memento = createMemento();
    const key = jobParamsKey('inst-1', 'deploy');
    await writeRecentParams(memento, key, { BRANCH: 'feature' });
    clearRecentParamsCache();
    expect(readRecentParams(memento, key)).toEqual({ BRANCH: 'feature' });
    expect(memento.get(RECENT_PARAMS_STATE_KEY)).toEqual({
      [key]: { BRANCH: 'feature' }
    });
  });

  it('fills default parameter values from job definitions', () => {
    expect(
      defaultParameterValues([
        { name: 'A', type: 'StringParameterDefinition', defaultValue: 'one' },
        { name: 'B', type: 'BooleanParameterDefinition' }
      ])
    ).toEqual({ A: 'one' });
  });
});
