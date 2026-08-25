import { describe, expect, it } from 'vitest';
import { AT_JENKINS_PLUGIN_ID, AT_JENKINS_PLUGIN_DISPLAY_NAME, AT_JENKINS_TOOL_CATALOG } from '../../src/mcp/toolCatalog';
import { BRIDGE_SCHEMAS_BY_TOOL_NAME } from '../../src/mcp/bridgeSchemas';

describe('toolCatalog', () => {
  it('pluginId matches reverse-domain requirement and display name is AT Jenkins', () => {
    expect(AT_JENKINS_PLUGIN_ID).toBe('at.jenkins');
    expect(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(AT_JENKINS_PLUGIN_ID)).toBe(true);
    expect(AT_JENKINS_PLUGIN_DISPLAY_NAME).toBe('AT Jenkins');
  });

  it('declares exactly the 7 read-only jenkins_ tools', () => {
    expect(AT_JENKINS_TOOL_CATALOG).toHaveLength(7);
    expect(AT_JENKINS_TOOL_CATALOG.map((tool) => tool.name).sort()).toEqual([
      'jenkins_get_build',
      'jenkins_get_build_log',
      'jenkins_get_job',
      'jenkins_get_pipeline_script',
      'jenkins_list_builds',
      'jenkins_list_instances',
      'jenkins_list_jobs'
    ]);

    for (const tool of AT_JENKINS_TOOL_CATALOG) {
      expect(tool.name).toMatch(/^jenkins_[a-z0-9_]+$/);
      expect(tool.risk).toBe('read');
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(BRIDGE_SCHEMAS_BY_TOOL_NAME[tool.name]).toBeDefined();
    }
  });

  it('jenkins_get_build_log description documents 64KiB default tail limit', () => {
    const buildLog = AT_JENKINS_TOOL_CATALOG.find((tool) => tool.name === 'jenkins_get_build_log');
    expect(buildLog).toBeDefined();
    expect(buildLog?.description).toMatch(/64\s*KiB|65536/i);
  });

  it('jenkins_list_instances description documents credential safety and instance discovery', () => {
    const listInstances = AT_JENKINS_TOOL_CATALOG.find((tool) => tool.name === 'jenkins_list_instances');
    expect(listInstances).toBeDefined();
    expect(listInstances?.description).toMatch(/credentials/i);
    expect(listInstances?.description).toMatch(/instanceId/i);
  });
});
