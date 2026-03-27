#!/usr/bin/env npx tsx
/**
 * Abbreviation Checker for TypeScript.
 *
 * Checks for the most problematic abbreviations that hurt code readability.
 * Focuses on the 80/20 rule: catch the worst offenders, not every possible case.
 *
 * Supports escape hatch: // noqa: ABBREV001
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCAN_DIRS = ["src", "infra"];
const FILE_EXTENSIONS = new Set([".ts", ".tsx"]);

const FORBIDDEN: Record<string, string> = {
  usr: "user",
  pwd: "password",
  passwd: "password",
  auth: "authentication",
  authn: "authentication",
  authz: "authorization",
  msg: "message",
  req: "request",
  res: "response",
  resp: "response",
  ctx: "context",
  cfg: "config",
  conf: "config",
  db: "database",
  conn: "connection",
  mgr: "manager",
  proc: "process",
  val: "value",
  num: "number",
  addr: "address",
  obj: "object",
  impl: "implementation",
  spec: "specification",
  arg: "argument",
  param: "parameter",
  env: "environment",
  temp: "temporary",
  tmp: "temporary",
  curr: "current",
  prev: "previous",
  cnt: "count",
  idx: "index",
  len: "length",
  calc: "calculate",
  util: "utility",
  btn: "button",
  err: "error",
};

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

function hasNoqa(line: string): boolean {
  return line.includes("// noqa: ABBREV") || line.includes("// noqa");
}

/**
 * Split a camelCase or PascalCase identifier into lowercase words.
 * e.g. "getUserMessage" -> ["get", "user", "message"]
 *      "HTTPResponse" -> ["h", "t", "t", "p", "response"] -- edge case, but fine
 */
function splitCamelCase(name: string): string[] {
  // Insert a separator before each uppercase letter that follows a lowercase letter
  // or before a sequence of uppercase letters followed by a lowercase letter
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split("_")
    .filter((part) => part.length > 0);
  return parts;
}

interface Violation {
  file: string;
  line: number;
  message: string;
}

/**
 * Check if any word part of a name is a forbidden abbreviation.
 * Returns the first match found, or null.
 */
function checkName(
  name: string,
  lineNum: number,
  context: string,
  filepath: string,
): Violation | null {
  // Skip very short names (single char loop variables, etc.)
  if (name.length <= 1) return null;

  // Split camelCase into words, also handle snake_case (shouldn't exist but check)
  const parts = splitCamelCase(name);

  for (const part of parts) {
    if (Object.hasOwn(FORBIDDEN, part)) {
      const suggestion = FORBIDDEN[part];
      return {
        file: filepath,
        line: lineNum,
        message: `${context} '${name}' contains '${part}' - use '${suggestion}' instead`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Regex patterns for identifiers
// ---------------------------------------------------------------------------

const DECLARATION_PATTERNS: Array<{ regex: RegExp; context: string; group: number }> = [
  // const/let/var declarations
  { regex: /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/, context: "Variable", group: 1 },
  // Function declarations
  { regex: /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/, context: "Function", group: 1 },
  // Class declarations
  { regex: /\bclass\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/, context: "Class", group: 1 },
  // Interface declarations
  { regex: /\binterface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/, context: "Interface", group: 1 },
  // Type alias declarations
  { regex: /\btype\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=<]/, context: "Type", group: 1 },
  // Enum declarations
  { regex: /\benum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/, context: "Enum", group: 1 },
];

// Parameter patterns: match function/method parameter lists
// This catches common cases like (req: Request, res: Response)
const PARAM_RE = /\(([^)]*)\)/g;
const PARAM_NAME_RE = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[?]?\s*:/g;

function checkFile(filepath: string): Violation[] {
  const violations: Violation[] = [];
  let content: string;

  try {
    content = fs.readFileSync(filepath, "utf-8");
  } catch {
    return [{ file: filepath, line: 0, message: "Error reading file" }];
  }

  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNum = i + 1;

    if (hasNoqa(line)) continue;

    // Skip import lines
    if (line.trimStart().startsWith("import ")) continue;

    // Skip comment-only lines
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

    // Check declaration patterns
    for (const pattern of DECLARATION_PATTERNS) {
      const match = line.match(pattern.regex);
      if (match) {
        const name = match[pattern.group] ?? '';
        const violation = checkName(name, lineNum, pattern.context, filepath);
        if (violation) violations.push(violation);
      }
    }

    // Check parameter names in function signatures
    let paramBlockMatch: RegExpExecArray | null;
    PARAM_RE.lastIndex = 0;
    while ((paramBlockMatch = PARAM_RE.exec(line)) !== null) {
      const paramBlock = paramBlockMatch[1] ?? '';
      let paramMatch: RegExpExecArray | null;
      PARAM_NAME_RE.lastIndex = 0;
      while ((paramMatch = PARAM_NAME_RE.exec(paramBlock)) !== null) {
        const paramName = paramMatch[1] ?? '';
        // Skip destructured patterns and type keywords
        if (["string", "number", "boolean", "void", "any", "unknown", "never", "object", "readonly"].includes(paramName)) continue;
        const violation = checkName(paramName, lineNum, "Parameter", filepath);
        if (violation) violations.push(violation);
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
    console.log("x Forbidden abbreviations found:\n");
    const sorted = allViolations.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
    for (const v of sorted) {
      console.log(`  ${v.file}:${v.line}: ${v.message}`);
    }
    console.log(`\nx Total violations: ${allViolations.length}`);
    console.log("\nTip: Use '// noqa: ABBREV001' to skip specific cases");
    return 1;
  }

  console.log("OK No forbidden abbreviations found!");
  return 0;
}

process.exit(main());
