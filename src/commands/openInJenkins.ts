import * as vscode from 'vscode';
import type { JenkinsInstanceConfigManager } from '../config/JenkinsInstanceConfigManager';
import { parsePipelineDraftUri } from '../document/draftUri';
import { parseJenkinsDocumentUri } from '../document/uri';
import { t } from '../i18n/t';
import { buildJobPath } from '../jenkins/JenkinsClient';
import { JenkinsInstanceTreeItem } from '../tree/InstancesTreeProvider';
import {
  JenkinsBuildsMoreTreeItem,
  JenkinsBuildTreeItem,
  JenkinsFolderTreeItem,
  JenkinsJobTreeItem
} from '../tree/JobsTreeProvider';
import { formatError } from '../utils/errors';

export type OpenInJenkinsTarget =
  | JenkinsInstanceTreeItem
  | JenkinsFolderTreeItem
  | JenkinsJobTreeItem
  | JenkinsBuildTreeItem
  | vscode.Uri
  | {
      url?: string;
      instanceId?: string;
      jobFullName?: string;
      buildNumber?: number;
      baseUrl?: string;
    };

export function joinJenkinsWebUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Jenkins web pages are always http(s). Server-supplied `job.url` / `build.url`
 * values must not be handed to `openExternal` if they use another scheme.
 */
export function isSafeJenkinsWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export async function resolveJenkinsWebUrl(
  target: OpenInJenkinsTarget | undefined,
  configManager?: JenkinsInstanceConfigManager
): Promise<string | undefined> {
  if (!target) {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      return resolveJenkinsWebUrl(active, configManager);
    }
    return undefined;
  }

  if (target instanceof JenkinsInstanceTreeItem) {
    return target.instance.baseUrl;
  }
  if (target instanceof JenkinsFolderTreeItem) {
    return target.folder.url || undefined;
  }
  if (target instanceof JenkinsJobTreeItem) {
    return target.job.url || undefined;
  }
  if (target instanceof JenkinsBuildTreeItem) {
    return target.build.url || undefined;
  }
  if (target instanceof JenkinsBuildsMoreTreeItem) {
    return undefined;
  }

  if (target instanceof vscode.Uri) {
    const draft = parsePipelineDraftUri(target);
    if (draft && configManager) {
      const instance = await configManager.getInstance(draft.instanceId);
      if (!instance) {
        return undefined;
      }
      return joinJenkinsWebUrl(instance.baseUrl, `${buildJobPath(draft.jobFullName)}/configure`);
    }
    const parsed = parseJenkinsDocumentUri(target);
    if (!parsed || !configManager) {
      return undefined;
    }
    const instance = await configManager.getInstance(parsed.instanceId);
    if (!instance) {
      return undefined;
    }
    if (parsed.type === 'log') {
      return joinJenkinsWebUrl(
        instance.baseUrl,
        `${buildJobPath(parsed.jobFullName)}/${parsed.buildNumber}/console`
      );
    }
    return joinJenkinsWebUrl(instance.baseUrl, `${buildJobPath(parsed.jobFullName)}/`);
  }

  if (typeof target === 'object' && target) {
    if (typeof target.url === 'string' && target.url.trim()) {
      return target.url.trim();
    }
    let baseUrl = target.baseUrl;
    if (!baseUrl && target.instanceId && configManager) {
      baseUrl = (await configManager.getInstance(target.instanceId))?.baseUrl;
    }
    if (!baseUrl || !target.jobFullName) {
      return undefined;
    }
    if (typeof target.buildNumber === 'number') {
      return joinJenkinsWebUrl(baseUrl, `${buildJobPath(target.jobFullName)}/${target.buildNumber}/`);
    }
    return joinJenkinsWebUrl(baseUrl, `${buildJobPath(target.jobFullName)}/`);
  }

  return undefined;
}

export async function openInJenkinsHandler(
  target?: OpenInJenkinsTarget,
  configManager?: JenkinsInstanceConfigManager
): Promise<boolean> {
  try {
    const url = await resolveJenkinsWebUrl(target, configManager);
    if (!url) {
      vscode.window.showInformationMessage(t('No Jenkins URL available for this item.'));
      return false;
    }
    if (!isSafeJenkinsWebUrl(url)) {
      vscode.window.showErrorMessage(t('Refusing to open a non-http(s) Jenkins URL.'));
      return false;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(
      t('Failed to open Jenkins URL: {error}', { error: formatError(error) })
    );
    return false;
  }
}
