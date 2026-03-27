#!/usr/bin/env npx tsx
/**
 * Skip Comments Checker for TypeScript.
 *
 * Detects comments that bypass lint rules, type checking, or coverage
 * requirements. These comments hide issues instead of fixing them.
 *
 * Forbidden patterns:
 * - // @ts-ignore
 * - // @ts-expect-error
 * - // @ts-nocheck
 * - // eslint-disable
 * - /* eslint-disable
 * - /* istanbul ignore
 * - // vitest-ignore
 * - // c8 ignore
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Note: infra/ is excluded because CDK type stubs have known issues
const SCAN_DIRS = ["src", "tests"];
const FILE_EXTENSIONS = new Set([".ts", ".tsx"]);

const SKIP_PATTERNS: Array<[RegExp, string]> = [
  [/\/\/\s*@ts-ignore/i, "@ts-ignore (TypeScript skip)"],
  [/\/\/\s*@ts-expect-error/i, "@ts-expect-error (TypeScript skip)"],
  [/\/\/\s*@ts-nocheck/i, "@ts-nocheck (TypeScript file skip)"],
  [/\/\/\s*eslint-disable/i, "eslint-disable (lint skip)"],
  [/\/\*\s*eslint-disable/i, "eslint-disable block (lint skip)"],
  [/\/\*\s*istanbul\s+ignore/i, "istanbul ignore (coverage skip)"],
  [/\/\/\s*vitest-ignore/i, "vitest-ignore (test skip)"],
  [/\/\/\s*c8\s+ignore/i, "c8 ignore (coverage skip)"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFiles(directory: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(directory)) return results;

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(fullPath);
      } else if (FILE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  walk(directory);
  return results;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  patternName: string;
  lineContent: string;
}

function checkFile(filepath: string): Violation[] {
  const violations: Violation[] = [];
  let content: string;

  try {
    content = fs.readFileSync(filepath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNum = i + 1;

    for (const [pattern, patternName] of SKIP_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: filepath,
          line: lineNum,
          patternName,
          lineContent: line.trim(),
        });
        break; // Only report first match per line
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  const allViolations: Violation[] = [];

  for (const dir of SCAN_DIRS) {
    const files = findFiles(dir);

    for (const filepath of files) {
      const violations = checkFile(filepath);
      allViolations.push(...violations);
    }
  }

  if (allViolations.length > 0) {
    console.log("x Skip comments found (these bypass checks instead of fixing issues):\n");
    const sorted = allViolations.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
    for (const v of sorted) {
      console.log(`  ${v.file}:${v.line}: ${v.patternName}`);
      console.log(`    ${v.lineContent}\n`);
    }
    console.log(`x Total violations: ${allViolations.length}`);
    console.log("\nFix: Remove the skip comment and fix the underlying issue.");
    return 1;
  }

  console.log("OK No skip comments found!");
  return 0;
}

process.exit(main());
