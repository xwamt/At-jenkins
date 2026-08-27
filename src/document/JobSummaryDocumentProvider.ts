import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { JenkinsClientPool } from '../jenkins/JenkinsClientPool';
import type { JobDetail } from '../jenkins/types';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import { parseJenkinsDocumentUri } from './uri';

export class JobSummaryDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly log: AtJenkinsLog;

  constructor(
    private readonly clientPool: JenkinsClientPool,
    options?: { log?: AtJenkinsLog }
  ) {
    this.log = asRedactedLog(options?.log ?? noopLog);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parseJenkinsDocumentUri(uri);
    if (!target || target.type !== 'summary') {
      return `# ${t('Invalid Jenkins job summary URI.')}\n`;
    }

    try {
      const client = await this.clientPool.get(target.instanceId);
      const job = await client.getJob(target.jobFullName);
      return formatJobSummaryMarkdown(job);
    } catch (error) {
      this.log.error(
        `Failed to load job summary for ${target.instanceId}/${target.jobFullName}: ${formatError(error)}`
      );
      return `# ${t('Failed to load job summary for "{job}": {error}', {
        job: target.jobFullName,
        error: formatError(error)
      })}\n`;
    }
  }
}

export function formatJobSummaryMarkdown(job: JobDetail): string {
  const lines: string[] = [
    `# ${job.fullName}`,
    '',
    `- **${t('Class')}:** \`${job._class ?? t('Unknown')}\``,
    `- **${t('URL')}:** ${job.url}`,
    `- **${t('Buildable')}:** ${job.buildable ? t('Yes') : t('No')}`,
    `- **${t('Status')}:** ${job.color ?? t('Unknown')}`
  ];

  if (job.description) {
    lines.push('', `## ${t('Description')}`, '', job.description);
  }

  if (job.parameters?.length) {
    lines.push('', `## ${t('Parameters')}`, '');
    for (const p of job.parameters) {
      const type = p.type ?? 'StringParameterDefinition';
      const isSecret = type.toLowerCase().includes('password') || type.toLowerCase().includes('credential');
      const defaultDisplay = isSecret
        ? t('(hidden)')
        : p.defaultValue === undefined
          ? t('(none)')
          : String(p.defaultValue);
      lines.push(`### ${p.name}`);
      lines.push(`- **${t('Type')}:** \`${type}\``);
      if (p.description) {
        lines.push(`- **${t('Description')}:** ${p.description}`);
      }
      lines.push(`- **${t('Default')}:** ${defaultDisplay}`);
      if (p.choices?.length) {
        lines.push(`- **${t('Choices')}:** ${p.choices.map((c) => `\`${c}\``).join(', ')}`);
      }
      lines.push('');
    }
  } else {
    lines.push('', `## ${t('Parameters')}`, '', t('This job has no parameters.'));
  }

  if (job.lastBuild) {
    lines.push(
      '',
      `## ${t('Last Build')}`,
      '',
      `- **#${job.lastBuild.number}** — ${job.lastBuild.building ? t('Building') : job.lastBuild.result ?? t('Unknown')}`
    );
  }

  return `${lines.join('\n')}\n`;
}
