import test from 'node:test';
import assert from 'node:assert/strict';

import { dumpMaxi } from '../src/api/dump.js';

const userTypes = [
  {
    alias: 'U',
    name: 'User',
    fields: [
      { name: 'id', typeExpr: 'int' },
      { name: 'name' },
      { name: 'email', defaultValue: 'unknown' },
    ],
  },
];

test('dumpMaxi: array of objects with defaultAlias and inline types', () => {
  const users = [
    { id: 1, name: 'Julie' }, // email missing -> empty
    { id: 2, name: 'Matt', email: null }, // email null -> ~
  ];

  const maxi = dumpMaxi(users, {
    defaultAlias: 'U',
    types: userTypes,
  });

  assert.equal(
    maxi,
    [
      'U:User(id:int|name|email=unknown)',
      '###',
      'U(1|Julie)',
      'U(2|Matt|~)',
    ].join('\n'),
  );
});

test('dumpMaxi: single object with defaultAlias and external schema', () => {
  const user = { id: 1, name: 'Julie' };

  const maxi = dumpMaxi(user, {
    defaultAlias: 'U',
    schemaFile: 'schemas/users.maxi',
    includeTypes: false, // We expect schema to be external
  });

  assert.equal(
    maxi,
    ['@schema:schemas/users.maxi', '###', 'U(1|Julie)'].join('\n'),
  );
});

test('dumpMaxi: map of { alias: [objects] }', () => {
  const data = {
    U: [
      { id: 1, name: 'Julie' },
      { id: 2, name: 'Matt', email: null },
    ],
  };

  const maxi = dumpMaxi(data, { types: userTypes });

  assert.equal(
    maxi,
    [
      'U:User(id:int|name|email=unknown)',
      '###',
      'U(1|Julie)',
      'U(2|Matt|~)',
    ].join('\n'),
  );
});

test('dumpMaxi: throws if defaultAlias is missing for an array', () => {
  assert.throws(
    () => dumpMaxi([{ id: 1 }]),
    { message: 'dumpMaxi requires `options.defaultAlias` when dumping an array.' },
  );
});

test('dumpMaxi: throws if defaultAlias is missing for a single object', () => {
  assert.throws(
    () => dumpMaxi({ id: 1 }),
    { message: 'dumpMaxi requires `options.defaultAlias` when dumping a single object.' },
  );
});

test('dumpMaxi: round-trip a parse-result-like object', () => {
  const parseResult = {
    schema: {
      version: '1.0.0',
      mode: 'lax',
      imports: [],
      types: new Map([
        ['U', {
          alias: 'U',
          name: 'User',
          parents: [],
          fields: [
            { name: 'id', typeExpr: 'int' },
            { name: 'name' },
          ],
        }],
      ]),
    },
    records: [
      { alias: 'U', values: [1, 'Julie'] },
    ],
  };

  const maxi = dumpMaxi(parseResult);
  assert.equal(
    maxi,
    [
      'U:User(id:int|name)',
      '###',
      'U(1|Julie)',
    ].join('\n'),
  );
});

test('dumpMaxi: with referenced and inline objects', () => {
  // Address is a separate, referenced object with an ID
  const shippingAddress = {
    id: 'A1',
    street: '123 Main St',
    city: 'Anytown',
  };

  // Customer references the address and contains inline orders (which have no ID)
  const customerData = [
    {
      id: 'C1',
      name: 'John Doe',
      shippingAddress: shippingAddress,
      orders: [
        { orderId: 101, total: 49.99 }, // Inline object
        { orderId: 102, total: 150.0 }, // Inline object
      ],
    },
  ];

  const testTypes = [
    {
      alias: 'C',
      name: 'Customer',
      fields: [
        { name: 'id' },
        { name: 'name' },
        { name: 'shippingAddress', typeExpr: 'A' }, // Reference to Address type
        { name: 'orders', typeExpr: 'O[]' }, // Array of inline Orders
      ],
    },
    {
      alias: 'A',
      name: 'Address',
      fields: [{ name: 'id' }, { name: 'street' }, { name: 'city' }],
    },
    {
      alias: 'O',
      name: 'Order',
      fields: [{ name: 'orderId', typeExpr: 'int' }, { name: 'total', typeExpr: 'decimal' }],
    },
  ];

  const maxi = dumpMaxi(customerData, {
    defaultAlias: 'C',
    types: testTypes,
  });

  // The dumper should identify that Address has an ID and create a top-level record for it.
  // The Customer record should then reference the Address by its ID.
  // The Order objects have no ID and are not top-level, so they are inlined.
  const expected = [
    'C:Customer(id|name|shippingAddress:A|orders:O[])',
    'A:Address(id|street|city)',
    'O:Order(orderId:int|total:decimal)',
    '###',
    'C(C1|"John Doe"|A1|[(101|49.99),(102|150)])',
    'A(A1|"123 Main St"|Anytown)',
  ].join('\n');

  // Normalizing output for comparison as record order isn't guaranteed
  const normalize = (str) => str.split('\n').sort().join('\n');

  assert.equal(normalize(maxi), normalize(expected));
});

test('dumpMaxi: booleans dump as 1/0 (§6.1)', () => {
  const data = [
    { id: 1, active: true, deleted: false },
  ];
  const types = [{
    alias: 'U',
    fields: [
      { name: 'id', typeExpr: 'int' },
      { name: 'active', typeExpr: 'bool' },
      { name: 'deleted', typeExpr: 'bool' },
    ],
  }];

  const maxi = dumpMaxi(data, { defaultAlias: 'U', types });
  assert.ok(maxi.includes('U(1|1|0)'), `Expected bool as 1/0, got: ${maxi}`);
});

test('dumpMaxi: round-trip booleans as 1/0 (§6.1)', () => {
  const parseResult = {
    schema: { version: '1.0.0', mode: 'lax', imports: [], types: new Map() },
    records: [{ alias: 'T', values: [true, false] }],
  };
  const maxi = dumpMaxi(parseResult);
  assert.ok(maxi.includes('T(1|0)'));
});

test('dumpMaxi: bytes field as base64 (§6.2)', () => {
  const data = [{ id: 1, avatar: Buffer.from('hello') }];
  const types = [{
    alias: 'F',
    fields: [
      { name: 'id', typeExpr: 'int' },
      { name: 'avatar', typeExpr: 'bytes' },
    ],
  }];

  const maxi = dumpMaxi(data, { defaultAlias: 'F', types });
  assert.ok(maxi.includes(Buffer.from('hello').toString('base64')));
});

test('dumpMaxi: bytes field with @hex annotation (§6.2)', () => {
  const data = [{ id: 1, hash: Buffer.from([0xde, 0xad, 0xbe, 0xef]) }];
  const types = [{
    alias: 'F',
    fields: [
      { name: 'id', typeExpr: 'int' },
      { name: 'hash', typeExpr: 'bytes', annotation: 'hex' },
    ],
  }];

  const maxi = dumpMaxi(data, { defaultAlias: 'F', types });
  assert.ok(maxi.includes('deadbeef'));
});

test('dumpMaxi: Uint8Array bytes field (§6.2)', () => {
  const data = [{ id: 1, payload: new Uint8Array([1, 2, 3]) }];
  const types = [{
    alias: 'F',
    fields: [
      { name: 'id', typeExpr: 'int' },
      { name: 'payload', typeExpr: 'bytes' },
    ],
  }];

  const maxi = dumpMaxi(data, { defaultAlias: 'F', types });
  assert.ok(maxi.includes(Buffer.from([1, 2, 3]).toString('base64')));
});

test('dumpMaxi: inline objects when collectReferences=false (§6.3)', () => {
  const addr = { id: 'A1', street: '123 Main', city: 'NYC' };
  const data = [{ id: 1, address: addr }];

  const types = [
    {
      alias: 'U',
      fields: [
        { name: 'id', typeExpr: 'int' },
        { name: 'address', typeExpr: 'A' },
      ],
    },
    {
      alias: 'A',
      fields: [
        { name: 'id' },
        { name: 'street' },
        { name: 'city' },
      ],
    },
  ];

  const maxi = dumpMaxi(data, { defaultAlias: 'U', types, collectReferences: false });
  // Should emit inline (A1|123 Main|NYC) instead of just the reference A1
  assert.ok(maxi.includes('(A1|"123 Main"|NYC)'), `Expected inline object, got: ${maxi}`);
  // Should NOT have a separate A(...) data record after ###
  const dataPart = maxi.split('###')[1] || '';
  assert.ok(!dataPart.includes('A('), `Should not have separate A record in data, got: ${maxi}`);
});

test('dumpMaxi: inherited types resolve parent fields (§6.4)', () => {
  const data = {
    E: [{ id: 1, name: 'Alice', department: 'Eng' }],
  };

  const types = [
    {
      alias: 'P',
      name: 'Person',
      fields: [
        { name: 'id', typeExpr: 'int' },
        { name: 'name' },
      ],
    },
    {
      alias: 'E',
      name: 'Employee',
      parents: ['P'],
      fields: [
        { name: 'department' },
      ],
    },
  ];

  const maxi = dumpMaxi(data, { types });
  // Employee should have all 3 fields: id, name (from Person), department (own)
  assert.ok(maxi.includes('E(1|Alice|Eng)'), `Expected resolved fields, got: ${maxi}`);
});

test('dumpMaxi: element constraints separate from array constraints (§6.6)', () => {
  const types = [{
    alias: 'T',
    fields: [
      {
        name: 'tags',
        typeExpr: 'str[]',
        elementConstraints: [
          { type: 'comparison', operator: '>=', value: 3 },
          { type: 'comparison', operator: '<=', value: 20 },
        ],
        constraints: [
          { type: 'comparison', operator: '>=', value: 1 },
          { type: 'comparison', operator: '<=', value: 10 },
        ],
      },
    ],
  }];

  const maxi = dumpMaxi([], { defaultAlias: 'T', types, includeTypes: true });
  // Should produce: tags:str(>=3,<=20)[](>=1,<=10)
  assert.ok(maxi.includes('tags:str(>=3,<=20)[](>=1,<=10)'), `Expected separated constraints, got: ${maxi}`);
});

