import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import {
  ECredentialStoreErrorCode,
  type ICredentialStore,
  type ISecretProtector,
  type IStoredCredentials,
} from '../models/auth.js';
import { writeFileAtomic } from './settings.js';

export class CredentialStoreError extends Error {
  public constructor(
    public readonly code: ECredentialStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

/**
 * Stores credentials as a DPAPI-protected blob in the user's local app data.
 * The protector binds the blob to the current Windows user, so another user
 * (or a copied file on another machine) cannot decrypt it.
 */
export class ProtectedFileCredentialStore implements ICredentialStore {
  public constructor(
    private readonly path: string,
    private readonly protector: ISecretProtector,
  ) {}

  public async load(): Promise<IStoredCredentials | null> {
    let blob: string;
    try {
      blob = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CredentialStoreError(ECredentialStoreErrorCode.Io, 'The credential file could not be read.');
    }
    let plaintext: string;
    try {
      plaintext = await this.protector.unprotect(blob.trim());
    } catch (error) {
      throw new CredentialStoreError(
        ECredentialStoreErrorCode.Protection,
        error instanceof PowerShellUnavailableError
          ? 'Windows PowerShell could not be started, which is needed to unlock the saved sign-in.'
          : 'Windows could not unlock the saved sign-in (it may belong to a different Windows user).',
      );
    }
    try {
      const parsed = JSON.parse(plaintext) as Partial<IStoredCredentials>;
      if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken || !Array.isArray(parsed.scopes)) {
        throw new Error('shape');
      }
      return parsed as IStoredCredentials;
    } catch {
      throw new CredentialStoreError(ECredentialStoreErrorCode.Corrupt, 'The saved sign-in is damaged.');
    }
  }

  public async save(credentials: IStoredCredentials): Promise<void> {
    let blob: string;
    try {
      blob = await this.protector.protect(JSON.stringify(credentials));
    } catch (error) {
      throw new CredentialStoreError(
        ECredentialStoreErrorCode.Protection,
        error instanceof PowerShellUnavailableError
          ? 'Windows PowerShell could not be started, which is needed to save the sign-in securely.'
          : 'Windows could not encrypt the sign-in.',
      );
    }
    try {
      await writeFileAtomic(this.path, `${blob}\n`);
    } catch {
      throw new CredentialStoreError(ECredentialStoreErrorCode.Io, 'The credential file could not be written.');
    }
  }

  public async delete(): Promise<void> {
    try {
      await rm(this.path, { force: true });
    } catch {
      throw new CredentialStoreError(ECredentialStoreErrorCode.Io, 'The credential file could not be removed.');
    }
  }
}

const PROTECT_SCRIPT =
  "Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($i); " +
  "$o=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Convert]::ToBase64String($o)";
const UNPROTECT_SCRIPT = PROTECT_SCRIPT.replace('::Protect(', '::Unprotect(');

/** Windows DPAPI (CurrentUser scope) through the built-in Windows PowerShell. Secrets go over stdin, never argv. */
export class WindowsDpapiProtector implements ISecretProtector {
  public constructor(private readonly run = runPowerShell) {}

  public protect(plaintext: string): Promise<string> {
    return this.run(PROTECT_SCRIPT, Buffer.from(plaintext, 'utf8').toString('base64'));
  }

  public async unprotect(protectedText: string): Promise<string> {
    return Buffer.from(await this.run(UNPROTECT_SCRIPT, protectedText), 'base64').toString('utf8');
  }
}

export class PowerShellUnavailableError extends Error {
  public constructor() {
    super('powershell-unavailable');
    this.name = 'PowerShellUnavailableError';
  }
}

/**
 * Absolute path to the built-in Windows PowerShell. Some MCP clients start servers with a
 * stripped environment (no PATH), so the bare name `powershell.exe` cannot be relied on.
 */
export function getPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? 'C:\\Windows';
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Child environment that always has a usable PATH and SystemRoot, whatever the parent passed. */
export function buildPowerShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? 'C:\\Windows';
  const system32 = win32.join(root, 'System32');
  const existing = env.PATH ?? env.Path ?? '';
  return { ...env, SystemRoot: root, PATH: existing ? `${system32};${existing}` : system32 };
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      getPowerShellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: buildPowerShellEnv() },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.on('error', () => reject(new PowerShellUnavailableError()));
    child.on('close', (code) => (code === 0 ? resolve(output.trim()) : reject(new Error('powershell failed'))));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/** Fails every operation with a clear message; used where secure storage is not implemented. */
class UnsupportedCredentialStore implements ICredentialStore {
  private fail(): never {
    throw new CredentialStoreError(
      ECredentialStoreErrorCode.Unsupported,
      'Secure credential storage is only implemented for Windows.',
    );
  }
  public async load(): Promise<IStoredCredentials | null> {
    return this.fail();
  }
  public async save(): Promise<void> {
    return this.fail();
  }
  public async delete(): Promise<void> {
    return this.fail();
  }
}

export function createDefaultCredentialStore(path: string): ICredentialStore {
  return process.platform === 'win32'
    ? new ProtectedFileCredentialStore(path, new WindowsDpapiProtector())
    : new UnsupportedCredentialStore();
}
