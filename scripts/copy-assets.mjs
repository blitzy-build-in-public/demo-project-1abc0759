/*
 * Copies the build assets that `tsc` does not emit into dist/: the versioned SQL migrations and
 * the browser assets served under /static. `npm run build` runs it right after `tsc`.
 *
 * The destinations are fixed because the compiled code resolves them from its own location:
 * src/db/migrate.ts reads path.join(__dirname, 'migrations') and src/app.ts serves
 * path.join(__dirname, 'web', 'public'), which become dist/db/migrations and dist/web/public.
 * Whole directories are copied, so a new numbered migration ships without editing this script.
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (the parent of scripts/), independent of the working directory. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Each source directory and the dist/ directory the compiled server reads it from. */
const COPIES = Object.freeze([
  {
    from: path.join(ROOT, 'src', 'db', 'migrations'),
    to: path.join(ROOT, 'dist', 'db', 'migrations'),
  },
  {
    from: path.join(ROOT, 'src', 'web', 'public'),
    to: path.join(ROOT, 'dist', 'web', 'public'),
  },
]);

/**
 * Writes one line to stderr and exits with code 1, so `npm run build` fails.
 *
 * @param {string} message - What went wrong, without the `copy-assets:` prefix.
 * @returns {never}
 */
function fail(message) {
  console.error(`copy-assets: ${message}`);
  process.exit(1);
}

/** @param {string} absolutePath @returns {string} The repository-relative form, for messages. */
function relative(absolutePath) {
  return path.relative(ROOT, absolutePath);
}

/** @param {string} dir @returns {boolean} */
function isDirectory(dir) {
  return existsSync(dir) && statSync(dir).isDirectory();
}

function main() {
  // Every source is checked before anything is deleted, so a failure leaves dist/ untouched.
  for (const { from } of COPIES) {
    if (!isDirectory(from)) {
      fail(`source directory not found: ${relative(from)}`);
    }
  }

  try {
    for (const { from, to } of COPIES) {
      // The stale destination is removed first so dist/ mirrors src/ exactly: a migration
      // renamed or removed in src/ must not linger in dist/, where runMigrations would apply it.
      rmSync(to, { recursive: true, force: true });
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
      console.log(`copy-assets: ${relative(from)} -> ${relative(to)}`);
    }
  } catch (err) {
    fail(`failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main();
