import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IMcpHandshakeResult } from '../models/client-adapter.js';

/**
 * Launches an MCP server exactly as a client would (stdio), initializes it, and lists
 * tools. This proves registration + startup only; it says nothing about Spotify auth.
 */
export async function performMcpHandshake(
  command: string[],
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<IMcpHandshakeResult> {
  const [executable, ...args] = command;
  if (!executable) throw new Error('The MCP command is empty.');
  const transport = new StdioClientTransport({
    command: executable,
    args,
    env: { ...getDefaultEnvironment(), ...options.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'spotify-curator-verify', version: '1.0.0' });
  const timeout = options.timeoutMs ?? 20_000;
  try {
    await client.connect(transport, { timeout });
    const server = client.getServerVersion();
    const { tools } = await client.listTools(undefined, { timeout });
    return {
      serverName: server?.name ?? 'unknown',
      serverVersion: server?.version ?? 'unknown',
      toolNames: tools.map((tool) => tool.name),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
