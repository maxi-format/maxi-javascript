import { MaxiParseResult } from '../core/types.js';
import { SchemaParser } from '../internal/schema-parser.js';
import { RecordParser } from '../internal/record-parser.js';
import { buildObjectRegistry, validateReferences } from '../internal/reference-resolver.js';

const NON_REF_TYPES = new Set(['str', 'int', 'decimal', 'float', 'bool', 'bytes']);

/**
 * @typedef {Object} MaxiParseOptions
 * @property {'strict'|'lax'} [mode='lax']
 * @property {string} [filename]
 * @property {(pathOrUrl: string) => Promise<string>|string} [loadSchema]
 */

/**
 * Parse MAXI input into a structured result (schema + records).
 * @param {string} input
 * @param {MaxiParseOptions} [options]
 * @returns {Promise<MaxiParseResult>}
 */
export async function parseMaxi(input, options = {}) {
  const result = new MaxiParseResult();
  result.schema.mode = options.mode ?? 'lax';

  const { schemaSection, recordsSection } = splitSections(input);

  const schemaParser = new SchemaParser(schemaSection, result, options);
  await schemaParser.parse();

  if (recordsSection) {
    const recordParser = new RecordParser(recordsSection, result, options);
    await recordParser.parse?.();
  }

  if (result.records.length > 0 && result.schema.types.size > 0) {
    // Only build registry if any field references another type
    let hasRefs = false;
    for (const [, typeDef] of result.schema.types) {
      for (const field of typeDef.fields) {
        if (field.typeExpr && !NON_REF_TYPES.has(field.typeExpr) &&
            !field.typeExpr.startsWith('enum') && field.typeExpr !== 'map' &&
            !field.typeExpr.startsWith('map<')) {
          hasRefs = true;
          break;
        }
      }
      if (hasRefs) break;
    }

    if (hasRefs) {
      const registry = buildObjectRegistry(result);
      Object.defineProperty(result, '_objectRegistry', {
        value: registry,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      validateReferences(result, registry, options.filename);
    }
  }

  return result;
}

/**
 * @param {string} input
 * @returns {{schemaSection: string, recordsSection: string | null}}
 */
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

  return {
    schemaSection,
    recordsSection: recordsSection || null
  };
}
