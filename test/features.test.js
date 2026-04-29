import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMaxi } from '../src/api/parse.js';


test('features: int[][][] three-dimensional array', async () => {
  const input = `C:Cube(id:int|data:int[][][])
###
C(1|[[[1,2],[3,4]],[[5,6],[7,8]]])`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values[1], [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]);
});

test('features: map<str,int> type expression is stored and value type extracted', async () => {
  const input = `S:Scores(id:int|data:map<str,int>)
###
S(1|{math:95,english:87})`;

  const res = await parseMaxi(input);
  const field = res.schema.getType('S').fields[1];
  assert.equal(field.typeExpr, 'map<str,int>');
  assert.deepEqual(res.records[0].values[1], { math: 95, english: 87 });
});

test('features: map with constrained value type parses correctly', async () => {
  const input = `S:Scores(id:int|data:map<str,int>(>=1))
###
S(1|{math:95})`;

  const res = await parseMaxi(input);
  const field = res.schema.getType('S').fields[1];
  assert.equal(field.typeExpr, 'map<str,int>');
  assert.ok(field.constraints.some(c => c.type === 'comparison' && c.operator === '>=' && c.value === 1));
});

test('features: untyped map still works', async () => {
  const input = `M:Meta(id:int|data:map)
###
M(1|{key:value})`;

  const res = await parseMaxi(input);
  assert.deepEqual(res.records[0].values[1], { key: 'value' });
});

test('features: element constraints separated from array constraints', async () => {
  const input = `U:User(id:int|tags:str(>=3,<=20)[](>=1,<=10))
###
U(1|[programming,design,music])`;

  const res = await parseMaxi(input);
  const field = res.schema.getType('U').fields[1];

  // Array-level constraints (>=1,<=10) should be in constraints
  assert.ok(field.constraints.length >= 2);
  assert.ok(field.constraints.some(c => c.type === 'comparison' && c.operator === '>=' && c.value === 1));
  assert.ok(field.constraints.some(c => c.type === 'comparison' && c.operator === '<=' && c.value === 10));

  // Element-level constraints (>=3,<=20) should be in elementConstraints
  assert.ok(field.elementConstraints);
  assert.ok(field.elementConstraints.length >= 2);
  assert.ok(field.elementConstraints.some(c => c.type === 'comparison' && c.operator === '>=' && c.value === 3));
  assert.ok(field.elementConstraints.some(c => c.type === 'comparison' && c.operator === '<=' && c.value === 20));

  // typeExpr should still contain the array type
  assert.equal(field.typeExpr, 'str[]');
});

test('features: array without element constraints has null elementConstraints', async () => {
  const input = `U:User(id:int|tags:str[](>=1))
###`;

  const res = await parseMaxi(input);
  const field = res.schema.getType('U').fields[1];

  assert.ok(field.constraints.some(c => c.operator === '>=' && c.value === 1));
  assert.equal(field.elementConstraints, null);
});

test('features: element constraints only (no array constraints)', async () => {
  const input = `U:User(id:int|scores:int(>=0,<=100)[])
###
U(1|[95,87,92])`;

  const res = await parseMaxi(input);
  const field = res.schema.getType('U').fields[1];

  // No array-level trailing constraints → constraints should be empty or from the name part
  // The element constraints are embedded in the typeExpr as int(>=0,<=100)[]
  // Since there's no trailing (...) after [], constraints is empty
  assert.equal(field.typeExpr, 'int(>=0,<=100)[]');
});

test('features: decimal precision 5.2 parsed into structured form', async () => {
  const input = `P:Product(id:int|price:decimal(5.2))
###`;

  const res = await parseMaxi(input);
  const field = res.schema.getType('P').fields[1];
  const dp = field.constraints.find(c => c.type === 'decimal-precision');

  assert.ok(dp, 'Should have decimal-precision constraint');
  assert.equal(dp.value, '5.2');
  assert.equal(dp.intMax, 5);
  assert.equal(dp.fracMax, 2);
});

test('features: decimal precision 0:10.2 (range int digits)', async () => {
  const input = `P:Product(id:int|price:decimal(0:10.2))
###`;

  const res = await parseMaxi(input);
  const dp = res.schema.getType('P').fields[1].constraints.find(c => c.type === 'decimal-precision');

  assert.equal(dp.intMin, 0);
  assert.equal(dp.intMax, 10);
  assert.equal(dp.fracMax, 2);
});

test('features: decimal precision .2:4 (range frac digits)', async () => {
  const input = `P:Product(id:int|price:decimal(.2:4))
###`;

  const res = await parseMaxi(input);
  const dp = res.schema.getType('P').fields[1].constraints.find(c => c.type === 'decimal-precision');

  assert.equal(dp.intMin, null);
  assert.equal(dp.intMax, null);
  assert.equal(dp.fracMin, 2);  // min frac digits is first in range after dot
  assert.equal(dp.fracMax, 4);
});

test('features: decimal precision 1:999. (int range, no frac)', async () => {
  const input = `P:Product(id:int|price:decimal(1:999.))
###`;

  const res = await parseMaxi(input);
  const dp = res.schema.getType('P').fields[1].constraints.find(c => c.type === 'decimal-precision');

  assert.equal(dp.intMin, 1);
  assert.equal(dp.intMax, 999);
  assert.equal(dp.fracMin, null);
  assert.equal(dp.fracMax, null);
});

test('features: decimal precision .2 (exact frac digits)', async () => {
  const input = `P:Product(id:int|price:decimal(.2))
###`;

  const res = await parseMaxi(input);
  const dp = res.schema.getType('P').fields[1].constraints.find(c => c.type === 'decimal-precision');

  assert.equal(dp.intMin, null);
  assert.equal(dp.intMax, null);
  assert.equal(dp.fracMax, 2);
});

test('features: decimal precision raw value still preserved', async () => {
  const input = `P:Product(id:int|price:decimal(5.2))
###`;

  const res = await parseMaxi(input);
  const dp = res.schema.getType('P').fields[1].constraints.find(c => c.type === 'decimal-precision');
  assert.equal(dp.value, '5.2');
});

