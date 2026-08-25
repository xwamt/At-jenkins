/**
 * The userinfo of an absolute URL: everything between `//` and the last `@`
 * of the authority. Bounded by `[^/?#]` so an `@` further along -- in a path
 * segment, or in a query value -- is not mistaken for the delimiter, and
 * greedy so that `http://a@b@host/` cuts at the last one, which is where the
 * WHATWG URL parser puts the boundary.
 */
const URL_USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

/**
 * Removes any `user:password@` from an address.
 */
export function stripUrlCredentials(input: string): string {
  return input.replace(URL_USERINFO_PATTERN, '$1');
}

/**
 * Normalizes a Jenkins base URL by trimming whitespace, stripping userinfo credentials,
 * and removing trailing slashes.
 */
export function normalizeJenkinsBaseUrl(input: string): string {
  return stripUrlCredentials(input.trim()).replace(/\/+$/, '');
}
