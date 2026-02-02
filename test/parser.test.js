import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMaxi } from '../src/api/parse.js';
import { MaxiError, MaxiErrorCode } from '../src/core/errors.js';

test('parse: inline schema + records', async () => {
  const input = `U:User(id:int|name|email)
###
U(1|Julie|julie@maxi.org)
U(2|Matt|matt@maxi.org)`;

  const res = await parseMaxi(input);

  assert.equal(res.schema.types.size, 1);
  assert.ok(res.schema.hasType('U'));
  assert.equal(res.records.length, 2);
  assert.deepEqual(res.records[0].values, [1, 'Julie', 'julie@maxi.org']);
});

test('parse: schema-only (no ###, no records)', async () => {
  const input = `U:User(id:int|name|email)`;

  const res = await parseMaxi(input);

  assert.equal(res.schema.types.size, 1);
  assert.equal(res.records.length, 0);
});

test('parse: data-only (no schema) is treated as records section', async () => {
  const input = `U(1|Julie|julie@maxi.org)
U(2|Matt|matt@maxi.org)`;

  const res = await parseMaxi(input);

  assert.equal(res.schema.types.size, 0);
  assert.equal(res.records.length, 2);
  assert.equal(res.warnings.length, 2); // unknown type warnings in lax mode
  assert.match(res.warnings[0].message, /Unknown type alias/);
});

test('parse: @mode:strict makes unknown type an error', async () => {
  const input = `@mode:strict
###
U(1|Julie)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.UnknownTypeError
  );
});

test('parse: @version unsupported -> E001', async () => {
  const input = `@version:2.0.0
U:User(id:int)
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.UnsupportedVersionError
  );
});

test('parse: duplicate type alias -> E002', async () => {
  const input = `U:User(id:int)
U:User2(email)
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.DuplicateTypeError
  );
});

test('parse: inheritance merges fields in order', async () => {
  const input = `P:Person(id:int|name)
U:User<P>(email)
###
U(1|Julie|julie@maxi.org)`;

  const res = await parseMaxi(input);
  const u = res.schema.getType('U');

  assert.deepEqual(u.parents, ['P']);
  assert.equal(u.fields.length, 3);
  assert.deepEqual(u.fields.map(f => f.name), ['id', 'name', 'email']);
});

test('parse: circular inheritance -> E010', async () => {
  const input = `A:A<B>(a)
B:B<A>(b)
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.CircularInheritanceError
  );
});

test('parse: undefined parent -> E013', async () => {
  const input = `U:User<P>(email)
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.UndefinedParentError
  );
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

test('parse: default values applied to omitted trailing fields', async () => {
  const input = `U:User(id:int|role=guest|active:bool=true)
###
U(1)`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values, [1, 'guest', 'true']); // defaults currently stored as raw strings in schema
});

test('parse: quoted strings and escapes in records', async () => {
  const input = `U:User(id:int|bio)
###
U(1|"Line1\\nLine2")
U(2|"He said \\"Hi\\"")`;

  const res = await parseMaxi(input);

  assert.equal(res.records[0].values[1], 'Line1\nLine2');
  assert.equal(res.records[1].values[1], 'He said "Hi"');
});

test('parse: arrays and maps in records', async () => {
  const input = `U:User(id:int|tags:str[]|meta:map)
###
U(1|[a,b,"c,d"]|{k1:v1,"k:2":"v,2"})`;

  const res = await parseMaxi(input);

  assert.deepEqual(res.records[0].values[1], ['a', 'b', 'c,d']);
  assert.deepEqual(res.records[0].values[2], { k1: 'v1', 'k:2': 'v,2' });
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

    assert.equal(expected.success, true, `[${id}] expected.success must be true`);

    const mode = meta.mode ?? 'lax';

    // Provide a default schema loader for fixtures:
    // resolves @schema:relative.mxs against the fixture directory.
    const loadSchema = async (pathOrUrl) => {
      const resolved = path.isAbsolute(pathOrUrl)
        ? pathOrUrl
        : path.join(dir, pathOrUrl);
      return fs.readFile(resolved, 'utf8');
    };

    const res = await parseMaxi(input, {
      mode,
      filename: `testdata/${id}/in.maxi`,
      loadSchema,
    });

    // Project parse result into a stable JSON shape matching expected.json
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

  function thisTypeAliasFromName(schema, typeName) {
    // Find alias by matching td.name (or alias itself) to the requested typeName
    for (const [alias, td] of schema.types.entries()) {
      if ((td.name || alias) === typeName) return alias;
    }
    return null;
  }
});

