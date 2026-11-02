/**
 * embed — 可选的本地 embedding 后端（默认关闭）。零必选依赖：推理包只在这里动态 import。
 *
 * 语义（四个导出，别在别处再写一份）：
 *   isAvailable(cfg)            依赖装没装。不读模型、不建 session。
 *   ensureModel(cfg, onProgress) 模型在不在；不在就下载；返回本地目录。失败抛 EmbedError。
 *   embedBatch(texts, cfg)       Float32Array[]，已 L2 归一化。懒加载：第一次调用才 import + 读模型，
 *                                之后进程内复用（module 级 promise 缓存）。
 *   embedFingerprint(cfg)        稳定指纹（模型 id + dim + pooling + 归一化 + 权重摘要），给 sidecar 检测错配。
 *
 * 失败策略：
 *   - 下载/校验失败 → 一律抛 EmbedError（code=ERR_DOWNLOAD/ERR_VERIFY），绝不返回零向量。
 *   - 下载只发生在显式调用 ensureModel()（面板上的"下载模型"）—— embedBatch/检索路径从不偷偷下 90MB。
 *   - 模型缺失 / 依赖缺失：embeddingFailFast !== false → embedBatch 抛错（默认，大声）；
 *     embeddingFailFast === false → embedBatch 返回 []（空数组，调用方退回词面检索），并 console.warn 一次。
 *
 * 配置键（逐字，与 panel/0.2 规格一致）：
 *   embeddingEnabled(default false) · embeddingModel('bge-small-zh-v1.5') ·
 *   embeddingModelDir('') · embeddingFailFast(true)
 */
import { EmbedError, ensureModelDir, fingerprintOf, modelState, specOf } from './embed-models.mjs';

const DEP = '@huggingface/transformers';
const CHUNK = 64;            // 单次 ONNX 推理条数上限，防长文本批量把内存顶上去

/** @type {{promise:Promise<any>|null, error:Error|null}} */
let dep_ = { promise: null, error: null };

function importDep() {
  if (!dep_.promise) {
    dep_.promise = import(DEP).catch((e) => {
      dep_.error = e;
      dep_.promise = null;                       // 允许下次重试（例如用户刚装完）
      throw new EmbedError('ERR_NO_DEP',
        `没有装可选的 embedding 依赖 ${DEP}。安装：npm i --save-optional ${DEP}\n  原始错误: ${e.message}`, e);
    });
  }
  return dep_.promise;
}

/** 依赖是否装了（只 import 模块，不读模型）。cfg 收下但不用 —— 签名与规格一致。 */
export async function isAvailable(_cfg) {
  try { await importDep(); return true; } catch { return false; }
}

/**
 * 模型是否落盘；不在就下载。返回模型目录。
 * @param {object} cfg
 * @param {(p:{file:string,received:number,total:number,pct:number|null,source:string})=>void} [onProgress]
 */
export async function ensureModel(cfg = {}, onProgress) {
  await importDep();
  return ensureModelDir(cfg, onProgress);
}

// ───────────────────────── 懒加载的 pipeline ─────────────────────────
/** @type {{key:string, promise:Promise<Function>}|null} */
let pipe = null;
let loads = 0;
let warned = false;

async function loadExtractor(cfg) {
  const spec = specOf(cfg);
  const state = modelState(cfg);
  const key = `${spec.id}|${spec.dtype}|${state.dir}`;
  if (pipe?.key === key) return pipe.promise;

  const promise = (async () => {
    const mod = await importDep();          // 先报"依赖没装"（可装），再报"模型没下"（可下）
    if (!state.ok) {
      throw new EmbedError('ERR_NO_MODEL',
        `模型没就位（${state.reason}）。先跑 ensureModel() 下载，或去设置面板点"下载模型"。目录: ${state.dir}`);
    }
    const dir = state.dir;
    const { pipeline, env } = mod;
    env.allowRemoteModels = false;         // 绝不偷偷联网：没有模型就报错，不自动下
    env.allowLocalModels = true;
    env.localModelPath = dir.slice(0, dir.length - spec.id.length).replace(/[\\/]+$/, '');
    const extract = await pipeline('feature-extraction', spec.id, { dtype: spec.dtype });
    loads++;
    return extract;
  })();
  pipe = { key, promise };
  promise.catch(() => { if (pipe?.promise === promise) pipe = null; });   // 失败不缓存，下次可重试
  return promise;
}

/**
 * 文本 → 归一化向量。
 * @param {string[]} texts
 * @param {object} cfg
 * @returns {Promise<Float32Array[]>}
 */
export async function embedBatch(texts, cfg = {}) {
  const list = [...texts];
  if (!list.length) return [];
  if (cfg.embeddingEnabled === false) {
    throw new EmbedError('ERR_DISABLED', 'embeddingEnabled=false —— 这个后端默认关闭，要显式打开才走向量');
  }
  for (const t of list) {
    if (typeof t !== 'string') throw new EmbedError('ERR_INPUT', `embedBatch 只收字符串，收到 ${typeof t}`);
  }
  const onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : undefined;

  const soft = cfg.embeddingFailFast === false;

  let extract;
  try {
    extract = await loadExtractor(cfg);
  } catch (e) {
    if (!soft) throw e;
    if (!warned) {
      warned = true;
      console.warn(`[dsh-mem/embed] 向量后端不可用（embeddingFailFast=false，退回词面检索）: ${e.code || ''} ${e.message}`);
    }
    return [];
  }

  // 按长度排序后再分批：同一批里长度接近，ONNX 的 padding 浪费就小
  // （实测混批 64 条 1000 字 + 10 字文档，逐条 288ms；按长度分批后降到 1.5ms 级）
  const order = list.map((t, i) => [t.length, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const out = new Array(list.length);
  for (let i = 0; i < order.length; i += CHUNK) {
    const idxs = order.slice(i, i + CHUNK);
    const part = idxs.map((k) => list[k]);
    let res;
    try {
      res = await extract(part, { pooling: 'cls', normalize: true });
    } catch (e) {
      throw new EmbedError('ERR_INFERENCE', `推理失败（${part.length} 条，首条 ${JSON.stringify(part[0].slice(0, 40))}）: ${e.message}`, e);
    }
    const [n, dim] = res.dims;
    if (n !== part.length) throw new EmbedError('ERR_INFERENCE', `返回条数 ${n} != 输入 ${part.length}`);
    const flat = res.data;
    for (let r = 0; r < n; r++) out[idxs[r]] = Float32Array.from(flat.subarray(r * dim, (r + 1) * dim));
  }
  return out;
}

/** 稳定指纹；同一进程/跨进程都必须一致。模型未落盘时摘要部分为 none。 */
export function embedFingerprint(cfg = {}) {
  return fingerprintOf(cfg);
}

/** 仅供测试：本进程真正建立过几个 pipeline。 */
embedBatch.stats = () => ({ loads, loaded: !!pipe, depLoaded: !!dep_.promise, depError: dep_.error?.message ?? null });
