/**
 * @typedef {Object} MaxiDumpOptions
 * @property {boolean} [multiline=false]
 * @property {boolean} [includeTypes=true]
 * @property {string} [version]
 * @property {'strict'|'lax'} [mode]
 * @property {string} [schemaFile]
 * @property {Map<string, MaxiDumpTypeInput> | MaxiDumpTypeInput[]} [types]
 * @property {string} [defaultAlias]
 * @property {boolean} [collectReferences=true]
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
 * @property {Record<string, Array<Record<string, any>>>} data
 */

/**
 * Serialize a JavaScript object, array, or map into a MAXI string.
 *
 * @param {Record<string, any> | Array<Record<string, any>> | Record<string, Array<Record<string, any>>> | import('../core/types.js').MaxiParseResult} data
 * @param {MaxiDumpOptions} [options]
 * @returns {string}
 */
export function dumpMaxi(data, options = {}) {
  if (data && 'records' in data && Array.isArray(data.records)) {
    return dumpMaxiFromParseResult(/** @type {import('../core/types.js').MaxiParseResult} */ (data), options);
  }

  let dataMap = {};
  if (Array.isArray(data)) {
    if (!options.defaultAlias) throw new Error('dumpMaxi requires `options.defaultAlias` when dumping an array.');
    dataMap[options.defaultAlias] = data;
  } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const firstValue = Object.values(data)[0];
    if (!Array.isArray(firstValue)) {
      if (!options.defaultAlias) throw new Error('dumpMaxi requires `options.defaultAlias` when dumping a single object.');
      dataMap[options.defaultAlias] = [data];
    } else {
      dataMap = data;
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

  if (result?.schema?.version && result.schema.version !== '1.0.0') {
    out.push(`@version:${result.schema.version}`);
  }
  if (result?.schema?.mode === 'strict') {
    out.push(`@mode:strict`);
  }
  for (const imp of result?.schema?.imports ?? []) {
    out.push(`@schema:${imp}`);
  }

  if (includeTypes && (result?.schema?.types?.size ?? 0) > 0) {
    if (out.length > 0) out.push('');
    for (const td of result.schema.types.values()) {
      out.push(dumpTypeDef(td, multiline));
    }
  }

  if (out.length > 0) {
    out.push('###');
  }

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

  resolveInheritanceForDump(types);

  if (schema.version && schema.version !== '1.0.0') out.push(`@version:${schema.version}`);
  if (schema.mode === 'strict') out.push(`@mode:strict`);
  for (const imp of schema.imports ?? []) out.push(`@schema:${imp}`);

  if (includeTypes && types.size > 0) {
    if (out.length > 0) out.push('');
    for (const t of types.values()) out.push(dumpTypeInfo(t, multiline));
  }

  if (out.length > 0) out.push('###');

  const recordsToDump = new Map();
  const seenObjects = new Set();

  for (const [alias, rows] of Object.entries(input.data ?? {})) {
    if (!recordsToDump.has(alias)) recordsToDump.set(alias, []);
    recordsToDump.get(alias).push(...rows);
  }

  const collectRefs = options.collectReferences ?? true;
  if (collectRefs) {
    collectReferencedObjectsIterative(types, recordsToDump, seenObjects);
  }

  for (const [alias, rows] of recordsToDump.entries()) {
    const t = types.get(alias);
    for (const obj of rows ?? []) {
      out.push(dumpObjectAsRecord(alias, obj, t, types, multiline, options));
    }
  }

  return out.join('\n');
}

/**
 * @param {Map<string, MaxiDumpTypeInput>} allTypes
 * @param {Map<string, Array<Record<string, any>>>} recordsToDump
 * @param {Set<any>} seenObjects
 */
function collectReferencedObjectsIterative(allTypes, recordsToDump, seenObjects) {
  /** @type {Array<{alias:string,obj:Record<string,any>}>} */
  const work = [];

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
 * @param {Map<string, MaxiDumpTypeInput>} types
 */
function resolveInheritanceForDump(types) {
  const resolved = new Set();

  function resolve(alias) {
    if (resolved.has(alias)) return;
    const t = types.get(alias);
    if (!t || !t.parents?.length) {
      resolved.add(alias);
      return;
    }

    const inheritedFields = [];
    const ownFieldNames = new Set((t.fields ?? []).map(f => f.name));

    for (const parentAlias of t.parents) {
      resolve(parentAlias);
      const parent = types.get(parentAlias);
      if (parent) {
        for (const pf of parent.fields ?? []) {
          if (!ownFieldNames.has(pf.name)) {
            inheritedFields.push({ ...pf });
            ownFieldNames.add(pf.name);
          }
        }
      }
    }

    if (inheritedFields.length > 0) {
      t.fields = [...inheritedFields, ...(t.fields ?? [])];
    }

    resolved.add(alias);
  }

  for (const alias of types.keys()) {
    resolve(alias);
  }
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
 * @param {string} alias
 * @param {Record<string, any>} obj
 * @param {MaxiDumpTypeInput | undefined} t
 * @param {Map<string, MaxiDumpTypeInput>} allTypes
 * @param {boolean} multiline
 * @returns {string}
 */
function dumpObjectAsRecord(alias, obj, t, allTypes, multiline, options) {
  let vals = [];
  if (t) {
    const fields = t.fields ?? [];
    vals = fields.map(f => {
      if (!Object.prototype.hasOwnProperty.call(obj, f.name)) return '';
      const v = obj[f.name];
      if (v === null || v === undefined) return '~';
      return dumpValue(v, f, allTypes, options);
    });
  } else {
    vals = Object.values(obj).map(v => {
      if (v === null || v === undefined) return '~';
      return dumpValue(v, undefined, allTypes, options);
    });
  }

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

  if (field.typeExpr && field.elementConstraints?.length > 0 && /\[\]/.test(field.typeExpr)) {
    const lastBracket = field.typeExpr.lastIndexOf('[]');
    const baseType = field.typeExpr.slice(0, lastBracket);
    const suffix = field.typeExpr.slice(lastBracket);

    result += `:${baseType}`;

    const elemStrs = field.elementConstraints.map(c => dumpConstraint(c)).filter(Boolean);
    if (elemStrs.length > 0) result += `(${elemStrs.join(',')})`;

    result += suffix;

    if (field.constraints?.length > 0) {
      const arrStrs = field.constraints.map(c => dumpConstraint(c)).filter(Boolean);
      if (arrStrs.length > 0) result += `(${arrStrs.join(',')})`;
    }
  } else {
    if (field.typeExpr) result += `:${field.typeExpr}`;
    if (field.annotation) result += `@${field.annotation}`;

    if (field.constraints && field.constraints.length > 0) {
      const constraintStrs = field.constraints.map(c => dumpConstraint(c)).filter(Boolean);
      if (constraintStrs.length > 0) {
        result += `(${constraintStrs.join(',')})`;
      }
    }
  }

  if (field.typeExpr && field.elementConstraints?.length > 0 && /\[\]/.test(field.typeExpr) && field.annotation) {
    result += `@${field.annotation}`;
  }

  if (field.defaultValue !== undefined) {
    const defStr = typeof field.defaultValue === 'string' && needsQuoting(field.defaultValue)
      ? `"${escapeString(field.defaultValue)}"`
      : String(field.defaultValue);
    result += `=${defStr}`;
  }

  return result;
}

/**
 * @param {any} c
 * @returns {string}
 */
function dumpConstraint(c) {
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
}

/**
 * @param {import('../core/types.js').MaxiRecord} record
 * @param {boolean} multiline
 * @returns {string}
 */
function dumpRecord(record, multiline) {
  const values = record.values.map(v => dumpValue(v, undefined, new Map(), {}));

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
function dumpValue(value, fieldInfo, allTypes, options) {
  if (value === null || value === undefined) return '~';

  if (value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) {
    const annotation = fieldInfo?.annotation;
    if (annotation === 'hex') {
      return Buffer.from(value).toString('hex');
    }
    return Buffer.from(value).toString('base64');
  }

  if (typeof value === 'string') {
    return needsQuoting(value) ? `"${escapeString(value)}"` : value;
  }

  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const elemTypeExpr =
      typeof fieldInfo?.typeExpr === 'string' && /\[\]\s*$/.test(fieldInfo.typeExpr)
        ? fieldInfo.typeExpr.replace(/\[\]\s*$/, '')
        : undefined;

    const elemFieldInfo = elemTypeExpr
      ? { ...fieldInfo, typeExpr: elemTypeExpr }
      : fieldInfo;

    return `[${value.map(v => dumpValue(v, elemFieldInfo, allTypes, options)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const fieldTypeRef = fieldInfo?.typeExpr?.replace(/\[\]$/, '');
    const nestedType = fieldTypeRef ? allTypes.get(fieldTypeRef) : undefined;

    if (nestedType) {
      const idField = nestedType.fields.find(f => f.name === 'id');
      if (idField && value[idField.name] !== undefined) {
        if (options?.collectReferences === false) {
          return dumpInlineObject(value, nestedType, allTypes, options);
        }
        return dumpValue(value[idField.name], undefined, allTypes, options);
      }
      return dumpInlineObject(value, nestedType, allTypes, options);
    }

    return `{${Object.entries(value).map(([k, v]) => `${dumpMapKey(k)}:${dumpValue(v, undefined, allTypes, options)}`).join(',')}}`;
  }

  return String(value);
}

/**
 * @param {Record<string, any>} obj
 * @param {MaxiDumpTypeInput} typeDef
 * @param {Map<string, MaxiDumpTypeInput>} allTypes
 * @param {any} options
 * @returns {string}
 */
function dumpInlineObject(obj, typeDef, allTypes, options) {
  const fields = typeDef.fields ?? [];
  const vals = fields.map(f => {
    if (!Object.prototype.hasOwnProperty.call(obj, f.name)) return '';
    const v = obj[f.name];
    if (v === null || v === undefined) return '~';
    return dumpValue(v, f, allTypes, options);
  });

  let last = vals.length - 1;
  while (last >= 0 && vals[last] === '') last--;

  return `(${vals.slice(0, last + 1).join('|')})`;
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
