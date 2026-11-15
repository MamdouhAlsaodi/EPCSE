import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function coreSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return coreSourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('bootstrap CLI and core source boundary', () => {
  it('exposes the documented built CLI through the root cli script', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.cli).toBe('node apps/cli/dist/main.js');

    // Exercise the exact built entrypoint; pnpm itself is not needed in the test process.
    const output = execFileSync(process.execPath, ['apps/cli/dist/main.js'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(output).toContain('simulation-core: full engine not implemented');
    expect(output).toContain('limited scripted demonstration available');
    expect(output).toContain('Two-city scripted demonstration (synthetic/provisional)');
    expect(output).toMatch(/not a complete S0 or economic simulation/i);
  });

  it('keeps core source imports inside the core package', () => {
    const sourceRoot = resolve(root, 'packages/simulation-core/src');
    const sourceFiles = coreSourceFiles(sourceRoot);
    expect(sourceFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const path of sourceFiles) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
      );
      const check = (specifier: string) => {
        const destination = resolve(path, '..', specifier);
        if (
          !specifier.startsWith('.') ||
          !isAbsolute(destination) ||
          relative(sourceRoot, destination).startsWith('..')
        ) {
          violations.push(`${relative(root, path)}: ${specifier}`);
        }
      };
      const visit = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          check(node.moduleSpecifier.text);
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!)) {
            violations.push(`${relative(root, path)}: dynamic module specifier`);
          } else check(node.arguments[0]!.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});
