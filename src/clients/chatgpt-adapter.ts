import {
  EClientDetection,
  EClientSupport,
  type IClientConfiguration,
  type IClientDetectionResult,
  type IInstallOptions,
  type IInstallResult,
  type IMcpClientAdapter,
  type IVerificationResult,
} from '../models/client-adapter.js';

export class ManualSetupRequiredError extends Error {
  public constructor(public readonly steps: string[]) {
    super('ChatGPT Desktop must be set up by hand; Spotify Curator cannot do it automatically.');
    this.name = 'ManualSetupRequiredError';
  }
}

/**
 * ChatGPT Desktop: status UNVERIFIED. Third-party sources describe a desktop
 * "MCP servers" settings page that accepts a STDIO command, but OpenAI's own
 * documentation could not be read in this build environment and no Windows
 * ChatGPT Desktop install was available. So this adapter never writes files,
 * never touches ChatGPT's internals and never claims success.
 */
export class ChatGptDesktopAdapter implements IMcpClientAdapter {
  public readonly id = 'chatgpt-desktop';
  public readonly name = 'ChatGPT Desktop';
  public readonly support = EClientSupport.Unverified;

  public async detect(): Promise<IClientDetectionResult> {
    return {
      installed: EClientDetection.Unknown,
      support: this.support,
      detail:
        'Automatic setup for ChatGPT Desktop is not available yet: whether your ChatGPT version and plan accept a local MCP program has not been verified. You can try the manual steps below.',
    };
  }

  public async inspect(): Promise<IClientConfiguration> {
    return {
      configPath: null, configExists: false, valid: true, registered: false, upToDate: false, command: null, conflicts: [],
      problems: ['Cannot be checked automatically.'],
    };
  }

  public manualSteps(executablePath: string): string[] {
    return [
      'Open ChatGPT Desktop and go to Settings → MCP servers (the name and location may differ by version; this is unverified).',
      'Add a new server of type STDIO.',
      `Command: ${executablePath}   Arguments: mcp`,
      'Save, then start a new chat and ask it to list its Spotify tools. If your version or plan has no MCP servers setting, local tools are not available there.',
      'Do not use a public web address for this server; Spotify Curator only runs locally.',
    ];
  }

  public async install(options: IInstallOptions): Promise<IInstallResult> {
    throw new ManualSetupRequiredError(this.manualSteps(options.executablePath));
  }

  public async verify(): Promise<IVerificationResult> {
    return {
      ok: false,
      toolCount: null,
      checks: [{ name: 'ChatGPT Desktop integration', ok: false, detail: 'Not verified: Spotify Curator cannot check what ChatGPT Desktop has configured.' }],
    };
  }

  public async uninstall(): Promise<void> {
    // Nothing was written, so there is nothing to remove. Users remove the server in ChatGPT's own settings.
  }
}
