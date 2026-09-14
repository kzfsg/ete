import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@ete/core'],
  // Monorepo: let output file tracing follow pnpm's virtual store at the workspace root.
  outputFileTracingRoot: join(here, '../..'),
};
