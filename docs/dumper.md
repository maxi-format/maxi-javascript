# MAXI Dumper

The `dumpMaxi` function serializes JavaScript objects, arrays, or parse results back into MAXI text format. This document explains how it works, what schema input is required, and how references and inline objects are handled.

---

## Table of Contents

1. [Overview](#overview)
2. [Input Modes](#input-modes)
3. [Schema Input](#schema-input)
4. [Schema-Annotated Classes](#schema-annotated-classes)
5. [Auto-Dump: `dumpMaxiAuto`](#auto-dump-dumpmaxiauto)
6. [Reference Collection](#reference-collection)
7. [Inline Objects vs. References](#inline-objects-vs-references)
8. [Inheritance](#inheritance)
9. [Options Reference](#options-reference)
10. [Examples](#examples)

---

## Overview

```js
import { dumpMaxi } from 'maxi-schema';

const maxi = dumpMaxi(data, options);
```

`dumpMaxi` accepts data in several formats and optional configuration through `options`. It emits a MAXI string that may contain:

- Directives (`@version`, `@mode`, `@schema`)
- Type definitions (schema section)
- A `###` separator
- Records (data section)

---

## Input Modes

`dumpMaxi` detects the input shape and routes to the appropriate internal path:

| Input shape | Behavior |
|---|---|
| Object with `records` array (parse result) | Round-trip path — re-emits schema and records exactly as parsed |
| Array of objects | Requires `options.defaultAlias`; type info from `options.types` |
| Single object | Requires `options.defaultAlias`; wrapped into a one-element array |
| `{ [alias]: object[] }` map | Each key is a record alias; type info from `options.types` |

### Round-trip (parse result)

If you pass the result of `parseMaxi(...)` directly, the dumper uses `dumpMaxiFromParseResult`. It re-emits:
- The schema (types, directives, imports)
- All records in order, using the parsed values directly

```js
const result = await parseMaxi(input);
const roundTripped = dumpMaxi(result);
```

### Plain objects

For regular JS objects, the dumper uses `dumpMaxiFromObjects` and needs a schema from `options.types` to:
- Determine field order
- Emit type definitions
- Handle typed references and inline objects

---

## Schema Input

The dumper does **not** infer schema from object shapes. You must supply it explicitly through `options.types`.

`options.types` can be an **array** or a **`Map`** of type descriptors:

```js
{
  alias: 'U',          // short alias used in records, e.g. U(...)
  name: 'User',        // optional long name for type definition header
  parents: ['P'],      // optional parent aliases for inheritance
  fields: [
    { name: 'id', typeExpr: 'int', constraints: [{ type: 'id' }] },
    { name: 'name' },
    { name: 'email', defaultValue: 'unknown' },
  ]
}
```

Each field can have:
- `name` — field name (required)
- `typeExpr` — type string, e.g. `int`, `str`, `bool`, `decimal`, `bytes`, `OtherAlias`, `OtherAlias[]`
- `annotation` — e.g. `hex` for bytes fields
- `constraints` — e.g. `[{ type: 'required' }]`, `[{ type: 'id' }]`
- `elementConstraints` — constraints applied to individual array elements (for `type[]` fields)
- `defaultValue` — used in type definition and when trimming trailing empty fields

### External schema file

If you have an external `.maxi` schema file, you can reference it instead of embedding types:

```js
dumpMaxi(data, {
  defaultAlias: 'U',
  schemaFile: 'schemas/users.maxi',
  includeTypes: false,
})
// Output:
// @schema:schemas/users.maxi
// ###
// U(1|Julie)
```

---

## Schema-Annotated Classes

Instead of passing `options.types` manually every time, you can attach schema metadata
directly to your classes and let the dumper discover it automatically.
This is the plain-JS equivalent of Java/PHP annotations — no TypeScript or transpiler needed.

### Option A: `static maxiSchema` on the class (recommended)

```js
class User {
  static maxiSchema = {
    alias: 'U',          // short alias used in records
    name: 'User',        // optional long name for the type definition header
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

When you can't modify the class (e.g. it's from a library):

```js
import { defineMaxiSchema } from 'maxi-schema';

defineMaxiSchema(SomeExternalClass, {
  alias: 'E',
  fields: [ { name: 'id', typeExpr: 'int' }, { name: 'label' } ],
});
```

Uses a `WeakMap` internally — GC-safe, does not modify the class.

### Schema descriptor fields

| Field | Type | Description |
|---|---|---|
| `alias` | `string` | **Required.** Short alias, e.g. `U` |
| `name` | `string` | Optional long name emitted in the type def header |
| `parents` | `string[]` | Optional parent aliases for inheritance |
| `fields` | `FieldDef[]` | Field list — order defines serialization order |

Each field descriptor:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | **Required.** |
| `typeExpr` | `string` | `int`, `str`, `bool`, `decimal`, `bytes`, `OtherAlias`, `OtherAlias[]` |
| `annotation` | `string` | e.g. `hex`, `base64` |
| `constraints` | `array` | e.g. `[{ type: 'required' }]`, `[{ type: 'id' }]` |
| `defaultValue` | `any` | Emitted in type def and used when trimming trailing empty fields |

---

## Auto-Dump: `dumpMaxiAuto`

When your classes have `static maxiSchema` (or are registered via `defineMaxiSchema`),
use `dumpMaxiAuto` instead of `dumpMaxi` — no `options.types` or `options.defaultAlias`
needed.

```js
import { dumpMaxiAuto } from 'maxi-schema';

// Array of instances — alias resolved from the class schema
const maxi = dumpMaxiAuto([new User({ id: 1, name: 'Julie' })]);

// Multi-type map
const maxi = dumpMaxiAuto({
  U: [new User({ id: 1, name: 'Julie' })],
  O: [new Order({ id: 100, total: 49.99 })],
});
```

### How schema collection works

1. For each object in the input, `dumpMaxiAuto` calls `getMaxiSchema(obj.constructor)`.
2. It then recurses into all typed nested fields to collect schemas for referenced types
   (e.g. an `Address` nested inside a `Customer` is picked up automatically).
3. All collected schemas are merged with any `options.types` you supply (caller wins on conflict).
4. The merged types are forwarded to the existing `dumpMaxi` pipeline — no logic duplication.

### Mixing with manual `options.types`

You can override or extend the auto-collected types:

```js
dumpMaxiAuto(users, {
  types: [
    // Override the User schema with a customised one
    { alias: 'U', name: 'CustomUser', fields: [{ name: 'id', typeExpr: 'int' }, { name: 'name' }] },
  ],
});
```

All `dumpMaxi` options (`multiline`, `includeTypes`, `collectReferences`, `schemaFile`, etc.)
are supported and forwarded unchanged.

When `options.collectReferences` is `true` (the default), the dumper automatically promotes nested objects into top-level records — if the nested type has an `id` field in its schema.

**How it works:**

1. For each object to dump, the dumper walks all fields that have a typed `typeExpr` pointing to another type.
2. If that nested type has an `id` field and the nested object has a value for it, the object is promoted to its own top-level record.
3. In the parent record, the field value is replaced with just the `id`.

This happens iteratively — deeply nested objects are also promoted.

**When `collectReferences: false`** — nested typed objects are serialized inline as `(val1|val2|...)` regardless of whether they have an id.

---

## Inline Objects vs. References

Consider a `Customer` with a `shippingAddress` field of type `Address`:

| Case | Output |
|---|---|
| `Address` has an `id` field, `collectReferences: true` (default) | Customer record stores the address id; a separate `A(...)` record is emitted |
| `Address` has an `id` field, `collectReferences: false` | Customer record stores the address inline: `(A1\|123 Main\|NYC)` |
| `Address` has **no** `id` field | Always inlined as `(val1\|val2)` |

---

## Inheritance

If a type has `parents`, the dumper resolves inherited fields before serializing. Parent fields are prepended to the type's own fields, in order of declaration, with duplicates skipped.

This resolution happens once at the start of `dumpMaxiFromObjects` via `resolveInheritanceForDump`.

---

## Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultAlias` | `string` | — | Required when input is an array or single object |
| `types` | `MaxiDumpTypeInput[] \| Map` | — | Type definitions used for field order, type defs, and references |
| `includeTypes` | `boolean` | `true` | Whether to emit type definitions above `###` |
| `schemaFile` | `string` | — | Emit `@schema:<path>` import directive |
| `version` | `string` | — | Emit `@version:<x>` if not `1.0.0` |
| `mode` | `'strict'\|'lax'` | — | Emit `@mode:strict` when `strict` |
| `multiline` | `boolean` | `false` | Pretty-print type defs and records across multiple lines |
| `collectReferences` | `boolean` | `true` | Promote nested typed objects with an `id` into top-level records |

---

## Examples

### 1. Array of objects with inline type definitions

```js
import { dumpMaxi } from 'maxi-schema';

const users = [
  { id: 1, name: 'Julie' },
  { id: 2, name: 'Matt', email: null },
];

const maxi = dumpMaxi(users, {
  defaultAlias: 'U',
  types: [
    {
      alias: 'U',
      name: 'User',
      fields: [
        { name: 'id', typeExpr: 'int' },
        { name: 'name' },
        { name: 'email', defaultValue: 'unknown' },
      ],
    },
  ],
});
```

Output:
```
U:User(id:int|name|email=unknown)
###
U(1|Julie)
U(2|Matt|~)
```

Note: `email` is omitted from the first record because it matches the trailing empty field (no `email` key on the object), not because it equals the default. The second record has `~` (explicit null).

---

### 2. Alias map — multiple types

```js
const data = {
  U: [{ id: 1, name: 'Julie' }],
  O: [{ id: 100, userId: 1, total: 49.99 }],
};

const maxi = dumpMaxi(data, {
  types: [
    {
      alias: 'U',
      name: 'User',
      fields: [{ name: 'id', typeExpr: 'int' }, { name: 'name' }],
    },
    {
      alias: 'O',
      name: 'Order',
      fields: [
        { name: 'id', typeExpr: 'int' },
        { name: 'userId', typeExpr: 'int' },
        { name: 'total', typeExpr: 'decimal' },
      ],
    },
  ],
});
```

Output:
```
U:User(id:int|name)
O:Order(id:int|userId:int|total:decimal)
###
U(1|Julie)
O(100|1|49.99)
```

---

### 3. Nested referenced objects (collectReferences: true)

```js
const address = { id: 'A1', street: '123 Main St', city: 'NYC' };
const customers = [{ id: 'C1', name: 'John', shippingAddress: address }];

const maxi = dumpMaxi(customers, {
  defaultAlias: 'C',
  types: [
    {
      alias: 'C',
      name: 'Customer',
      fields: [
        { name: 'id' },
        { name: 'name' },
        { name: 'shippingAddress', typeExpr: 'A' },
      ],
    },
    {
      alias: 'A',
      name: 'Address',
      fields: [{ name: 'id' }, { name: 'street' }, { name: 'city' }],
    },
  ],
});
```

Output:
```
C:Customer(id|name|shippingAddress:A)
A:Address(id|street|city)
###
C(C1|John|A1)
A(A1|"123 Main St"|NYC)
```

The `shippingAddress` field is replaced with just `A1` (the id), and a separate `A(...)` record is emitted.

---

### 4. Nested inline objects (collectReferences: false)

Same data as above but with `collectReferences: false`:

```js
const maxi = dumpMaxi(customers, {
  defaultAlias: 'C',
  types: [ /* same as above */ ],
  collectReferences: false,
});
```

Output:
```
C:Customer(id|name|shippingAddress:A)
A:Address(id|street|city)
###
C(C1|John|(A1|"123 Main St"|NYC))
```

The address is now inlined inside the customer record.

---

### 5. Inline arrays of typed objects

```js
const customers = [{
  id: 'C1',
  name: 'John',
  orders: [
    { orderId: 101, total: 49.99 },
    { orderId: 102, total: 150.0 },
  ],
}];

const maxi = dumpMaxi(customers, {
  defaultAlias: 'C',
  types: [
    {
      alias: 'C',
      name: 'Customer',
      fields: [
        { name: 'id' },
        { name: 'name' },
        { name: 'orders', typeExpr: 'O[]' },
      ],
    },
    {
      alias: 'O',
      name: 'Order',
      fields: [
        { name: 'orderId', typeExpr: 'int' },
        { name: 'total', typeExpr: 'decimal' },
      ],
    },
  ],
});
```

Output:
```
C:Customer(id|name|orders:O[])
O:Order(orderId:int|total:decimal)
###
C(C1|John|[(101|49.99),(102|150)])
```

Order objects have no `id` field, so they are always inlined as `(val|val)` tuples in a MAXI array `[...]`.

---

### 6. Inheritance

```js
const data = {
  E: [{ id: 1, name: 'Alice', department: 'Engineering' }],
};

const maxi = dumpMaxi(data, {
  types: [
    {
      alias: 'P',
      name: 'Person',
      fields: [{ name: 'id', typeExpr: 'int' }, { name: 'name' }],
    },
    {
      alias: 'E',
      name: 'Employee',
      parents: ['P'],
      fields: [{ name: 'department' }],
    },
  ],
});
```

Output:
```
P:Person(id:int|name)
E:Employee<P>(department)
###
E(1|Alice|Engineering)
```

The `Employee` record emits all three fields (`id`, `name` from `Person`; `department` own) in the correct inherited order.

---

### 7. Round-trip a parse result

```js
import { parseMaxi, dumpMaxi } from 'maxi-schema';

const input = `U:User(id:int|name|email=unknown)
###
U(1|Julie)
U(2|Matt|~)`;

const result = await parseMaxi(input);
const output = dumpMaxi(result);

// output === input (modulo equivalent whitespace)
```

---

### 8. Multiline pretty-print

```js
const maxi = dumpMaxi(users, {
  defaultAlias: 'U',
  types: userTypes,
  multiline: true,
});
```

Output:
```
U:User(
  id:int|
  name|
  email=unknown
)
###
U(
  1|
  Julie
)
```

---

### 9. External schema reference (no inline types)

```js
const maxi = dumpMaxi({ id: 1, name: 'Julie' }, {
  defaultAlias: 'U',
  schemaFile: 'schemas/users.maxi',
  includeTypes: false,
});
```

Output:
```
@schema:schemas/users.maxi
###
U(1|Julie)
```

---

### 10. `dumpMaxiAuto` — zero-config dump from annotated classes

```js
import { dumpMaxiAuto } from 'maxi-schema';

class User {
  static maxiSchema = {
    alias: 'U',
    name: 'User',
    fields: [
      { name: 'id',   typeExpr: 'int' },
      { name: 'name' },
      { name: 'email', defaultValue: 'unknown' },
    ],
  };
  constructor({ id, name, email } = {}) {
    this.id = id; this.name = name;
    if (email !== undefined) this.email = email;
  }
}

const maxi = dumpMaxiAuto([
  new User({ id: 1, name: 'Julie' }),
  new User({ id: 2, name: 'Matt', email: null }),
]);
```

Output:
```
U:User(id:int|name|email=unknown)
###
U(1|Julie)
U(2|Matt|~)
```

---

### 11. `dumpMaxiAuto` — multi-type map

```js
class Order {
  static maxiSchema = {
    alias: 'O',
    name: 'Order',
    fields: [
      { name: 'id',    typeExpr: 'int' },
      { name: 'total', typeExpr: 'decimal' },
    ],
  };
  constructor({ id, total } = {}) { this.id = id; this.total = total; }
}

const maxi = dumpMaxiAuto({
  U: [new User({ id: 1, name: 'Julie' })],
  O: [new Order({ id: 100, total: 49.99 })],
});
```

Output:
```
U:User(id:int|name|email=unknown)
O:Order(id:int|total:decimal)
###
U(1|Julie)
O(100|49.99)
```

---

### 12. `dumpMaxiAuto` — nested referenced objects auto-collected

When a nested object's class also has a `maxiSchema`, its schema is discovered and
its instances are promoted to top-level records automatically — no extra config needed.

```js
class Address {
  static maxiSchema = {
    alias: 'A',
    name: 'Address',
    fields: [{ name: 'id' }, { name: 'street' }, { name: 'city' }],
  };
  constructor({ id, street, city } = {}) { this.id = id; this.street = street; this.city = city; }
}

class Customer {
  static maxiSchema = {
    alias: 'C',
    name: 'Customer',
    fields: [
      { name: 'id' },
      { name: 'name' },
      { name: 'address', typeExpr: 'A' },
    ],
  };
  constructor({ id, name, address } = {}) { this.id = id; this.name = name; this.address = address; }
}

const addr = new Address({ id: 'A1', street: '123 Main St', city: 'NYC' });
const maxi = dumpMaxiAuto([new Customer({ id: 'C1', name: 'John', address: addr })]);
```

Output:
```
C:Customer(id|name|address:A)
A:Address(id|street|city)
###
C(C1|John|A1)
A(A1|"123 Main St"|NYC)
```

