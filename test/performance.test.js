import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { parseMaxi } from '../src/api/parse.js';
import { dumpMaxi } from '../src/api/dump.js';

// Use env override for local load tests; keep CI reasonable.
const DATA_SIZE = Number(process.env.MAXI_BENCH_SIZE ?? 100000);

// NEW: dumping benchmark size (keep smaller by default; dumping builds an array of objects)
const DUMP_SIZE = Number(process.env.MAXI_DUMP_BENCH_SIZE ?? 100000);

// --- Data Generation ---
// NOTE: For very large sizes (e.g. 1_000_000), building an array of objects dominates memory/time.
// Provide streaming string builders for fairer parser-only benchmarks.

function buildMaxiString(count) {
  let s =
    'U:User(id:int|name|email:str@email|role:enum[admin,user]|createdAt:str@datetime|logins:int|active:bool)\n###\n';
  for (let i = 1; i <= count; i++) {
    const name = `User ${i}`;
    const email = `user${i}@example.com`;
    const role = i % 5 === 0 ? 'admin' : 'user';
    const createdAt = `2023-10-27T10:00:${String(i % 60).padStart(2, '0')}.000Z`;
    const logins = i % 10;
    const active = i % 2 === 0 ? 'true' : 'false';
    s += `U(${i}|${name}|${email}|${role}|${createdAt}|${logins}|${active})\n`;
  }
  return s;
}

function buildJsonString(count) {
  let s = '[';
  for (let i = 1; i <= count; i++) {
    const obj =
      `{"id":${i},` +
      `"name":"User ${i}",` +
      `"email":"user${i}@example.com",` +
      `"role":"${i % 5 === 0 ? 'admin' : 'user'}",` +
      `"createdAt":"2023-10-27T10:00:${String(i % 60).padStart(2, '0')}.000Z",` +
      `"logins":${i % 10},` +
      `"active":${i % 2 === 0 ? 'true' : 'false'}` +
      `}`;
    s += (i === 1 ? '' : ',') + obj;
  }
  s += ']';
  return s;
}

// --- Legacy serializers (kept for comparison / correctness) ---
const maxiUserTypes = [{
  alias: 'U',
  name: 'User',
  fields: [
    { name: 'id', typeExpr: 'int' },
    { name: 'name' },
    // FIX: annotation must not be stuffed into typeExpr
    { name: 'email', typeExpr: 'str', annotation: 'email' },
    { name: 'role', typeExpr: 'enum[admin,user]' },
    { name: 'createdAt', typeExpr: 'str', annotation: 'datetime' },
    { name: 'logins', typeExpr: 'int' },
    { name: 'active', typeExpr: 'bool' },
  ],
}];

function serializeToMaxi(data) {
  // Perf benchmark: do not scan/promote referenced objects
  return dumpMaxi(data, { defaultAlias: 'U', types: maxiUserTypes, collectReferences: false });
}

function serializeToJson(data) {
  return JSON.stringify(data);
}

// NEW: generate objects for dump benchmark (only; avoid for parse benchmark)
function generateUsers(count) {
  const out = new Array(count);
  for (let i = 1; i <= count; i++) {
    out[i - 1] = {
      id: i,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      role: i % 5 === 0 ? 'admin' : 'user',
      createdAt: `2023-10-27T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
      logins: i % 10,
      active: i % 2 === 0,
    };
  }
  return out;
}

test('Performance comparison: MAXI vs JSON vs XML parsing', async (t) => {
  console.log(`\n--- Generating ${DATA_SIZE} records for benchmark ---`);

  // Build strings directly to support very large sizes without O(count) object allocations.
  const maxiString = buildMaxiString(DATA_SIZE);
  const jsonString = buildJsonString(DATA_SIZE);

  console.log(`MAXI size: ${Math.round(maxiString.length / 1024)} KB`);
  console.log(`JSON size: ${Math.round(jsonString.length / 1024)} KB`);

  // Warmup (JIT)
  await parseMaxi(maxiString);
  JSON.parse(jsonString);

  await t.test('MAXI parsing', async () => {
    const start = performance.now();
    const parsed = await parseMaxi(maxiString);
    const end = performance.now();
    const ms = end - start;
    console.log(`MAXI parse time: ${ms.toFixed(2)} ms (${Math.round((DATA_SIZE * 1000) / ms)} rec/s)`);
    assert.strictEqual(parsed.records.length, DATA_SIZE);
  });

  await t.test('JSON parsing', () => {
    const start = performance.now();
    const parsed = JSON.parse(jsonString);
    const end = performance.now();
    const ms = end - start;
    console.log(`JSON parse time: ${ms.toFixed(2)} ms (${Math.round((DATA_SIZE * 1000) / ms)} rec/s)`);
    assert.strictEqual(parsed.length, DATA_SIZE);
  });
});

// NEW: dumping benchmark
test('Performance comparison: MAXI vs JSON dumping', (t) => {
  console.log(`\n--- Generating ${DUMP_SIZE} records for dump benchmark ---`);
  const users = generateUsers(DUMP_SIZE);

  // Warmup (JIT)
  serializeToMaxi(users);
  serializeToJson(users);

  // MAXI dump
  {
    const start = performance.now();
    const maxi = serializeToMaxi(users);
    const end = performance.now();
    const ms = end - start;

    console.log(`MAXI dump size: ${Math.round(maxi.length / 1024)} KB`);
    console.log(`MAXI dump time: ${ms.toFixed(2)} ms (${Math.round((DUMP_SIZE * 1000) / ms)} rec/s)`);

    // sanity
    assert.ok(maxi.includes('###'));
    assert.ok(maxi.includes('U('));
  }

  // JSON dump
  {
    const start = performance.now();
    const json = serializeToJson(users);
    const end = performance.now();
    const ms = end - start;

    console.log(`JSON dump size: ${Math.round(json.length / 1024)} KB`);
    console.log(`JSON dump time: ${ms.toFixed(2)} ms (${Math.round((DUMP_SIZE * 1000) / ms)} rec/s)`);

    // sanity
    assert.ok(json.startsWith('['));
    assert.ok(json.includes('"id"'));
  }

  // keep node:test happy (no subtests needed here)
  assert.ok(true);
});
