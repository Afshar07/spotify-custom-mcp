import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDisabledTools, getSpotifyConfig } from './config.js';
import { createMcpServer } from './mcp-server.js';
import { SpotifyClient } from './spotify.js';

// MCP stdout is protocol-only: diagnostics must go to stderr.
const server = createMcpServer(new SpotifyClient(getSpotifyConfig()), {
  disabledTools: getDisabledTools(),
});

await server.connect(new StdioServerTransport());
