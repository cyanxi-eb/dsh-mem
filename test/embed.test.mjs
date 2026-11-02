/**
 * lib/embed.mjs 的测试：契约、懒加载、失败路径、下载校验、质量下限。
 *
 * 约定：没有模型 / 没装依赖的机器上，与模型相关的用例走 t.skip()，其余照常（CI 友好）。
 * 下载用例一律指向本机 http 服务器或不可达端口，绝不真的去 huggingface 拉 90MB。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LIB = new URL('../lib/embed.mjs', import.meta.url);
const MODELS = new URL('../lib/embed-models.mjs', import.meta.url);
const embed = await import(LIB.href);
const models = await import(MODELS.href);

const HAVE_DEP = await embed.isAvailable();
const HAVE_MODEL = models.modelState({}).ok;
const READY = HAVE_DEP && HAVE_MODEL;   // 模型类用例的前提：依赖装了 + 模型落盘了
const cfg = { embeddingEnabled: true };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-embed-${p}-`));
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

test('导出面就是这 4 个函数', () => {
  for (const fn of ['isAvailable', 'ensureModel', 'embedBatch', 'embedFingerprint']) {
    assert.equal(typeof embed[fn], 'function', `缺导出 ${fn}`);
  }
});

test('embedFingerprint：稳定、含 model/dim/norm，跨进程一致', () => {
  const fp = embed.embedFingerprint({});
  assert.match(fp, /^bge-small-zh-v1\.5\|dim=512\|pool=cls\|norm=l2\|w=/);
  assert.equal(embed.embedFingerprint({}), fp, '同进程两次必须一致');
  const child = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import('${LIB.href}').then(m => process.stdout.write(m.embedFingerprint({})))`], { encoding: 'utf8' }).trim();
  assert.equal(child, fp, '跨进程必须一致（否则 sidecar 每次启动都判错配）');
});

test('embedFingerprint：换目录/缺权重时摘要不同（能抓到错配）', () => {
  const empty = tmp('fp');
  const bare = embed.embedFingerprint({ embeddingModelDir: empty });
  assert.match(bare, /w=none$/);
  if (HAVE_MODEL) assert.notEqual(bare, embed.embedFingerprint({}), '有模型与无模型的指纹必须不同');
});

test('embedFingerprint：未知模型名大声报错', () => {
  assert.throws(() => embed.embedFingerprint({ embeddingModel: 'gpt-embed-9000' }), (e) => e.code === 'ERR_MODEL_UNKNOWN');
});

test('isAvailable 与本机依赖的真实状态一致', async () => {
  assert.equal(typeof HAVE_DEP, 'boolean');
  const direct = await import('@huggingface/transformers').then(() => true, () => false);
  assert.equal(HAVE_DEP, direct, 'isAvailable() 必须如实反映依赖装没装');
});

test('embeddingEnabled=false → 直接拒绝，不碰依赖/模型', async () => {
  await assert.rejects(() => embed.embedBatch(['你好'], { embeddingEnabled: false }), (e) => e.code === 'ERR_DISABLED');
});

test('空输入返回空数组，且不加载模型', async () => {
  const before = embed.embedBatch.stats().loads;
  assert.deepEqual(await embed.embedBatch([], cfg), []);
  assert.equal(embed.embedBatch.stats().loads, before);
});

test('非字符串输入 → ERR_INPUT', async () => {
  await assert.rejects(() => embed.embedBatch([42], cfg), (e) => e.code === 'ERR_INPUT');
});

test('模型缺失：默认大声抛 ERR_NO_MODEL，embeddingFailFast=false 时返回 [] 并 warn 一次', async (t) => {
  if (!HAVE_DEP) return t.skip('本机没装可选依赖，走不到模型分支');
  const empty = tmp('nomodel');
  const bad = { embeddingEnabled: true, embeddingModelDir: empty };
  await assert.rejects(() => embed.embedBatch(['你好'], bad), (e) => e.code === 'ERR_NO_MODEL');

  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    assert.deepEqual(await embed.embedBatch(['你好'], { ...bad, embeddingFailFast: false }), []);
    await embed.embedBatch(['你好'], { ...bad, embeddingFailFast: false });
  } finally { console.warn = orig; }
  assert.equal(warns.length, 1, '只 warn 一次，别刷屏');
  assert.match(warns[0], /embeddingFailFast=false/);
});

test('ensureModel：全部源不可达 → ERR_DOWNLOAD（不是静默成功）', async (t) => {
  if (!HAVE_DEP) return t.skip('本机没装可选依赖，走不到下载分支');
  const empty = tmp('offline');
  const old = process.env.DSH_MEM_HF_HOSTS;
  process.env.DSH_MEM_HF_HOSTS = 'http://127.0.0.1:9';
  try {
    await assert.rejects(() => embed.ensureModel({ embeddingModelDir: empty }), (e) => {
      assert.equal(e.code, 'ERR_DOWNLOAD');
      assert.match(e.message, /所有源都不可用/);
      return true;
    });
  } finally {
    if (old === undefined) delete process.env.DSH_MEM_HF_HOSTS; else process.env.DSH_MEM_HF_HOSTS = old;
  }
});

test('ensureModel：下载到错误页（HTML）→ ERR_VERIFY，且不留下半个模型', async (t) => {
  if (!HAVE_DEP) return t.skip('本机没装可选依赖，走不到下载分支');
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html>404 not found</html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const empty = tmp('badbody');
  const old = process.env.DSH_MEM_HF_HOSTS;
  process.env.DSH_MEM_HF_HOSTS = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(() => embed.ensureModel({ embeddingModelDir: empty }), (e) => e.code === 'ERR_VERIFY');
    assert.equal(models.modelState({ embeddingModelDir: empty }).ok, false, '校验失败不能留下能用的清单');
  } finally {
    if (old === undefined) delete process.env.DSH_MEM_HF_HOSTS; else process.env.DSH_MEM_HF_HOSTS = old;
    await new Promise((r) => srv.close(r));
  }
});

test('ensureModel：模型已就位 → 立刻返回同一目录，不发起下载', async (t) => {
  if (!READY) return t.skip(HAVE_DEP ? '本机没有模型' : '本机没装可选依赖');
  const progress = [];
  const t0 = performance.now();
  const dir = await embed.ensureModel({}, (p) => progress.push(p));
  assert.equal(dir, models.modelDirOf({}));
  assert.equal(progress.length, 0, '已就位不该有下载事件');
  assert.ok(performance.now() - t0 < 500, `已就位应秒回，实测 ${(performance.now() - t0).toFixed(0)}ms`);
});

test('embedBatch：512 维、L2 归一化、批量顺序不被长度排序打乱', async (t) => {
  if (!READY) return t.skip(HAVE_DEP ? '本机没有模型' : '本机没装可选依赖');
  const texts = ['短', '这是一条明显更长一些的句子，用来验证按长度分批之后返回顺序依然对得上。', '中等的句子'];
  const many = await embed.embedBatch(texts, cfg);
  assert.equal(many.length, 3);
  for (const v of many) {
    assert.ok(v instanceof Float32Array, '必须是 Float32Array');
    assert.equal(v.length, 512);
    assert.ok(Math.abs(cos(v, v) - 1) < 1e-5, 'L2 范数必须是 1');
  }
  const single = await embed.embedBatch([texts[2]], cfg);
  assert.ok(cos(single[0], many[2]) > 0.9999, '批量结果必须和单条一致（顺序不能错）');
  assert.ok(cos(single[0], many[0]) < 0.99, '不同文本的向量不该雷同');
});

test('embedBatch：懒加载——第二次调用不再建 pipeline', async (t) => {
  if (!READY) return t.skip(HAVE_DEP ? '本机没有模型' : '本机没装可选依赖');
  const before = embed.embedBatch.stats().loads;
  await embed.embedBatch(['第一次'], cfg);
  const mid = embed.embedBatch.stats().loads;
  await embed.embedBatch(['第二次'], cfg);
  assert.ok(mid - before <= 1, `首次最多建 1 个 pipeline（实际 ${mid - before}）`);
  assert.equal(embed.embedBatch.stats().loads, mid, '第二次调用不许重新加载模型');
});

test('embedBatch：语义质量下限（改写能对上，闲聊对不上）', async (t) => {
  if (!READY) return t.skip(HAVE_DEP ? '本机没有模型' : '本机没装可选依赖');
  const [q, near, far] = await embed.embedBatch([
    '怎么把记忆搬到别的机器',
    '导出成 NDJSON 再在另一台电脑上导入',
    '今天中午吃什么比较好',
  ], cfg);
  assert.ok(cos(q, near) > cos(q, far) + 0.05,
    `语义近邻必须明显更近：near=${cos(q, near).toFixed(3)} far=${cos(q, far).toFixed(3)}`);
});

test('缺依赖的机器：isAvailable()=false、embedBatch 抛 ERR_NO_DEP、failFast:false 时返回 []', async () => {
  // 把两个模块复制到没有 node_modules 的临时目录，那里解析不到 @huggingface/transformers
  const dir = tmp('nodep');
  fs.mkdirSync(path.join(dir, 'lib'));
  for (const f of ['embed.mjs', 'embed-models.mjs']) {
    fs.copyFileSync(new URL(`../lib/${f}`, import.meta.url), path.join(dir, 'lib', f));
  }
  // core.mjs 只为 homeDir 而来：给一个等价桩，避免把被测文件跟别人正在改的 core 绑在一起
  fs.writeFileSync(path.join(dir, 'lib', 'core.mjs'),
    `import path from 'node:path'; import os from 'node:os';\n` +
    `export const homeDir = (o = {}) => path.resolve(o.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));\n`);

  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(dir, 'lib', 'embed.mjs')).href)});
    const out = { available: await m.isAvailable() };
    try { await m.embedBatch(['x'], { embeddingEnabled: true }); out.hard = 'no-throw'; }
    catch (e) { out.hard = e.code + ':' + String(e.message).split('\\n')[0]; }
    const w = []; const ow = console.warn; console.warn = (...a) => w.push(a.join(' '));
    const soft = await m.embedBatch(['x'], { embeddingEnabled: true, embeddingFailFast: false });
    console.warn = ow;
    out.softLen = soft.length; out.warns = w.length;
    process.stdout.write(JSON.stringify(out));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  assert.equal(out.available, false, '没有依赖时必须 false');
  assert.match(out.hard, /^ERR_NO_DEP:/);
  assert.equal(out.softLen, 0);
  assert.equal(out.warns, 1);
});

test('其余功能不被 embedding 影响：core 的 search 仍可用', async (t) => {
  if (!READY) return t.skip(HAVE_DEP ? '本机没有模型' : '本机没装可选依赖');
  // 只证明 core 能在有 embed 模块的进程里照常被 import（不改 core 的任何行为）
  const core = await import(new URL('../lib/core.mjs', import.meta.url).href);
  assert.equal(typeof core.search, 'function');
  assert.equal(typeof core.insertRows, 'function');
});
