import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // No test may talk to Spotify: the HTTP layer is always injected.
    restoreMocks: true,
  },
});
