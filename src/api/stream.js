import { MaxiParseResult } from '../core/types.js';
import { MaxiError, MaxiErrorCode } from '../core/errors.js';
import { SchemaParser } from '../internal/schema-parser.js';
import { RecordParser } from '../internal/record-parser.js';

/**
 * @typedef {import('./parse.js').MaxiParseOptions} MaxiParseOptions
 */

/**
 * Streaming parse result. Provides the fully-parsed schema and an async
 * iterator that yields records one at a time.
 */
export class MaxiStreamResult {
  /**
   * @param {import('../core/types.js').MaxiSchema} schema
   * @param {AsyncGenerator<import('../core/types.js').MaxiRecord>} recordIterator
   * @param {import('../core/types.js').MaxiParseResult} result
   */
  constructor(schema, recordIterator, result) {
    /** @type {import('../core/types.js').MaxiSchema} */
    this.schema = schema;
    /** @type {Array<{message: string, code?: string, line?: number}>} */
    this.warnings = result.warnings;
    /** @private */
    this._iterator = recordIterator;
  }

  /**
   * Async generator over records.
   * @returns {AsyncGenerator<import('../core/types.js').MaxiRecord>}
   */
  async *records() {
    yield* this._iterator;
  }

  [Symbol.asyncIterator]() {
    return this.records();
  }
}

/**
 * Parse MAXI input in streaming mode.
 * Phase 1 (schema) completes before returning; phase 2 yields records lazily.
 * @param {string} input
 * @param {MaxiParseOptions} [options]
 * @returns {Promise<MaxiStreamResult>}
 */
export async function streamMaxi(input, options = {}) {
  const result = new MaxiParseResult();
  result.schema.mode = options.mode ?? 'lax';

  const { schemaSection, recordsSection } = splitSections(input);

  const schemaParser = new SchemaParser(schemaSection, result, options);
  await schemaParser.parse();

  const recordIterator = generateRecords(recordsSection, result, options);
  return new MaxiStreamResult(result.schema, recordIterator, result);
}

async function* generateRecords(recordsText, result, options) {
  if (!recordsText || !recordsText.trim()) return;

  const parser = new RecordParser(recordsText, result, options);
  const text = recordsText;
  const len = text.length;
  let i = 0;
  let lineNumber = 1;

  const isIdentStart = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
  const isIdentChar = (c) =>
    isIdentStart(c) || (c >= '0' && c <= '9') || c === '-' || c === '_';

  while (i < len) {
    const ch = text[i];
    if (ch === '\n') { lineNumber++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (!isIdentStart(ch)) { i++; continue; }

    const aliasStart = i;
    i++;
    while (i < len && isIdentChar(text[i])) i++;
    const alias = text.slice(aliasStart, i);

    while (i < len && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i++;
    if (i >= len || text[i] !== '(') continue;

    const recordLine = lineNumber;
    i++;
    const valuesStart = i;

    let parenDepth = 1;
    let bracketDepth = 0;
    let braceDepth = 0;
    let inString = false;
    let escapeNext = false;

    while (i < len) {
      const c = text[i];
      if (c === '\n') lineNumber++;
      if (escapeNext) { escapeNext = false; i++; continue; }
      if (inString) {
        if (c === '\\') escapeNext = true;
        else if (c === '"') inString = false;
        i++; continue;
      }
      if (c === '"') { inString = true; i++; continue; }
      if (c === '(') parenDepth++;
      else if (c === ')') { parenDepth--; if (parenDepth === 0) break; }
      else if (c === '[') bracketDepth++;
      else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (c === '{') braceDepth++;
      else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);
      i++;
    }

    if (i >= len || text[i] !== ')' || parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0) {
      if (bracketDepth !== 0) {
        throw new MaxiError(
          `Malformed array: unmatched bracket in record '${alias}'`,
          MaxiErrorCode.ArraySyntaxError,
          { line: recordLine, filename: options.filename }
        );
      }
      throw new MaxiError(
        `Unclosed record parentheses for '${alias}'`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: recordLine, filename: options.filename }
      );
    }

    const valuesStr = text.slice(valuesStart, i);
    i++;

    yield parser.parseSingleRecord(alias, valuesStr, recordLine);
  }
}

function splitSections(input) {
  const separatorRegex = /^[ \t]*###[ \t]*(?:\r?\n|$)/m;
  const match = separatorRegex.exec(input);

  if (!match) {
    const hasDirective = /^[ \t]*@/m.test(input);
    const hasExplicitTypeDef = /^[ \t]*[A-Za-z_][A-Za-z0-9_-]*[ \t]*:/m.test(input);
    const hasInheritanceTypeDef = /^[ \t]*[A-Za-z_][A-Za-z0-9_-]*[ \t]*<[^>]+>[ \t]*\(/m.test(input);

    if (hasDirective || hasExplicitTypeDef || hasInheritanceTypeDef) {
      return { schemaSection: input, recordsSection: null };
    }
    return { schemaSection: '', recordsSection: input };
  }

  const schemaSection = input.slice(0, match.index).trim();
  const recordsSection = input.slice(match.index + match[0].length).trim();
  return { schemaSection, recordsSection: recordsSection || null };
}
