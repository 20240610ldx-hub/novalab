import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 首屏包边界：从 app/src/main.tsx 出发沿「静态、非 type-only」import 走一遍，AI SDK（ai / @ai-sdk/* / zod）
 * 与依赖它的 agent 模块都不能出现——它们只能经 App.tsx 里的 lazy() 进入（Agent / 设置面板）。
 * 有人在启动路径上直接 import agent/models.ts 之类，这里会先红，而不是等主包悄悄回到 1.4 MB。
 */

const SRC = fileURLToPath(new URL('../app/src/', import.meta.url));
const FORBIDDEN_PACKAGES = [/^ai$/, /^@ai-sdk\//, /^zod$/, /^@novalab\/bridge\/mcp-tools$/];
const LAZY_ONLY = /^agent\/(models|openaiCompat|useAgentChat|tools)\.ts$|^components\/(AgentPanel|SettingsPanel)\//;
// `import x from 'y'` / `import { a } from 'y'` / `import 'y'` / `export … from 'y'`；`import type` 不进包
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;

function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

/** `{ type A, type B }` 全是类型的具名导入在编译后消失。 */
function typeOnlyClause(clause) {
  const named = /^\{([^}]*)\}$/.exec(clause.trim());
  return named !== null && named[1].split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '));
}

function eagerGraph(entry) {
  const files = new Set();
  const packages = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const [, clause = '', spec] of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      if (typeOnlyClause(clause)) continue;
      if (spec.startsWith('.')) {
        const resolved = resolveLocal(file, spec);
        if (resolved) queue.push(resolved);
      } else if (!packages.has(spec)) {
        packages.set(spec, path.relative(SRC, file));
      }
    }
  }
  return { files: [...files].map((f) => path.relative(SRC, f).replace(/\\/g, '/')), packages };
}

const graph = eagerGraph(path.join(SRC, 'main.tsx'));

test('app startup graph reaches App.tsx (the walk itself works)', () => {
  assert.ok(graph.files.includes('App.tsx'));
  assert.ok(graph.files.includes('store/agent.ts'));
});

test('no AI SDK package is statically imported on the startup path', () => {
  const leaks = [...graph.packages].filter(([spec]) => FORBIDDEN_PACKAGES.some((re) => re.test(spec)));
  assert.deepEqual(leaks, []);
});

test('model construction and the Agent / Settings panels load only lazily', () => {
  assert.deepEqual(graph.files.filter((f) => LAZY_ONLY.test(f)), []);
});
