#!/usr/bin/env npx tsx
/**
 * Naming Conventions Checker for TypeScript.
 *
 * Validates TypeScript code follows Sc0red naming conventions:
 * - Classes/Interfaces/Types/Enums: PascalCase
 * - Functions (top-level, exported): camelCase with verb prefix
 * - Constants: SCREAMING_SNAKE_CASE
 * - Files: kebab-case
 *
 * Supports escape hatch: // noqa: NAMING001
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCAN_DIRS = ["src", "infra"];
const FILE_EXTENSIONS = new Set([".ts", ".tsx"]);

const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9_]*$/;
const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const KEBAB_CASE_FILE = /^[a-z][a-z0-9-]*(\.[a-z]+)*\.(ts|tsx)$/;

const CORE_VERBS = new Set([
  "get", "set", "create", "update", "delete", "remove", "add",
  "check", "validate", "process", "handle", "run", "execute",
  "build", "make", "send", "receive", "fetch", "save", "load",
  "read", "write", "parse", "format", "convert", "transform",
  "calculate", "compute", "generate", "render", "display",
  "initialize", "setup", "cleanup", "start", "stop", "restart",
  "open", "close", "connect", "disconnect", "enable", "disable",
  "show", "hide", "move", "copy", "clear", "reset", "refresh",
  "search", "find", "filter", "sort", "merge", "split", "join",
  "register", "unregister", "subscribe", "unsubscribe", "publish",
  "download", "upload", "sync", "extract", "emit", "notify", "sleep",
  // Boolean prefixes
  "is", "has", "can", "should", "will", "was", "are", "have",
]);

const VERB_ENDINGS = ["ate", "ize", "ify"];

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

function lineHasNoqa(line: string): boolean {
  return line.includes("// noqa: NAMING") || line.includes("// noqa");
}

function hasNoqa(lines: string[], index: number): boolean {
  const current = lines[index] ?? '';
  const next = lines[index + 1] ?? '';
  const prev = lines[index - 1] ?? '';
  return lineHasNoqa(current) || lineHasNoqa(next) || lineHasNoqa(prev);
}

function isVerbPrefix(word: string): boolean {
  if (CORE_VERBS.has(word)) return true;
  if (word.length > 4) {
    for (const ending of VERB_ENDINGS) {
      if (word.endsWith(ending)) return true;
    }
  }
  return false;
}

/**
 * Extract the first "word" from a camelCase identifier.
 * e.g. "getUserById" -> "get", "isValid" -> "is", "render" -> "render"
 */
function extractFirstWord(name: string): string {
  // Find the index of the first uppercase letter after position 0
  for (let i = 1; i < name.length; i++) {
    if (name.charAt(i) >= "A" && name.charAt(i) <= "Z") {
      return name.slice(0, i).toLowerCase();
    }
  }
  return name.toLowerCase();
}

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  message: string;
}

// Regex patterns for declarations
const CLASS_RE = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const INTERFACE_RE = /\binterface\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const TYPE_RE = /\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/;
const ENUM_RE = /\benum\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const FUNCTION_RE = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const EXPORT_FUNCTION_RE = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const EXPORT_CONST_RE = /\bexport\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]/;
const TOP_CONST_RE = /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]/;

function checkFile(filepath: string): Violation[] {
  const violations: Violation[] = [];
  let content: string;

  try {
    content = fs.readFileSync(filepath, "utf-8");
  } catch {
    return [{ file: filepath, line: 0, message: "Error reading file" }];
  }

  const lines = content.split("\n");

  // Track brace depth to determine if we're at top level
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNum = i + 1;

    if (hasNoqa(lines, i)) continue;

    // Strip strings and comments for analysis
    const stripped = line.replace(/\/\/.*$/, "").replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
    for (const ch of stripped) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }
    if (braceDepth < 0) braceDepth = 0;

    // Use stripped line (no strings/comments) for matching declarations
    // Check class names
    const classMatch = stripped.match(CLASS_RE);
    if (classMatch) {
      const name = classMatch[1] ?? '';
      if (!PASCAL_CASE.test(name)) {
        violations.push({ file: filepath, line: lineNum, message: `Class '${name}' must be PascalCase` });
      }
    }

    // Check interface names
    const interfaceMatch = stripped.match(INTERFACE_RE);
    if (interfaceMatch) {
      const name = interfaceMatch[1] ?? '';
      if (!PASCAL_CASE.test(name)) {
        violations.push({ file: filepath, line: lineNum, message: `Interface '${name}' must be PascalCase` });
      }
    }

    // Check type alias names
    const typeMatch = stripped.match(TYPE_RE);
    if (typeMatch) {
      const name = typeMatch[1] ?? '';
      if (!PASCAL_CASE.test(name)) {
        violations.push({ file: filepath, line: lineNum, message: `Type '${name}' must be PascalCase` });
      }
    }

    // Check enum names
    const enumMatch = stripped.match(ENUM_RE);
    if (enumMatch) {
      const name = enumMatch[1] ?? '';
      if (!PASCAL_CASE.test(name)) {
        violations.push({ file: filepath, line: lineNum, message: `Enum '${name}' must be PascalCase` });
      }
    }

    // Check exported/top-level function names
    const exportFnMatch = stripped.match(EXPORT_FUNCTION_RE);
    const fnMatch = !exportFnMatch ? stripped.match(FUNCTION_RE) : null;
    const functionName = exportFnMatch?.[1] ?? fnMatch?.[1] ?? null;

    if (functionName) {
      // Only check verb prefix for top-level functions (braceDepth ~0 at start of line)
      // We use the braceDepth from BEFORE processing this line's braces
      const isTopLevel = exportFnMatch !== null || (braceDepth <= 1 && fnMatch !== null);

      if (!CAMEL_CASE.test(functionName)) {
        violations.push({ file: filepath, line: lineNum, message: `Function '${functionName}' must be camelCase` });
      } else if (isTopLevel) {
        const firstWord = extractFirstWord(functionName);
        if (!isVerbPrefix(firstWord)) {
          violations.push({
            file: filepath,
            line: lineNum,
            message: `Function '${functionName}' should start with a verb (common: get, set, create, etc. or use // noqa: NAMING001)`,
          });
        }
      }
    }

    // Check exported constants for SCREAMING_SNAKE_CASE
    // Only flag constants that look like they're meant to be constants (all uppercase)
    const constMatch = stripped.match(TOP_CONST_RE);
    if (constMatch) {
      const name = constMatch[1] ?? '';
      // If name is all uppercase, verify it matches SCREAMING_SNAKE
      if (name === name.toUpperCase() && name.length > 1) {
        if (!SCREAMING_SNAKE.test(name)) {
          violations.push({ file: filepath, line: lineNum, message: `Constant '${name}' must be SCREAMING_SNAKE_CASE` });
        }
      }
    }
  }

  return violations;
}

function checkFileName(filepath: string): Violation | null {
  const filename = path.basename(filepath);

  // Skip declaration files (*.d.ts)
  if (filename.endsWith(".d.ts")) return null;

  // Skip index files
  if (filename === "index.ts" || filename === "index.tsx") return null;

  if (!KEBAB_CASE_FILE.test(filename)) {
    return { file: filepath, line: 0, message: `File '${filename}' must be kebab-case (e.g., my-component.ts)` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  const allViolations: Violation[] = [];

  for (const dir of SCAN_DIRS) {
    const files = findFiles(dir);

    for (const filepath of files) {
      // Check file name
      const fileViolation = checkFileName(filepath);
      if (fileViolation) {
        allViolations.push(fileViolation);
      }

      // Check file content
      const violations = checkFile(filepath);
      allViolations.push(...violations);
    }
  }

  if (allViolations.length > 0) {
    console.log("x Naming convention violations found:\n");
    const sorted = allViolations.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
    for (const v of sorted) {
      console.log(`  ${v.file}:${v.line}: ${v.message}`);
    }
    console.log(`\nx Total violations: ${allViolations.length}`);
    console.log("\nTip: Use '// noqa: NAMING001' to skip a specific line");
    return 1;
  }

  console.log("OK All naming conventions passed!");
  return 0;
}

process.exit(main());
