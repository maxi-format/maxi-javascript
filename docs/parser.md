# MAXI Parser

This document covers everything about parsing MAXI text into structured data —
from raw records, through streaming, all the way to typed class instances
(object hydration).

---

## Table of Contents

1. [Overview](#overview)
2. [MAXI File Structure (Quick Recap)](#maxi-file-structure-quick-recap)
3. [`parseMaxi` — Full In-Memory Parse](#parsemaxi--full-in-memory-parse)
4. [`streamMaxi` — Streaming Parse](#streammaxi--streaming-parse)
5. [Parse Result Shape](#parse-result-shape)
6. [Schema-Annotated Classes](#schema-annotated-classes)
7. [`parseMaxiAs` — Parse into Class Instances](#parsemaxias--parse-into-class-instances)
8. [`parseMaxiAutoAs` — Auto-Resolve Classes](#parsemaxiautoas--auto-resolve-classes)
9. [Reference Resolution during Hydration](#reference-resolution-during-hydration)
10. [Construction Strategies](#construction-strategies)
11. [`MaxiParseOptions` Reference](#maxiparseoptions-reference)
12. [Examples](#examples)

---

## Overview

The parser converts MAXI text into one of two output shapes:

| Function | Output |
|---|---|
| `parseMaxi` | `MaxiParseResult` — schema + raw records (positional values) |
| `streamMaxi` | `MaxiStreamResult` — schema immediately, then an async record iterator |
| `parseMaxiAs` | `{ objects, schema, warnings }` — records hydrated into class instances |
| `parseMaxiAutoAs` | Same as `parseMaxiAs`, but class → alias map inferred automatically |

---

## MAXI File Structure (Quick Recap)

```
U:User(id:int|name|email=unknown)    ← type definitions (schema section)
O:Order(id:int|user:U|total:decimal)
###                                   ← separator
U(1|Julie|julie@example.com)          ← records (data section)
O(100|1|49.99)
```

- Everything **above** `###` is the schema section (type defs, directives like `@maxi`, `@schema`).
- Everything **below** `###` is the records section.
- If no `###` is present, the parser auto-detects whether the input is schema-only or records-only.

---

## `parseMaxi` — Full In-Memory Parse

```js
import { parseMaxi } from '@maxi-format/maxi';

const result = await parseMaxi(input, options);
```

Parses the full input at once. Returns a `MaxiParseResult` containing:
- `result.schema` — types, directives, imports
- `result.records` — array of `{ alias, values }` (positional values, schema-typed)
- `result.warnings` — recoverable issues found during parsing (type coercions, unknown types, constraint violations, etc.)

### What the parser does internally

1. **Split sections** at `###`
2. **Parse schema section** — type definitions, `@maxi`, `@schema` imports (loaded via `options.loadSchema`)
3. **Parse records section** — each record is matched to its type def; values are coerced to the declared type (`int`, `bool`, `decimal`, etc.)
4. **Build object registry** — if any field references another type, an internal `_objectRegistry` (alias → id → object) is built for reference validation
5. **Validate references** — unresolved references emit a warning (lax) or throw (strict)

---

## `streamMaxi` — Streaming Parse

For large files where you don't want to hold all records in memory at once.

```js
import { streamMaxi } from '@maxi-format/maxi';

const stream = await streamMaxi(input, options);

// Schema is fully available before iterating
console.log(stream.schema.getType('U').fields.map(f => f.name));

// Iterate over records one by one
for await (const record of stream) {
  console.log(record.alias, record.values);
}

// Or use the .records() generator method explicitly
for await (const record of stream.records()) {
  // ...
}
```

- The schema section is parsed **eagerly** and available immediately on the returned `MaxiStreamResult`.
- Records are yielded **lazily** one at a time as you iterate.
- `stream.warnings` accumulates warnings for the full session.

---

## Parse Result Shape

### `MaxiParseResult`

```js
{
  schema: MaxiSchema,       // parsed type definitions and directives
  records: MaxiRecord[],    // all records: { alias, values, lineNumber }
  warnings: Warning[],      // { message, code, line }
}
```

### `MaxiRecord`

```js
{
  alias: 'U',               // type alias
  values: [1, 'Julie', null] // positional values, schema-coerced
}
```

### `MaxiSchema`

```js
schema.getType('U')         // → MaxiTypeDef | undefined
schema.hasType('U')         // → boolean
schema.types                // → Map<alias, MaxiTypeDef>
schema.maxiVersion          // → string
schema.userVersion          // → string | null
schema.imports              // → string[]
```

### `MaxiTypeDef`

```js
typeDef.alias               // 'U'
typeDef.name                // 'User'
typeDef.parents             // ['P']
typeDef.fields              // MaxiFieldDef[]
typeDef.getIdField()        // → MaxiFieldDef | null
```

### `MaxiFieldDef`

```js
field.name                  // 'email'
field.typeExpr              // 'str', 'int', 'U', 'O[]', etc.
field.annotation            // 'hex', 'base64', 'email', etc.
field.constraints           // [{ type: 'required' }, ...]
field.defaultValue          // 'unknown', 0, etc.
```

---

## Schema-Annotated Classes

Before using `parseMaxiAs` / `parseMaxiAutoAs`, your classes need a schema attached.
This is the JS equivalent of Java/PHP annotations — no transpiler required.

### Option A: `static maxiSchema` on the class (recommended)

```js
class User {
  static maxiSchema = {
    alias: 'U',          // must match the alias in the MAXI file
    name: 'User',        // optional long name
    fields: [
      { name: 'id',    typeExpr: 'int' },
      { name: 'name' },
      { name: 'email', defaultValue: 'unknown' },
    ],
  };

  constructor({ id, name, email } = {}) {
    this.id    = id;
    this.name  = name;
    this.email = email;
  }
}
```

### Option B: `defineMaxiSchema` for external / third-party classes

```js
import { defineMaxiSchema } from '@maxi-format/maxi';

defineMaxiSchema(User, {
  alias: 'U',
  fields: [ ... ],
});
```

Uses a `WeakMap` internally — GC-safe, does not modify the class.

### Schema descriptor fields

| Field | Type | Description |
|---|---|---|
| `alias` | `string` | **Required.** Short alias used in records, e.g. `U(...)` |
| `name` | `string` | Optional long name emitted in type definition header |
| `parents` | `string[]` | Optional parent aliases for inheritance |
| `fields` | `FieldDef[]` | Field list — order defines serialization / deserialization order |

Each field descriptor:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | **Required.** Field name |
| `typeExpr` | `string` | Type: `int`, `str`, `bool`, `decimal`, `float`, `bytes`, `OtherAlias`, `OtherAlias[]` |
| `annotation` | `string` | e.g. `hex`, `base64`, `email` |
| `constraints` | `array` | e.g. `[{ type: 'required' }]`, `[{ type: 'id' }]` |
| `defaultValue` | `any` | Applied when field is omitted from record |

---

## `parseMaxiAs` — Parse into Class Instances

```js
import { parseMaxiAs } from '@maxi-format/maxi';

const { objects, schema, warnings } = await parseMaxiAs(input, classMap, options);
```

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `input` | `string` | MAXI text to parse |
| `classMap` | `{ [alias]: Class }` | Maps each alias to the constructor to instantiate |
| `options` | `MaxiParseOptions` | Same options as `parseMaxi` |

### Return value

```js
{
  objects:  { [alias]: instance[] },  // hydrated class instances
  schema:   MaxiSchema,               // parsed schema (same as parseMaxi)
  warnings: Warning[],                // same as parseMaxi
}
```

Only aliases present in `classMap` are hydrated. Records with other aliases are silently skipped.

---

## `parseMaxiAutoAs` — Auto-Resolve Classes

Convenience variant — pass an array of classes instead of an alias map. Each class must have `static maxiSchema` or be registered via `defineMaxiSchema`.

```js
import { parseMaxiAutoAs } from '@maxi-format/maxi';

const { objects } = await parseMaxiAutoAs(input, [User, Order], options);
```

Internally builds `{ U: User, O: Order }` from each class's `schema.alias`, then calls `parseMaxiAs`.

---

## Reference Resolution during Hydration

After all records are hydrated into instances, the hydrator performs a **second pass** to resolve cross-reference fields.

A field is a cross-reference when its `typeExpr` points to another alias in the schema (not a primitive like `int`, `str`, etc.).

**Example:**

```
U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
U(1|Julie)
O(100|1|49.99)
```

After hydration, `order.user` will be the actual `User` instance for `id=1`, not the scalar `1`.

### What happens step by step

1. All `U` records are hydrated into `User` instances and indexed by their id.
2. All `O` records are hydrated into `Order` instances.
3. The hydrator walks each `Order`'s `user` field — its `typeExpr` is `U`, a known alias.
4. The scalar value `1` is looked up in the `User` instance registry → the `User` instance is found.
5. `order.user` is replaced with the actual `User` instance.

### Forward references

Forward references work naturally because reference resolution is a **second pass** over all already-parsed records. An `Order` that appears before the `User` it references will still resolve correctly.

### Unresolved references

If a referenced id is not found among the hydrated instances, the field **stays as the original scalar value**. A warning is also emitted by the underlying `parseMaxi` call.

---

## Construction Strategies

`parseMaxiAs` tries three strategies in order to construct each instance:

| Strategy | When it applies |
|---|---|
| `new Cls(fieldMap)` | Constructor accepts an object bag: `constructor({ id, name } = {})` — **most common** |
| `new Cls()` + `Object.assign(inst, fieldMap)` | Zero-arg or positional-arg constructor |
| `Object.create(Cls.prototype)` + `Object.assign` | Constructor throws even with no args |

The first strategy is verified by checking that the first expected field actually landed on the instance. If the constructor accepted the call but ignored the map (positional args pattern), the fallback kicks in automatically.

---

## `MaxiParseOptions` Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `allowAdditionalFields` | `'ignore'\|'warning'\|'error'` | `'ignore'` | Extra fields beyond schema definition |
| `allowMissingFields` | `'null'\|'warning'\|'error'` | `'null'` | Missing required fields — fill with null or reject |
| `allowTypeCoercion` | `'coerce'\|'warning'\|'error'` | `'coerce'` | Type mismatches — coerce or reject |
| `allowConstraintViolations` | `'warning'\|'error'` | `'warning'` | Value violates a schema constraint |
| `allowForwardReferences` | `boolean` | `true` | Allow references to records not yet seen |
| `allowUnknownTypes` | `'ignore'\|'warning'\|'error'` | `'warning'` | Records with an unrecognised type alias |
| `filename` | `string` | — | Used in error/warning messages for better diagnostics |
| `loadSchema` | `(path) => string\|Promise<string>` | — | Resolver for `@schema:` import directives |

---

## Examples

### 1. Basic `parseMaxi` — raw records

```js
import { parseMaxi } from '@maxi-format/maxi';

const input = `
U:User(id:int|name|email=unknown)
###
U(1|Julie|julie@example.com)
U(2|Matt)
`.trim();

const result = await parseMaxi(input);

console.log(result.records[0].alias);   // 'U'
console.log(result.records[0].values);  // [1, 'Julie', 'julie@example.com']
console.log(result.records[1].values);  // [2, 'Matt', 'unknown']  ← default filled in
```

---

### 2. `streamMaxi` — large files

```js
import { streamMaxi } from '@maxi-format/maxi';

const stream = await streamMaxi(input);

// Schema is available immediately — no need to wait for records
const fields = stream.schema.getType('U').fields.map(f => f.name);
console.log(fields); // ['id', 'name', 'email']

// Stream records one at a time
for await (const record of stream) {
  console.log(record.values);
}
```

---

### 3. `parseMaxiAs` — hydrate into class instances

```js
import { parseMaxiAs } from '@maxi-format/maxi';

class User {
  static maxiSchema = {
    alias: 'U',
    name: 'User',
    fields: [
      { name: 'id',   typeExpr: 'int' },
      { name: 'name' },
      { name: 'email' },
    ],
  };

  constructor({ id, name, email } = {}) {
    this.id    = id;
    this.name  = name;
    this.email = email;
  }
}

const input = `
U:User(id:int|name|email)
###
U(1|Julie|julie@example.com)
U(2|Matt|matt@example.com)
`.trim();

const { objects } = await parseMaxiAs(input, { U: User });

console.log(objects.U[0] instanceof User);  // true
console.log(objects.U[0].name);             // 'Julie'
```

---

### 4. `parseMaxiAutoAs` — zero-config with `static maxiSchema`

```js
import { parseMaxiAutoAs } from '@maxi-format/maxi';

// Alias is read from User.maxiSchema.alias and Order.maxiSchema.alias automatically
const { objects } = await parseMaxiAutoAs(input, [User, Order]);

console.log(objects.U[0] instanceof User);   // true
console.log(objects.O[0] instanceof Order);  // true
```

---

### 5. Cross-reference fields resolved to instances

```js
class User {
  static maxiSchema = {
    alias: 'U',
    fields: [{ name: 'id', typeExpr: 'int' }, { name: 'name' }],
  };
  constructor({ id, name } = {}) { this.id = id; this.name = name; }
}

class Order {
  static maxiSchema = {
    alias: 'O',
    fields: [
      { name: 'id',    typeExpr: 'int' },
      { name: 'user',  typeExpr: 'U' },   // ← reference to User
      { name: 'total', typeExpr: 'decimal' },
    ],
  };
  constructor({ id, user, total } = {}) { this.id = id; this.user = user; this.total = total; }
}

const input = `
U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
U(1|Julie)
O(100|1|49.99)
`.trim();

const { objects } = await parseMaxiAutoAs(input, [User, Order]);

const order = objects.O[0];
console.log(order.user instanceof User);  // true  ← not just the scalar 1
console.log(order.user.name);             // 'Julie'
```

---

### 6. Enum value aliases

Enum fields may use short aliases as wire tokens. The parser always returns the full semantic value.

```js
const input = `
U:User(id:int|name|role:enum[a:admin,e:editor,v:viewer])
###
U(1|Alice|a)
U(2|Bob|v)
`.trim();

const result = await parseMaxi(input);

console.log(result.records[0].values[2]);  // 'admin': alias 'a' expanded
console.log(result.records[1].values[2]);  // 'viewer': alias 'v' expanded
```

`enum<int>` aliases work the same way — the parsed value is always the integer:

```js
const input = `
D:Device(id:int|name|state:enum<int>[O:900,I:910,R:1000,E:999])
###
D(1|sensor-A|R)
`.trim();

const result = await parseMaxi(input);

console.log(result.records[0].values[2]);  // 1000: alias 'R' expanded to int
```

Wire tokens that are neither a declared alias nor the full value trigger a constraint violation (E303).

---

### 7. Forward references

```js
const input = `
U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
O(100|1|49.99)   ← Order before the User it references
U(1|Julie)
`.trim();

const { objects } = await parseMaxiAutoAs(input, [User, Order]);

// Forward reference resolves correctly because resolution is a second pass
console.log(objects.O[0].user instanceof User);  // true
```

---

### 7. External schema via `@schema` import

```js
import { parseMaxiAs } from '@maxi-format/maxi';
import { readFileSync } from 'node:fs';

const input = `
@schema:schemas/users.maxi
###
U(1|Julie)
`.trim();

const { objects } = await parseMaxiAs(input, { U: User }, {
  loadSchema: (path) => readFileSync(path, 'utf8'),
});
```

---

### 8. Strict-style validation — throws on schema violations

Use `allowAdditionalFields: 'error'` to reject records with extra fields:

```js
const input = `
U:User(id:int|name)
###
U(1|Julie|extra-field-not-in-schema)
`.trim();

// Throws MaxiError with code SchemaMismatchError
await parseMaxiAs(input, { U: User }, { allowAdditionalFields: 'error' });
```

---

### 9. `defineMaxiSchema` for classes you don't own

```js
import { defineMaxiSchema, parseMaxiAutoAs } from '@maxi-format/maxi';

// Third-party class — can't add static maxiSchema
import { ExternalProduct } from 'some-library';

defineMaxiSchema(ExternalProduct, {
  alias: 'P',
  fields: [
    { name: 'id',    typeExpr: 'int' },
    { name: 'title' },
    { name: 'price', typeExpr: 'decimal' },
  ],
});

const { objects } = await parseMaxiAutoAs(maxi, [ExternalProduct]);
console.log(objects.P[0] instanceof ExternalProduct);  // true
```

