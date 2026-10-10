/** Copyable stdio configuration for any other MCP client (not a substitute for the real adapters). */
export function buildGenericStdioConfig(executablePath: string): string {
  return JSON.stringify(
    { mcpServers: { 'spotify-curator': { command: executablePath, args: ['mcp'] } } },
    null,
    2,
  );
}
