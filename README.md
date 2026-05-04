# maxi-schema

JavaScript library for parsing and dumping **MAXI schema + records**.

Version: `0.1.0`

## Install

```bash
npm install maxi-format/maxi-javascript
```

## API overview

| Function | Description |
|---|---|
| `parseMaxi(input, options?)` | Parse MAXI text → `MaxiParseResult` (schema + raw records) |
| `streamMaxi(input, options?)` | Parse schema eagerly, yield records lazily via async iterator |
| `parseMaxiAs(input, classMap, options?)` | Parse + hydrate records into class instances |
| `parseMaxiAutoAs(input, classes, options?)` | Same, with alias inferred from `static maxiSchema` |
| `dumpMaxi(data, options?)` | Serialize objects / parse results → MAXI text |
| `dumpMaxiAuto(objects, options?)` | Same, with schema inferred from `static maxiSchema` |
| `defineMaxiSchema(Class, schema)` | Register a schema descriptor for a class (WeakMap-based) |
| `getMaxiSchema(ClassOrInstance)` | Look up a registered schema descriptor |

## Quick start

### Parse

```js
import { parseMaxi } from 'maxi-schema';

const input = `
U:User(id:int|name|email)
###
U(1|Julie|julie@maxi.org)
`.trim();

const res = await parseMaxi(input);
console.log(res.records[0].values); // [1, 'Julie', 'julie@maxi.org']
```

### Parse into class instances

```js
import { parseMaxiAutoAs } from 'maxi-schema';

class User {
  static maxiSchema = {
    alias: 'U',
    fields: [{ name: 'id', typeExpr: 'int' }, { name: 'name' }, { name: 'email' }],
  };
  constructor({ id, name, email } = {}) { this.id = id; this.name = name; this.email = email; }
}

const { objects } = await parseMaxiAutoAs(input, [User]);
console.log(objects.U[0] instanceof User); // true
console.log(objects.U[0].name);            // 'Julie'
```

### Dump

```js
import { dumpMaxiAuto } from 'maxi-schema';

const maxi = dumpMaxiAuto([new User({ id: 1, name: 'Julie' })]);
```

Or with explicit types via `dumpMaxi`:

```js
import { dumpMaxi } from 'maxi-schema';

const maxi = dumpMaxi([{ id: 1, name: 'Julie' }], {
  defaultAlias: 'U',
  types: [{ alias: 'U', name: 'User', fields: [{ name: 'id', typeExpr: 'int' }, { name: 'name' }] }],
});
```

## Documentation

- **[docs/parser.md](docs/parser.md)** — full parser guide: `parseMaxi`, `streamMaxi`, `parseMaxiAs`, `parseMaxiAutoAs`, hydration, reference resolution, options
- **[docs/dumper.md](docs/dumper.md)** — full dumper guide: `dumpMaxi`, `dumpMaxiAuto`, schema-annotated classes, references, inheritance, options

## MAXI format (quick reference)

```
U:User(id:int|name|email=unknown)   ← type definition
###                                  ← section separator
U(1|Julie|~)                         ← record  (~ = explicit null)
```

- Omitted trailing fields use their declared default value.
- See the [MAXI spec](SPEC.md) for the full format definition.

## Test

```bash
node --test
```

## License

Released under the [MIT License](./LICENSE).
