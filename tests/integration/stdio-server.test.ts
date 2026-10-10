import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const SECRET_VALUES = ['stdio-client-id', 'stdio-client-secret', 'stdio-refresh-token'];

async function withServer<TResult>(
  extraEnv: Record<string, string>,
  run: (client: Client, stderr: () => string) => Promise<TResult>,
): Promise<TResult> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/server.ts'],
    env: {
      PATH: process.env.PATH ?? '',
      SPOTIFY_CLIENT_ID: SECRET_VALUES[0],
      SPOTIFY_CLIENT_SECRET: SECRET_VALUES[1],
      SPOTIFY_REFRESH_TOKEN: SECRET_VALUES[2],
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  let stderrText = '';
  transport.stderr?.on('data', (chunk) => {
    stderrText += String(chunk);
  });

  const client = new Client({ name: 'stdio-test', version: '0.0.0' });
  const protocolErrors: Error[] = [];
  client.onerror = (error) => protocolErrors.push(error);
  await client.connect(transport);
  try {
    const result = await run(client, () => stderrText);
    expect(protocolErrors).toEqual([]); // stdout carried protocol messages only
    return result;
  } finally {
    await client.close();
  }
}

describe('local stdio MCP server', () => {
  it('starts over stdio, lists all tools, and answers validation errors without touching Spotify', async () => {
    await withServer({}, async (client, stderr) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(21);
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['search_tracks', 'generate_playlist', 'suggest_playlist_flow']));

      const result = await client.callTool({ name: 'add_playlist_items', arguments: { playlistId: 'p', uris: ['nope'] } });
      expect(result.isError).toBe(true);

      for (const secret of SECRET_VALUES) {
        expect(JSON.stringify(tools)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(stderr()).not.toContain(secret);
      }
    });
  }, 30_000);

  it('honors SPOTIFY_DISABLED_TOOLS', async () => {
    await withServer({ SPOTIFY_DISABLED_TOOLS: 'get_top_items, generate_playlist' }, async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toHaveLength(19);
      expect(names).not.toContain('get_top_items');
      expect(names).not.toContain('generate_playlist');
    });
  }, 30_000);
});
