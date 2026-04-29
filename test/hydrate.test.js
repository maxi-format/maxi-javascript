import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMaxiAs, parseMaxiAutoAs } from '../src/api/hydrate.js';
import { defineMaxiSchema, undefineMaxiSchema } from '../src/core/schema-registry.js';

class User {
  static maxiSchema = {
    alias: 'U',
    name: 'User',
    fields: [
      { name: 'id', typeExpr: 'int' },
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

class Order {
  static maxiSchema = {
    alias: 'O',
    name: 'Order',
    fields: [
      { name: 'id', typeExpr: 'int' },
      { name: 'userId', typeExpr: 'U' },  // reference to User
      { name: 'total', typeExpr: 'decimal' },
    ],
  };

  constructor({ id, userId, total } = {}) {
    this.id     = id;
    this.userId = userId;
    this.total  = total;
  }
}

class Address {
  static maxiSchema = {
    alias: 'A',
    name: 'Address',
    fields: [
      { name: 'id' },
      { name: 'street' },
      { name: 'city' },
    ],
  };

  constructor({ id, street, city } = {}) {
    this.id     = id;
    this.street = street;
    this.city   = city;
  }
}

function makeMaxi(schemaLines, recordLines) {
  return [...schemaLines, '###', ...recordLines].join('\n');
}

test('parseMaxiAs: hydrates records into class instances', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name|email)'],
    ['U(1|Julie|julie@example.com)', 'U(2|Matt|matt@example.com)']
  );

  const { objects } = await parseMaxiAs(input, { U: User });

  assert.equal(objects.U.length, 2);
  assert.ok(objects.U[0] instanceof User, 'should be a User instance');
  assert.equal(objects.U[0].id, 1);
  assert.equal(objects.U[0].name, 'Julie');
  assert.equal(objects.U[0].email, 'julie@example.com');
  assert.ok(objects.U[1] instanceof User);
  assert.equal(objects.U[1].id, 2);
});

test('parseMaxiAs: result contains schema and warnings', async () => {
  const input = makeMaxi(['U:User(id:int|name)'], ['U(1|Julie)']);

  const result = await parseMaxiAs(input, { U: User });

  assert.ok(result.schema, 'should have schema');
  assert.ok(Array.isArray(result.warnings), 'should have warnings array');
});

test('parseMaxiAs: only aliases present in classMap are hydrated', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name)', 'O:Order(id:int|userId:int|total:decimal)'],
    ['U(1|Julie)', 'O(100|1|49.99)']
  );

  // Only pass User — Order should not appear in objects
  const { objects } = await parseMaxiAs(input, { U: User });

  assert.ok(objects.U, 'U should be hydrated');
  assert.equal(objects.U.length, 1);
  assert.equal(objects.O, undefined, 'O should not be hydrated');
});

test('parseMaxiAs: resolves cross-reference fields to hydrated instances', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name)', 'O:Order(id:int|userId:U|total:decimal)'],
    ['U(1|Julie)', 'O(100|1|49.99)']
  );

  const { objects } = await parseMaxiAs(input, { U: User, O: Order });

  assert.equal(objects.U.length, 1);
  assert.equal(objects.O.length, 1);

  const order = objects.O[0];
  assert.ok(order instanceof Order);

  // userId should be replaced with the actual User instance
  assert.ok(order.userId instanceof User, `userId should be a User instance, got: ${JSON.stringify(order.userId)}`);
  assert.equal(order.userId.id, 1);
  assert.equal(order.userId.name, 'Julie');
});

test('parseMaxiAs: unresolved reference stays as scalar (no error in lax mode)', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name)', 'O:Order(id:int|userId:U|total:decimal)'],
    ['O(100|999|49.99)']  // User 999 does not exist
  );

  const { objects, warnings } = await parseMaxiAs(input, { U: User, O: Order });

  const order = objects.O[0];
  // Reference not found — field stays as the original scalar id value
  assert.equal(order.userId, 999);
  // A warning should be present from parseMaxi
  assert.ok(warnings.some(w => w.message.includes('999')), 'should warn about unresolved ref');
});

test('parseMaxiAs: forward references resolve correctly', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name)', 'O:Order(id:int|userId:U|total:decimal)'],
    ['O(100|1|49.99)', 'U(1|Julie)']  // Order comes before User
  );

  const { objects } = await parseMaxiAs(input, { U: User, O: Order });

  const order = objects.O[0];
  assert.ok(order.userId instanceof User, 'forward ref should resolve to User instance');
  assert.equal(order.userId.name, 'Julie');
});

test('parseMaxiAutoAs: resolves aliases automatically from static maxiSchema', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name)'],
    ['U(1|Julie)']
  );

  const { objects } = await parseMaxiAutoAs(input, [User]);

  assert.equal(objects.U.length, 1);
  assert.ok(objects.U[0] instanceof User);
  assert.equal(objects.U[0].name, 'Julie');
});

test('parseMaxiAutoAs: works with multiple classes', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name)', 'O:Order(id:int|userId:U|total:decimal)'],
    ['U(1|Julie)', 'O(100|1|49.99)']
  );

  const { objects } = await parseMaxiAutoAs(input, [User, Order]);

  assert.ok(objects.U[0] instanceof User);
  assert.ok(objects.O[0] instanceof Order);
  assert.ok(objects.O[0].userId instanceof User, 'reference should be resolved');
});

test('parseMaxiAutoAs: throws if class has no registered schema', async () => {
  class NoSchema {}
  await assert.rejects(
    () => parseMaxiAutoAs('U(1|Julie)', [NoSchema]),
    { message: /no maxiSchema found for class 'NoSchema'/ }
  );
});

test('parseMaxiAutoAs: works with WeakMap-registered schema', async () => {
  class Product {
    constructor({ id, title } = {}) {
      this.id = id;
      this.title = title;
    }
  }

  defineMaxiSchema(Product, {
    alias: 'P',
    name: 'Product',
    fields: [
      { name: 'id', typeExpr: 'int' },
      { name: 'title' },
    ],
  });

  const input = makeMaxi(['P:Product(id:int|title)'], ['P(1|Widget)']);
  const { objects } = await parseMaxiAutoAs(input, [Product]);

  assert.ok(objects.P[0] instanceof Product);
  assert.equal(objects.P[0].id, 1);
  assert.equal(objects.P[0].title, 'Widget');

  undefineMaxiSchema(Product);
});

test('parseMaxiAs: falls back to Object.assign when constructor does not accept map', async () => {
  class PosArgs {
    constructor(id, name) {
      this.id   = id;
      this.name = name;
    }
  }

  const input = makeMaxi(['P:PosArgs(id:int|name)'], ['P(1|Alice)']);
  const { objects } = await parseMaxiAs(input, { P: PosArgs });

  // Object.assign fallback should have set the fields
  assert.ok(objects.P[0] instanceof PosArgs);
  assert.equal(objects.P[0].name, 'Alice');
});

test('parseMaxiAs: null (~) values map to null on instance', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name|email)'],
    ['U(1|Julie|~)']
  );

  const { objects } = await parseMaxiAs(input, { U: User });
  assert.equal(objects.U[0].email, null);
});

test('parseMaxiAs: default-value fields are filled in by parser', async () => {
  const input = makeMaxi(
    ['U:User(id:int|name|email=unknown)'],
    ['U(1|Julie)']  // email omitted
  );

  const { objects } = await parseMaxiAs(input, { U: User });
  assert.equal(objects.U[0].email, 'unknown');
});

test('parseMaxiAs: throws if classMap is not an object', async () => {
  await assert.rejects(
    () => parseMaxiAs('U(1|Julie)', null),
    { message: /classMap must be/ }
  );
});

test('parseMaxiAutoAs: throws if classes arg is not an array', async () => {
  await assert.rejects(
    () => parseMaxiAutoAs('U(1|Julie)', { U: User }),
    { message: /must be an array/ }
  );
});

test('parseMaxiAs: empty records section returns empty objects map', async () => {
  const input = 'U:User(id:int|name)\n###\n';
  const { objects } = await parseMaxiAs(input, { U: User });
  // Key may not even be present if no records exist
  assert.equal((objects.U ?? []).length, 0);
});

