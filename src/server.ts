import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDisabledTools } from './config.js';
import { createMcpServer } from './mcp-server.js';
import { createRuntimeSpotifyClient } from './runtime.js';

// The packaged launcher sets SPOTIFY_CURATOR_PACKAGED=1: it must not read a .env from the working directory.
if (process.env.SPOTIFY_CURATOR_PACKAGED !== '1') {
  await import('dotenv/config');
}

// MCP stdout is protocol-only: diagnostics must go to stderr.
const server = createMcpServer(await createRuntimeSpotifyClient(), {
  disabledTools: getDisabledTools(),
});

await server.connect(new StdioServerTransport());
