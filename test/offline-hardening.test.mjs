// Synthetic, dependency-free regression tests. Never loads the runtime, wallet or SDK.
// Node 24: source functions are transformed with imports replaced by explicit fakes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const root = process.env.HARDENING_SOURCE_ROOT || path.resolve(import.meta.dirname, '..');
async function load(file, prefix = '', extract) {
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  if (extract) source = extract(source);
  const js = stripTypeScriptTypes(source, { mode: 'transform' })
    .replace(/^import[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '');
  return import('data:text/javascript;base64,' + Buffer.from(prefix + '\n' + js).toString('base64'));
}
const { InferenceRouter } = await load('src/inference/router.ts', `
const DEFAULT_ROUTING_MATRIX={normal:{agent_turn:{candidates:['fixture'],maxTokens:4096}}};
const TASK_TIMEOUTS={agent_turn:100};`);
const request = { messages: [{ role: 'user', content: 'synthetic' }], tier: 'normal', taskType: 'agent_turn' };
function routerFixture(limit = 10) {
  const state = { estimates: [], calls: 0, sent: undefined, costs: [] };
  const router = new InferenceRouter({}, {
    get: () => ({ modelId: 'fixture', provider: 'other', enabled: true, costPer1kInput: 0, costPer1kOutput: 600, maxTokens: 8192 }),
  }, {
    config: { sessionBudgetCents: 0 },
    checkBudget: cost => { state.estimates.push(cost); return { allowed: cost <= limit }; },
    recordCost: cost => state.costs.push(cost),
  });
  const transport = async (_, options) => {
    state.calls++; state.sent = options.maxTokens;
    return { usage: { completionTokens: options.maxTokens }, message: { content: 'fixture' } };
  };
  return { router, state, transport };
}
test('implicit 4096-token ceiling is budgeted before dispatch', async () => {
  const { router, state, transport } = routerFixture();
  const result = await router.route(request, transport);
  assert.equal(result.finishReason, 'budget_exceeded');
  assert.deepEqual(state.estimates, [25]);
  assert.equal(state.calls, 0);
});
test('explicit ceiling is used for both estimate and dispatch', async () => {
  const { router, state, transport } = routerFixture();
  await router.route({ ...request, maxTokens: 1000 }, transport);
  assert.equal(state.sent, 1000); assert.deepEqual(state.estimates, [6]);
  assert.equal(state.costs[0].costCents, 6);
});
test('implicit ceiling dispatches unchanged when budget permits', async () => {
  const { router, state, transport } = routerFixture(30);
  await router.route(request, transport);
  assert.equal(state.sent, 4096); assert.deepEqual(state.estimates, [25]);
});
for (const ceiling of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects invalid token ceiling ${ceiling} before budget or transport`, async () => {
    const { router, state, transport } = routerFixture();
    await assert.rejects(router.route({ ...request, maxTokens: ceiling }, transport), /Invalid output token ceiling/);
    assert.equal(state.calls, 0); assert.equal(state.estimates.length, 0);
  });
}
const { executeTool } = await load('src/agent/tools.ts', `
const ulid=()=> 'fixture'; const EXTERNAL_SOURCE_TOOLS=new Set(); const logger={error:()=>{}};`, source => {
  const start = source.indexOf('export async function executeTool(');
  const end = source.indexOf('/** Escape a string for safe shell interpolation. */');
  assert.ok(start >= 0 && end > start, 'review extraction boundaries after source changes');
  return source.slice(start, end);
});
const turn = { inputSource: 'agent', turnToolCallCount: 0, sessionSpend: { recordSpend() {} } };
const allow = { evaluate: () => ({ action: 'allow' }), logDecision() {} };
for (const [label, engine, context] of [
  ['both missing', undefined, undefined], ['engine missing', undefined, turn], ['turn missing', allow, undefined],
]) {
  test(`policy context fails closed: ${label}`, async () => {
    let calls = 0;
    const result = await executeTool('fixture', {}, [{ name: 'fixture', execute: async () => { calls++; return 'ok'; } }], {}, engine, context);
    assert.equal(result.error, 'POLICY_CONTEXT_REQUIRED'); assert.equal(calls, 0);
  });
}
test('denied policy never reaches transport', async () => {
  let calls = 0;
  const result = await executeTool('fixture', {}, [{ name: 'fixture', execute: async () => { calls++; return 'ok'; } }], {}, {
    ...allow, evaluate: () => ({ action: 'deny', reasonCode: 'FIXTURE', humanMessage: 'denied' }),
  }, turn);
  assert.match(result.error, /Policy denied/); assert.equal(calls, 0);
});
test('allow decision executes exactly once', async () => {
  let calls = 0;
  const result = await executeTool('fixture', {}, [{ name: 'fixture', execute: async () => { calls++; return 'ok'; } }], {}, allow, turn);
  assert.equal(result.result, 'ok'); assert.equal(calls, 1);
});
test('policy exception propagates before effect', async () => {
  let calls = 0;
  await assert.rejects(executeTool('fixture', {}, [{ name: 'fixture', execute: async () => { calls++; return 'ok'; } }], {}, {
    ...allow, evaluate: () => { throw new Error('fixture policy unavailable'); },
  }, turn), /policy unavailable/);
  assert.equal(calls, 0);
});
const { editFile } = await load('src/self-mod/code.ts', `import fs from 'node:fs'; import path from 'node:path'; const logModification=()=>{};`);
for (const target of ['constitution.md', 'agent/tools.ts', '.ssh/config']) {
  test(`canonical alias cannot modify ${target}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-hardening-'));
    const previous = process.cwd();
    try {
      process.chdir(dir);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture');
      fs.symlinkSync(target, 'alias.txt'); let writes = 0, reads = 0;
      const result = await editFile({ readFile: async () => { reads++; return 'fixture'; }, writeFile: async () => writes++ },
        { getRecentModifications: () => [] }, 'alias.txt', 'changed', 'fixture');
      assert.equal(result.success, false); assert.equal(writes, 0); assert.equal(reads, 0);
      assert.equal(fs.readFileSync(target, 'utf8'), 'fixture');
    } finally { process.chdir(previous); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
test('ordinary file remains editable with a fake transport', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-hardening-'));
  const previous = process.cwd();
  try {
    process.chdir(dir); fs.writeFileSync('notes.txt', 'fixture'); let writes = 0;
    const result = await editFile({ readFile: async () => 'fixture', writeFile: async () => writes++, exec: async () => ({ exitCode: 0 }) },
      { getRecentModifications: () => [] }, 'notes.txt', 'changed', 'fixture');
    assert.equal(result.success, true); assert.equal(writes, 1);
    assert.equal(fs.readFileSync('notes.txt', 'utf8'), 'fixture');
  } finally { process.chdir(previous); fs.rmSync(dir, { recursive: true, force: true }); }
});
