/**
 * @typedef {Object} MaxiDumpOptions
 * @property {boolean} [multiline=false] Use multi-line formatting
 * @property {boolean} [includeTypes=true] Include type definitions in the output
 * @property {string} [version] MAXI version (e.g., '1.0.0')
 * @property {'strict'|'lax'} [mode] Parsing mode for directives
 * @property {string} [schemaFile] Path to an external schema file to import via `@schema`
 * @property {Map<string, MaxiDumpTypeInput> | MaxiDumpTypeInput[]} [types] Inline type definitions
 * @property {string} [defaultAlias] The type alias to use when `data` is a single object or an array of objects.
 * @property {boolean} [collectReferences=true] Promote nested typed objects with `id` into their own records
 */

/**
 * @typedef {Object} MaxiDumpTypeInput
 * @property {string} alias
 * @property {string} [name]
 * @property {string[]} [parents]
 * @property {Array<{name:string,typeExpr?:string,annotation?:string,constraints?:any[],defaultValue?:any}>} fields
 */

/**
 * @typedef {Object} MaxiDumpSchemaInput
 * @property {string} [version]
 * @property {'strict'|'lax'} [mode]
 * @property {string[]} [imports]
 * @property {Map<string, MaxiDumpTypeInput> | MaxiDumpTypeInput[]} [types]
 */

/**
 * @typedef {Object} MaxiDumpFromObjectsInput
 * @property {MaxiDumpSchemaInput} schema
 * @property {Record<string, Array<Record<string, any>>>} data Records grouped by type alias
 */

/**
 * Serialize a JavaScript object, array, or map into a MAXI string.
 *
 * @param {Record<string, any> | Array<Record<string, any>> | Record<string, Array<Record<string, any>>> | import('../core/types.js').MaxiParseResult} data
 *   The data to serialize. Can be:
 *   - A single object (requires `options.defaultAlias`).
 *   - An array of objects (requires `options.defaultAlias`).
 *   - A map of `{ alias: [objects...] }`.
 *   - A previously parsed `MaxiParseResult` object for round-tripping.
 * @param {MaxiDumpOptions} [options]
 * @returns {string}
 */
export function dumpMaxi(data, options = {}) {
  // Heuristic dispatch for round-tripping a parse result
  if (data && 'records' in data && Array.isArray(data.records)) {
    return dumpMaxiFromParseResult(/** @type {import('../core/types.js').MaxiParseResult} */ (data), options);
  }

  // Normalize various data inputs into the { alias: [objects...] } structure
  let dataMap = {};
  if (Array.isArray(data)) {
    if (!options.defaultAlias) throw new Error('dumpMaxi requires `options.defaultAlias` when dumping an array.');
    dataMap[options.defaultAlias] = data;
  } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    // If it doesn't look like a map of arrays, treat as a single object
    const firstValue = Object.values(data)[0];
    if (!Array.isArray(firstValue)) {
      if (!options.defaultAlias) throw new Error('dumpMaxi requires `options.defaultAlias` when dumping a single object.');
      dataMap[options.defaultAlias] = [data];
    } else {
      dataMap = data; // Assumed to be a map of { alias: [objects...] }
    }
  }

  const input = {
    schema: {
      version: options.version,
      mode: options.mode,
      imports: options.schemaFile ? [options.schemaFile] : [],
      types: options.types,
    },
    data: dataMap,
  };

  return dumpMaxiFromObjects(input, options);
}

/**
 * @param {import('../core/types.js').MaxiParseResult} result
 * @param {MaxiDumpOptions} options
 * @returns {string}
 */
function dumpMaxiFromParseResult(result, options) {
  const multiline = options.multiline ?? false;
  const includeTypes = options.includeTypes ?? true;
  const out = [];

  // Directives
  if (result?.schema?.version && result.schema.version !== '1.0.0') {
    out.push(`@version:${result.schema.version}`);
  }
  if (result?.schema?.mode === 'strict') {
    out.push(`@mode:strict`);
  }
  for (const imp of result?.schema?.imports ?? []) {
    out.push(`@schema:${imp}`);
  }

  // Type definitions
  if (includeTypes && (result?.schema?.types?.size ?? 0) > 0) {
    if (out.length > 0) out.push('');
    for (const td of result.schema.types.values()) {
      out.push(dumpTypeDef(td, multiline));
    }
  }

  // Schema/data separator
  if (out.length > 0) {
    out.push('###');
  }

  // Data records
  for (const record of result?.records ?? []) {
    out.push(dumpRecord(record, multiline));
  }

  return out.join('\n');
}

/**
 * @param {MaxiDumpFromObjectsInput} input
 * @param {MaxiDumpOptions} options
 * @returns {string}
 */
function dumpMaxiFromObjects(input, options) {
  const multiline = options.multiline ?? false;
  const includeTypes = options.includeTypes ?? true;
  const out = [];

  const schema = input.schema ?? {};
  const types = normalizeTypes(schema.types);

  // Directives
  if (schema.version && schema.version !== '1.0.0') out.push(`@version:${schema.version}`);
  if (schema.mode === 'strict') out.push(`@mode:strict`);
  for (const imp of schema.imports ?? []) out.push(`@schema:${imp}`);

  // Type definitions
  if (includeTypes && types.size > 0) {
    if (out.length > 0) out.push('');
    for (const t of types.values()) out.push(dumpTypeInfo(t, multiline));
  }

  // Schema/data separator
  if (out.length > 0) out.push('###');

  // Data records (objects -> positional record)
  const recordsToDump = new Map(); // alias -> array of objects
  const seenObjects = new Set(); // To avoid processing the same object twice

  // Prime the pump with the initial data
  for (const [alias, rows] of Object.entries(input.data ?? {})) {
    if (!recordsToDump.has(alias)) recordsToDump.set(alias, []);
    recordsToDump.get(alias).push(...rows);
  }

  // NEW: allow disabling reference collection (perf / simple dumps)
  const collectRefs = options.collectReferences ?? true;
  if (collectRefs) {
    collectReferencedObjectsIterative(types, recordsToDump, seenObjects);
  }

  // Now dump all collected records
  for (const [alias, rows] of recordsToDump.entries()) {
    const t = types.get(alias);
    for (const obj of rows ?? []) {
      out.push(dumpObjectAsRecord(alias, obj, t, types, multiline));
    }
  }

  return out.join('\n');
}

/**
 * Iteratively traverses known typed objects and promotes nested typed objects with an `id` field
 * into their own top-level records.
 *
 * @param {Map<string, MaxiDumpTypeInput>} allTypes
 * @param {Map<string, Array<Record<string, any>>>} recordsToDump
 * @param {Set<any>} seenObjects
 */
function collectReferencedObjectsIterative(allTypes, recordsToDump, seenObjects) {
  /** @type {Array<{alias:string,obj:Record<string,any>}>} */
  const work = [];

  // Seed worklist with all currently-known top-level records
  for (const [alias, rows] of recordsToDump.entries()) {
    for (const obj of rows ?? []) {
      if (obj && typeof obj === 'object' && !seenObjects.has(obj)) {
        seenObjects.add(obj);
        work.push({ alias, obj });
      }
    }
  }

  while (work.length > 0) {
    const { alias, obj } = work.pop();
    const t = allTypes.get(alias);
    if (!t) continue;

    for (const field of t.fields ?? []) {
      const v = obj[field.name];
      if (!v || typeof v !== 'object') continue;

      const baseType = field.typeExpr?.replace(/\[\]$/, '');
      const nestedType = baseType ? allTypes.get(baseType) : undefined;
      if (!nestedType) continue;

      const idField = nestedType.fields?.find(f => f.name === 'id');
      if (!idField) continue;

      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (seenObjects.has(item)) continue;

        // Promote only if it has an id value
        if (item[idField.name] !== undefined) {
          if (!recordsToDump.has(nestedType.alias)) recordsToDump.set(nestedType.alias, []);
          recordsToDump.get(nestedType.alias).push(item);

          seenObjects.add(item);
          work.push({ alias: nestedType.alias, obj: item });
        }
      }
    }
  }
}

/**
 * @param {Map<string, MaxiDumpTypeInput> | MaxiDumpTypeInput[] | undefined} types
 * @returns {Map<string, MaxiDumpTypeInput>}
 */
function normalizeTypes(types) {
  if (!types) return new Map();
  if (types instanceof Map) return types;
  const m = new Map();
  for (const t of types) m.set(t.alias, t);
  return m;
}

/**
 * @param {MaxiDumpTypeInput} t
 * @param {boolean} multiline
 * @returns {string}
 */
function dumpTypeInfo(t, multiline) {
  const header = t.name ? `${t.alias}:${t.name}` : t.alias;
  const parents = t.parents?.length ? `<${t.parents.join(',')}>` : '';
  const fields = (t.fields ?? []).map(f => dumpField(f)).join('|');

  if (!multiline) return `${header}${parents}(${fields})`;
  const body = (t.fields ?? []).map(f => `  ${dumpField(f)}`).join('|\n');
  return `${header}${parents}(\n${body}\n)`;
}

/**
 * Dump plain object as MAXI record using schema field order.
 * Missing property => empty (so defaults/null semantics apply via parser).
 * null/undefined => explicit null '~' (override).
 *
 * @param {string} alias
 * @param {Record<string, any>} obj
 * @param {MaxiDumpTypeInput | undefined} t
 * @param {Map<string, MaxiDumpTypeInput>} allTypes
 * @param {boolean} multiline
 * @returns {string}
 */
function dumpObjectAsRecord(alias, obj, t, allTypes, multiline) {
  let vals = [];
  if (t) {
    // Schema-driven: emit values in field order
    const fields = t.fields ?? [];
    vals = fields.map(f => {
      if (!Object.prototype.hasOwnProperty.call(obj, f.name)) return ''; // omitted/empty
      const v = obj[f.name];
      if (v === null || v === undefined) return '~';
      return dumpValue(v, f, allTypes);
    });
  } else {
    // No schema: best-effort, emit values in object key order
    vals = Object.values(obj).map(v => {
      if (v === null || v === undefined) return '~';
      return dumpValue(v, undefined, allTypes);
    });
  }

  // Trim trailing empty values as they are optional by spec
  let lastIndex = vals.length - 1;
  while (lastIndex >= 0 && vals[lastIndex] === '') {
    lastIndex--;
  }
  vals = vals.slice(0, lastIndex + 1);

  if (!multiline) return `${alias}(${vals.join('|')})`;
  const body = vals.map(v => `  ${v}`).join('|\n');
  return `${alias}(\n${body}\n)`;
}

/**
 * @param {import('../core/types.js').MaxiTypeDef} td
 * @param {boolean} multiline
 * @returns {string}
 */
function dumpTypeDef(td, multiline) {
  const header = td.name ? `${td.alias}:${td.name}` : td.alias;
  const parents = td.parents.length ? `<${td.parents.join(',')}>` : '';
  const fields = td.fields.map(f => dumpField(f)).join('|');

  if (!multiline) {
    return `${header}${parents}(${fields})`;
  }

  const body = td.fields.map(f => `  ${dumpField(f)}`).join('|\n');
  return `${header}${parents}(\n${body}\n)`;
}

/**
 * @param {import('../core/types.js').MaxiFieldDef} field
 * @returns {string}
 */
function dumpField(field) {
  let result = field.name;

  if (field.typeExpr) result += `:${field.typeExpr}`;
  if (field.annotation) result += `@${field.annotation}`;

  // Dump constraints
  if (field.constraints && field.constraints.length > 0) {
    const constraintStrs = field.constraints.map(c => {
      switch (c.type) {
        case 'required': return '!';
        case 'id': return 'id';
        case 'comparison': return `${c.operator}${c.value}`;
        case 'pattern': return `pattern:${c.value}`;
        case 'mime':
          if (Array.isArray(c.value) && c.value.length > 1) {
            return `mime:[${c.value.join(',')}]`;
          }
          return `mime:${Array.isArray(c.value) ? c.value[0] : c.value}`;
        case 'decimal-precision': return c.value;
        case 'exact-length': return `=${c.value}`;
        default: return '';
      }
    }).filter(Boolean);

    if (constraintStrs.length > 0) {
      result += `(${constraintStrs.join(',')})`;
    }
  }

  // Dump default value
  if (field.defaultValue !== undefined) {
    const defStr = typeof field.defaultValue === 'string' && needsQuoting(field.defaultValue)
      ? `"${escapeString(field.defaultValue)}"`
      : String(field.defaultValue);
    result += `=${defStr}`;
  }

  return result;
}

/**
 * @param {import('../core/types.js').MaxiRecord} record
 * @param {boolean} multiline
 * @returns {string}
 */
function dumpRecord(record, multiline) {
  const values = record.values.map(v => dumpValue(v, undefined, new Map()));

  if (!multiline) {
    return `${record.alias}(${values.join('|')})`;
  }

  const body = values.map(v => `  ${v}`).join('|\n');
  return `${record.alias}(\n${body}\n)`;
}

/**
 * @param {unknown} value
 * @param {any} fieldInfo
 * @param {Map<string, MaxiDumpTypeInput>} allTypes
 * @returns {string}
 */
function dumpValue(value, fieldInfo, allTypes) {
  if (value === null || value === undefined) return '~';

  if (typeof value === 'string') {
    return needsQuoting(value) ? `"${escapeString(value)}"` : value;
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    // IMPORTANT: for typed arrays (e.g. "O[]"), each element should be treated as "O"
    // Otherwise we resolve nestedType using "O[]" repeatedly and can recurse forever.
    const elemTypeExpr =
      typeof fieldInfo?.typeExpr === 'string' && /\[\]\s*$/.test(fieldInfo.typeExpr)
        ? fieldInfo.typeExpr.replace(/\[\]\s*$/, '')
        : undefined;

    const elemFieldInfo = elemTypeExpr
      ? { ...fieldInfo, typeExpr: elemTypeExpr }
      : fieldInfo;

    return `[${value.map(v => dumpValue(v, elemFieldInfo, allTypes)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const fieldTypeRef = fieldInfo?.typeExpr?.replace(/\[\]$/, '');
    const nestedType = fieldTypeRef ? allTypes.get(fieldTypeRef) : undefined;

    if (nestedType) {
      const idField = nestedType.fields.find(f => f.name === 'id');
      if (idField && value[idField.name] !== undefined) {
        return dumpValue(value[idField.name], undefined, allTypes);
      }
      return dumpObjectAsRecord('', value, nestedType, allTypes, false);
    }

    // Unknown object => map (do NOT attempt inline recursion)
    return `{${Object.entries(value).map(([k, v]) => `${dumpMapKey(k)}:${dumpValue(v, undefined, allTypes)}`).join(',')}}`;
  }

  return String(value);
}

/**
 * @param {string} k
 * @returns {string}
 */
function dumpMapKey(k) {
  return needsQuoting(k) ? `"${escapeString(k)}"` : k;
}

/**
 * @param {string} str
 * @returns {boolean}
 */
function needsQuoting(str) {
  return /[|()\[\]{}~,:]|\s/.test(str);
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeString(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
