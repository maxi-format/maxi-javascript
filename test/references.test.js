import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMaxi } from '../src/api/parse.js';
import { MaxiError, MaxiErrorCode } from '../src/core/errors.js';

test('references: object registry is built from records', async () => {
  const input = `U:User(id:int|name|email)
O:Order(id:int|user:U|total:decimal)
###
U(1|Julie|julie@maxi.org)
U(2|Matt|matt@maxi.org)
O(100|1|99.99)
O(101|2|149.50)`;

  const res = await parseMaxi(input);

  // Registry should be built
  assert.ok(res._objectRegistry, 'Object registry should exist');
  assert.ok(res._objectRegistry.has('U'), 'Registry should have User type');
  assert.ok(res._objectRegistry.has('O'), 'Registry should have Order type');

  // Users should be indexed
  const users = res._objectRegistry.get('U');
  assert.equal(users.size, 2);
  assert.deepEqual(users.get('1'), { id: 1, name: 'Julie', email: 'julie@maxi.org' });
  assert.deepEqual(users.get('2'), { id: 2, name: 'Matt', email: 'matt@maxi.org' });

  // Order user field should be a reference value (plain int)
  assert.equal(res.records[2].values[1], 1); // user field = 1 (reference)
  assert.equal(res.records[3].values[1], 2); // user field = 2 (reference)
});

test('references: valid references produce no warnings in lax mode', async () => {
  const input = `U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
U(1|Julie)
O(100|1|99.99)`;

  const res = await parseMaxi(input);

  // No unresolved reference warnings
  const refWarnings = res.warnings.filter(w => w.code === MaxiErrorCode.UnresolvedReferenceError);
  assert.equal(refWarnings.length, 0, 'Should have no unresolved reference warnings');
});

test('references: unresolved reference in strict mode throws E009', async () => {
  const input = `@mode:strict
U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
O(100|999|99.99)`;

  await assert.rejects(
    () => parseMaxi(input),
    (err) => err instanceof MaxiError && err.code === MaxiErrorCode.UnresolvedReferenceError
  );
});

test('references: unresolved reference in lax mode emits warning', async () => {
  const input = `U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
O(100|999|99.99)`;

  const res = await parseMaxi(input);
  assert.equal(res.records.length, 1);
  assert.ok(
    res.warnings.some(w => w.code === MaxiErrorCode.UnresolvedReferenceError),
    'Should have unresolved reference warning'
  );
});

test('references: forward references are supported in lax mode', async () => {
  const input = `U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
O(100|1|99.99)
U(1|Julie)`;

  const res = await parseMaxi(input);

  // Forward reference should resolve (user id=1 defined after order)
  const refWarnings = res.warnings.filter(w => w.code === MaxiErrorCode.UnresolvedReferenceError);
  assert.equal(refWarnings.length, 0, 'Forward references should resolve in lax mode');

  // Registry should contain both
  assert.ok(res._objectRegistry.get('U').has('1'));
});

test('references: forward references in strict mode - unresolved triggers error', async () => {
  // In strict mode, if a forward ref ultimately resolves, it should be OK
  // because we resolve after ALL records are loaded
  const input = `@mode:strict
U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
O(100|1|99.99)
U(1|Julie)`;

  const res = await parseMaxi(input);

  // Should NOT error because forward ref resolves after all records loaded
  assert.equal(res.records.length, 2);
});

test('references: inline objects are indexed in registry', async () => {
  const input = `U:User(id:int|name|email)
O:Order(id:int|user:U|total:decimal)
###
O(100|(1|Julie|julie@maxi.org)|99.99)
O(101|1|149.50)`;

  const res = await parseMaxi(input);

  // The inline User(1|Julie|...) should be indexed
  assert.ok(res._objectRegistry.get('U').has('1'));

  // Second order references User id=1 - should resolve
  const refWarnings = res.warnings.filter(w => w.code === MaxiErrorCode.UnresolvedReferenceError);
  assert.equal(refWarnings.length, 0);
});

test('references: mixed inline and reference usage', async () => {
  const input = `U:User(id:int|name|email)
A:Address(id:int|street|city)
O:Order(id:int|user:U|shipTo:A|total:decimal)
###
U(1|Julie|julie@maxi.org)
A(1|123 Main St|NYC)
O(100|1|1|99.99)
O(101|(2|Matt|matt@maxi.org)|(2|456 Oak Ave|LA)|149.50)`;

  const res = await parseMaxi(input);

  // All references should resolve
  const refWarnings = res.warnings.filter(w => w.code === MaxiErrorCode.UnresolvedReferenceError);
  assert.equal(refWarnings.length, 0);

  // Registry should have all objects
  assert.equal(res._objectRegistry.get('U').size, 2);
  assert.equal(res._objectRegistry.get('A').size, 2);
});

test('references: primitive-typed fields are not treated as references', async () => {
  const input = `U:User(id:int|name|age:int|score:decimal)
###
U(1|Julie|25|99.5)`;

  const res = await parseMaxi(input);

  // No reference warnings for primitive fields
  const refWarnings = res.warnings.filter(w => w.code === MaxiErrorCode.UnresolvedReferenceError);
  assert.equal(refWarnings.length, 0);
});

test('references: enum and map fields are not treated as references', async () => {
  const input = `U:User(id:int|role:enum[admin,user]|meta:map)
###
U(1|admin|{key:value})`;

  const res = await parseMaxi(input);

  const refWarnings = res.warnings.filter(w => w.code === MaxiErrorCode.UnresolvedReferenceError);
  assert.equal(refWarnings.length, 0);
});

test('references: null reference values are not validated', async () => {
  const input = `U:User(id:int|name)
O:Order(id:int|user:U|total:decimal)
###
O(100|~|99.99)`;

  const res = await parseMaxi(input);

  // Null user ref should not trigger unresolved reference
  const refWarnings = res.warnings.filter(w => w.code === MaxiErrorCode.UnresolvedReferenceError);
  assert.equal(refWarnings.length, 0);
});

