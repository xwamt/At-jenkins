import { describe, expect, it } from 'vitest';
import { normalizeJenkinsBaseUrl, stripUrlCredentials } from '../../src/utils/url';

describe('normalizeJenkinsBaseUrl', () => {
  it('strips trailing slashes and URL userinfo', () => {
    expect(normalizeJenkinsBaseUrl('https://admin:secret@ci.example.com:8443/jenkins/')).toBe(
      'https://ci.example.com:8443/jenkins'
    );
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeJenkinsBaseUrl('http://ci.example.com:8080///')).toBe(
      'http://ci.example.com:8080'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeJenkinsBaseUrl('  https://ci.example.com/jenkins  ')).toBe(
      'https://ci.example.com/jenkins'
    );
  });

  it('strips username-only userinfo', () => {
    expect(normalizeJenkinsBaseUrl('http://admin@jenkins.local:8080/')).toBe(
      'http://jenkins.local:8080'
    );
  });

  it('leaves an @ in the path alone', () => {
    expect(normalizeJenkinsBaseUrl('http://jenkins.local:8080/job@folder/')).toBe(
      'http://jenkins.local:8080/job@folder'
    );
  });
});

describe('stripUrlCredentials', () => {
  it('removes a username and password', () => {
    expect(stripUrlCredentials('http://admin:hunter2@ci.example.com:8080/jenkins')).toBe(
      'http://ci.example.com:8080/jenkins'
    );
  });

  it('removes a username on its own', () => {
    expect(stripUrlCredentials('http://admin@ci.example.com:8080/jenkins')).toBe(
      'http://ci.example.com:8080/jenkins'
    );
  });

  it('removes an empty userinfo delimiter', () => {
    expect(stripUrlCredentials('http://@ci.example.com:8080')).toBe(
      'http://ci.example.com:8080'
    );
  });

  it('leaves an address without userinfo untouched', () => {
    expect(stripUrlCredentials('https://ci.example.com:8443/jenkins')).toBe(
      'https://ci.example.com:8443/jenkins'
    );
  });

  it('cuts at the last @ of authority', () => {
    expect(stripUrlCredentials('http://admin:pass@word@ci.example.com:8080/jenkins')).toBe(
      'http://ci.example.com:8080/jenkins'
    );
  });

  it('leaves @ in path, query, and fragment alone', () => {
    expect(stripUrlCredentials('http://h:8080/job@folder?tag=a@b#ref@c')).toBe(
      'http://h:8080/job@folder?tag=a@b#ref@c'
    );
  });

  it('keeps IPv6 literal intact', () => {
    expect(stripUrlCredentials('http://admin:secret@[2001:db8::1]:8080/jenkins')).toBe(
      'http://[2001:db8::1]:8080/jenkins'
    );
  });
});
