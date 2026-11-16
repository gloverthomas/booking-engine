/**
 * The OAuth authorize endpoint sends a signed-out user to /login with the original request in the query, plus a
 * signature (`sig`) and the list of signed parameter names (`ba_param`). Sign-in must hand exactly those
 * parameters back (as `oauth_query`) for Better Auth to resume the authorization once the user is in.
 * Mirrors Better Auth's own client helper; anything unsigned (like our `error` param) is left out.
 */
const SIGNATURE = "sig";
const SIGNED_NAMES = "ba_param";

export type SearchParams = Record<string, string | string[] | undefined>;

export function signedOAuthQuery(params: SearchParams): string | undefined {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      search.append(key, v);
    }
  }
  if (!search.has(SIGNATURE)) return undefined;
  const names = new Set(search.getAll(SIGNED_NAMES));
  if (names.size === 0) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of search.entries()) {
    if (key === SIGNATURE || key === SIGNED_NAMES || names.has(key)) signed.append(key, value);
  }
  return signed.toString();
}
