import { MaxiError, MaxiErrorCode } from '../core/errors.js';

const NON_REF_TYPES = new Set([
  'int', 'decimal', 'float', 'str', 'bool', 'bytes',
]);

function getReferencedTypeAlias(typeExpr, schema) {
  if (!typeExpr) return null;
  let t = typeExpr.trim();

  t = t.replace(/(\[\])+$/, '');

  if (NON_REF_TYPES.has(t)) return null;
  if (t === 'map' || t.startsWith('map<')) return null;
  if (t.startsWith('enum')) return null;

  const alias = schema.resolveTypeAlias?.(t) ?? (schema.hasType(t) ? t : null);
  return alias;
}

/**
 * Build an object registry (alias → id → object) from all parsed records and inline objects.
 * @param {import('../core/types.js').MaxiParseResult} result
 * @returns {Map<string, Map<string, object>>}
 */
export function buildObjectRegistry(result) {
  /** @type {Map<string, Map<string, object>>} */
  const registry = new Map();

  for (const record of result.records) {
    const typeDef = result.schema.getType(record.alias);
    if (!typeDef) continue;

    const idField = typeDef.getIdField();
    if (!idField) continue;

    const idIndex = typeDef.fields.indexOf(idField);
    if (idIndex < 0 || idIndex >= record.values.length) continue;

    const idValue = record.values[idIndex];
    if (idValue === null || idValue === undefined) continue;

    if (!registry.has(record.alias)) {
      registry.set(record.alias, new Map());
    }

    const obj = {};
    for (let i = 0; i < typeDef.fields.length; i++) {
      obj[typeDef.fields[i].name] = i < record.values.length ? record.values[i] : null;
    }

    registry.get(record.alias).set(String(idValue), obj);
  }

  for (const record of result.records) {
    const typeDef = result.schema.getType(record.alias);
    if (!typeDef) continue;

    for (let i = 0; i < typeDef.fields.length; i++) {
      const field = typeDef.fields[i];
      const value = record.values[i];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

      const refAlias = getReferencedTypeAlias(field.typeExpr, result.schema);
      if (!refAlias) continue;

      const refTypeDef = result.schema.getType(refAlias);
      if (!refTypeDef) continue;

      const refIdField = refTypeDef.getIdField();
      if (!refIdField) continue;

      const refIdValue = value[refIdField.name];
      if (refIdValue === null || refIdValue === undefined) continue;

      if (!registry.has(refAlias)) {
        registry.set(refAlias, new Map());
      }

      const idKey = String(refIdValue);
      if (!registry.get(refAlias).has(idKey)) {
        registry.get(refAlias).set(idKey, value);
      }
    }
  }

  return registry;
}

/**
 * Validate that all object references resolve to a known object.
 * Runs after all records are parsed to support forward references.
 * @param {import('../core/types.js').MaxiParseResult} result
 * @param {Map<string, Map<string, object>>} registry
 * @param {string} [filename]
 */
export function validateReferences(result, registry, filename) {
  const isStrict = result.schema.mode === 'strict';

  for (const record of result.records) {
    const typeDef = result.schema.getType(record.alias);
    if (!typeDef) continue;

    for (let i = 0; i < typeDef.fields.length; i++) {
      const field = typeDef.fields[i];
      const value = record.values[i];

      if (value === null || value === undefined) continue;
      if (typeof value === 'object') continue;

      const refAlias = getReferencedTypeAlias(field.typeExpr, result.schema);
      if (!refAlias) continue;

      const typeRegistry = registry.get(refAlias);
      const idKey = String(value);
      if (!typeRegistry || !typeRegistry.has(idKey)) {
        const msg = `Unresolved reference: field '${field.name}' in '${record.alias}' references ${refAlias} id '${value}', but no such object found`;

        if (isStrict) {
          throw new MaxiError(
            msg,
            MaxiErrorCode.UnresolvedReferenceError,
            { line: record.lineNumber, filename }
          );
        }

        result.addWarning(msg, {
          code: MaxiErrorCode.UnresolvedReferenceError,
          line: record.lineNumber,
        });
      }
    }
  }
}

export { getReferencedTypeAlias };
