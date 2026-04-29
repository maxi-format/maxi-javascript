import test from 'node:test';
import assert from 'node:assert/strict';

import { defineMaxiSchema, getMaxiSchema, undefineMaxiSchema } from '../src/core/schema-registry.js';

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
  constructor({ id, total } = {}) {
    this.id    = id;
    this.total = total;
  }
}

const orderSchema = {
  alias: 'O',
  name: 'Order',
  fields: [
    { name: 'id', typeExpr: 'int' },
    { name: 'total', typeExpr: 'decimal' },
  ],
};

test('getMaxiSchema: reads static maxiSchema from class', () => {
  const schema = getMaxiSchema(User);
  assert.ok(schema, 'schema should be found');
  assert.equal(schema.alias, 'U');
  assert.equal(schema.name, 'User');
  assert.equal(schema.fields.length, 3);
});

test('getMaxiSchema: reads static maxiSchema from instance', () => {
  const user = new User({ id: 1, name: 'Julie' });
  const schema = getMaxiSchema(user);
  assert.ok(schema, 'schema should be found from instance');
  assert.equal(schema.alias, 'U');
});

test('defineMaxiSchema: registers schema for a class', () => {
  defineMaxiSchema(Order, orderSchema);
  const schema = getMaxiSchema(Order);
  assert.ok(schema, 'schema should be found after registration');
  assert.equal(schema.alias, 'O');
  assert.equal(schema.fields.length, 2);
});

test('getMaxiSchema: reads WeakMap schema from instance', () => {
  defineMaxiSchema(Order, orderSchema);
  const order = new Order({ id: 100, total: 49.99 });
  const schema = getMaxiSchema(order);
  assert.ok(schema);
  assert.equal(schema.alias, 'O');
});

test('defineMaxiSchema: static property takes priority over WeakMap', () => {
  // Register a conflicting schema in the WeakMap for User
  defineMaxiSchema(User, { alias: 'WRONG', fields: [] });
  const schema = getMaxiSchema(User);
  // Static property should win
  assert.equal(schema.alias, 'U', 'static maxiSchema should take priority over WeakMap');
  // Clean up
  undefineMaxiSchema(User);
});

test('undefineMaxiSchema: removes registered schema', () => {
  class Temp {}
  defineMaxiSchema(Temp, { alias: 'T', fields: [] });
  assert.ok(getMaxiSchema(Temp), 'should exist before removal');
  undefineMaxiSchema(Temp);
  assert.equal(getMaxiSchema(Temp), null, 'should be null after removal');
});

test('getMaxiSchema: returns null for unregistered class', () => {
  class Unregistered {}
  assert.equal(getMaxiSchema(Unregistered), null);
});

test('getMaxiSchema: returns null for plain object with no known constructor', () => {
  assert.equal(getMaxiSchema({}), null);
});

test('getMaxiSchema: returns null for null input', () => {
  assert.equal(getMaxiSchema(null), null);
});

test('getMaxiSchema: returns null for undefined input', () => {
  assert.equal(getMaxiSchema(undefined), null);
});

test('defineMaxiSchema: throws if first arg is not a function', () => {
  assert.throws(
    () => defineMaxiSchema({}, { alias: 'X', fields: [] }),
    { message: /first argument must be a class/ }
  );
});

test('defineMaxiSchema: throws if schema is missing alias', () => {
  assert.throws(
    () => defineMaxiSchema(class Foo {}, { fields: [] }),
    { message: /schema\.alias is required/ }
  );
});

test('defineMaxiSchema: throws if schema is not an object', () => {
  assert.throws(
    () => defineMaxiSchema(class Foo {}, null),
    { message: /second argument must be a schema descriptor/ }
  );
});

test('defineMaxiSchema: allows overwriting a previously registered schema', () => {
  class Product {}
  defineMaxiSchema(Product, { alias: 'P1', fields: [{ name: 'id' }] });
  defineMaxiSchema(Product, { alias: 'P2', fields: [{ name: 'id' }, { name: 'name' }] });
  const schema = getMaxiSchema(Product);
  assert.equal(schema.alias, 'P2');
  assert.equal(schema.fields.length, 2);
});
