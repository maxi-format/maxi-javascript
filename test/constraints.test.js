import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMaxi } from '../src/api/parse.js';
import { MaxiError, MaxiErrorCode } from '../src/core/errors.js';

test('constraints: comparison >=N on int field (strict, violation)', async () => {
  const input = `@mode:strict
P:Product(id:int|stock:int(>=0))
###
P(1|-5)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.ConstraintViolationError
  );
});

test('constraints: comparison >=N on int field (strict, pass)', async () => {
  const input = `@mode:strict
P:Product(id:int|stock:int(>=0))
###
P(1|10)`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values, [1, 10]);
});

test('constraints: comparison <=N on int field (strict, violation)', async () => {
  const input = `@mode:strict
U:User(id:int|age:int(>=0,<=120))
###
U(1|200)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.ConstraintViolationError
  );
});

test('constraints: comparison on string length (strict, violation)', async () => {
  const input = `@mode:strict
U:User(id:int|name(>=3,<=20))
###
U(1|ab)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.ConstraintViolationError
  );
});

test('constraints: comparison on string length (strict, pass)', async () => {
  const input = `@mode:strict
U:User(id:int|name(>=3,<=20))
###
U(1|Julie)`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values, [1, 'Julie']);
});

test('constraints: pattern match (strict, violation)', async () => {
  const input = `@mode:strict
U:User(id:int|username(pattern:^[a-z0-9_]+$))
###
U(1|Hello World!)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.ConstraintViolationError
  );
});

test('constraints: pattern match (strict, pass)', async () => {
  const input = `@mode:strict
U:User(id:int|username(pattern:^[a-z0-9_]+$))
###
U(1|julie_99)`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values, [1, 'julie_99']);
});

test('constraints: exact-length on array (strict, violation)', async () => {
  const input = `@mode:strict
U:User(id:int|scores:int[](=3))
###
U(1|[95,87])`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.ConstraintViolationError
  );
});

test('constraints: exact-length on array (strict, pass)', async () => {
  const input = `@mode:strict
U:User(id:int|scores:int[](=3))
###
U(1|[95,87,92])`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values[1], [95, 87, 92]);
});

test('constraints: lax mode emits warnings not errors', async () => {
  const input = `U:User(id:int|age:int(>=0,<=120))
###
U(1|200)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], 200);
  assert.ok(res.warnings.some(w => w.code === MaxiErrorCode.ConstraintViolationError));
});

test('constraints: conflicting >=10 and <=5 causes error', async () => {
  const input = `U:User(id:int|count:int(>=10,<=5))
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.InvalidConstraintValueError
  );
});

test('constraints: conflicting >10 and <10 causes error', async () => {
  const input = `U:User(id:int|count:int(>10,<10))
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.InvalidConstraintValueError
  );
});

test('constraints: non-conflicting >=0 and <=100 is OK', async () => {
  const input = `U:User(id:int|score:int(>=0,<=100))
###
U(1|50)`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values, [1, 50]);
});

test('constraints: duplicate id in strict mode causes error -> E016', async () => {
  const input = `@mode:strict
U:User(id:int|name)
###
U(1|Julie)
U(1|Matt)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.DuplicateIdentifierError
  );
});

test('constraints: duplicate id in lax mode emits warning', async () => {
  const input = `U:User(id:int|name)
###
U(1|Julie)
U(1|Matt)`;

  const res = await parseMaxi(input);
  assert.equal(res.records.length, 2);
  assert.ok(res.warnings.some(w => w.code === MaxiErrorCode.DuplicateIdentifierError));
});

test('constraints: different ids are OK', async () => {
  const input = `@mode:strict
U:User(id:int|name)
###
U(1|Julie)
U(2|Matt)`;

  const res = await parseMaxi(input);
  assert.equal(res.records.length, 2);
});

test('constraints: explicit id constraint field for duplicate detection', async () => {
  const input = `@mode:strict
O:Order(order_id:int(id)|user_id:int|total:decimal)
###
O(100|1|99.99)
O(100|2|149.50)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.DuplicateIdentifierError
  );
});

test('constraints: invalid enum value in strict mode causes error', async () => {
  const input = `@mode:strict
U:User(id:int|role:enum[admin,user,guest])
###
U(1|superadmin)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.ConstraintViolationError
  );
});

test('constraints: valid enum value passes', async () => {
  const input = `@mode:strict
U:User(id:int|role:enum[admin,user,guest])
###
U(1|admin)`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values, [1, 'admin']);
});

test('constraints: invalid enum value in lax mode emits warning', async () => {
  const input = `U:User(id:int|role:enum[admin,user,guest])
###
U(1|superadmin)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], 'superadmin');
  assert.ok(res.warnings.some(w => w.code === MaxiErrorCode.ConstraintViolationError));
});

test('constraints: integer enum validation', async () => {
  const input = `@mode:strict
U:User(id:int|status:enum<int>[0,1,2])
###
U(1|1)`;

  const res = await parseMaxi(input);
  // enum<int> values: the value is parsed as-is (string "1") since typeExpr is "enum<int>[...]"
  // Enum validation compares string representations
  assert.equal(res.records[0].values[0], 1);
  assert.equal(res.records[0].values[1], '1');
});

test('constraints: @email on int field causes error -> E012', async () => {
  const input = `U:User(id:int@email|name)
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.InvalidConstraintValueError
  );
});

test('constraints: @timestamp on str field causes error -> E012', async () => {
  const input = `U:User(id:int|ts:str@timestamp)
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.InvalidConstraintValueError
  );
});

test('constraints: @base64 on str field causes error -> E012', async () => {
  const input = `U:User(id:int|data:str@base64)
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.InvalidConstraintValueError
  );
});

test('constraints: @email on str field is OK', async () => {
  const input = `U:User(id:int|email:str@email)
###
U(1|julie@maxi.org)`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values, [1, 'julie@maxi.org']);
});

test('constraints: @timestamp on int field is OK', async () => {
  const input = `U:User(id:int|ts:int@timestamp)
###
U(1|1234567890)`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values, [1, 1234567890]);
});

test('constraints: @hex on bytes field is OK', async () => {
  const input = `F:File(id:int|data:bytes@hex)
###
F(1|48656c6c6f)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], '48656c6c6f');
});


