/**
 * 插件加载：这是"能不能装"的关键用例。
 * 直接 import apply，喂一个假 ctx（记录 ctx.tools.register 的每次调用），
 * 断言 4 个工具都被注册、schema 有 name/description/parameters，且 execute 真能读库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import applyDefault, { DEFAULTS, apply, inject, name, normalizeConfig, toolSpecs } from '../index.mjs';
import * as core from '../lib/core.mjs';
import { tmpHome } from '../support/helpers.mjs';

const TOOL_NAMES = ['mem_ingest', 'mem_open', 'mem_search', 'mem_stats'];

function fakeCtx() {
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  return { ctx, registered };
}

test('插件元信息：name / inject / 默认导出都是 apply', () => {
  assert.equal(name, 'dsh-mem');
  assert.deepEqual(inject, ['tools']);
  assert.equal(typeof apply, 'function');
  assert.equal(applyDefault, apply, '默认导出必须是 apply（`import apply from "dsh-mem"` 直接用）');
  assert.deepEqual(DEFAULTS, { storeDir: '', excludePaths: [], redact: [], autoIngest: false });
  assert.equal(normalizeConfig({}).storeDir, path.join(core.homeDir(), 'mem'), 'storeDir 缺省 = $DSH_HOME/mem');
  assert.equal(normalizeConfig({ storeDir: 'D:\\x' }).storeDir, path.resolve('D:\\x'));
});

test('apply 注册 4 个工具，schema 形状符合宿主契约', async () => {
  const home = tmpHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, registered } = fakeCtx();
    const dispose = await apply(ctx, { storeDir: path.join(home, 'mem') });
    assert.equal(registered.length, 4, '必须注册 4 个工具');
    assert.deepEqual(registered.map((t) => t.name).sort(), TOOL_NAMES);

    for (const t of registered) {
      assert.equal(typeof t.description, 'string', `${t.name}.description 必须是字符串`);
      assert.ok(t.description.length > 20, `${t.name}.description 不能是占位符`);
      assert.equal(typeof t.execute, 'function', `${t.name}.execute 必须存在`);
      assert.equal(t.parameters?.type, 'object', `${t.name}.parameters 必须是 object 根`);
      assert.equal(typeof t.parameters?.properties, 'object');
      assert.ok(t.output && typeof t.output.render === 'function', `${t.name}.output.render 必须存在（register 硬要求）`);
    }

    const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName.mem_search.parameters.properties), ['query', 'k']);
    assert.deepEqual(Object.keys(byName.mem_open.parameters.properties), ['pointer', 'context']);
    assert.deepEqual(byName.mem_search.parameters.required, ['query']);
    assert.deepEqual(byName.mem_open.parameters.required, ['pointer']);
    assert.equal(byName.mem_search.parameters.properties.query.type, 'string');
    assert.equal(byName.mem_open.parameters.properties.context.type, 'integer');
    assert.deepEqual(byName.mem_stats.parameters.properties, {});

    assert.equal(typeof dispose, 'function');
    dispose();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});

test('注册后的 execute 真能读库：search → open → stats', async () => {
  const home = tmpHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const storeDir = path.join(home, 'mem');
    const { ctx, registered } = fakeCtx();
    await apply(ctx, { storeDir });
    const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

    const dbp = core.dbPathOf(home, process.cwd(), storeDir);
    const db = core.openDb(dbp, { mustExist: false });
    core.insertRows(db, [
      { session: 'sess-x', seq: 1, role: 'user', ts: 10, text: '我们决定把库固定为 mem 目录，实测四层体检可以命中', kind: 'user' },
      { session: 'sess-x', seq: 2, role: 'asst', ts: 11, text: '跑通了，退出码 0', kind: 'model' },
    ]);
    db.close();

    const s = await byName.mem_search.execute({ query: 'Router Worker', k: 3 });
    assert.equal(s.hits, 0, '0 命中必须返回空数组而不是抛错');

    const s2 = await byName.mem_search.execute({ query: '四层体检', k: 3 });
    assert.equal(s2.hits, 1);
    assert.equal(s2.results[0].pointer, 'sess-x#seq=1');
    assert.match(s2.results[0].snippet, /四层体检/);

    const o = await byName.mem_open.execute({ pointer: 'sess-x#seq=1', context: 0 });
    assert.match(o.rows[0].text, /决定把库固定为 mem/);

    const st = await byName.mem_stats.execute({});
    assert.equal(st.turns, 2);

    const bad = await byName.mem_open.execute({ pointer: 'nope#999', context: 0 });
    assert.equal(bad.exitCode, 2, '坏指针以结构化 error 返回，不炸宿主');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});

test('配置透传：excludePaths / redact / autoIngest 进到工具里', async () => {
  const home = tmpHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, registered } = fakeCtx();
    await apply(ctx, {
      storeDir: path.join(home, 'mem'),
      excludePaths: ['*scratch*'],
      redact: ['sk-[A-Za-z0-9]{20,}'],
      autoIngest: false,
    });
    assert.equal(registered.length, 4);

    const badCfg = fakeCtx();
    await apply(badCfg.ctx, { storeDir: path.join(home, 'mem'), redact: ['('] });
    assert.equal(badCfg.registered.length, 4, '坏正则只告警，不阻断注册');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});

test('宿主真实 defineTool 能编译这 4 份 spec（有安装时；无则跳过）', async (t) => {
  const candidates = [
    process.env.DSH_TOOLS_PATH,
    process.resourcesPath && path.join(process.resourcesPath, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    path.join('D:', 'DSH', 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  ].filter(Boolean);
  const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!found) { t.skip('本机没有安装 @deepseek-ai/dsh-tools'); return; }

  const mod = await import(pathToFileURL(found).href);
  const realDefineTool = mod.defineTool ?? mod.default?.defineTool;
  assert.equal(typeof realDefineTool, 'function');

  const cfg = normalizeConfig({ storeDir: path.join(tmpHome(), 'mem') });
  const specs = toolSpecs(cfg, {});
  assert.equal(specs.length, 4);
  for (const spec of specs) {
    const compiled = realDefineTool(spec);            // schema 不合宿主词汇表会在这里抛
    assert.equal(compiled.name, spec.name);
    assert.equal(compiled.parameters.type, 'object');
    assert.deepEqual(compiled.parameters.required, spec.name === 'mem_search' ? ['query']
      : spec.name === 'mem_open' ? ['pointer'] : undefined);
  }
});
