import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProtectedFileCredentialStore, WindowsDpapiProtector } from '../../src/auth/credential-store.js';
import { ECredentialStoreErrorCode, type IStoredCredentials } from '../../src/models/auth.js';
import { FakeUserProtector } from '../helpers/auth-fakes.js';

const credentials: IStoredCredentials = {
  refreshToken: 'super-secret-refresh',
  scopes: ['user-library-read'],
  obtainedAt: '2026-01-01T00:00:00.000Z',
  account: { id: 'u1', displayName: 'Listener' },
};

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'curator-cred-')), 'credentials.bin');
}

describe('ProtectedFileCredentialStore', () => {
  it('saves, loads, replaces a rotated token, and deletes', async () => {
    const path = await tempFile();
    const store = new ProtectedFileCredentialStore(path, new FakeUserProtector('alice'));
    expect(await store.load()).toBeNull();
    await store.save(credentials);
    expect(await store.load()).toEqual(credentials);
    await store.save({ ...credentials, refreshToken: 'rotated' });
    expect((await store.load())?.refreshToken).toBe('rotated');
    await store.delete();
    expect(await store.load()).toBeNull();
    await store.delete(); // idempotent
  });

  it('never writes the token in plaintext', async () => {
    const path = await tempFile();
    await new ProtectedFileCredentialStore(path, new FakeUserProtector('alice')).save(credentials);
    expect(await readFile(path, 'utf8')).not.toContain('super-secret-refresh');
  });

  it("cannot be unlocked by a different Windows user's protector", async () => {
    const path = await tempFile();
    await new ProtectedFileCredentialStore(path, new FakeUserProtector('alice')).save(credentials);
    await expect(new ProtectedFileCredentialStore(path, new FakeUserProtector('bob')).load()).rejects.toMatchObject({
      code: ECredentialStoreErrorCode.Protection,
    });
  });

  it('fails safely on a corrupt or tampered file without leaking contents', async () => {
    const path = await tempFile();
    const protector = new FakeUserProtector('alice');
    await writeFile(path, await protector.protect('{"not":"credentials"}'));
    const store = new ProtectedFileCredentialStore(path, protector);
    await expect(store.load()).rejects.toMatchObject({ code: ECredentialStoreErrorCode.Corrupt });
    await writeFile(path, 'garbage');
    await expect(store.load()).rejects.toMatchObject({ code: ECredentialStoreErrorCode.Protection });
  });

  it('reports a write failure as an Io error', async () => {
    const blocker = await tempFile();
    await writeFile(blocker, 'a file, not a directory');
    const store = new ProtectedFileCredentialStore(join(blocker, 'cred.bin'), new FakeUserProtector('a'));
    await expect(store.save(credentials)).rejects.toMatchObject({ code: ECredentialStoreErrorCode.Io });
  });
});

describe('WindowsDpapiProtector', () => {
  it('sends secrets over stdin as base64, never in the script text', async () => {
    const calls: Array<{ script: string; input: string }> = [];
    const protector = new WindowsDpapiProtector(async (script, input) => {
      calls.push({ script, input });
      return 'PROTECTED';
    });
    await protector.protect('top-secret');
    expect(calls[0].script).toContain('Protect');
    expect(calls[0].script).toContain("'CurrentUser'");
    expect(calls[0].script).not.toContain('top-secret');
    expect(Buffer.from(calls[0].input, 'base64').toString()).toBe('top-secret');
  });

  it('decodes the unprotected output', async () => {
    const protector = new WindowsDpapiProtector(async () => Buffer.from('hello').toString('base64'));
    await expect(protector.unprotect('blob')).resolves.toBe('hello');
  });
});
