/**
 * panel-routes — 宿主侧 5 条 HTTP 路由（契约逐字照 docs/PANEL-CONTRACT.md §1）。
 *
 * 为什么单列一个文件：index.mjs 已经背着 5 个工具，路由再塞进去就没人看得懂"哪行是工具、
 * 哪行是 HTTP"了。这里只做**接线与形状**：健康数、设置读写、模型下载 job、重建索引，
 * 业务实现全部转调 core / embed / embed-models / settings-schema —— 本文件没有第二份实现。
 *
 * 三条硬约束（踩过就不再改）：
 *   1. handler 里**所有异常都要吞成结构化 JSON**（{error, code?, detail?}），绝不把栈甩给浏览器；
 *   2. 每条路由注册的 disposer 都交回调用方，进 apply 的清理链（卸载插件 = 端口上不留残废路由）；
 *   3. 同一路径只能注册一次（宿主对 (kind,path) 重复注册直接抛），`models/download`
 *      的 GET/POST 因此在**一个 handler 里按 method 分派**。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.mjs';
import * as embed from './embed.mjs';
import * as embedModels from './embed-models.mjs';
import { PANEL_KEYS, effectiveRerank, sanitizePanelConfig } from './settings-schema.js';

const BASE = '/dsh-mem/panel';
const JSON_CT = 'application/json; charset=utf-8';
const MAX_BODY = 64 * 1024;
const MAX_JOBS = 20;

/** 带 HTTP 语义的错误：code 进 JSON，status 决定状态码。 */
export class PanelError extends Error {
  constructor(message, code, status = 500, extra = {}) {
    super(message);
    this.name = 'PanelError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const messageOf = (e) => {
  const m = e && e.message ? String(e.message) : String(e ?? '');
  return m.trim() || '未知错误';
};

/** 只保留面板那 9 个键（键序 = PANEL_KEYS）。 */
export function pickPanelConfig(cfg = {}) {
  const out = {};
  for (const k of PANEL_KEYS) out[k] = cfg[k];
  return out;
}

// ───────────────────────────── 面板配置落盘 ─────────────────────────────
export const panelConfigPath = (home) => path.join(home, 'mem', 'panel-config.json');

/** 原子写：先写 .tmp 再 rename（半截文件绝不冒充一份好配置）。 */
export function writePanelConfig(home, config) {
  const file = panelConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 读盘；不存在 / 坏 JSON / 脏值都由调用方给的 base 收束（返回值恒为 9 键完整配置）。 */
export function readPanelConfig(home, base, { warn = () => {} } = {}) {
  const file = panelConfigPath(home);
  let raw = {};
  try {
    if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`[dsh-mem] ${file} 读不了（${messageOf(e)}），按 loader config 走`);
    raw = {};
  }
  return sanitizePanelConfig(raw, base).config;
}

// ───────────────────────────── HTTP 小工具 ─────────────────────────────
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', JSON_CT);
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendError(res, e) {
  const status = e instanceof PanelError ? e.status : 500;
  const body = { error: messageOf(e) };
  if (e && e.code) body.code = String(e.code);
  if (e && e.model) body.model = e.model;
  if (e && e.modelDir) body.modelDir = e.modelDir;
  if (e && e.jobId) body.jobId = e.jobId;
  sendJson(res, status, body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new PanelError(`请求体超过 ${MAX_BODY} 字节`, 'ERR_BODY', 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch (e) {
    throw new PanelError(`请求体不是合法 JSON: ${messageOf(e)}`, 'ERR_BODY', 400);
  }
}

const methodOf = (req) => String(req.method || 'GET').toUpperCase();

// ───────────────────────────── 注册 ─────────────────────────────
/**
 * @param {{ register(route: {kind:'exact', path:string, handler:Function}): Function }} webServer
 * @param {{
 *   cfg: object,                                  // 活配置（PUT 后原地更新，工具立刻看到）
 *   getContext: () => { home: string, ws: string, dbp: string },
 *   reindex: (lc: object) => object,              // 增量 ingest + episode pass → core 的 totals
 *   log?: (msg: string) => void,
 *   warn?: (msg: string) => void,
 *   embed?: typeof embed, embedModels?: typeof embedModels,   // 测试台注入假后端；线上不传
 * }} deps
 * @returns {() => void} 注销 4 条路径（5 个 method）
 */
export function registerPanelRoutes(webServer, deps) {
  const log = deps.log ?? ((m) => console.log(m));
  const warn = deps.warn ?? ((m) => console.warn(m));
  const cfg = deps.cfg;
  const getContext = deps.getContext;
  // 测试台用假后端（不联网、不下载 90MB）；线上永远走真模块
  const embedApi = deps.embed ?? embed;
  const models = deps.embedModels ?? embedModels;

  /** job 表（内存）：同一时刻最多一个 running。 */
  const jobs = new Map();
  let runningJobId = '';
  let reindexing = false;

  const pruneJobs = () => {
    if (jobs.size <= MAX_JOBS) return;
    for (const [id, job] of jobs) {
      if (jobs.size <= MAX_JOBS) break;
      if (job.status === 'running') continue;
      jobs.delete(id);
    }
  };

  async function modelReport() {
    let state;
    try { state = models.modelState(cfg); }
    catch (e) { state = { ok: false, dir: '', reason: messageOf(e) }; }
    let available = false;
    try { available = await embedApi.isAvailable(cfg); } catch { available = false; }
    return {
      enabled: cfg.embeddingEnabled === true,
      available,
      model: cfg.embeddingModel,
      modelDir: state.dir || '',
      modelPresent: state.ok === true,
      reason: state.ok ? '' : String(state.reason || ''),
    };
  }

  // ── 1. GET /panel/state ────────────────────────────────────────────────
  async function getState(req, res) {
    const lc = getContext();
    const view = pickPanelConfig(cfg);
    const embedding = await modelReport();
    const rerank = effectiveRerank(view, { modelPresent: embedding.modelPresent });

    const out = {
      db: lc.dbp,
      dbBytes: core.dbBytes(lc.dbp),
      sessions: 0, turns: 0, firstTs: null, lastTs: null,
      episodes: 0, sealed: 0,
      index: { uncoveredTurns: 0, danglingEpisodes: 0 },
      rerank: { mode: view.rerank, effective: rerank.mode, degraded: rerank.degraded, reason: rerank.reason },
      embedding,
      config: view,
    };
    if (out.dbBytes === 0 && !fs.existsSync(lc.dbp)) return sendJson(res, 200, out);   // 还没 ingest 不算错

    const db = core.openReadOnly(lc.dbp);
    if (!db) return sendJson(res, 200, out);                                          // 读不了 = 空库口径
    try {
      const st = core.stats(db, lc.dbp);
      const ih = core.indexHealth(db);
      out.dbBytes = st.dbBytes;
      out.sessions = st.sessions;
      out.turns = st.turns;
      out.firstTs = st.firstTs ?? null;
      out.lastTs = st.lastTs ?? null;
      out.episodes = ih.episodes;
      out.sealed = ih.sealed;
      out.index = { uncoveredTurns: ih.uncoveredTurns, danglingEpisodes: ih.danglingEpisodes };
      out.factLive = st.factLive;
    } finally { try { db.close(); } catch { /* ignore */ } }
    return sendJson(res, 200, out);
  }

  // ── 2. PUT /panel/settings ────────────────────────────────────────────
  async function putSettings(req, res) {
    const body = await readJson(req);
    const patch = body.patch ?? body.settings ?? body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new PanelError('body 必须是 {"patch":{…}}', 'ERR_BODY', 400);
    }
    const lc = getContext();
    const { config, ignored } = sanitizePanelConfig(patch, pickPanelConfig(cfg));

    // 选了向量重排但模型没落盘：failFast 时**不落盘**（用户自己选了"宁可炸"）
    if (config.rerank === 'embedding') {
      const state = models.modelState(config);
      if (!state.ok && config.embeddingFailFast !== false) {
        throw new PanelError(`向量模型未下载：${state.dir}`, 'model-missing', 409,
          { model: config.embeddingModel, modelDir: state.dir });
      }
    }

    writePanelConfig(lc.home, config);
    Object.assign(cfg, config);                     // 活配置：工具下一次调用就用新值

    const state = models.modelState(config);
    const eff = effectiveRerank(config, { modelPresent: state.ok });
    const warning = eff.degraded ? eff.reason : '';
    const payload = { config: pickPanelConfig(cfg), ignored };
    if (warning) payload.warning = warning;
    return sendJson(res, 200, payload);
  }

  // ── 3/4. /panel/models/download（POST 起任务 / GET 轮询）────────────────
  function startDownload(body) {
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : cfg.embeddingModel;
    try { models.specOf({ embeddingModel: model }); }
    catch (e) { throw new PanelError(messageOf(e), e.code || 'ERR_MODEL_UNKNOWN', 400); }

    if (runningJobId && jobs.get(runningJobId)?.status === 'running') {
      throw new PanelError('已有下载任务在跑', 'busy', 409, { jobId: runningJobId });
    }
    const jobId = `dl-${Date.now()}`;
    const job = {
      jobId, status: 'running', file: '', received: 0, total: 0, percent: 0, path: '', error: '',
    };
    jobs.set(jobId, job);
    runningJobId = jobId;
    pruneJobs();

    const dlCfg = {
      ...cfg,
      embeddingModel: model,
      embeddingModelDir: typeof body.modelDir === 'string' ? body.modelDir.trim() : cfg.embeddingModelDir,
    };
    const onProgress = (p) => {
      if (!p || typeof p !== 'object') return;
      if (typeof p.file === 'string') job.file = p.file;
      if (Number.isFinite(p.received)) job.received = p.received;
      if (Number.isFinite(p.total)) job.total = p.total;
      job.percent = Number.isFinite(p.pct) ? p.pct : (job.total ? +((job.received / job.total) * 100).toFixed(1) : 0);
    };
    // 不 await：202 先回去，进度靠 GET 轮询（契约 §1.3/§1.4）
    embedApi.ensureModel(dlCfg, onProgress).then((dir) => {
      job.status = 'done';
      job.percent = 100;
      job.path = String(dir || '');
      log(`[dsh-mem] 模型已就位: ${job.path}`);
    }).catch((e) => {
      job.status = 'error';
      job.error = messageOf(e);
      warn(`[dsh-mem] 模型下载失败: ${job.error}`);
    }).finally(() => {
      if (runningJobId === jobId) runningJobId = '';
    });
    return { jobId, status: job.status };
  }

  function pollDownload(req, res, url) {
    const jobId = url.searchParams.get('jobId') || '';
    const job = jobId ? jobs.get(jobId) : null;
    if (!job) throw new PanelError('未知 jobId', 'ERR_JOB_UNKNOWN', 404);
    return sendJson(res, 200, {
      jobId: job.jobId, status: job.status, file: job.file,
      received: job.received, total: job.total, percent: job.percent,
      path: job.path, error: job.error,
    });
  }

  async function downloadRoute(req, res, url) {
    if (methodOf(req) === 'GET') return pollDownload(req, res, url);
    const body = await readJson(req);
    return sendJson(res, 202, startDownload(body));
  }

  // ── 5. POST /panel/reindex ────────────────────────────────────────────
  async function postReindex(req, res) {
    if (reindexing) throw new PanelError('重建正在进行', 'busy', 409);
    reindexing = true;
    try {
      const lc = getContext();
      const totals = deps.reindex(lc);
      if (totals && totals.skippedLock) throw new PanelError('另一个 ingest 正在写库，稍后重试', 'busy', 409);
      const ep = (totals && totals.episodes) || {};
      return sendJson(res, 200, {
        ok: true,
        turns: Number(totals?.turns ?? 0),
        episodes: Number(ep.created ?? 0),
        sealed: Number(ep.sealed ?? 0),
        ms: Number(totals?.ms ?? 0),
      });
    } finally { reindexing = false; }
  }

  // ── 注册（disposer 交回调用方）────────────────────────────────────────
  const routes = [
    { path: `${BASE}/state`, handle: getState },
    { path: `${BASE}/settings`, handle: (req, res, url) => {
      if (methodOf(req) !== 'PUT') throw new PanelError('只接受 PUT', 'ERR_METHOD', 405);
      return putSettings(req, res, url);
    } },
    { path: `${BASE}/models/download`, handle: downloadRoute },
    { path: `${BASE}/reindex`, handle: (req, res) => {
      if (methodOf(req) !== 'POST') throw new PanelError('只接受 POST', 'ERR_METHOD', 405);
      return postReindex(req, res);
    } },
  ];

  const disposers = routes.map(({ path: routePath, handle }) => webServer.register({
    kind: 'exact',
    path: routePath,
    handler: async (req, res) => {
      // 所有异常 → 结构化 JSON；栈只进宿主日志，不进浏览器
      try {
        let url;
        try { url = new URL(req.url || '/', 'http://127.0.0.1'); } catch { url = new URL('http://127.0.0.1/'); }
        if (url.pathname !== routePath) throw new PanelError(`未知路径 ${url.pathname}`, 'ERR_PATH', 404);
        await handle(req, res, url);
      } catch (e) {
        if (!(e instanceof PanelError)) warn(`[dsh-mem] ${routePath} 处理失败: ${e?.stack || messageOf(e)}`);
        try { sendError(res, e); } catch { /* 响应已结束 / 连接断了 */ }
      }
    },
  }));

  return () => {
    for (const d of disposers) { try { d?.(); } catch { /* ignore */ } }
  };
}
