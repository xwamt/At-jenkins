import * as vscode from 'vscode';
import { t } from '../i18n/t';

export class JenkinsStatusBarManager implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private activeLabel?: string;
  private isBuilding = false;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.name = 'AT Jenkins';
    this.updateActiveInstance(undefined);
    this.statusBarItem.show();
  }

  updateActiveInstance(label?: string): void {
    this.activeLabel = label;
    if (!this.isBuilding) {
      this.renderActiveState();
    }
  }

  setBuildingStatus(
    jobFullName: string,
    buildNumber: number,
    durationText?: string,
    instanceId?: string
  ): void {
    this.isBuilding = true;
    const dur = durationText ? ` (${durationText})` : '';
    this.statusBarItem.text = `$(sync~spin) Jenkins: ${jobFullName} #${buildNumber}${dur}`;
    this.statusBarItem.tooltip = t('Build in progress for "{job} #{build}". Click to open build log.', {
      job: jobFullName,
      build: buildNumber
    });
    this.statusBarItem.command = {
      command: 'atJenkins.openBuildLog',
      title: t('Open Build Log'),
      arguments: [{ instanceId, jobFullName, buildNumber }]
    };
    this.statusBarItem.show();
  }

  clearBuildingStatus(): void {
    this.isBuilding = false;
    this.renderActiveState();
  }

  private renderActiveState(): void {
    if (this.activeLabel) {
      this.statusBarItem.text = `$(radio-tower) Jenkins: ${this.activeLabel}`;
      this.statusBarItem.tooltip = t('Active Jenkins Controller: {label}. Click to switch controller.', {
        label: this.activeLabel
      });
    } else {
      this.statusBarItem.text = `$(radio-tower) Jenkins (${t('No active controller')})`;
      this.statusBarItem.tooltip = t('No active Jenkins controller selected. Click to select.');
    }
    this.statusBarItem.command = 'atJenkins.setActiveInstance';
    this.statusBarItem.show();
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
