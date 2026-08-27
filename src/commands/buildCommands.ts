import * as vscode from 'vscode';
import type { ExtensionMemento, JenkinsInstanceConfigManager } from '../config/JenkinsInstanceConfigManager';
import { t } from '../i18n/t';
import type { JenkinsClientPool } from '../jenkins/JenkinsClientPool';
import type { JobParameterDefinition } from '../jenkins/types';
import {
  JenkinsBuildTreeItem,
  JenkinsJobTreeItem,
  type JobsTreeProvider
} from '../tree/JobsTreeProvider';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import type { JenkinsStatusBarManager } from '../utils/statusBar';
import type { JenkinsBuildFollowService } from './buildFollow';
import {
  defaultParameterValues,
  jobParamsKey,
  readRecentParams,
  sanitizeParamsForStorage,
  writeRecentParams
} from './recentParams';

export interface BuildCommandsContext {
  configManager: JenkinsInstanceConfigManager;
  clientPool: JenkinsClientPool;
  jobsTreeProvider?: JobsTreeProvider;
  statusBar?: JenkinsStatusBarManager;
  followService?: JenkinsBuildFollowService;
  globalState?: ExtensionMemento;
  log?: AtJenkinsLog;
}

export type TriggerBuildTarget =
  | JenkinsJobTreeItem
  | { instanceId?: string; jobFullName: string }
  | string;

export type StopBuildTarget =
  | JenkinsBuildTreeItem
  | { instanceId?: string; jobFullName: string; buildNumber: number };

/**
 * Handles triggering a build for a job, prompting for parameters if defined,
 * checking controller read-only write guard, and asking for confirmation.
 */
export async function triggerBuildHandler(
  context: BuildCommandsContext,
  target?: TriggerBuildTarget
): Promise<boolean> {
  const log = asRedactedLog(context.log ?? noopLog);

  let jobFullName: string | undefined;
  let instanceId: string | undefined;
  let jobItem: JenkinsJobTreeItem | undefined;

  if (target instanceof JenkinsJobTreeItem) {
    jobFullName = target.job.fullName;
    instanceId = target.instanceId;
    jobItem = target;
  } else if (typeof target === 'string') {
    jobFullName = target;
  } else if (target && typeof target === 'object' && 'jobFullName' in target) {
    jobFullName = target.jobFullName;
    instanceId = target.instanceId;
  }

  if (!jobFullName) {
    return false;
  }

  if (!instanceId) {
    instanceId = await context.configManager.getActiveInstanceId();
  }

  if (!instanceId) {
    vscode.window.showInformationMessage(t('No active Jenkins controller selected.'));
    return false;
  }

  try {
    const client = await context.clientPool.get(instanceId);
    const instance =
      client.config ?? (await context.configManager.getInstance(instanceId));

    if (instance?.readOnly) {
      vscode.window.showErrorMessage(
        t('Cannot trigger build: controller "{label}" is read-only.', {
          label: instance.label || instanceId
        })
      );
      return false;
    }

    const job = await client.getJob(jobFullName);
    const jobKey = jobParamsKey(instanceId, jobFullName);
    const previousParams = readRecentParams(context.globalState, jobKey);

    let collectedParams: Record<string, string | number | boolean> | undefined;
    if (job.parameters && job.parameters.length > 0) {
      collectedParams = await collectJobParameters(job.parameters, previousParams, jobFullName);
      if (!collectedParams) {
        return false;
      }
    }

    const confirm = await vscode.window.showWarningMessage(
      t('Are you sure you want to trigger build for "{job}"?', { job: jobFullName }),
      { modal: true },
      t('Trigger Build'),
      t('Cancel')
    );

    if (confirm !== t('Trigger Build')) {
      return false;
    }

    const triggerResult = await client.triggerBuild(jobFullName, collectedParams);

    if (collectedParams) {
      const stored = sanitizeParamsForStorage(collectedParams, job.parameters ?? []);
      await writeRecentParams(context.globalState, jobKey, stored);
    }

    void vscode.window.showInformationMessage(
      t('Build triggered for "{job}".', { job: jobFullName }),
      t('Open Job Summary'),
      t('Open in Jenkins')
    ).then(async (action) => {
      if (action === t('Open Job Summary')) {
        await vscode.commands.executeCommand('atJenkins.openJobSummary', { instanceId, jobFullName });
      } else if (action === t('Open in Jenkins')) {
        await vscode.commands.executeCommand('atJenkins.openInJenkins', {
          instanceId,
          jobFullName,
          url: job.url
        });
      }
    });

    if (context.followService) {
      void context.followService.follow({
        client,
        jobFullName,
        queueUrl: triggerResult?.queueUrl,
        statusBar: context.statusBar,
        jobsTreeProvider: context.jobsTreeProvider,
        log
      });
    }

    if (context.jobsTreeProvider) {
      if (jobItem) {
        context.jobsTreeProvider.refresh(jobItem);
      } else {
        context.jobsTreeProvider.refresh();
      }
    }

    return true;
  } catch (error) {
    log.error(`Failed to trigger build for ${instanceId}/${jobFullName}: ${formatError(error)}`);
    vscode.window.showErrorMessage(
      t('Failed to trigger build for "{job}": {error}', {
        job: jobFullName,
        error: formatError(error)
      })
    );
    return false;
  }
}

async function collectJobParameters(
  parameters: JobParameterDefinition[],
  previousParams: Record<string, string | number | boolean> | undefined,
  jobFullName: string
): Promise<Record<string, string | number | boolean> | undefined> {
  const hasRecent = previousParams && Object.keys(previousParams).length > 0;
  let mode: 'recent' | 'edit' | 'defaults' = 'edit';

  if (hasRecent) {
    const useRecent = t('Use recent parameters');
    const editParams = t('Edit parameters');
    const useDefaults = t('Use default parameters');
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: useRecent,
          description: t('Reuse the last values submitted for this job')
        },
        {
          label: editParams,
          description: t('Review and change each parameter')
        },
        {
          label: useDefaults,
          description: t('Reset every parameter to its job default')
        }
      ],
      {
        title: t('Parameter: {name}', { name: jobFullName }),
        placeHolder: t('How do you want to fill parameters for "{job}"?', { job: jobFullName })
      }
    );
    if (!selected) {
      return undefined;
    }
    if (selected.label === useRecent) {
      mode = 'recent';
    } else if (selected.label === useDefaults) {
      mode = 'defaults';
    }
  }

  if (mode === 'recent' && previousParams) {
    return {
      ...defaultParameterValues(parameters),
      ...previousParams
    };
  }

  if (mode === 'defaults') {
    const values = defaultParameterValues(parameters);
    for (const param of parameters) {
      if (values[param.name] === undefined) {
        values[param.name] = param.choices?.[0] ?? '';
      }
    }
    return values;
  }

  const collected: Record<string, string | number | boolean> = {};
  for (const param of parameters) {
    const paramValue = await promptParameterValue(param, previousParams?.[param.name]);
    if (paramValue === undefined) {
      return undefined;
    }
    collected[param.name] = paramValue;
  }
  return collected;
}

/**
 * Prompts the user to provide a value for a single job parameter.
 * Returns undefined if user cancels the prompt.
 */
async function promptParameterValue(
  param: JobParameterDefinition,
  recentValue?: string | number | boolean
): Promise<string | number | boolean | undefined> {
  const isChoice =
    (param.choices && param.choices.length > 0) ||
    param.type.toLowerCase().includes('choice');
  const isBoolean =
    param.type.toLowerCase().includes('boolean') ||
    typeof param.defaultValue === 'boolean';
  const isPassword = param.type.toLowerCase().includes('password');

  if (isChoice && param.choices && param.choices.length > 0) {
    const preferredChoice = recentValue !== undefined ? String(recentValue) : param.defaultValue;
    const items = param.choices.map((choice) => ({
      label: choice,
      description:
        choice === preferredChoice
          ? recentValue !== undefined
            ? t('(recent)')
            : t('(default)')
          : undefined
    }));
    const selected = await vscode.window.showQuickPick(items, {
      title: t('Parameter: {name}', { name: param.name }),
      placeHolder: param.description || t('Select choice for {name}', { name: param.name })
    });
    if (!selected) {
      return undefined;
    }
    return selected.label;
  }

  if (isBoolean) {
    const activeValue = recentValue !== undefined ? recentValue : param.defaultValue;
    const isDefaultTrue =
      activeValue === true || activeValue === 'true';
    const isDefaultFalse =
      activeValue === false || activeValue === 'false';

    const items = [
      {
        label: 'true',
        description: isDefaultTrue
          ? recentValue !== undefined
            ? t('(recent)')
            : t('(default)')
          : undefined
      },
      {
        label: 'false',
        description: isDefaultFalse
          ? recentValue !== undefined
            ? t('(recent)')
            : t('(default)')
          : undefined
      }
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: t('Parameter: {name}', { name: param.name }),
      placeHolder: param.description || t('Select value for {name}', { name: param.name })
    });
    if (!selected) {
      return undefined;
    }
    return selected.label === 'true';
  }

  const defaultValue =
    recentValue !== undefined
      ? String(recentValue)
      : param.defaultValue !== undefined && param.defaultValue !== null
        ? String(param.defaultValue)
        : '';

  const input = await vscode.window.showInputBox({
    title: t('Parameter: {name}', { name: param.name }),
    prompt: param.description || t('Enter value for {name}', { name: param.name }),
    value: defaultValue,
    password: isPassword
  });

  return input;
}

/**
 * Handles stopping / aborting a running build on Jenkins.
 */
export async function stopBuildHandler(
  context: BuildCommandsContext,
  target?: StopBuildTarget
): Promise<boolean> {
  const log = asRedactedLog(context.log ?? noopLog);

  let jobFullName: string | undefined;
  let buildNumber: number | undefined;
  let instanceId: string | undefined;

  if (target instanceof JenkinsBuildTreeItem) {
    if (!target.build.building) {
      return false;
    }
    jobFullName = target.jobFullName;
    buildNumber = target.build.number;
    instanceId = target.instanceId;
  } else if (
    target &&
    typeof target === 'object' &&
    'jobFullName' in target &&
    'buildNumber' in target
  ) {
    jobFullName = target.jobFullName;
    buildNumber = target.buildNumber;
    instanceId = target.instanceId;
  }

  if (!jobFullName || buildNumber === undefined) {
    return false;
  }

  if (!instanceId) {
    instanceId = await context.configManager.getActiveInstanceId();
  }

  if (!instanceId) {
    vscode.window.showInformationMessage(t('No active Jenkins controller selected.'));
    return false;
  }

  try {
    const client = await context.clientPool.get(instanceId);
    const instance =
      client.config ?? (await context.configManager.getInstance(instanceId));

    if (instance?.readOnly) {
      vscode.window.showErrorMessage(
        t('Cannot stop build: controller "{label}" is read-only.', {
          label: instance.label || instanceId
        })
      );
      return false;
    }

    const build = await client.getBuild(jobFullName, buildNumber);
    if (!build.building) {
      vscode.window.showInformationMessage(
        t('Build #{number} of "{job}" is not running.', {
          number: buildNumber,
          job: jobFullName
        })
      );
      return false;
    }

    const confirm = await vscode.window.showWarningMessage(
      t('Are you sure you want to stop build #{number} of "{job}"?', {
        number: buildNumber,
        job: jobFullName
      }),
      { modal: true },
      t('Stop Build'),
      t('Cancel')
    );

    if (confirm !== t('Stop Build')) {
      return false;
    }

    await client.stopBuild(jobFullName, buildNumber);

    vscode.window.showInformationMessage(
      t('Stop build requested for "{job} #{number}".', {
        job: jobFullName,
        number: buildNumber
      })
    );

    if (context.jobsTreeProvider) {
      context.jobsTreeProvider.refresh();
    }

    return true;
  } catch (error) {
    log.error(
      `Failed to stop build for ${instanceId}/${jobFullName} #${buildNumber}: ${formatError(error)}`
    );
    vscode.window.showErrorMessage(
      t('Failed to stop build for "{job} #{number}": {error}', {
        job: jobFullName,
        number: buildNumber,
        error: formatError(error)
      })
    );
    return false;
  }
}

/**
 * Registers AT Jenkins build commands with the VS Code extension context.
 */
export function registerBuildCommands(
  extensionContext: vscode.ExtensionContext,
  buildContext: BuildCommandsContext
): vscode.Disposable[] {
  const triggerDisposable = vscode.commands.registerCommand(
    'atJenkins.triggerBuild',
    async (target?: TriggerBuildTarget) => {
      return triggerBuildHandler(buildContext, target);
    }
  );

  const stopDisposable = vscode.commands.registerCommand(
    'atJenkins.stopBuild',
    async (target?: StopBuildTarget) => {
      return stopBuildHandler(buildContext, target);
    }
  );

  extensionContext.subscriptions.push(triggerDisposable, stopDisposable);
  return [triggerDisposable, stopDisposable];
}
