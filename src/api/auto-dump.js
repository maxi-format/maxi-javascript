import { dumpMaxi } from './dump.js';
import { getMaxiSchema } from '../core/schema-registry.js';

/**
 * @typedef {import('./dump.js').MaxiDumpOptions} MaxiDumpOptions
 * @typedef {import('./dump.js').MaxiDumpTypeInput} MaxiDumpTypeInput
 */

/**
 * Serialize class instances into a MAXI string, inferring schema automatically
 * from `static maxiSchema` properties or the registry (`defineMaxiSchema`).
 *
 * `objects` can be:
 * - An **array** of instances sharing the same class/alias
 * - A **`{ [alias]: instance[] }`** map for multiple types
 *
 * Any `options.types` supplied are merged with the auto-collected ones (caller wins).
 *
 * @param {Array<object> | Record<string, Array<object>>} objects
 * @param {MaxiDumpOptions} [options]
 * @returns {string}
 *
 * @example
 * const maxi = dumpMaxiAuto([new User({ id: 1, name: 'Julie' })]);
 *
 * @example
 * const maxi = dumpMaxiAuto({ U: users, O: orders });
 */
export function dumpMaxiAuto(objects, options = {}) {
  /** @type {Record<string, Array<object>>} */
  let dataMap;

  if (Array.isArray(objects)) {
    const firstSchema = objects.length > 0 ? getMaxiSchema(objects[0]) : null;
    const alias = firstSchema?.alias ?? options.defaultAlias;
    if (!alias) {
      throw new Error(
        'dumpMaxiAuto: cannot determine alias for the array. ' +
        'Either attach a `static maxiSchema` to the class or pass `options.defaultAlias`.'
      );
    }
    dataMap = { [alias]: objects };
  } else if (objects && typeof objects === 'object') {
    dataMap = objects;
  } else {
    throw new TypeError('dumpMaxiAuto: `objects` must be an array or a { [alias]: instance[] } map.');
  }

  /** @type {Map<string, MaxiDumpTypeInput>} */
  const collectedTypes = new Map();

  for (const [, rows] of Object.entries(dataMap)) {
    for (const obj of rows ?? []) {
      if (obj && typeof obj === 'object') _collectSchemasDeep(obj, collectedTypes);
    }
  }

  if (options.types) {
    const callerTypes = options.types instanceof Map
      ? options.types
      : new Map((Array.isArray(options.types) ? options.types : []).map(t => [t.alias, t]));
    for (const [alias, schema] of callerTypes) collectedTypes.set(alias, schema);
  }

  return dumpMaxi(dataMap, {
    ...options,
    types: collectedTypes.size > 0 ? collectedTypes : undefined,
  });
}

function _collectSchemasDeep(obj, collected) {
  if (!obj || typeof obj !== 'object') return;
  const schema = getMaxiSchema(obj);
  if (!schema || collected.has(schema.alias)) return;
  collected.set(schema.alias, schema);
  for (const field of schema.fields ?? []) {
    const v = obj[field.name];
    if (!v) continue;
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      if (item && typeof item === 'object') _collectSchemasDeep(item, collected);
    }
  }
}
