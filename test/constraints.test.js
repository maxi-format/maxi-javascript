import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMaxi } from '../src/api/parse.js';
import { MaxiError, MaxiErrorCode } from '../src/core/errors.js';

test('constraints: lax mode emits warnings not errors', async () => {
  const input = `U:User(id:int|age:int(>=0,<=120))
###
U(1|200)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], 200);
  assert.ok(res.warnings.some(w => w.code === MaxiErrorCode.ConstraintViolationError));
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

test('constraints: invalid enum value in lax mode emits warning', async () => {
  const input = `U:User(id:int|role:enum[admin,user,guest])
###
U(1|superadmin)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], 'superadmin');
  assert.ok(res.warnings.some(w => w.code === MaxiErrorCode.ConstraintViolationError));
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

test('constraints: enum alias expands to full value on parse', async () => {
  const input = `U:User(id:int|role:enum[a:admin,e:editor,v:viewer])
###
U(1|a)
U(2|e)
U(3|v)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], 'admin');
  assert.equal(res.records[1].values[1], 'editor');
  assert.equal(res.records[2].values[1], 'viewer');
});

test('constraints: enum alias mixed mode (only some values aliased)', async () => {
  const input = `U:User(id:int|role:enum[a:admin,user,guest])
###
U(1|a)
U(2|user)
U(3|guest)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], 'admin');
  assert.equal(res.records[1].values[1], 'user');
  assert.equal(res.records[2].values[1], 'guest');
});

test('constraints: enum<int> alias expands to integer value on parse', async () => {
  const input = `D:Device(id:int|state:enum<int>[O:900,R:1000,E:999])
###
D(1|R)
D(2|O)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], 1000);
  assert.equal(res.records[1].values[1], 900);
  assert.equal(typeof res.records[0].values[1], 'number');
});

test('constraints: enum full value accepted as wire token (backward compat)', async () => {
  const input = `U:User(id:int|role:enum[a:admin,e:editor])
###
U(1|admin)`;

  const res = await parseMaxi(input);
  assert.equal(res.records[0].values[1], 'admin');
});

test('constraints: enum duplicate alias → E021', async () => {
  const input = `U:User(id:int|role:enum[a:admin,a:editor])
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.EnumAliasError
  );
});

test('constraints: enum duplicate full value → E021', async () => {
  const input = `U:User(id:int|role:enum[a:admin,b:admin])
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.EnumAliasError
  );
});

test('constraints: enum alias equals another entry full value → E021', async () => {
  const input = `U:User(id:int|role:enum[admin:superadmin,e:admin])
###`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.EnumAliasError
  );
});

test('constraints: unknown enum wire token → E008 in strict mode', async () => {
  const input = `U:User(id:int|role:enum[a:admin,e:editor])
###
U(1|superadmin)`;

  await assert.rejects(
    () => parseMaxi(input, { allowConstraintViolations: 'error' }),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.ConstraintViolationError
  );
});


