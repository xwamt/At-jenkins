import type { ExtensionMemento } from '../config/JenkinsInstanceConfigManager';
import type { JobParameterDefinition } from '../jenkins/types';

export const RECENT_PARAMS_STATE_KEY = 'atJenkins.recentBuildParams';

const memoryCache = new Map<string, Record<string, string | number | boolean>>();

export function jobParamsKey(instanceId: string, jobFullName: string): string {
  return `${instanceId}:${jobFullName}`;
}

export function isSecretParameter(param: JobParameterDefinition): boolean {
  const type = param.type.toLowerCase();
  return type.includes('password') || type.includes('credential');
}

export function sanitizeParamsForStorage(
  params: Record<string, string | number | boolean>,
  definitions: JobParameterDefinition[]
): Record<string, string | number | boolean> {
  const secretNames = new Set(definitions.filter(isSecretParameter).map((param) => param.name));
  const stored: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(params)) {
    if (!secretNames.has(name)) {
      stored[name] = value;
    }
  }
  return stored;
}

export function defaultParameterValues(
  definitions: JobParameterDefinition[]
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const param of definitions) {
    if (param.defaultValue !== undefined && param.defaultValue !== null) {
      values[param.name] = param.defaultValue;
    }
  }
  return values;
}

export function readRecentParams(
  memento: ExtensionMemento | undefined,
  key: string
): Record<string, string | number | boolean> | undefined {
  const fromMemory = memoryCache.get(key);
  if (fromMemory && Object.keys(fromMemory).length > 0) {
    return fromMemory;
  }
  if (!memento) {
    return undefined;
  }
  const all = memento.get<Record<string, Record<string, string | number | boolean>>>(
    RECENT_PARAMS_STATE_KEY,
    {}
  );
  const stored = all[key];
  if (stored && Object.keys(stored).length > 0) {
    memoryCache.set(key, stored);
    return stored;
  }
  return undefined;
}

export async function writeRecentParams(
  memento: ExtensionMemento | undefined,
  key: string,
  params: Record<string, string | number | boolean>
): Promise<void> {
  if (Object.keys(params).length === 0) {
    return;
  }
  memoryCache.set(key, params);
  if (!memento) {
    return;
  }
  const all = {
    ...memento.get<Record<string, Record<string, string | number | boolean>>>(RECENT_PARAMS_STATE_KEY, {})
  };
  all[key] = params;
  await memento.update(RECENT_PARAMS_STATE_KEY, all);
}

export function clearRecentParamsCache(): void {
  memoryCache.clear();
}
