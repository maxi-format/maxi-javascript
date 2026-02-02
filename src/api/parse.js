import { MaxiParseResult } from '../core/types.js';
import { SchemaParser } from '../internal/schema-parser.js';
import { RecordParser } from '../internal/record-parser.js';

/**
 * @typedef {Object} MaxiParseOptions
 * @property {'strict'|'lax'} [mode='lax'] Parsing mode
 * @property {string} [filename] Filename for error messages
 * @property {(pathOrUrl: string) => Promise<string>|string} [loadSchema] Schema loader function
 */

/**
 * Parse MAXI input into structured result.
 *
 * @param {string} input MAXI file content
 * @param {MaxiParseOptions} [options] Parse options
 * @returns {MaxiParseResult} Parsed schema and records
 * @throws {MaxiError} On parse errors
 */
export async function parseMaxi(input, options = {}) {
  const result = new MaxiParseResult();
  result.schema.mode = options.mode ?? 'lax';

  // Split input into schema and records sections
  const { schemaSection, recordsSection } = splitSections(input);

  // Phase 1: Parse schema section (directives + types + imports)
  const schemaParser = new SchemaParser(schemaSection, result, options);
  await schemaParser.parse();

  // Phase 2: Parse records section
  if (recordsSection) {
    const recordParser = new RecordParser(recordsSection, result, options);
    await recordParser.parse?.(); // allow future async; current impl is sync
  }

  return result;
}

/**
 * Split input into schema and records sections on ### delimiter.
 * @param {string} input
 * @returns {{schemaSection: string, recordsSection: string | null}}
 */
function splitSections(input) {
  // Match ### on its own line (with optional whitespace and line endings)
  const separatorRegex = /^[ \t]*###[ \t]*(?:\r?\n|$)/m;
  const match = separatorRegex.exec(input);

  if (!match) {
    // No separator found - entire input is either schema-only or records-only.
    //
    // We ONLY treat as schema-only if we see something unambiguously schema:
    // - directives (@...)
    // - explicit type name (Alias:TypeName...)
    // - inheritance marker before '(' (Alias<Parent>(...)) -- only valid in schema
    const hasDirective = /^[ \t]*@/m.test(input);
    const hasExplicitTypeDef = /^[ \t]*[A-Za-z_][A-Za-z0-9_-]*[ \t]*:/m.test(input);
    const hasInheritanceTypeDef = /^[ \t]*[A-Za-z_][A-Za-z0-9_-]*[ \t]*<[^>]+>[ \t]*\(/m.test(input);

    if (hasDirective || hasExplicitTypeDef || hasInheritanceTypeDef) {
      return { schemaSection: input, recordsSection: null };
    }

    // Otherwise treat as records-only (covers plain Alias(...) records)
    return { schemaSection: '', recordsSection: input };
  }

  const schemaSection = input.slice(0, match.index).trim();
  const recordsSection = input.slice(match.index + match[0].length).trim();

  return {
    schemaSection,
    recordsSection: recordsSection || null
  };
}
