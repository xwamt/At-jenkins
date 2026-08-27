import * as vscode from 'vscode';
import type { JenkinsInstanceConfigManager } from '../config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';

export class JenkinsInstanceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly instance: JenkinsInstanceConfig,
    public readonly isActive: boolean
  ) {
    super(instance.label, vscode.TreeItemCollapsibleState.None);
    this.id = `atJenkins.instance:${instance.id}`;
    this.description = [
      instance.baseUrl,
      instance.readOnly ? '[RO]' : undefined,
      instance.allowBackgroundAccess ? `[${t('Agent')}]` : undefined
    ]
      .filter(Boolean)
      .join(' ');
    this.contextValue = isActive ? 'atJenkins.instance.active' : 'atJenkins.instance.inactive';
    this.iconPath = isActive
      ? new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('charts.green'))
      : instance.allowBackgroundAccess
        ? new vscode.ThemeIcon('server-process')
        : new vscode.ThemeIcon('server');
    this.tooltip = buildTooltip(instance, isActive);
    this.command = {
      command: 'atJenkins.setActiveInstance',
      title: t('Set as Active Controller'),
      arguments: [instance]
    };
  }
}

export class InstancesTreeProvider implements vscode.TreeDataProvider<JenkinsInstanceTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<JenkinsInstanceTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<JenkinsInstanceTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private readonly configManager: JenkinsInstanceConfigManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: JenkinsInstanceTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: JenkinsInstanceTreeItem): Promise<JenkinsInstanceTreeItem[]> {
    if (element) {
      return [];
    }

    const instances = await this.configManager.listInstances();
    const activeId = await this.configManager.getActiveInstanceId();

    return instances.map((instance) => new JenkinsInstanceTreeItem(instance, instance.id === activeId));
  }
}

function buildTooltip(instance: JenkinsInstanceConfig, isActive: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(`**${instance.label}**\n\n`);
  md.appendMarkdown(`- **${t('Base URL')}:** \`${instance.baseUrl}\`\n`);
  md.appendMarkdown(`- **${t('Authentication')}:** ${instance.authMode}\n`);
  if (instance.username) {
    md.appendMarkdown(`- **${t('Username')}:** ${instance.username}\n`);
  }
  md.appendMarkdown(`- **${t('Active')}:** ${isActive ? t('Yes') : t('No')}\n`);
  md.appendMarkdown(`- **${t('Read-only')}:** ${instance.readOnly ? t('Yes') : t('No')}\n`);
  md.appendMarkdown(`- **${t('Background Access')}:** ${instance.allowBackgroundAccess ? t('Yes') : t('No')}\n`);
  md.appendMarkdown(`- **${t('TLS Verification')}:** ${instance.verifyTls ? t('Enabled') : t('Disabled')}\n`);
  return md;
}
