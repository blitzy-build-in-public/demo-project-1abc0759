/**
 * Architecture test: the import rules of the layer map (plan 0.3.2), standing in for the ESLint
 * import rules that the dependency constraint excludes (plan 0.12.2).
 *
 * Every `.ts` file under `src/` is parsed with the TypeScript compiler API, and each module
 * specifier it references is classified. The test fails on any import the layer map forbids:
 *
 * - the web layer (`src/web/**`) never imports the data-access layer (`src/db/**`);
 * - the domain modules (`src/auth/**`, `src/tasks/**`, `src/reports/**`) never import the web
 *   layer or each other;
 * - the data-access layer never imports the web layer or a domain module;
 * - the shared kernel (`src/shared/**`) imports Node built-ins and itself only;
 * - `pg` is imported only under `src/db/`.
 *
 * The composition root (`src/server.ts`, `src/app.ts`, `src/config.ts`, `src/purge-job.ts` and the
 * `src/db/migrate-cli.ts` entry point) wires every layer and has no other restriction.
 *
 * The rules are the map's "must not import" lists, not its "may call" lists, so the web layer may
 * read the `AppConfig` type from `src/config.ts`. Only direct specifiers are checked: the web
 * layer reads the `UserId` and `TaskId` types through `src/tasks/types.ts`, which re-exports them
 * from `src/db/types.ts`, and that is not a web-to-db import.
 *
 * Specifiers come from an AST walk rather than a text scan, so import-like text in comments, TSDoc
 * and string literals never counts, while type-only imports count like any other. The test only
 * reads the source tree.
 */

import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

/** Absolute path of the application source tree under test. */
const SRC_ROOT = path.resolve(__dirname, '../../src');

/** Absolute path of the repository root, against which violations are reported. */
const REPO_ROOT = path.resolve(__dirname, '../..');

/** A layer of the layer map. `root` is the composition root. */
type Layer = 'root' | 'web' | 'auth' | 'tasks' | 'reports' | 'db' | 'shared';

/** Every layer, each of which must own at least one scanned file. */
const LAYERS: readonly Layer[] = ['root', 'web', 'auth', 'tasks', 'reports', 'db', 'shared'];

/** Layers named by the first segment of a `src/`-relative path. */
const SEGMENT_LAYERS: readonly Layer[] = ['web', 'auth', 'tasks', 'reports', 'db', 'shared'];

/**
 * Composition-root modules, as `src/`-relative paths without extension. `db/migrate-cli` is the
 * second process entry point beside `server`: it reads the environment through `src/config.ts`,
 * so it belongs to the root although it lives under `src/db/`. Its `pg` use is governed by the
 * path rule in {@link violationOf}, which allows `pg` anywhere under `src/db/`.
 */
const ROOT_MODULES: ReadonlySet<string> = new Set([
  'server',
  'app',
  'config',
  'purge-job',
  'db/migrate-cli',
]);

/**
 * The layers each layer must not import. The shared kernel is absent because its rule is an allow
 * list (Node built-ins and itself), applied separately.
 */
const FORBIDDEN_LAYERS: Readonly<Record<Exclude<Layer, 'shared'>, readonly Layer[]>> = {
  root: [],
  web: ['db'],
  auth: ['web', 'tasks', 'reports'],
  tasks: ['web', 'auth', 'reports'],
  reports: ['web', 'auth', 'tasks'],
  db: ['web', 'auth', 'tasks', 'reports'],
};

/** Names of Node's built-in modules, such as `fs` and `fs/promises`. */
const BUILTIN_MODULES: ReadonlySet<string> = new Set(builtinModules);

/** What a module specifier refers to. */
type ImportTarget =
  | { kind: 'local'; layer: Layer | null; srcRel: string }
  | { kind: 'pg' }
  | { kind: 'builtin' }
  | { kind: 'package'; name: string };

/** One scanned source file and the specifiers it references. */
interface ScannedFile {
  repoRel: string;
  srcRel: string;
  layer: Layer | null;
  specifiers: string[];
}

/** Returns `absPath` relative to `base`, with `/` separators on every platform. */
function toPosixRel(absPath: string, base: string): string {
  return path.relative(base, absPath).split(path.sep).join('/');
}

/** Lists every `.ts` file (`.d.ts` included) under `dir`, recursively, in sorted order. */
function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(entryPath);
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** Returns the module specifier `node` references, or `null` when it references none. */
function specifierOf(node: ts.Node): string | null {
  // `import … from`, `import type … from`, side-effect `import '…'`, `export … from`,
  // `export * from` and `export type … from`.
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  // `import x = require('…')`.
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  // Dynamic `import('…')` and `require('…')`.
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
    const isRequireCall = ts.isIdentifier(callee) && callee.text === 'require';
    const first = node.arguments[0];
    if ((isImportCall || isRequireCall) && first !== undefined && ts.isStringLiteralLike(first)) {
      return first.text;
    }
  }
  // Import types: `typeof import('…')` and `import('…').T`.
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  return null;
}

/**
 * Returns every module specifier `text` references, in source order. `ts.forEachChild` never
 * descends into comments or JSDoc, and a string literal is collected only in a module position.
 */
function extractSpecifiers(fileName: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    if (specifier !== null) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/**
 * Returns the layer of a `src/`-relative POSIX path, or `null` for a path the layer map does not
 * cover. A trailing `.d.ts`, `.ts` or `.js` is ignored, so a file and the specifier naming it
 * classify alike.
 */
function layerOf(srcRel: string): Layer | null {
  const modulePath = srcRel.replace(/(\.d)?\.ts$|\.js$/, '');
  if (ROOT_MODULES.has(modulePath)) {
    return 'root';
  }
  const firstSegment = modulePath.split('/')[0];
  return SEGMENT_LAYERS.find((layer) => layer === firstSegment) ?? null;
}

/** Returns the npm package name of a bare specifier: `@scope/name` or its first segment. */
function packageName(spec: string): string {
  const segments = spec.split('/');
  const first = segments[0] ?? spec;
  return first.startsWith('@') && segments[1] !== undefined ? `${first}/${segments[1]}` : first;
}

/**
 * Classifies `spec` as referenced from the absolute path `fromFile`. Specifiers carry no
 * extension, so a local target is classified by its path, not by an existing file; a local target
 * outside `src/` has no layer.
 */
function targetOf(fromFile: string, spec: string): ImportTarget {
  if (/^\.\.?(\/|$)/.test(spec) || path.isAbsolute(spec)) {
    const srcRel = toPosixRel(path.resolve(path.dirname(fromFile), spec), SRC_ROOT);
    const outsideSrc = srcRel === '..' || srcRel.startsWith('../') || path.isAbsolute(srcRel);
    return { kind: 'local', layer: outsideSrc ? null : layerOf(srcRel), srcRel };
  }
  if (spec.startsWith('node:')) {
    return { kind: 'builtin' };
  }
  const name = packageName(spec);
  if (name === 'pg') {
    return { kind: 'pg' };
  }
  if (BUILTIN_MODULES.has(spec) || BUILTIN_MODULES.has(name)) {
    return { kind: 'builtin' };
  }
  return { kind: 'package', name };
}

/**
 * Returns the label of the rule an import of `target` breaks in the file at `fromSrcRel` (a
 * `src/`-relative POSIX path), or `null` when the import is allowed. Each import yields at most
 * one label.
 */
function violationOf(fromSrcRel: string, target: ImportTarget): string | null {
  if (target.kind === 'pg') {
    return fromSrcRel.startsWith('db/') ? null : 'pg is allowed only in src/db';
  }
  const layer = layerOf(fromSrcRel);
  if (layer === null) {
    // Unclassified files fail the layer-coverage test instead.
    return null;
  }
  if (layer === 'shared') {
    const allowed =
      target.kind === 'builtin' || (target.kind === 'local' && target.layer === 'shared');
    return allowed ? null : 'shared imports only Node built-ins and src/shared';
  }
  if (
    target.kind === 'local' &&
    target.layer !== null &&
    FORBIDDEN_LAYERS[layer].includes(target.layer)
  ) {
    return `${layer} must not import ${target.layer}`;
  }
  return null;
}

/** Returns the rule `spec` breaks when imported by the file at `fromSrcRel`, or `null`. */
function brokenRule(fromSrcRel: string, spec: string): string | null {
  return violationOf(fromSrcRel, targetOf(path.join(SRC_ROOT, fromSrcRel), spec));
}

/** Reads and parses every `.ts` file under `src/`. */
function scanSourceTree(): ScannedFile[] {
  return listTsFiles(SRC_ROOT).map((absPath): ScannedFile => {
    const srcRel = toPosixRel(absPath, SRC_ROOT);
    return {
      repoRel: toPosixRel(absPath, REPO_ROOT),
      srcRel,
      layer: layerOf(srcRel),
      specifiers: extractSpecifiers(absPath, fs.readFileSync(absPath, 'utf8')),
    };
  });
}

/**
 * One instance of every import form, followed by import-like text that is not an import: a line
 * comment, a TSDoc block (including a JSDoc import type) and a string literal.
 */
const EXTRACTOR_FIXTURE = `
import a from './a';
import type { B } from '../b';
import './side-effect';
export { c } from './c';
export * from './d';
export type { E } from './e';
import f = require('./f');
const g = require('./g');
const h = import('./h');
type I = typeof import('./i');
// import x from './comment'
/**
 * Re-exported from './doc' for callers.
 * @type {import('./doc-type').T}
 */
const s = 'import y from "./string"';
`;

describe('layer map import rules', () => {
  let scanned: ScannedFile[] = [];

  beforeAll(() => {
    scanned = scanSourceTree();
  });

  it('extracts every import form', () => {
    const expected = [
      './a',
      '../b',
      './side-effect',
      './c',
      './d',
      './e',
      './f',
      './g',
      './h',
      './i',
    ];

    const actual = extractSpecifiers('fixture.ts', EXTRACTOR_FIXTURE);

    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it.each<[from: string, spec: string, rule: string | null]>([
    ['web/routes/task-routes.ts', '../../db/types', 'web must not import db'],
    ['web/routes/task-routes.ts', 'pg', 'pg is allowed only in src/db'],
    ['web/cookies.ts', '../config', null],
    ['web/routes/task-routes.ts', '../../tasks/types', null],
    ['auth/auth-service.ts', '../tasks/task-rules', 'auth must not import tasks'],
    ['tasks/task-service.ts', '../web/async-handler', 'tasks must not import web'],
    ['reports/report-service.ts', '../auth/tokens', 'reports must not import auth'],
    ['reports/summary.ts', '../db/types', null],
    ['db/tasks-repo.ts', '../reports/csv', 'db must not import reports'],
    ['db/pool.ts', 'pg', null],
    ['db/migrate-cli.ts', 'pg', null],
    ['db/migrate-cli.ts', '../config', null],
    ['server.ts', 'pg/lib/client', 'pg is allowed only in src/db'],
    ['app.ts', './db/data-access', null],
    ['shared/dates.ts', './clock', null],
    ['shared/logger.ts', 'node:fs', null],
    ['shared/logger.ts', 'fs/promises', null],
    ['shared/errors.ts', 'express', 'shared imports only Node built-ins and src/shared'],
    ['shared/errors.ts', '../db/types', 'shared imports only Node built-ins and src/shared'],
    ['shared/errors.ts', '../config', 'shared imports only Node built-ins and src/shared'],
  ])('classifies src/%s -> %s', (from, spec, rule) => {
    expect(brokenRule(from, spec)).toBe(rule);
  });

  it('scans every layer', () => {
    const missingLayers = LAYERS.filter((layer) => !scanned.some((file) => file.layer === layer));
    const unclassifiedFiles = scanned
      .filter((file) => file.layer === null)
      .map((file) => file.repoRel);

    expect({ missingLayers, unclassifiedFiles }).toEqual({
      missingLayers: [],
      unclassifiedFiles: [],
    });
  });

  it('respects the layer map', () => {
    const violations: string[] = [];
    for (const file of scanned) {
      for (const spec of file.specifiers) {
        const rule = brokenRule(file.srcRel, spec);
        if (rule !== null) {
          violations.push(`${file.repoRel} -> ${spec} (${rule})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
