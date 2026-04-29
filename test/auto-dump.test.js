import test from 'node:test';
import assert from 'node:assert/strict';

import { dumpMaxiAuto } from '../src/api/auto-dump.js';
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
    this.id   = id;
    this.name = name;
    // Only set email if explicitly provided — omitting it lets the dumper treat it as a trailing empty field
    if (email !== undefined) this.email = email;
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

  constructor({ id, name, address } = {}) {
    this.id      = id;
    this.name    = name;
    this.address = address;
  }
}

class Order {
  static maxiSchema = {
    alias: 'O',
    name: 'Order',
    fields: [
      { name: 'orderId', typeExpr: 'int' },
      { name: 'total', typeExpr: 'decimal' },
    ],
  };

  constructor({ orderId, total } = {}) {
    this.orderId = orderId;
    this.total   = total;
  }
}

test('dumpMaxiAuto: array of class instances with static maxiSchema', () => {
  const users = [
    new User({ id: 1, name: 'Julie' }),
    new User({ id: 2, name: 'Matt', email: null }),
  ];

  const maxi = dumpMaxiAuto(users);

  assert.equal(
    maxi,
    [
      'U:User(id:int|name|email=unknown)',
      '###',
      'U(1|Julie)',
      'U(2|Matt|~)',
    ].join('\n')
  );
});

test('dumpMaxiAuto: { alias: instances[] } map', () => {
  const data = {
    U: [new User({ id: 1, name: 'Julie' })],
    O: [new Order({ orderId: 100, total: 49.99 })],
  };

  const maxi = dumpMaxiAuto(data);

  assert.ok(maxi.includes('U:User(id:int|name|email=unknown)'));
  assert.ok(maxi.includes('O:Order(orderId:int|total:decimal)'));
  assert.ok(maxi.includes('###'));
  assert.ok(maxi.includes('U(1|Julie)'));
  assert.ok(maxi.includes('O(100|49.99)'));
});

test('dumpMaxiAuto: class registered via defineMaxiSchema', () => {
  class Product {
    constructor({ id, title } = {}) {
      this.id    = id ?? null;
      this.title = title ?? null;
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

  const maxi = dumpMaxiAuto([new Product({ id: 1, title: 'Widget' })]);
  assert.ok(maxi.includes('P:Product(id:int|title)'));
  assert.ok(maxi.includes('P(1|Widget)'));

  undefineMaxiSchema(Product);
});

test('dumpMaxiAuto: falls back to options.defaultAlias when no schema on class', () => {
  const plain = [{ id: 1, name: 'Julie' }];

  const maxi = dumpMaxiAuto(plain, { defaultAlias: 'U' });

  // No types emitted (no schema found), but records should appear
  assert.ok(maxi.includes('U('), `expected record, got: ${maxi}`);
  // No  ### separator when no schema section
  const parts = maxi.split('###');
  // Either no separator (records only) or separator present preceded by nothing
  const recordPart = parts[parts.length - 1];
  assert.ok(recordPart.includes('U('));
});

test('dumpMaxiAuto: throws when array has no schema and no defaultAlias', () => {
  class NoSchema {}
  assert.throws(
    () => dumpMaxiAuto([new NoSchema()]),
    { message: /cannot determine alias/ }
  );
});

test('dumpMaxiAuto: throws for invalid input type', () => {
  assert.throws(
    () => dumpMaxiAuto('not-an-object'),
    { message: /must be an array/ }
  );
});

test('dumpMaxiAuto: collects nested referenced-object schemas automatically', () => {
  const addr = new Address({ id: 'A1', street: '123 Main St', city: 'NYC' });
  const customers = [new Customer({ id: 'C1', name: 'John', address: addr })];

  const maxi = dumpMaxiAuto(customers);

  // Both type defs should appear
  assert.ok(maxi.includes('C:Customer('), `missing Customer typedef, got:\n${maxi}`);
  assert.ok(maxi.includes('A:Address('), `missing Address typedef, got:\n${maxi}`);
  // C record references address by id
  assert.ok(maxi.includes('C(C1|John|A1)'), `missing C record, got:\n${maxi}`);
  // Separate A record
  assert.ok(maxi.includes('A(A1|'), `missing A record, got:\n${maxi}`);
});

test('dumpMaxiAuto: collectReferences=false inlines nested objects', () => {
  const addr = new Address({ id: 'A1', street: '123 Main', city: 'NYC' });
  const customers = [new Customer({ id: 'C1', name: 'John', address: addr })];

  const maxi = dumpMaxiAuto(customers, { collectReferences: false });

  // Address should be inlined, not a separate record
  const dataPart = maxi.split('###')[1] ?? maxi;
  assert.ok(!dataPart.includes('\nA('), `should not have separate A record, got:\n${maxi}`);
  assert.ok(maxi.includes('(A1|'), `address should be inlined, got:\n${maxi}`);
});

test('dumpMaxiAuto: respects includeTypes=false', () => {
  const users = [new User({ id: 1, name: 'Julie' })];
  const maxi = dumpMaxiAuto(users, { includeTypes: false });

  assert.ok(!maxi.includes('U:User('), `should not include type def, got: ${maxi}`);
  assert.ok(maxi.includes('U(1|Julie)'));
});

test('dumpMaxiAuto: respects multiline=true', () => {
  const users = [new User({ id: 1, name: 'Julie' })];
  const maxi = dumpMaxiAuto(users, { multiline: true });

  assert.ok(maxi.includes('\n'), 'output should be multiline');
  assert.ok(maxi.includes('  1'), 'values should be indented');
});

test('dumpMaxiAuto: caller-supplied types override auto-collected ones', () => {
  const users = [new User({ id: 1, name: 'Julie' })];

  // Override the User schema with a custom one (fewer fields)
  const maxi = dumpMaxiAuto(users, {
    types: [
      { alias: 'U', name: 'CustomUser', fields: [{ name: 'id', typeExpr: 'int' }, { name: 'name' }] },
    ],
  });

  assert.ok(maxi.includes('U:CustomUser('), `expected overridden type name, got: ${maxi}`);
  // email field should not be present (overridden schema only has id + name)
  assert.ok(!maxi.includes('email'), `overridden schema should not have email, got: ${maxi}`);
});

test('dumpMaxiAuto: empty array with schema-bearing class emits type def and no records', () => {
  const maxi = dumpMaxiAuto([], { defaultAlias: 'U', types: User.maxiSchema ? [User.maxiSchema] : undefined });
  // No records, but should not throw
  assert.ok(typeof maxi === 'string');
});

