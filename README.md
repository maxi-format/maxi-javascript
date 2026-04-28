# maxi-schema

JavaScript library for parsing and dumping **MAXI schema + records**.

- `parseMaxi(input, options)` → parses MAXI text into a structured result (schema + records)
- `streamMaxi(input, options)` → parses schema immediately and returns an async iterator for records
- `dumpMaxi(data, options)` → serializes objects/records back into MAXI text

Version: `1.0.0-draft`

## Install

Install from GitHub:
```bash
npm install maxi-format/maxi-javascript
```

## Quick start

### Parse (in-memory)

```js
import { parseMaxi } from "maxi-schema";

(async () => {
  const input = `
U:User(id:int|name|email)
###
U(1|Julie|julie@maxi.org)
`.trim();

  const res = await parseMaxi(input, { mode: "lax" });
  console.log(res.records[0].alias);   // "U"
  console.log(res.records[0].values);  // [1, "Julie", "julie@maxi.org"]
})();
```

### Parse (streaming)

For large files, `streamMaxi` parses the schema immediately and returns an async iterator that yields records one at a time.

```js
import { streamMaxi } from "maxi-schema";

(async () => {
  const input = `
U:User(id:int|name|email)
###
U(1|Julie|julie@maxi.org)
U(2|Matt|matt@maxi.org)
`.trim();

  const stream = await streamMaxi(input);

  // Schema is available immediately
  console.log(stream.schema.getType('U').fields.map(f => f.name));

  // Iterate over records as they are parsed
  for await (const record of stream) {
    console.log(record.values);
  }
})();
```

### Dump

Dump a single object/array by providing `defaultAlias`, or dump a map of `{ alias: [objects...] }`.

```js
import { dumpMaxi } from "maxi-schema";

const maxi = dumpMaxi(
  [{ id: 1, name: "Julie" }, { id: 2, name: "Matt", email: null }],
  {
    defaultAlias: "U",
    types: [
      {
        alias: "U",
        name: "User",
        fields: [
          { name: "id", typeExpr: "int" },
          { name: "name" },
          { name: "email", defaultValue: "unknown" }
        ]
      }
    ]
  }
);

console.log(maxi);
```

## API

### `parseMaxi(input, options?)`

- `input: string` MAXI content
- `options.mode: "lax" | "strict"` (default: `"lax"`)
  - `lax`: best-effort parsing, accumulates warnings for recoverable errors
  - `strict`: fails on any deviation from the schema
- `options.filename?: string` used in error messages
- `options.loadSchema?: (pathOrUrl: string) => string | Promise<string>`
  - used to resolve `@schema:...` imports

Returns a `MaxiParseResult` containing:
- `schema` (types, directives/imports)
- `records` (array of `{ alias, values }`)
- `warnings` (array of errors encountered in lax mode)

### `streamMaxi(input, options?)`

Parses MAXI content in a streaming fashion. It returns a `Promise` that resolves to a `MaxiStreamResult`.

- `input` and `options` are the same as `parseMaxi`.

The resolved `MaxiStreamResult` object has:
- `schema`: The fully parsed schema, available immediately.
- `warnings`: An array for storing warnings.
- `records()`: An async generator method that yields records one by one.
- The result object is also an async-iterable, so you can use `for await...of` directly on it.

### `dumpMaxi(data, options?)`

`data` can be one of:
- a single object (requires `options.defaultAlias`)
- an array of objects (requires `options.defaultAlias`)
- a map `{ [alias]: object[] }`
- a previously parsed parse-result-like object (for round-tripping)

Common options:
- `defaultAlias?: string` required for single object / array input
- `types?: Array<{ alias, name?, parents?, fields: [...] }> | Map<alias, type>` inline schema types
- `includeTypes?: boolean` (default: `true`) include type definitions in output
- `schemaFile?: string` emit `@schema:<path>` import directive
- `version?: string` emit `@version:<x>` when not `1.0.0`
- `mode?: "strict" | "lax"` emit `@mode:strict` when strict
- `multiline?: boolean` pretty multi-line types/records
- `collectReferences?: boolean` (default: `true`)
  - promotes nested typed objects with an `id` field into their own top-level records
  - and replaces references with the nested object’s `id`

## MAXI snippet (very small overview)

Type definition:
```
U:User(id:int|name|email=unknown)
```

Records section delimiter:
```
###
```

Record:
```
U(1|Julie|~)
```

Notes:
- omitted trailing fields may use defaults (when defined in schema)
- `~` represents explicit null

## Test

```bash
node --test
```

## License

Released under the [MIT License](./LICENSE).
