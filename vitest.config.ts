import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@qozara/google-auth/react': path.resolve(
        import.meta.dirname,
        'packages/google-auth/src/react.tsx'
      ),
      '@qozara/google-auth': path.resolve(
        import.meta.dirname,
        'packages/google-auth/src/index.ts'
      ),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.{ts,tsx}'],
  },
});
