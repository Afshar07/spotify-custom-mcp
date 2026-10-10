const PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  [/("?(?:access_token|refresh_token|client_secret|code|code_verifier|id_token)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1[redacted]'],
  [/(authorization"?\s*[:=]\s*"?)[^"\n]+/gi, '$1[redacted]'],
];

/** Strips tokens, secrets, authorization codes and auth headers from diagnostic text. */
export function redact(text: string): string {
  return PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}
