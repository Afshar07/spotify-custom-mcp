import { describe, expect, it } from 'vitest';
import { deriveCodeChallenge, generatePkcePair, generateState } from '../../src/auth/pkce.js';
import { redact } from '../../src/auth/redact.js';

describe('PKCE', () => {
  it('derives the RFC 7636 S256 challenge', () => {
    expect(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates verifiers within 43-128 unreserved characters and matching challenges', () => {
    const pair = generatePkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.challenge).toBe(deriveCodeChallenge(pair.verifier));
    expect(generatePkcePair().verifier).not.toBe(pair.verifier);
  });

  it('generates unique, url-safe state values', () => {
    const states = new Set(Array.from({ length: 50 }, generateState));
    expect(states.size).toBe(50);
    expect([...states][0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('redact', () => {
  it('removes tokens, secrets, codes and auth headers', () => {
    const text =
      'Authorization: Bearer abc.def-123 {"access_token":"AT1","refresh_token":"RT1"} client_secret=S3 code=CODE9&state=x Basic dXNlcjpwYXNz';
    const out = redact(text);
    for (const secret of ['abc.def-123', 'AT1', 'RT1', 'S3', 'CODE9', 'dXNlcjpwYXNz']) {
      expect(out).not.toContain(secret);
    }
  });
});
