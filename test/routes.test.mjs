/**
 * 面板路由层：不起真端口，直接调 5 条路由的 handler。
 *
 * 做法：一个 12 行的假 webServer（只记录 register 的 {kind,path,handler}），
 * 一个假 req（async iterable，body 走流）+ 假 res（收 statusCode/headers/body），
 * 于是"路由是否真的注册、handler 是否真的回 JSON、错误是否结构化"全部可在 Node 里断言。
 *
 * 覆盖：
 *   ① GET  /panel/state            200 + 形状 + config 就是核心 9 键
 *   ② PUT  /panel/settings         200 + 原子落盘 + ignored；model 缺失且 failFast → 409
 *   ③ POST /panel/models/download  202 + jobId；同刻第二个 → 409；GET 轮询 running → done
 *   ④ GET  /panel/models/download  未知 jobId → 404
 *   ⑤ POST /panel/reindex          200 + 计数
 *   ⑥ 默认值一致性：/panel/state 的 config 与 cordis.patch.yml 的 config 逐键相等
 *   ⑦ apply() 真接线：注册 4 条 exact 路径（5 个 method），dispose 后全部注销
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import apply, { DEFAULTS } from '../index.mjs';
import * as core from '../lib/core.mjs';
import { PANEL_KEYS } from '../lib/settings-schema.js';
import { registerPanelRoutes, panelConfigPath, readPanelConfig } from '../lib/panel-routes.mjs';
import { ROOT, addSession, asstTurn, tmpHome, userTurn } from '../support/helpers.mjs';

const WS = 'D:\\ws-panel-fixture';

// ── 假宿主 ──────────────────────────────────────────────────────────────
function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      assert.equal(route.kind, 'exact', '契约要求 kind:"exact"');
      assert.equal(typeof route.handler, 'function');
      routes.push(route);
      return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
    },
    find(p) { return routes.find((r) => r.path === p); },
  };
}

function fakeReq(method, url, body) {
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(body, 'utf8'); },
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(chunk) { this.body = chunk == null ? '' : String(chunk); this.writableEnded = true; },
  };
}

/** 调一条路由（handler 是 async，能直接 await）。 */
async function call(ws, method, url, body) {
  const pathname = url.split('?')[0];
  const route = ws.find(pathname);
  assert.ok(route, `路由未注册: ${pathname}（已注册: ${ws.routes.map((r) => r.path).join(', ')}）`);
  const res = fakeRes();
  await route.handler(fakeReq(method, url, body == null ? null : JSON.stringify(body)), res);
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = { __raw: res.body }; }
  return { status: res.statusCode, headers: res.headers, json };
}

// ── 夹具：一个真库（ingest 建库，含 episode）──────────────────────────────
function seed() {
  const home = tmpHome('dsh-mem-routes-');
  addSession(home, WS, 'sess-p1', [
    userTurn(1, '我们决定把库固定在 mem 目录，实测四层体检可以命中'),
    asstTurn(2, '跑通了，退出码 0'),
    userTurn(3, '结论：panel 的 state 只读，不写库'),
  ]);
  const storeDir = path.join(home, 'mem');
  const lc = { home, ws: WS, dbp: core.dbPathOf(home, WS, storeDir), cfg: null };
  core.ingest(lc, {});
  return { home, storeDir, lc };
}

const fakeModels = (home, { modelPresent = true } = {}) => ({
  modelState: () => (modelPresent
    ? { ok: true, dir: path.join(home, 'mem', 'models', 'bge-small-zh-v1.5') }
    : { ok: false, dir: path.join(home, 'mem', 'models', 'bge-small-zh-v1.5'), reason: '没有 model.manifest.json' }),
  specOf: (c) => {
    const id = String(c.embeddingModel || '');
    if (id !== 'bge-small-zh-v1.5') {
      const e = new Error(`未知的 embeddingModel: ${id}（可选: bge-small-zh-v1.5）`);
      e.code = 'ERR_MODEL_UNKNOWN';
      throw e;
    }
    return { id };
  },
});

function setup({ modelPresent = true, ensureModel } = {}) {
  const { home, storeDir, lc } = seed();
  const web = fakeWebServer();
  const cfg = { ...DEFAULTS, storeDir };
  const deps = {
    cfg,
    getContext: () => ({ ...lc, cfg }),
    reindex: (c) => core.ingest(c, {
      excludePaths: cfg.excludePaths, redact: cfg.redact,
      episodes: cfg.episodeEnabled, episodeClosureMinutes: cfg.episodeClosureMinutes, episodeMaxChars: cfg.episodeMaxChars,
    }),
    log: () => {},
    warn: () => {},
    embed: {
      isAvailable: async () => true,
      ensureModel: ensureModel ?? (async (_c, p) => {
        p?.({ file: 'onnx/model.onnx', received: 94371840, total: 94371840, pct: 100 });
        return path.join(home, 'mem', 'models', 'bge-small-zh-v1.5');
      }),
    },
    embedModels: fakeModels(home, { modelPresent }),
  };
  const dispose = registerPanelRoutes(web, deps);
  return { home, storeDir, lc, web, cfg, deps, dispose };
}

// ── ① state ────────────────────────────────────────────────────────────
test('① GET /panel/state → 200：形状齐全，config 是核心 9 键，库数现算', async () => {
  const { web, cfg } = setup();
  const r = await call(web, 'GET', '/dsh-mem/panel/state');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.json.turns, 3);
  assert.equal(r.json.sessions, 1);
  assert.ok(r.json.episodes >= 1, 'ingest 后应有 episode 区间');
  assert.equal(typeof r.json.index.uncoveredTurns, 'number');
  assert.equal(typeof r.json.index.danglingEpisodes, 'number');
  assert.equal(r.json.rerank.mode, 'lexical');
  assert.equal(r.json.rerank.effective, 'lexical');
  assert.equal(r.json.embedding.modelPresent, true);
  assert.equal(r.json.embedding.available, true);
  assert.deepEqual(Object.keys(r.json.config), PANEL_KEYS);
  for (const k of PANEL_KEYS) assert.deepEqual(r.json.config[k], cfg[k], `/panel/state.config.${k}`);
  assert.ok(fs.existsSync(r.json.db));
  console.log(`[routes] state: turns=${r.json.turns} episodes=${r.json.episodes} dbBytes=${r.json.dbBytes}`);
});

// ── ② settings ─────────────────────────────────────────────────────────
test('② PUT /panel/settings → 200：消毒 + 原子落盘 + ignored，工具活配置立刻生效', async () => {
  const { web, cfg, home } = setup();
  const r = await call(web, 'PUT', '/dsh-mem/panel/settings', {
    patch: { episodeClosureMinutes: 99999, rerankLexical: false, bogus: 1 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.config.episodeClosureMinutes, 1440, '上界收束');
  assert.equal(r.json.config.rerankLexical, false);
  assert.deepEqual(r.json.ignored, ['bogus']);
  assert.equal(cfg.episodeClosureMinutes, 1440, '活配置（工具下一次调用就用新值）');
  assert.equal(cfg.rerankLexical, false);

  const file = panelConfigPath(home);
  assert.ok(fs.existsSync(file), 'panel-config.json 必须落盘');
  assert.ok(!fs.existsSync(`${file}.tmp`), '不能留下半截 .tmp');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.episodeClosureMinutes, 1440);

  // 写盘即降级提示：词面重排子开关关掉 → rerank 存的是 lexical，但生效是 off
  assert.equal(r.json.config.rerank, 'lexical');
  assert.match(String(r.json.warning || ''), /词面重排/, '值存下了但没生效必须回 warning');
  console.log(`[routes] settings: ${file} → rerank=${onDisk.rerank} warning=${r.json.warning || '(none)'}`);
});

test('②b PUT rerank=embedding 且模型缺失 + embeddingFailFast=true → 409 model-missing，不落盘', async () => {
  const { web, cfg, home } = setup({ modelPresent: false });
  const r = await call(web, 'PUT', '/dsh-mem/panel/settings', { patch: { rerank: 'embedding' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'model-missing');
  assert.match(r.json.error, /向量模型未下载/);
  assert.ok(r.json.modelDir);
  assert.equal(cfg.rerank, 'lexical', '409 时活配置不许变');
  assert.equal(readPanelConfig(home, cfg).rerank, 'lexical', '409 时磁盘不许变');
});

// ── ③/④ job ────────────────────────────────────────────────────────────
test('③ POST /panel/models/download → 202+jobId；同刻再发 409；轮询 running → done', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const { ensureModel } = {
    ensureModel: async (_c, onProgress) => {
      onProgress({ file: 'onnx/model.onnx', received: 5, total: 10, pct: 50 });
      await gate;
      return 'C:\\models\\bge-small-zh-v1.5';
    },
  };
  const { web } = setup({ ensureModel });

  const started = await call(web, 'POST', '/dsh-mem/panel/models/download', { model: 'bge-small-zh-v1.5' });
  assert.equal(started.status, 202);
  assert.match(started.json.jobId, /^dl-\d+$/);
  assert.equal(started.json.status, 'running');

  const again = await call(web, 'POST', '/dsh-mem/panel/models/download', { model: 'bge-small-zh-v1.5' });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'busy');
  assert.equal(again.json.jobId, started.json.jobId);

  const mid = await call(web, 'GET', `/dsh-mem/panel/models/download?jobId=${encodeURIComponent(started.json.jobId)}`);
  assert.equal(mid.status, 200);
  assert.equal(mid.json.status, 'running');
  assert.equal(mid.json.percent, 50);
  assert.equal(mid.json.file, 'onnx/model.onnx');

  release();
  await new Promise((r) => setImmediate(r));
  const done = await call(web, 'GET', `/dsh-mem/panel/models/download?jobId=${encodeURIComponent(started.json.jobId)}`);
  assert.equal(done.status, 200);
  assert.equal(done.json.status, 'done');
  assert.equal(done.json.path, 'C:\\models\\bge-small-zh-v1.5');

  const unknown = await call(web, 'GET', '/dsh-mem/panel/models/download?jobId=dl-nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, '未知 jobId');
  console.log(`[routes] download: ${started.json.jobId} running→done (${done.json.path})`);
});

test('③b POST download 未知模型 → 400 ERR_MODEL_UNKNOWN（不启动任务）', async () => {
  const { web } = setup();
  const r = await call(web, 'POST', '/dsh-mem/panel/models/download', { model: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'ERR_MODEL_UNKNOWN');
  assert.match(r.json.error, /未知的 embeddingModel/);
});

// ── ⑤ reindex ──────────────────────────────────────────────────────────
test('⑤ POST /panel/reindex → 200：真跑一次增量 ingest，回计数', async () => {
  const { web } = setup();
  const r = await call(web, 'POST', '/dsh-mem/panel/reindex', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.turns, 0, '幂等：首次 ingest 已入库，重建只补未覆盖的 turn');
  assert.equal(typeof r.json.episodes, 'number');
  assert.equal(typeof r.json.sealed, 'number');
  assert.ok(r.json.ms >= 0);
});

test('路由方法/路径守门：GET settings → 405，错误也是 JSON 形状', async () => {
  const { web } = setup();
  const r = await call(web, 'GET', '/dsh-mem/panel/settings');
  assert.equal(r.status, 405);
  assert.equal(r.json.code, 'ERR_METHOD');
  assert.equal(typeof r.json.error, 'string');
});

// ── ⑥ 默认值一致性 ──────────────────────────────────────────────────────
/** 只认 cordis.patch.yml 里 config: 块下的 `k: v`（不引 yaml 依赖：这是三个标量+一个空数组）。 */
function yamlConfig(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s{2,}config:\s*$/.test(l));
  assert.ok(start >= 0, 'cordis.patch.yml 必须有 config: 块');
  const out = {};
  let indent = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^(\s+)([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) break;
    if (indent < 0) indent = m[1].length;
    if (m[1].length !== indent) break;
    const raw = m[3].replace(/\s+#.*$/, '').trim();
    let v;
    if (raw === '[]') v = [];
    else if (raw === 'true') v = true;
    else if (raw === 'false') v = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) v = Number(raw);
    else v = raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    out[m[2]] = v;
  }
  return out;
}

test('⑥ 默认值只有一份：/panel/state 的 config 与 cordis.patch.yml 的 config 逐键相等', async () => {
  const { web } = setup();                                   // 新 home：没有 panel-config.json
  const r = await call(web, 'GET', '/dsh-mem/panel/state');
  assert.equal(r.status, 200);
  const yaml = yamlConfig(fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8'));

  assert.deepEqual(Object.keys(r.json.config).sort(), [...PANEL_KEYS].sort(), 'state.config 恰好是 9 键');
  const yamlPanel = Object.fromEntries(PANEL_KEYS.map((k) => [k, yaml[k]]));
  assert.deepEqual(r.json.config, yamlPanel, 'state.config 与 cordis.patch.yml 的 9 键必须逐键相等');

  const corePanel = Object.fromEntries(PANEL_KEYS.map((k) => [k, DEFAULTS[k]]));
  assert.deepEqual(corePanel, yamlPanel, 'index.mjs 的 DEFAULTS 与 cordis.patch.yml 也必须逐键相等');
  assert.equal(yamlPanel.rerank, 'lexical');
  assert.equal(yamlPanel.embeddingFailFast, true);
  console.log(`[routes] defaults: ${PANEL_KEYS.length} 键三方一致（state = DEFAULTS = cordis.patch.yml）`);
});

// ── ⑦ apply() 真接线（动态注入 webServer）────────────────────────────────
/**
 * 假 ctx：形状逐字对齐 cordis 的 `ctx.inject(deps, cb) → fiber` 与 `host.effect(fn, label) → disposer`。
 * `defer` = 先不触发回调（模拟 webServer 还没挂上），由用例手动 fire()。
 */
function fakeCtx(web, { defer = false } = {}) {
  const registered = [];
  const labels = [];
  const effects = [];
  const state = { injected: [], fired: false, callback: null };
  const host = {
    webServer: web,
    effect(fn, label) {
      labels.push(label);
      const cleanup = fn();
      const off = () => { try { cleanup?.(); } catch { /* ignore */ } };
      effects.push(off);
      return off;
    },
  };
  const ctx = {
    tools: { register(def) { registered.push(def); return () => {}; } },
    inject(names, cb) {
      state.injected.push(names);
      state.callback = cb;
      if (!defer) { state.fired = true; cb(host); }
      return { fiber: true, names };
    },
  };
  return {
    ctx, registered, labels, state, host,
    fire() { state.fired = true; state.callback(host); },
    /** 模拟 cordis 卸载插件：跑掉该 fiber 上所有 effect 的 cleanup。 */
    disposeEffects() { while (effects.length) effects.pop()(); },
  };
}

test('⑦ apply() 静态 inject 只有 tools；webServer 走动态注入，注册 4 条 exact 路径（5 个 method）', async () => {
  const home = tmpHome('dsh-mem-apply-');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const web = fakeWebServer();
    const f = fakeCtx(web);
    let dispose;
    const { logs } = await (async () => {
      const bag = { logs: [] };
      const prevLog = console.log;
      console.log = (...a) => { bag.logs.push(a.map(String).join(' ')); };
      try { dispose = await apply(f.ctx, { storeDir: path.join(home, 'mem') }); }
      finally { console.log = prevLog; }
      return bag;
    })();

    // 静态 inject 只留 tools：webServer 列进去会让 apply 等一个后挂的服务
    const mod = await import('../index.mjs');
    assert.deepEqual(mod.inject, ['tools'], '静态 inject 必须是 [tools]');
    assert.deepEqual(f.state.injected, [['webServer']], '必须用 ctx.inject(["webServer"], …) 动态拿服务');
    assert.equal(f.state.fired, true, '同步就绪时必须真的触发回调');
    assert.deepEqual(f.labels, ['dsh-mem: panel routes']);

    assert.equal(f.registered.length, 5, '5 个工具照旧注册');
    assert.ok(logs.some((l) => l.includes('[dsh-mem] panel routes registered: /dsh-mem/panel/*')),
      `注册成功必须打一行 console.log（实际: ${JSON.stringify(logs)}）`);
    assert.deepEqual(web.routes.map((r) => r.path).sort(), [
      '/dsh-mem/panel/models/download', '/dsh-mem/panel/reindex',
      '/dsh-mem/panel/settings', '/dsh-mem/panel/state',
    ]);
    for (const r of web.routes) assert.equal(r.kind, 'exact');

    // 真 handler：GET state 在空 home 上回 200 + 全 0（库不存在不是错误）
    const r = await call(web, 'GET', '/dsh-mem/panel/state');
    assert.equal(r.status, 200);
    assert.equal(r.json.turns, 0);
    assert.equal(r.json.episodes, 0);

    dispose();
    assert.equal(web.routes.length, 4, 'apply 的 disposer 只管工具，路由归 inject fiber 的 effect');

    f.disposeEffects();                                  // = cordis 卸载插件时跑 effect cleanup
    assert.equal(web.routes.length, 0, '卸载必须注销全部路由（端口上不留残废路由）');
    console.log('[routes] apply(): ctx.inject → host.effect → 4 路径 + effect cleanup 全清');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});

test('⑧ 路由只在 ctx.inject 回调触发后才注册（webServer 晚到也接得上）', async () => {
  const home = tmpHome('dsh-mem-apply-defer-');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const web = fakeWebServer();
    const f = fakeCtx(web, { defer: true });
    const dispose = await apply(f.ctx, { storeDir: path.join(home, 'mem') });

    assert.equal(f.registered.length, 5, '工具不等 webServer，先注册');
    assert.equal(f.state.fired, false);
    assert.equal(web.routes.length, 0, '回调没触发就一条路由都不许有');

    f.fire();
    assert.equal(web.routes.length, 4, '回调触发后 4 条路径就位');
    const r = await call(web, 'GET', '/dsh-mem/panel/state');
    assert.equal(r.status, 200);
    dispose();
    f.disposeEffects();
    assert.equal(web.routes.length, 0);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});

test('⑨ host.webServer.register 抛错（路径重复）时不炸 apply，且把原文打出来', async () => {
  const home = tmpHome('dsh-mem-apply-throw-');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const web = fakeWebServer();
    web.register = () => { throw new Error('route already registered: /dsh-mem/panel/state'); };
    const f = fakeCtx(web);
    let dispose;
    const { errs } = await (async () => {
      const prevErr = console.error;
      const bag = { errs: [] };
      console.error = (...a) => { bag.errs.push(a.map(String).join(' ')); };
      try { dispose = await apply(f.ctx, { storeDir: path.join(home, 'mem') }); }
      finally { console.error = prevErr; }
      return bag;
    })();

    assert.equal(f.registered.length, 5, '路由注册失败不影响 5 个工具');
    assert.ok(errs.some((e) => e.includes('host.webServer.register failed')), '必须打 error');
    assert.ok(errs.some((e) => e.includes('route already registered')), '必须把抛错原文带出来');
    assert.doesNotThrow(() => dispose());
    f.disposeEffects();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});
