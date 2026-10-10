import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from './spotify.js';
import { registerCurationTools } from './tools/curation.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerLegacyTools } from './tools/legacy.js';
import { registerLibraryTools } from './tools/library.js';
import { registerPlaylistTools } from './tools/playlists.js';
import type { IToolContext } from './tools/shared.js';

export const SERVER_NAME = 'spotify-custom-mcp';
export const SERVER_VERSION = '0.2.0';

export interface IMcpServerOptions {
  /** Tool names to leave unregistered (e.g. features whose scopes were not granted). */
  disabledTools?: string[];
}

/** Builds the MCP server without connecting a transport, so tests can attach one. */
export function createMcpServer(spotify: SpotifyClient, options: IMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const disabled = new Set(options.disabledTools ?? []);

  const registerTool = ((name: string, ...rest: unknown[]) => {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => { remove(): void };
    const tool = register(name, ...rest);
    if (disabled.has(name)) {
      tool.remove();
    }
    return tool;
  }) as unknown as McpServer['registerTool'];

  const context: IToolContext = { registerTool, spotify };
  registerLegacyTools(context);
  registerPlaylistTools(context);
  registerLibraryTools(context);
  registerDiscoveryTools(context);
  registerCurationTools(context);

  return server;
}
