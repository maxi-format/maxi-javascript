import { test } from 'node:test';
import assert from 'node:assert/strict';

import { streamMaxi } from '../src/api/stream.js';
import { MaxiError, MaxiErrorCode } from '../src/core/errors.js';

test('stream: schema available before iterating records', async () => {
  const input = `U:User(id:int|name|email)
###
U(1|Julie|julie@maxi.org)
U(2|Matt|matt@maxi.org)`;

  const stream = await streamMaxi(input);

  // Schema is available immediately
  assert.ok(stream.schema.hasType('U'));
  assert.equal(stream.schema.types.size, 1);

  const records = [];
  for await (const record of stream) {
    records.push(record);
  }

  assert.equal(records.length, 2);
  assert.deepEqual(records[0].values, [1, 'Julie', 'julie@maxi.org']);
  assert.deepEqual(records[1].values, [1 + 1, 'Matt', 'matt@maxi.org']);
});

test('stream: records() method also works as async iterator', async () => {
  const input = `U:User(id:int|name)
###
U(1|Alice)
U(2|Bob)
U(3|Charlie)`;

  const stream = await streamMaxi(input);
  const names = [];

  for await (const record of stream.records()) {
    names.push(record.values[1]);
  }

  assert.deepEqual(names, ['Alice', 'Bob', 'Charlie']);
});

test('stream: schema errors throw before records are available', async () => {
  const input = `@version:2.0.0
U:User(id:int)
###
U(1)`;

  await assert.rejects(
    () => streamMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.UnsupportedVersionError
  );
});

test('stream: record validation errors throw during iteration', async () => {
  const input = `@mode:strict
U:User(id:int|name)
###
U(hello|Julie)`;

  const stream = await streamMaxi(input);

  await assert.rejects(
    async () => {
      for await (const _record of stream) {
        // should throw on first record
      }
    },
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.TypeMismatchError
  );
});

test('stream: empty records section yields nothing', async () => {
  const input = `U:User(id:int|name)
###`;

  const stream = await streamMaxi(input);
  assert.ok(stream.schema.hasType('U'));

  const records = [];
  for await (const record of stream) {
    records.push(record);
  }
  assert.equal(records.length, 0);
});

test('stream: schema-only input (no ###) yields no records', async () => {
  const input = `U:User(id:int|name)`;

  const stream = await streamMaxi(input);
  assert.ok(stream.schema.hasType('U'));

  const records = [];
  for await (const record of stream) {
    records.push(record);
  }
  assert.equal(records.length, 0);
});

test('stream: can break early from iteration', async () => {
  const input = `U:User(id:int|name)
###
U(1|Alice)
U(2|Bob)
U(3|Charlie)
U(4|Diana)`;

  const stream = await streamMaxi(input);
  const collected = [];

  for await (const record of stream) {
    collected.push(record);
    if (collected.length === 2) break;
  }

  assert.equal(collected.length, 2);
  assert.equal(collected[0].values[1], 'Alice');
  assert.equal(collected[1].values[1], 'Bob');
});

test('stream: warnings are accumulated', async () => {
  const input = `U:User(id:int|name)
###
U(hello|Julie)`;

  const stream = await streamMaxi(input);

  for await (const _record of stream) {
    // consume all
  }

  assert.ok(stream.warnings.length > 0);
  assert.ok(stream.warnings.some(w => w.code === MaxiErrorCode.TypeMismatchError));
});

test('stream: with imported schema', async () => {
  const input = `@schema:users.mxs
###
U(1|Julie)
U(2|Matt)`;

  const loadSchema = async (path) => {
    assert.equal(path, 'users.mxs');
    return `U:User(id:int|name)`;
  };

  const stream = await streamMaxi(input, { loadSchema });
  assert.ok(stream.schema.hasType('U'));

  const records = [];
  for await (const record of stream) {
    records.push(record);
  }

  assert.equal(records.length, 2);
  assert.deepEqual(records[0].values, [1, 'Julie']);
});

test('stream: strict mode unknown type throws during iteration', async () => {
  const input = `@mode:strict
U:User(id:int|name)
###
X(1|oops)`;

  const stream = await streamMaxi(input);

  await assert.rejects(
    async () => {
      for await (const _record of stream) {
        // should throw
      }
    },
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.UnknownTypeError
  );
});

test('stream: duplicate id detection across streamed records', async () => {
  const input = `@mode:strict
U:User(id:int(id)|name)
###
U(1|Alice)
U(1|Duplicate)`;

  const stream = await streamMaxi(input);

  await assert.rejects(
    async () => {
      for await (const _record of stream) {
        // should throw on second record
      }
    },
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.DuplicateIdentifierError
  );
});

