/**
 * Making the vendored schemas usable from JavaScript.
 *
 * Six of HMCTS's schemas carry `pattern` values written in Java regex syntax
 * that ECMA-262 rejects outright. Not the instances -- the schemas. Any
 * JavaScript JSON Schema validator throws while *compiling* them:
 *
 *   1. An inline dotall flag, in the three Crown PDDA lists:
 *        (?s)^(?!.*(?:<\s*\/[^>]*>|...)).*$
 *      ECMA-262 has no inline flags.
 *
 *   2. A redundant `\-` escape, in master_schema and the two magistrates lists:
 *        ^((([\+-]?\d{4}(?!\d{2}\b))\-(0[13578]|1[02])\-...
 *      Legal in Java; an invalid identity escape in unicode-mode JavaScript,
 *      which is what Ajv and most validators use.
 *
 * Both rewrites below are exact -- `(?s)` only changes what `.` matches, and
 * `\x2d` is `-`. Worth raising with HMCTS: as shipped, these schemas cannot be
 * consumed by anything off the JVM.
 */

/** `(?s)a.b` -> `a[\s\S]b`, leaving escapes and character classes alone. */
function rewriteDotAll(pattern: string): string {
  const FLAG = '(?s)';
  if (!pattern.startsWith(FLAG)) return pattern;

  const body = pattern.slice(FLAG.length);
  let out = '';
  let inClass = false;

  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string;
    if (char === '\\') {
      out += char + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;

    out += char === '.' && !inClass ? '[\\s\\S]' : char;
  }

  return out;
}

/** `\-` is an invalid identity escape under `u`; `\x2d` is the same character. */
function rewriteIdentityEscapes(pattern: string): string {
  return pattern.replace(/\\-/g, '\\x2d');
}

export function javaPatternToEcma(pattern: string): string {
  return rewriteIdentityEscapes(rewriteDotAll(pattern));
}

/** True when a JS validator cannot compile this pattern as written. */
export function isJavaOnlyPattern(pattern: string): boolean {
  try {
    // Unicode mode, because that is what Ajv and friends use.
    new RegExp(pattern, 'u');
    return false;
  } catch {
    return true;
  }
}

export function collectPatterns(node: unknown, into: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return into;
  if (Array.isArray(node)) {
    for (const item of node) collectPatterns(item, into);
    return into;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'pattern' && typeof value === 'string') into.push(value);
    else collectPatterns(value, into);
  }
  return into;
}

export function hasJavaOnlyPatterns(node: unknown): boolean {
  return collectPatterns(node).some(isJavaOnlyPattern);
}

/**
 * Deep-copies a schema with every pattern rewritten to ECMA-262. Use before
 * handing a vendored schema to Ajv or any other JS validator.
 */
export function toEcmaSchema<T>(node: T): T {
  if (Array.isArray(node)) return node.map((item) => toEcmaSchema(item)) as unknown as T;
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] =
      key === 'pattern' && typeof value === 'string'
        ? javaPatternToEcma(value)
        : toEcmaSchema(value);
  }
  return out as unknown as T;
}
