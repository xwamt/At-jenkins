import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { JenkinsStatusBarManager } from '../../src/utils/statusBar';

describe('JenkinsStatusBarManager', () => {
  let mockItem: {
    text: string;
    tooltip: string | vscode.MarkdownString | undefined;
    command: string | vscode.Command | undefined;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockItem = {
      text: '',
      tooltip: '',
      command: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn()
    };

    vi.spyOn(vscode.window, 'createStatusBarItem').mockReturnValue(
      mockItem as unknown as vscode.StatusBarItem
    );
  });

  it('initializes and displays active instance label', () => {
    const manager = new JenkinsStatusBarManager();
    manager.updateActiveInstance('Production Controller');

    expect(mockItem.text).toContain('Jenkins: Production Controller');
    expect(mockItem.command).toBe('atJenkins.setActiveInstance');
    expect(mockItem.show).toHaveBeenCalled();
  });

  it('displays default placeholder when no active instance is configured', () => {
    const manager = new JenkinsStatusBarManager();
    manager.updateActiveInstance(undefined);

    expect(mockItem.text).toContain('Jenkins');
    expect(mockItem.text).toContain('No active controller');
    expect(mockItem.command).toBe('atJenkins.setActiveInstance');
  });

  it('updates to building spinner status and restores active instance when cleared', () => {
    const manager = new JenkinsStatusBarManager();
    manager.updateActiveInstance('Production Controller');

    manager.setBuildingStatus('backend-service', 42, '35s');
    expect(mockItem.text).toContain('sync~spin');
    expect(mockItem.text).toContain('backend-service #42 (35s)');

    manager.clearBuildingStatus();
    expect(mockItem.text).toContain('Jenkins: Production Controller');
    expect(mockItem.command).toBe('atJenkins.setActiveInstance');
  });

  it('disposes underlying status bar item', () => {
    const manager = new JenkinsStatusBarManager();
    manager.dispose();
    expect(mockItem.dispose).toHaveBeenCalled();
  });
});
