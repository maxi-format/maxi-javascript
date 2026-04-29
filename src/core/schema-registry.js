/**
 * Global WeakMap-based registry for MAXI schema metadata.
 * Keyed by constructor function (class), value is a MaxiDumpTypeInput descriptor.
 *
 * @type {WeakMap<Function, import('../api/dump.js').MaxiDumpTypeInput>}
 */
const registry = new WeakMap();

/**
 * Register a MAXI schema descriptor for a class or constructor function.
 * Use this when you cannot (or do not want to) add a `static maxiSchema` property
 * directly to the class — e.g. for third-party classes or plain-object factories.
 *
 * @param {Function} Class - The class / constructor to register schema for.
 * @param {import('../api/dump.js').MaxiDumpTypeInput} schema
 *
 * @example
 * defineMaxiSchema(User, {
 *   alias: 'U',
 *   name: 'User',
 *   fields: [
 *     { name: 'id', typeExpr: 'int' },
 *     { name: 'name' },
 *     { name: 'email', defaultValue: 'unknown' },
 *   ],
 * });
 */
export function defineMaxiSchema(Class, schema) {
  if (typeof Class !== 'function') {
    throw new TypeError('defineMaxiSchema: first argument must be a class or constructor function.');
  }
  if (!schema || typeof schema !== 'object') {
    throw new TypeError('defineMaxiSchema: second argument must be a schema descriptor object.');
  }
  if (!schema.alias || typeof schema.alias !== 'string') {
    throw new TypeError('defineMaxiSchema: schema.alias is required and must be a string.');
  }
  registry.set(Class, schema);
}

/**
 * Look up the MAXI schema descriptor for a class, instance, or constructor.
 *
 * Resolution order:
 * 1. `Class.maxiSchema` — static property directly on the class
 * 2. Global WeakMap registry (populated via `defineMaxiSchema`)
 *
 * @param {Function | object} ClassOrInstance
 * @returns {import('../api/dump.js').MaxiDumpTypeInput | null}
 *
 * @example
 * // From a class
 * getMaxiSchema(User);
 *
 * // From an instance
 * getMaxiSchema(new User());
 */
export function getMaxiSchema(ClassOrInstance) {
  if (!ClassOrInstance) return null;

  // Resolve to the constructor if an instance was passed
  const Ctor = typeof ClassOrInstance === 'function'
    ? ClassOrInstance
    : ClassOrInstance.constructor;

  if (!Ctor || Ctor === Object || Ctor === Function) return null;

  // 1. Static property on the class itself
  if (Ctor.maxiSchema && typeof Ctor.maxiSchema === 'object') {
    return Ctor.maxiSchema;
  }

  // 2. WeakMap registry
  if (registry.has(Ctor)) {
    return registry.get(Ctor);
  }

  return null;
}

/**
 * Remove a previously registered schema from the WeakMap registry.
 * (Does not affect `static maxiSchema` properties.)
 *
 * @param {Function} Class
 */
export function undefineMaxiSchema(Class) {
  registry.delete(Class);
}
