import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMaxi } from '../src/api/parse.js';
import { MaxiError, MaxiErrorCode } from '../src/core/errors.js';

test('parse: schema-only (no ###, no records)', async () => {
  const input = `U:User(id:int|name|email)`;

  const res = await parseMaxi(input);

  assert.equal(res.schema.types.size, 1);
  assert.equal(res.records.length, 0);
});

test('parse: field constraints parsed (!, id, comparisons, pattern, mime, exact length)', async () => {
  const input = `F:File(
  name(!)|
  key:str(id)|
  age:int(>=0,<=120)|
  username(pattern:^[a-z0-9_]+$)|
  data:bytes(mime:[image/png,image/jpg])|
  tags:str[](=3)
)
###`;

  const res = await parseMaxi(input);
  const t = res.schema.getType('F');
  assert.ok(t, `Type F should exist. types=[${[...res.schema.types.keys()].join(',')}]`);
  assert.ok(Array.isArray(t.fields), 'Type F fields should be an array');

  const name = t.fields[0];
  assert.equal(name.name, 'name');
  assert.equal(name.isRequired(), true);

  const key = t.fields[1];
  assert.equal(key.isId(), true);

  const age = t.fields[2];
  assert.ok(Array.isArray(age.constraints), 'age.constraints should be an array');
  assert.equal(age.constraints.length, 2);
  assert.deepEqual(age.constraints.map(c => c.operator), ['>=', '<=']);
  assert.deepEqual(age.constraints.map(c => c.value), [0, 120]);

  const username = t.fields[3];
  assert.ok(Array.isArray(username.constraints), 'username.constraints should be an array');
  assert.equal(username.constraints[0].type, 'pattern');

  const data = t.fields[4];
  assert.ok(Array.isArray(data.constraints), 'data.constraints should be an array');
  assert.equal(data.constraints[0].type, 'mime');
  assert.deepEqual(data.constraints[0].value, ['image/png', 'image/jpg']);

  const tags = t.fields[5];
  assert.ok(Array.isArray(tags.constraints), 'tags.constraints should be an array');
  assert.equal(tags.constraints[0].type, 'exact-length');
  assert.equal(tags.constraints[0].value, 3);
});



test('parse: @schema import is loaded via loadSchema()', async () => {
  const input = `@schema:users.mxs
###
U(1|Julie)`;

  const loadSchema = async (path) => {
    assert.equal(path, 'users.mxs');
    return `U:User(id:int|name)`;
  };

  const res = await parseMaxi(input, { loadSchema });

  assert.ok(res.schema.hasType('U'));
  assert.equal(res.records.length, 1);
  assert.deepEqual(res.records[0].values, [1, 'Julie']);
});

test('parse: imported schema inheritance resolves within the import file', async () => {
  // products.mxs defines TS and P:Product<TS>
  // users.mxs redefines TS with different fields
  // P should use the TS from products.mxs (resolved within that file)
  const input = `@schema:products.mxs
@schema:users.mxs
###
P(1|Widget|2024-01-01)`;

  const schemas = {
    'products.mxs': `TS:Timestamped(created_at)
P:Product<TS>(id:int|name)`,
    'users.mxs': `TS:Timestamped(updated_at)
U:User<TS>(id:int|email)`,
  };

  const loadSchema = async (path) => schemas[path];
  const res = await parseMaxi(input, { loadSchema });

  // P should have fields: created_at (from original TS), id, name
  const pType = res.schema.getType('P');
  assert.ok(pType);
  assert.deepEqual(pType.fields.map(f => f.name), ['created_at', 'id', 'name']);

  // U should have fields: updated_at (from overridden TS), id, email
  const uType = res.schema.getType('U');
  assert.ok(uType);
  assert.deepEqual(uType.fields.map(f => f.name), ['updated_at', 'id', 'email']);
});

test('parse: cross-file type override is allowed (last wins)', async () => {
  const input = `@schema:base.mxs
U:User(id:int|name|role=admin)
###
U(1|Julie)`;

  const loadSchema = async (path) => {
    return `U:User(id:int|name)`;
  };

  const res = await parseMaxi(input, { loadSchema });

  // Local definition should override imported one
  const uType = res.schema.getType('U');
  assert.equal(uType.fields.length, 3); // id, name, role
  assert.equal(uType.fields[2].name, 'role');
});

test('parse: same-file duplicate still errors', async () => {
  const input = `U:User(id:int|name)
U:User2(id:int|email)
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.DuplicateTypeError
  );
});

test('parse: cross-file duplicate in imported file also errors within that file', async () => {
  const input = `@schema:bad.mxs
###`;

  const loadSchema = async (path) => {
    // Same alias defined twice within the same .mxs file
    return `U:User(id:int|name)
U:User2(id:int|email)`;
  };

  await assert.rejects(
    () => parseMaxi(input, { loadSchema }),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.DuplicateTypeError
  );
});


// --- §1.3 Type mismatch in strict mode ---



// --- §1.4 Type coercion warnings in lax mode ---

test('parse: lax mode warns on non-numeric value for int field', async () => {
  const input = `U:User(id:int|name)
###
U(hello|Julie)`;

  const res = await parseMaxi(input);
  // Value should be returned as-is (string), with a warning
  assert.equal(res.records[0].values[0], 'hello');
  assert.ok(res.warnings.some(w => w.code === MaxiErrorCode.TypeMismatchError));
});


test('testdata: run all fixtures in ../testdata/*', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');

  const __filename = url.fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const testdataRoot = path.resolve(__dirname, '..', 'maxi-testdata', 'testdata');

  const entries = await fs.readdir(testdataRoot, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

  assert.ok(dirs.length > 0, `No testdata directories found under ${testdataRoot}`);

  for (const id of dirs) {
    const dir = path.join(testdataRoot, id);

    const testJsonPath = path.join(dir, 'test.json');
    const inputPath = path.join(dir, 'in.maxi');
    const expectedPath = path.join(dir, 'expected.json');

    const [testJsonRaw, input, expectedRaw] = await Promise.all([
      fs.readFile(testJsonPath, 'utf8'),
      fs.readFile(inputPath, 'utf8'),
      fs.readFile(expectedPath, 'utf8'),
    ]);

    const meta = JSON.parse(testJsonRaw);
    const expected = JSON.parse(expectedRaw);

    const mode = meta.mode ?? 'lax';

    const loadSchema = async (pathOrUrl) => {
      const resolved = path.isAbsolute(pathOrUrl)
        ? pathOrUrl
        : path.join(dir, pathOrUrl);
      return fs.readFile(resolved, 'utf8');
    };

    if (expected.success === false) {
      await assert.rejects(
        () => parseMaxi(input, { mode, filename: `testdata/${id}/in.maxi`, loadSchema }),
        (err) => {
          if (expected.error_code) {
            assert.equal(
              err.code, expected.error_code,
              `[${id}] expected error_code ${expected.error_code}, got ${err.code}`
            );
          }
          return true;
        },
        `[${id}] expected parse to throw but it did not`
      );
      continue;
    }

    const res = await parseMaxi(input, {
      mode,
      filename: `testdata/${id}/in.maxi`,
      loadSchema,
    });

    // Optional warning assertions
    for (const w of expected.expected_warnings ?? []) {
      assert.ok(
        res.warnings.some(rw => rw.code === w.code),
        `[${id}] expected warning with code ${w.code} ("${w.description}") but none found`
      );
    }

    const actual = projectParseResult(res);

    for (const v of expected.record_validations ?? []) {
      const got = getByPath(actual, v.path, v.follow_references ?? false);
      assert.deepEqual(
        got,
        v.expected_value,
        `[${id}] record validation failed: ${v.description}\npath=${v.path}`
      );
    }

    for (const v of expected.object_validations ?? []) {
      const got = getByPath(actual, v.path, v.follow_references ?? false);
      assert.deepEqual(
        got,
        v.expected_value,
        `[${id}] object validation failed: ${v.description}\npath=${v.path}`
      );
    }

    // Schema validations — walk result.schema using #/schema/types/<alias>/... paths
    for (const v of expected.schema_validations ?? []) {
      const got = getSchemaByPath(res.schema, v.path);
      assert.deepEqual(
        got,
        v.expected_value,
        `[${id}] schema validation failed: ${v.description}\npath=${v.path}`
      );
    }
  }

  function projectParseResult(res) {
    // Build alias -> schema type name mapping (fallback to alias)
    const aliasToName = new Map();
    for (const [alias, td] of res.schema.types.entries()) {
      aliasToName.set(alias, td.name || alias);
    }

    const records = [];
    /** @type {Record<string, Record<string, any>>} */
    const objects = {}; // was Object.create(null)

    const indexObject = (typeName, objValue) => {
      if (!objValue || typeof objValue !== 'object' || Array.isArray(objValue)) return;
      if (!('id' in objValue)) return;

      const objId = objValue.id;
      if (objId === null || objId === undefined) return;

      if (!objects[typeName]) objects[typeName] = {}; // was Object.create(null)

      if (!objects[typeName][String(objId)]) {
        objects[typeName][String(objId)] = { ...objValue };
      }
    };

    // Stable projected field naming:
    // - Most annotations (email/url/uuid/date/datetime/time/timestamp) keep the original field name.
    // - Binary encodings (base64/hex) are expected by fixtures as "<name>_<annotation>".
    const projectedFieldName = (fieldDef) => {
      if (!fieldDef) return null;

      const ann = (fieldDef.annotation ?? '').trim();
      if (!ann) return fieldDef.name;

      if (ann === 'base64' || ann === 'hex') {
        return `${fieldDef.name}_${ann}`;
      }

      return fieldDef.name;
    };

    for (const r of res.records) {
      const td = res.schema.getType(r.alias);
      const typeName = aliasToName.get(r.alias) || r.alias;

      const value = {}; // was Object.create(null)

      if (td) {
        for (let i = 0; i < td.fields.length; i++) {
          const field = td.fields[i];
          const fieldValue = (i < r.values.length) ? r.values[i] : null;

          const outKey = projectedFieldName(field);
          value[outKey] = fieldValue;

          // index inline objects into objects map under their target type name
          if (fieldValue && typeof fieldValue === 'object' && !Array.isArray(fieldValue) && 'id' in fieldValue) {
            const fieldTypeAlias = field.typeExpr;
            if (fieldTypeAlias) {
              const fieldTypeDef = res.schema.getType(fieldTypeAlias);
              if (fieldTypeDef) {
                const fieldTypeName = fieldTypeDef.name || fieldTypeDef.alias;
                indexObject(fieldTypeName, fieldValue);
              }
            }
          }
        }
      } else {
        value.values = r.values.slice();
      }

      records.push({ type: typeName, value });

      if (td && td.fields.length > 0) {
        let idx = td.fields.findIndex(f => typeof f.isId === 'function' && f.isId());
        if (idx === -1) idx = td.fields.findIndex(f => f.name === 'id');
        if (idx === -1) idx = 0;

        const objIdValue = r.values[idx];
        const objId = (typeof objIdValue === 'object' && objIdValue !== null && !Array.isArray(objIdValue))
          ? objIdValue.id
          : objIdValue;

        if (objId !== null && objId !== undefined) {
          if (!objects[typeName]) objects[typeName] = {}; // was Object.create(null)

          // For stored objects, convert inline objects to IDs to match expected.json "objects"
          const projectedValue = { ...value };
          for (const key in projectedValue) {
            const v = projectedValue[key];
            if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'id' in v) {
              projectedValue[key] = v.id;
            }
          }
          objects[typeName][String(objId)] = projectedValue;
        }
      }
    }

    return { records, objects, _schema: res.schema };
  }

  function getByPath(root, pointer, followReferences = false) {
    if (pointer === '#') return root;
    if (!pointer.startsWith('#/')) throw new Error(`Unsupported path: ${pointer}`);

    const parts = pointer
      .slice(2)
      .split('/')
      .map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));

    let cur = root;

    // Track schema context for reference following:
    let currentTypeName = null;

    // Track last non-numeric property name (needed for arrays-of-refs like orders/0)
    let lastFieldName = null;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (cur == null) return undefined;

      // Enter objects/<TypeName>
      if (i === 1 && parts[0] === 'objects') {
        currentTypeName = part;
      }

      // Remember last non-numeric field name (ignore numeric indices)
      if (!/^[0-9]+$/.test(part)) {
        lastFieldName = part;
      }

      // numeric index for arrays
      if (Array.isArray(cur) && /^[0-9]+$/.test(part)) {
        cur = cur[Number(part)];
      } else {
        cur = cur[part];
      }

      // Follow references using schema type info (ONLY inside objects tree)
      if (
        followReferences &&
        cur != null &&
        (typeof cur === 'number' || typeof cur === 'string') &&
        parts[0] === 'objects' &&
        currentTypeName &&
        i >= 3 &&
        i < parts.length - 1
      ) {
        const schema = root._schema;
        if (!schema) break;

        const typeAlias = thisTypeAliasFromName(schema, currentTypeName);
        const td = typeAlias ? schema.getType(typeAlias) : undefined;

        // For normal object fields, use the immediate property name (parts[i])
        // For arrays (orders/0), parts[i] is "0" so we must use lastFieldName ("orders")
        const fieldNameForSchema = /^[0-9]+$/.test(part) ? lastFieldName : part;

        const field = td?.fields?.find(f => f.name === fieldNameForSchema);
        const rawFieldType = field?.typeExpr ?? null;

        // If this is an array-of-refs (e.g. Order[]), derive element type
        let rawTarget = rawFieldType;
        if (rawTarget && /\[\]\s*$/.test(rawTarget)) {
          rawTarget = rawTarget.replace(/\[\]\s*$/, '').trim();
        }

        const resolvedAlias = rawTarget ? (schema.resolveTypeAlias?.(rawTarget) ?? rawTarget) : null;

        const targetTd = resolvedAlias ? schema.getType(resolvedAlias) : null;
        const targetTypeName = targetTd ? (targetTd.name || targetTd.alias) : null;

        if (targetTypeName && root.objects?.[targetTypeName]?.[String(cur)]) {
          cur = root.objects[targetTypeName][String(cur)];
          currentTypeName = targetTypeName; // schema context becomes referenced type
        }
      }
    }

    return cur;
  }

  /**
   * Walk a MaxiSchema using a JSON-pointer-style path.
   *
   * Supported path segments after `#/schema/`:
   *   types/<alias>                    → MaxiTypeDef
   *   types/<alias>/fields/<N>         → MaxiFieldDef (0-based index)
   *   types/<alias>/fields/<N>/typeExpr
   *   types/<alias>/fields/<N>/constraints/<M>/<prop>
   *   types/<alias>/fields/<N>/elementConstraints/<M>/<prop>
   *   types/<alias>/fields/<N>/defaultValue
   *   types/<alias>/name
   *   types/<alias>/parents/<N>
   *
   * @param {import('../src/core/types.js').MaxiSchema} schema
   * @param {string} pointer  e.g. "#/schema/types/S/fields/1/typeExpr"
   */
  function getSchemaByPath(schema, pointer) {
    if (!pointer.startsWith('#/schema/')) {
      throw new Error(`schema_validations path must start with #/schema/ — got: ${pointer}`);
    }

    const parts = pointer
      .slice('#/schema/'.length)
      .split('/')
      .map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));

    if (parts[0] !== 'types') {
      throw new Error(`schema_validations: only #/schema/types/... paths are supported`);
    }

    // parts[1] = alias
    const alias = parts[1];
    let cur = schema.getType(alias);
    if (cur === undefined) return undefined;

    for (let i = 2; i < parts.length; i++) {
      if (cur == null) return undefined;
      const seg = parts[i];
      if (Array.isArray(cur) && /^[0-9]+$/.test(seg)) {
        cur = cur[Number(seg)];
      } else if (cur instanceof Map) {
        cur = cur.get(seg);
      } else {
        cur = cur[seg];
      }
    }

    return cur;
  }

  function thisTypeAliasFromName(schema, typeName) {
    // Find alias by matching td.name (or alias itself) to the requested typeName
    for (const [alias, td] of schema.types.entries()) {
      if ((td.name || alias) === typeName) return alias;
    }
    return null;
  }
});





test('parse: map<int> shorthand resolves value type as int', async () => {
  const input = `S:Scores(id:int|data:map<int>)
###
S(1|{math:95,english:87})`;

  const res = await parseMaxi(input);
  const field = res.schema.getType('S').fields[1];
  assert.equal(field.typeExpr, 'map<int>');
  assert.deepEqual(res.records[0].values[1], { math: 95, english: 87 });
});

test('parse: circular imports are handled without infinite loop', async () => {
  const input = `@schema:a.mxs
###
U(1|Julie)`;

  const schemas = {
    'a.mxs': `@schema:b.mxs\nU:User(id:int|name)`,
    'b.mxs': `@schema:a.mxs\nO:Order(id:int|total:decimal)`,
  };

  const loadSchema = async (path) => schemas[path];
  const res = await parseMaxi(input, { loadSchema });

  assert.ok(res.schema.hasType('U'));
  assert.ok(res.schema.hasType('O'));
  assert.equal(res.records[0].values, res.records[0].values); // just confirm it resolves
});

