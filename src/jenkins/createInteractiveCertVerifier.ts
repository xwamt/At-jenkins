import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { JenkinsCertTrustStore, JenkinsCertVerifier } from './JenkinsCertTrustStore';

/**
 * Interactive Trust-On-First-Use (TOFU) verifier for Jenkins TLS certificate fingerprints:
 * - `unknown` (never seen before): prompts once, trusts on accept.
 * - `trusted` (matches the previously-trusted fingerprint): returns true immediately without prompt.
 * - `changed` (fingerprint differs from previously-trusted one): prompts with a security warning,
 *   and fails closed (rejects) unless the user explicitly clicks "Trust New Certificate".
 */
export function createInteractiveCertVerifier(trustStore: JenkinsCertTrustStore): JenkinsCertVerifier {
  return {
    async verify(host: string, port: number, fingerprint256: string): Promise<boolean> {
      const status = await trustStore.check(host, port, fingerprint256);

      if (status === 'trusted') {
        return true;
      }

      if (status === 'changed') {
        const previous = trustStore.getTrusted(host, port);
        const trustAction = t('Trust New Certificate');
        const choice = await vscode.window.showWarningMessage(
          t(
            'SECURITY WARNING: The TLS certificate for Jenkins instance {host}:{port} has CHANGED since it was last trusted.\n\nPreviously trusted fingerprint: {previousFingerprint}\nNew fingerprint presented: {fingerprint}\n\nThis can happen after a legitimate certificate rotation, but it can also indicate a machine-in-the-middle attack. Only continue if you can independently confirm the new fingerprint with whoever administers this Jenkins server.',
            {
              host,
              port,
              previousFingerprint: previous?.fingerprint ?? t('(unknown)'),
              fingerprint: fingerprint256
            }
          ),
          { modal: true },
          trustAction,
          t('Reject')
        );
        if (choice === trustAction) {
          await trustStore.trust(host, port, fingerprint256);
          return true;
        }
        return false;
      }

      // status === 'unknown'
      const trustAction = t('Trust Certificate');
      const choice = await vscode.window.showWarningMessage(
        t(
          'Jenkins instance {host}:{port} presented a TLS certificate that has not been seen before.\n\nFingerprint: {fingerprint}\n\nIf you recognize and trust this Jenkins server (for example, it uses a self-signed or private-CA certificate you administer), you can trust it now. Otherwise, reject the connection.',
          { host, port, fingerprint: fingerprint256 }
        ),
        { modal: true },
        trustAction,
        t('Reject')
      );
      if (choice === trustAction) {
        await trustStore.trust(host, port, fingerprint256);
        return true;
      }
      return false;
    }
  };
}
