import { describe, expect, it } from 'vitest';
import { WindowsDpapiProtector } from '../../src/auth/credential-store.js';

// Real DPAPI through the built-in Windows PowerShell; runs only on Windows (CI windows-latest).
describe.skipIf(process.platform !== 'win32')('real Windows DPAPI protector', () => {
  const secret = 'refresh-token-for-test-only';

  it('round-trips a secret and does not store it in plaintext', async () => {
    const protector = new WindowsDpapiProtector();
    const blob = await protector.protect(secret);
    expect(blob).not.toContain(secret);
    expect(await protector.unprotect(blob)).toBe(secret);
  }, 30_000);

  it('still works when the parent passes no PATH (some MCP clients strip the environment)', async () => {
    const protector = new WindowsDpapiProtector();
    const blob = await protector.protect(secret);
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    delete process.env.PATH;
    delete process.env.Path;
    try {
      expect(await protector.unprotect(blob)).toBe(secret);
    } finally {
      if (saved.PATH !== undefined) process.env.PATH = saved.PATH;
    }
  }, 30_000);
});
