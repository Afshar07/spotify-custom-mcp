import { createHash, randomBytes } from 'node:crypto';
import type { IPkcePair } from '../models/auth.js';

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** RFC 7636: 43-128 characters from the unreserved set; 64 random bytes give 86. */
export function generatePkcePair(): IPkcePair {
  const verifier = base64Url(randomBytes(64));
  return { verifier, challenge: deriveCodeChallenge(verifier) };
}

export function deriveCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function generateState(): string {
  return base64Url(randomBytes(32));
}
