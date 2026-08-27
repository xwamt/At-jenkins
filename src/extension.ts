import * as vscode from 'vscode';
import { detectHostApp } from '@at-series/mcp-hub';
import { JenkinsAgentToolService } from './agent/JenkinsAgentToolService';
import { BridgeServer } from './mcp/BridgeServer';
import { syncPackagedHub } from './mcp/hubSync';
import { ensureAtSeriesConfigForCurrentIde } from './mcp/McpConfigInstaller';
import { JenkinsInstanceConfigManager } from './config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from './config/schema';
import { readAtJenkinsSettings } from './config/settings';
import { t } from './i18n/t';
import { createInteractiveCertVerifier } from './jenkins/createInteractiveCertVerifier';
import { JenkinsCertTrustStore } from './jenkins/JenkinsCertTrustStore';
import { JenkinsClientPool } from './jenkins/JenkinsClientPool';
import { BuildLogDocumentProvider } from './document/BuildLogDocumentProvider';
import { JENKINS_DRAFT_SCHEME } from './document/draftUri';
import { JenkinsPipelineDraftFileSystemProvider } from './document/JenkinsPipelineDraftFileSystemProvider';
import { JobSummaryDocumentProvider } from './document/JobSummaryDocumentProvider';
import { openPipelineScriptDocument } from './document/openPipelineScriptDocument';
import { PipelineScriptDocumentProvider } from './document/PipelineScriptDocumentProvider';
import {
  buildBuildLogUri,
  buildJobSummaryUri,
  JENKINS_DOCUMENT_SCHEME,
  parseJenkinsDocumentUri
} from './document/uri';
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
import { registerBuildCommands } from './commands/buildCommands';
import { JenkinsBuildFollowService } from './commands/buildFollow';
import { openInJenkinsHandler } from './commands/openInJenkins';
import { JenkinsStatusBarManager } from './utils/statusBar';
import { JenkinsInstancePanel } from './webview/JenkinsInstancePanel';
import { disposeOpenPanels } from './webview/openPanels';

let extensionCleanup: { dispose(): Promise<void> } | undefined;
let clientPool: JenkinsClientPool | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('AT Jenkins', { log: true });
  context.subscriptions.push(outputChannel);

  const log = createRedactedLog(outputChannel);
  const configManager = new JenkinsInstanceConfigManager(context.globalState, context.secrets, log);
  const trustStore = new JenkinsCertTrustStore(context.globalState);
  const certVerifier = createInteractiveCertVerifier(trustStore);
  clientPool = new JenkinsClientPool(configManager, { certVerifier, log });

  const statusBar = new JenkinsStatusBarManager();
  context.subscriptions.push(statusBar);

  const syncStatusBar = async (): Promise<void> => {
    try {
      const active = await configManager.getActiveInstance();
      statusBar.updateActiveInstance(active?.label);
    } catch {
      statusBar.updateActiveInstance(undefined);
    }
  };
  void syncStatusBar();

  const settings = readAtJenkinsSettings();

  const instancesTreeProvider = new InstancesTreeProvider(configManager);
  const instancesTreeView = vscode.window.createTreeView('atJenkins.instances', {
    treeDataProvider: instancesTreeProvider
  });
  context.subscriptions.push(instancesTreeView);

  const jobsTreeProvider = new JobsTreeProvider(configManager, clientPool, {
    log,
    pageSize: settings.buildsPageSize
  });
  const jobsTreeView = vscode.window.createTreeView('atJenkins.jobs', {
    treeDataProvider: jobsTreeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(jobsTreeView);

  const followService = new JenkinsBuildFollowService({
    pollIntervalMs: settings.followPollIntervalMs,
    maxPolls: settings.followMaxPolls
  });
  context.subscriptions.push(followService);

  const syncJobsViewChrome = async (): Promise<void> => {
    try {
      const active = await configManager.getActiveInstance();
      jobsTreeView.description = active?.label;
      jobsTreeView.message = active
        ? t('Controller: {label}', { label: active.label })
        : undefined;
    } catch {
      jobsTreeView.description = undefined;
      jobsTreeView.message = undefined;
    }
  };
  void syncJobsViewChrome();

  const draftFileSystemProvider = new JenkinsPipelineDraftFileSystemProvider();
  const pipelineScriptProvider = new PipelineScriptDocumentProvider(
    clientPool,
    configManager,
    { log, draftProvider: draftFileSystemProvider }
  );
  const buildLogProvider = new BuildLogDocumentProvider(clientPool, {
    log,
    pollIntervalMs: settings.logPollIntervalMs,
    uiLogTailBytes: settings.uiLogTailBytes
  });
  const jobSummaryProvider = new JobSummaryDocumentProvider(clientPool, { log });

  const combinedContentProvider: vscode.TextDocumentContentProvider = {
    onDidChange: (listener) => {
      const d1 = pipelineScriptProvider.onDidChange(listener);
      const d2 = buildLogProvider.onDidChange(listener);
      return {
        dispose: () => {
          d1.dispose();
          d2.dispose();
        }
      };
    },
    provideTextDocumentContent: (uri: vscode.Uri) => {
      const target = parseJenkinsDocumentUri(uri);
      if (target?.type === 'script') {
        return pipelineScriptProvider.provideTextDocumentContent(uri);
      }
      if (target?.type === 'log') {
        return buildLogProvider.provideTextDocumentContent(uri);
      }
      if (target?.type === 'summary') {
        return jobSummaryProvider.provideTextDocumentContent(uri);
      }
      return `// ${t('Invalid Jenkins document URI.')}\n`;
    }
  };

  context.subscriptions.push(
    // Match nacos-draft: do not pass isReadonly (writable FS by default).
    vscode.workspace.registerFileSystemProvider(JENKINS_DRAFT_SCHEME, draftFileSystemProvider, {
      isCaseSensitive: true
    })
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      JENKINS_DOCUMENT_SCHEME,
      combinedContentProvider
    )
  );
  context.subscriptions.push(pipelineScriptProvider);
  context.subscriptions.push(buildLogProvider);
  context.subscriptions.push(draftFileSystemProvider);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (
        document.uri.scheme === JENKINS_DRAFT_SCHEME ||
        document.uri.scheme === JENKINS_DOCUMENT_SCHEME
      ) {
        await pipelineScriptProvider.savePipelineScript(document);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === JENKINS_DOCUMENT_SCHEME) {
        buildLogProvider.handleDidCloseTextDocument(document);
      }
    })
  );

  const refreshAll = (): void => {
    instancesTreeProvider.refresh();
    jobsTreeProvider.refresh();
    void syncStatusBar();
    void syncJobsViewChrome();
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
      async (target?: JenkinsJobTreeItem | { instanceId?: string; jobFullName: string } | string) => {
        let jobFullName: string | undefined;
        let instanceId: string | undefined;

        if (typeof target === 'string') {
          jobFullName = target;
        } else if (target instanceof JenkinsJobTreeItem) {
          jobFullName = target.job.fullName;
          instanceId = target.instanceId;
        } else if (target && typeof target === 'object' && 'jobFullName' in target) {
          jobFullName = target.jobFullName;
          instanceId = target.instanceId;
        }

        if (!jobFullName) {
          return;
        }

        if (!instanceId) {
          instanceId = await configManager.getActiveInstanceId();
        }

        if (!instanceId || !clientPool) {
          vscode.window.showInformationMessage(t('No active Jenkins controller selected.'));
          return;
        }

        try {
          await openPipelineScriptDocument({
            instanceId,
            jobFullName,
            clientPool,
            draftProvider: draftFileSystemProvider
          });
        } catch (error) {
          vscode.window.showErrorMessage(
            t('Failed to open pipeline script: {error}', { error: formatError(error) })
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.openJobSummary',
      async (target?: JenkinsJobTreeItem | { instanceId?: string; jobFullName: string } | string) => {
        let jobFullName: string | undefined;
        let instanceId: string | undefined;

        if (typeof target === 'string') {
          jobFullName = target;
        } else if (target instanceof JenkinsJobTreeItem) {
          jobFullName = target.job.fullName;
          instanceId = target.instanceId;
        } else if (target && typeof target === 'object' && 'jobFullName' in target) {
          jobFullName = target.jobFullName;
          instanceId = target.instanceId;
        }

        if (!jobFullName) {
          return;
        }

        if (!instanceId) {
          instanceId = await configManager.getActiveInstanceId();
        }

        if (!instanceId) {
          vscode.window.showInformationMessage(t('No active Jenkins controller selected.'));
          return;
        }

        const uri = buildJobSummaryUri(instanceId, jobFullName);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        try {
          await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
        } catch {
          // ignore
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.openBuildLog',
      async (
        target?:
          | JenkinsBuildTreeItem
          | { instanceId?: string; jobFullName: string; buildNumber: number }
      ) => {
        let info: { instanceId?: string; jobFullName: string; buildNumber: number } | undefined;
        if (target instanceof JenkinsBuildTreeItem) {
          info = {
            instanceId: target.instanceId,
            jobFullName: target.jobFullName,
            buildNumber: target.build.number
          };
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

        let instanceId = info.instanceId;
        if (!instanceId) {
          instanceId = await configManager.getActiveInstanceId();
        }

        if (!instanceId) {
          vscode.window.showInformationMessage(t('No active Jenkins controller selected.'));
          return;
        }

        const uri = buildBuildLogUri(instanceId, info.jobFullName, info.buildNumber);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        try {
          await vscode.languages.setTextDocumentLanguage(doc, 'log');
        } catch {
          // ignore
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.followBuildLogInOutput',
      async (
        target?:
          | JenkinsBuildTreeItem
          | { instanceId?: string; jobFullName: string; buildNumber: number }
      ) => {
        let info: { instanceId?: string; jobFullName: string; buildNumber: number } | undefined;
        if (target instanceof JenkinsBuildTreeItem) {
          info = {
            instanceId: target.instanceId,
            jobFullName: target.jobFullName,
            buildNumber: target.build.number
          };
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

        let instanceId = info.instanceId;
        if (!instanceId) {
          instanceId = await configManager.getActiveInstanceId();
        }

        if (!instanceId) {
          vscode.window.showInformationMessage(t('No active Jenkins controller selected.'));
          return;
        }

        const disposable = await buildLogProvider.followBuildLogInOutput(
          instanceId,
          info.jobFullName,
          info.buildNumber,
          outputChannel
        );
        context.subscriptions.push(disposable);
      }
    )
  );

  registerBuildCommands(context, {
    configManager,
    clientPool,
    jobsTreeProvider,
    statusBar,
    followService,
    globalState: context.globalState,
    log
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'atJenkins.openInJenkins',
      async (target?: Parameters<typeof openInJenkinsHandler>[0]) => {
        return openInJenkinsHandler(target, configManager);
      }
    )
  );

  const toolService = new JenkinsAgentToolService({
    configManager,
    clientPool,
    log
  });

  const hostEnv = {
    appName: vscode.env.appName,
    appRoot: vscode.env.appRoot,
    uriScheme: vscode.env.uriScheme,
    extensionPath: context.extensionUri.fsPath
  };
  const hostApp = detectHostApp(hostEnv);
  const currentWorkspaceFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const bridgeServer = new BridgeServer({
    hostApp,
    pluginVersion:
      typeof context.extension?.packageJSON?.version === 'string'
        ? context.extension.packageJSON.version
        : undefined,
    toolService,
    log
  });
  void bridgeServer.start().catch((error) => {
    log.error(`bridge: failed to start: ${formatError(error)}`);
  });

  const hubReady = syncPackagedHub(context)
    .then((result) => {
      log.info(`hub-sync: ok (updated=${result.updated}, active=${result.activeVersion})`);
      return result;
    })
    .catch((error) => {
      log.error(`hub-sync: failed: ${formatError(error)}`);
    });

  void hubReady
    .then(() => ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() }))
    .catch((error) => {
      log.error(`mcp-config: could not be updated: ${formatError(error)}`);
    });

  let disposed = false;
  const cleanup = {
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
      }
      await bridgeServer.stop().catch(() => undefined);
      disposeOpenPanels();
      clientPool?.clear();
      clientPool = undefined;
      log.info('deactivate: AT Jenkins shut down');
    }
  };
  extensionCleanup = cleanup;
}

export async function deactivate(): Promise<void> {
  await extensionCleanup?.dispose();
}

