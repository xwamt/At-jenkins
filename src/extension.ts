import * as vscode from 'vscode';
import { JenkinsInstanceConfigManager } from './config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from './config/schema';
import { t } from './i18n/t';
import { createInteractiveCertVerifier } from './jenkins/createInteractiveCertVerifier';
import { JenkinsCertTrustStore } from './jenkins/JenkinsCertTrustStore';
import { JenkinsClientPool } from './jenkins/JenkinsClientPool';
import {
  InstancesTreeProvider,
  JenkinsInstanceTreeItem
} from './tree/InstancesTreeProvider';
import {
  JenkinsBuildsMoreTreeItem,
  JenkinsBuildTreeItem,
  JenkinsJobTreeItem,
  JobsTreeProvider
} from './tree/JobsTreeProvider';
import { formatError } from './utils/errors';
import { createRedactedLog } from './utils/logger';
import { JenkinsInstancePanel } from './webview/JenkinsInstancePanel';
import { disposeOpenPanels } from './webview/openPanels';

let clientPool: JenkinsClientPool | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('AT Jenkins', { log: true });
  context.subscriptions.push(outputChannel);

  const log = createRedactedLog(outputChannel);
  const configManager = new JenkinsInstanceConfigManager(context.globalState, context.secrets, log);
  const trustStore = new JenkinsCertTrustStore(context.globalState);
  const certVerifier = createInteractiveCertVerifier(trustStore);
  clientPool = new JenkinsClientPool(configManager, { certVerifier, log });

  const instancesTreeProvider = new InstancesTreeProvider(configManager);
  const instancesTreeView = vscode.window.createTreeView('atJenkins.instances', {
    treeDataProvider: instancesTreeProvider
  });
  context.subscriptions.push(instancesTreeView);

  const jobsTreeProvider = new JobsTreeProvider(configManager, clientPool, { log });
  const jobsTreeView = vscode.window.createTreeView('atJenkins.jobs', {
    treeDataProvider: jobsTreeProvider
  });
  context.subscriptions.push(jobsTreeView);

  const refreshAll = (): void => {
    instancesTreeProvider.refresh();
    jobsTreeProvider.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('atJenkins.addInstance', async () => {
      await JenkinsInstancePanel.open(
        context,
        configManager,
        refreshAll,
        undefined,
        { certVerifier, log }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.editInstance',
      async (target?: JenkinsInstanceTreeItem | JenkinsInstanceConfig | string) => {
        let instance: JenkinsInstanceConfig | undefined;
        if (typeof target === 'string') {
          instance = await configManager.getInstance(target);
        } else if (target instanceof JenkinsInstanceTreeItem) {
          instance = target.instance;
        } else if (target && typeof target === 'object' && 'id' in target) {
          instance = target as JenkinsInstanceConfig;
        } else {
          const instances = await configManager.listInstances();
          if (instances.length === 0) {
            vscode.window.showInformationMessage(t('No Jenkins controllers configured.'));
            return;
          }
          const items = instances.map((inst) => ({
            label: inst.label,
            description: inst.baseUrl,
            instance: inst
          }));
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: t('Select a Jenkins controller to edit')
          });
          if (!selected) {
            return;
          }
          instance = selected.instance;
        }

        if (!instance) {
          return;
        }

        await JenkinsInstancePanel.open(
          context,
          configManager,
          refreshAll,
          instance,
          { certVerifier, log }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.deleteInstance',
      async (target?: JenkinsInstanceTreeItem | JenkinsInstanceConfig | string) => {
        let instance: JenkinsInstanceConfig | undefined;
        if (typeof target === 'string') {
          instance = await configManager.getInstance(target);
        } else if (target instanceof JenkinsInstanceTreeItem) {
          instance = target.instance;
        } else if (target && typeof target === 'object' && 'id' in target) {
          instance = target as JenkinsInstanceConfig;
        } else {
          const instances = await configManager.listInstances();
          if (instances.length === 0) {
            vscode.window.showInformationMessage(t('No Jenkins controllers configured.'));
            return;
          }
          const items = instances.map((inst) => ({
            label: inst.label,
            description: inst.baseUrl,
            instance: inst
          }));
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: t('Select a Jenkins controller to delete')
          });
          if (!selected) {
            return;
          }
          instance = selected.instance;
        }

        if (!instance) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          t('Are you sure you want to delete controller "{label}"?', { label: instance.label }),
          { modal: true },
          t('Delete')
        );
        if (confirm !== t('Delete')) {
          return;
        }

        await configManager.deleteInstance(instance.id);
        clientPool?.evict(instance.id);
        refreshAll();
        vscode.window.showInformationMessage(t('Controller "{label}" deleted.', { label: instance.label }));
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.testConnection',
      async (target?: JenkinsInstanceTreeItem | JenkinsInstanceConfig | string) => {
        let instance: JenkinsInstanceConfig | undefined;
        if (typeof target === 'string') {
          instance = await configManager.getInstance(target);
        } else if (target instanceof JenkinsInstanceTreeItem) {
          instance = target.instance;
        } else if (target && typeof target === 'object' && 'id' in target) {
          instance = target as JenkinsInstanceConfig;
        } else {
          const instances = await configManager.listInstances();
          if (instances.length === 0) {
            vscode.window.showInformationMessage(t('No Jenkins controllers configured.'));
            return;
          }
          const items = instances.map((inst) => ({
            label: inst.label,
            description: inst.baseUrl,
            instance: inst
          }));
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: t('Select a Jenkins controller to test')
          });
          if (!selected) {
            return;
          }
          instance = selected.instance;
        }

        if (!instance || !clientPool) {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('Testing connection to Jenkins controller "{label}"...', { label: instance.label }),
            cancellable: false
          },
          async () => {
            try {
              const client = await clientPool!.get(instance.id);
              const result = await client.testConnection();
              const nodeInfo = result.nodeName ? ` (${result.nodeName})` : '';
              vscode.window.showInformationMessage(
                t('Successfully connected to Jenkins controller "{label}"{nodeInfo}.', {
                  label: instance.label,
                  nodeInfo
                })
              );
            } catch (error) {
              vscode.window.showErrorMessage(
                t('Failed to connect to Jenkins controller "{label}": {error}', {
                  label: instance.label,
                  error: formatError(error)
                })
              );
            }
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('atJenkins.refreshInstances', () => {
      instancesTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.setActiveInstance',
      async (target?: JenkinsInstanceTreeItem | JenkinsInstanceConfig | string) => {
        let instanceId: string | undefined;
        if (typeof target === 'string') {
          instanceId = target;
        } else if (target instanceof JenkinsInstanceTreeItem) {
          instanceId = target.instance.id;
        } else if (target && typeof target === 'object' && 'id' in target) {
          instanceId = target.id;
        } else {
          const instances = await configManager.listInstances();
          if (instances.length === 0) {
            vscode.window.showInformationMessage(t('No Jenkins controllers configured.'));
            return;
          }
          const currentActiveId = await configManager.getActiveInstanceId();
          const items = instances.map((inst) => ({
            label: inst.label,
            description: inst.baseUrl,
            detail: inst.id === currentActiveId ? t('Current Active Controller') : undefined,
            instanceId: inst.id
          }));
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: t('Select a Jenkins controller to activate')
          });
          if (!selected) {
            return;
          }
          instanceId = selected.instanceId;
        }

        if (!instanceId) {
          return;
        }

        await configManager.setActiveInstanceId(instanceId);
        refreshAll();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('atJenkins.refreshJobs', () => {
      jobsTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.loadMoreBuilds',
      (target?: JenkinsJobTreeItem | JenkinsBuildsMoreTreeItem | string) => {
        if (target) {
          jobsTreeProvider.loadMoreBuilds(target);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.openPipelineScript',
      async (target?: JenkinsJobTreeItem | string) => {
        const jobFullName =
          typeof target === 'string'
            ? target
            : target instanceof JenkinsJobTreeItem
              ? target.job.fullName
              : undefined;
        if (!jobFullName) {
          return;
        }
        vscode.window.showInformationMessage(
          t('Open Pipeline Script for "{job}"', { job: jobFullName })
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.openBuildLog',
      async (target?: JenkinsBuildTreeItem | { jobFullName: string; buildNumber: number }) => {
        let info: { jobFullName: string; buildNumber: number } | undefined;
        if (target instanceof JenkinsBuildTreeItem) {
          info = { jobFullName: target.jobFullName, buildNumber: target.build.number };
        } else if (
          target &&
          typeof target === 'object' &&
          'jobFullName' in target &&
          'buildNumber' in target
        ) {
          info = target;
        }
        if (!info) {
          return;
        }
        vscode.window.showInformationMessage(
          t('Open Build Log for "{job} #{build}"', {
            job: info.jobFullName,
            build: info.buildNumber
          })
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.triggerBuild',
      async (target?: JenkinsJobTreeItem | string) => {
        const jobFullName =
          typeof target === 'string'
            ? target
            : target instanceof JenkinsJobTreeItem
              ? target.job.fullName
              : undefined;
        if (!jobFullName) {
          return;
        }
        vscode.window.showInformationMessage(
          t('Trigger Build for "{job}"', { job: jobFullName })
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.stopBuild',
      async (target?: JenkinsBuildTreeItem | { jobFullName: string; buildNumber: number }) => {
        let info: { jobFullName: string; buildNumber: number } | undefined;
        if (target instanceof JenkinsBuildTreeItem) {
          info = { jobFullName: target.jobFullName, buildNumber: target.build.number };
        } else if (
          target &&
          typeof target === 'object' &&
          'jobFullName' in target &&
          'buildNumber' in target
        ) {
          info = target;
        }
        if (!info) {
          return;
        }
        vscode.window.showInformationMessage(
          t('Stop Build for "{job} #{build}"', {
            job: info.jobFullName,
            build: info.buildNumber
          })
        );
      }
    )
  );
}

export function deactivate(): void {
  disposeOpenPanels();
  clientPool?.clear();
  clientPool = undefined;
}
