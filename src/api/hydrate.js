import { parseMaxi } from './parse.js';
import { getMaxiSchema } from '../core/schema-registry.js';

/**
 * @typedef {import('./parse.js').MaxiParseOptions} MaxiParseOptions
 * @typedef {import('./dump.js').MaxiDumpTypeInput} MaxiDumpTypeInput
 */

/**
 * @typedef {Object} MaxiHydrateResult
 * @property {Record<string, any[]>} objects
 * @property {import('../core/types.js').MaxiSchema} schema
 * @property {Array<{message:string,code?:string,line?:number}>} warnings
 */

const NON_REF_TYPES = new Set(['str', 'int', 'decimal', 'float', 'bool', 'bytes']);

/**
 * Parse MAXI text and hydrate records into class instances.
 *
 * @param {string} input
 * @param {Record<string, Function>} classMap  e.g. `{ U: User, O: Order }`
 * @param {MaxiParseOptions} [options]
 * @returns {Promise<MaxiHydrateResult>}
 *
 * @example
 * const { objects } = await parseMaxiAs(maxi, { U: User, O: Order });
 */
export async function parseMaxiAs(input, classMap, options = {}) {
  if (!classMap || typeof classMap !== 'object' || Array.isArray(classMap)) {
    throw new TypeError('parseMaxiAs: classMap must be a { [alias]: Class } object.');
  }
  const result = await parseMaxi(input, options);
  return _hydrateResult(result, classMap);
}

/**
 * Convenience variant of `parseMaxiAs` — pass an array of classes instead of
 * an alias → class map. Each class must have a `static maxiSchema` property
 * or be registered via `defineMaxiSchema`.
 *
 * @param {string} input
 * @param {Function[]} classes   e.g. `[User, Order]`
 * @param {MaxiParseOptions} [options]
 * @returns {Promise<MaxiHydrateResult>}
 *
 * @example
 * const { objects } = await parseMaxiAutoAs(maxi, [User, Order]);
 */
export async function parseMaxiAutoAs(input, classes, options = {}) {
  if (!Array.isArray(classes)) {
    throw new TypeError('parseMaxiAutoAs: second argument must be an array of classes.');
  }
  /** @type {Record<string, Function>} */
  const classMap = {};
  for (const Cls of classes) {
    const schema = getMaxiSchema(Cls);
    if (!schema) {
      throw new Error(
        `parseMaxiAutoAs: no maxiSchema found for class '${Cls.name}'. ` +
        `Attach a 'static maxiSchema' property or use defineMaxiSchema().`
      );
    }
    classMap[schema.alias] = Cls;
  }
  return parseMaxiAs(input, classMap, options);
}

function _hydrateResult(result, classMap) {
  /** @type {Map<string, MaxiDumpTypeInput>} */
  const schemaByAlias = new Map();
  for (const [alias, Cls] of Object.entries(classMap)) {
    const parsed = result.schema.getType(alias);
    if (parsed) {
      schemaByAlias.set(alias, parsed);
    } else {
      const cls = getMaxiSchema(Cls);
      if (cls) schemaByAlias.set(alias, cls);
    }
  }

  /** @type {Record<string, any[]>} */
  const objects = {};
  /** @type {Map<string, Map<string, any>>} */
  const instanceRegistry = new Map();

  for (const record of result.records) {
    const Cls = classMap[record.alias];
    if (!Cls) continue;

    const schema = schemaByAlias.get(record.alias);
    const fieldMap = _recordToFieldMap(record, schema);
    const instance = _construct(Cls, fieldMap);

    if (!objects[record.alias]) objects[record.alias] = [];
    objects[record.alias].push(instance);

    const idField = _findIdField(schema);
    if (idField) {
      const idVal = fieldMap[idField];
      if (idVal != null) {
        if (!instanceRegistry.has(record.alias)) instanceRegistry.set(record.alias, new Map());
        instanceRegistry.get(record.alias).set(String(idVal), instance);
      }
    }
  }

  _resolveReferences(objects, schemaByAlias, instanceRegistry, result.schema);

  return { objects, schema: result.schema, warnings: result.warnings };
}

function _recordToFieldMap(record, schema) {
  const fields = schema?.fields ?? [];
  const map = {};
  if (fields.length > 0) {
    for (let i = 0; i < fields.length; i++) {
      map[fields[i].name] = i < record.values.length ? record.values[i] : null;
    }
  } else {
    for (let i = 0; i < record.values.length; i++) {
      map[i] = record.values[i];
    }
  }
  return map;
}

function _construct(Cls, fieldMap) {
  const firstKey = Object.keys(fieldMap)[0];
  try {
    const inst = new Cls(fieldMap);
    if (firstKey === undefined || inst[firstKey] === fieldMap[firstKey]) return inst;
  } catch { /* fall through */ }
  try {
    const inst = new Cls();
    return Object.assign(inst, fieldMap);
  } catch { /* fall through */ }
  return Object.assign(Object.create(Cls.prototype), fieldMap);
}

function _findIdField(schema) {
  if (!schema?.fields) return null;
  for (const f of schema.fields) {
    if (f.constraints?.some(c => c.type === 'id')) return f.name;
  }
  for (const f of schema.fields) {
    if (f.name === 'id') return f.name;
  }
  return null;
}

function _resolveReferences(objects, schemaByAlias, instanceRegistry, parsedSchema) {
  for (const [alias, instances] of Object.entries(objects)) {
    const schema = schemaByAlias.get(alias);
    if (!schema?.fields) continue;
    for (const instance of instances) {
      for (const field of schema.fields) {
        const refAlias = _getRefAlias(field.typeExpr, parsedSchema);
        if (!refAlias) continue;
        const refRegistry = instanceRegistry.get(refAlias);
        if (!refRegistry) continue;
        const currentVal = instance[field.name];
        if (currentVal == null || typeof currentVal === 'object') continue;
        const resolved = refRegistry.get(String(currentVal));
        if (resolved !== undefined) instance[field.name] = resolved;
      }
    }
  }
}

function _getRefAlias(typeExpr, parsedSchema) {
  if (!typeExpr) return null;
  let t = typeExpr.trim().replace(/(\[\])+$/, '');
  if (NON_REF_TYPES.has(t)) return null;
  if (t === 'map' || t.startsWith('map<')) return null;
  if (t.startsWith('enum')) return null;
  if (parsedSchema.hasType(t)) return t;
  return null;
}
