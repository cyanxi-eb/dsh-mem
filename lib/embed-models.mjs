/**
 * embed-models — 模型清单、下载、校验、指纹。
 *
 * 只有 embed.mjs 调这里。设计约束（与 PROPOSAL-0.2 一致）：
 *   1. 零必选依赖：本文件只用 node:* 内置，任何第三方推理包由 embed.mjs 动态 import。
 *   2. 模型不进 node_modules：落在 `<base>/<modelId>/`，base = cfg.embeddingModelDir || <DSH_HOME>/mem/models。
 *      每个模型一个子目录 —— 换模型时不互相覆盖，同一个目录也不会被第二个模型顶掉。
 *   3. 下载/校验失败一律抛 EmbedError（带 code），绝不返回零向量、绝不吞错。
 *   4. 带进度回调：onProgress({file, received, total, pct, source})。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { homeDir } from './core.mjs';

/** 支持的中文小模型（数据表，不做抽象）。dtype 对应 transformers.js 的 onnx 文件名。 */
export const MODELS = {
  'bge-small-zh-v1.5': {
    repo: 'Xenova/bge-small-zh-v1.5',   // 上游 BAAI/bge-small-zh-v1.5 的 ONNX 转换版
    dim: 512,
    pooling: 'cls',                      // bge 官方口径：CLS token
    // fp32 而不是 int8：同一套 30 条查询实测 R@3 0.567 vs 0.433、MRR 0.333 vs 0.272，
    // 代价是 90.5MB 模型 + 单窗 39ms vs 24ms。默认取质量。
    dtype: 'fp32',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'],
  },
};

export class EmbedError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'EmbedError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const MB = 1024 * 1024;
const HF_HOSTS = () => {
  const first = (process.env.HF_ENDPOINT || '').replace(/\/+$/, '');
  const envHosts = (process.env.DSH_MEM_HF_HOSTS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (envHosts.length) return envHosts;                 // 测试/离线环境可整体替换源列表
  return [first, 'https://huggingface.co', 'https://hf-mirror.com'].filter((v, i, a) => v && a.indexOf(v) === i);
};

export function specOf(cfg = {}) {
  const id = String(cfg.embeddingModel || 'bge-small-zh-v1.5');
  const spec = MODELS[id];
  if (!spec) {
    throw new EmbedError('ERR_MODEL_UNKNOWN',
      `未知的 embeddingModel: ${id}（可选: ${Object.keys(MODELS).join(', ')}）`);
  }
  return { id, ...spec };
}

/** 模型根目录（不含 modelId） */
export const modelBaseDir = (cfg = {}) =>
  path.resolve(cfg.embeddingModelDir || path.join(homeDir(cfg), 'mem', 'models'));

/** 单个模型的落地目录 */
export const modelDirOf = (cfg = {}) => path.join(modelBaseDir(cfg), specOf(cfg).id);

const MANIFEST = 'model.manifest.json';

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch { return null; }
}

/** 模型是否完整落盘（只看文件系统，不 hash、不加载）。 */
export function modelState(cfg = {}) {
  const spec = specOf(cfg);
  const dir = path.join(modelBaseDir(cfg), spec.id);
  const m = readManifest(dir);
  if (!m || m.model !== spec.id) return { ok: false, dir, reason: m ? `目录里的清单属于 ${m.model}` : `没有 ${MANIFEST}` };
  for (const f of spec.files) {
    const p = path.join(dir, f);
    let st = null;
    try { st = fs.statSync(p); } catch { /* missing */ }
    if (!st || !st.size) return { ok: false, dir, reason: `缺文件 ${f}` };
    if (m.files?.[f] && m.files[f] !== st.size) return { ok: false, dir, reason: `${f} 大小 ${st.size} != 清单 ${m.files[f]}` };
  }
  return { ok: true, dir, manifest: m };
}

async function downloadOne(spec, f, onProgress, firstHost) {
  const errs = [];
  const hosts = [firstHost, ...HF_HOSTS()].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const host of hosts) {
    const url = `${host}/${spec.repo}/resolve/main/${f}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length') || 0);
        const chunks = [];
        let received = 0;
        if (res.body?.getReader) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            received += value.length;
            onProgress?.({ file: f, received, total, pct: total ? +((received / total) * 100).toFixed(1) : null, source: host });
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          chunks.push(buf); received = buf.length;
          onProgress?.({ file: f, received, total: buf.length, pct: 100, source: host });
        }
        const buf = Buffer.concat(chunks);
        if (!buf.length) throw new Error('空响应');
        if (total && buf.length !== total) throw new Error(`字节数 ${buf.length} != content-length ${total}`);
        return { buf, source: host, url };
      } catch (e) {
        errs.push(`${host}#${attempt}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`);
      }
    }
  }
  throw new EmbedError('ERR_DOWNLOAD', `下载 ${spec.repo}/${f} 失败，所有源都不可用：\n  ${errs.join('\n  ')}`);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function verifyFile(spec, f, buf) {
  if (f.endsWith('.json')) {
    let o;
    try { o = JSON.parse(buf.toString('utf8')); } catch (e) {
      throw new EmbedError('ERR_VERIFY', `${f} 不是合法 JSON（下载到的大概率是错误页）: ${e.message}`);
    }
    if (f === 'config.json' && Number(o.hidden_size) !== spec.dim) {
      throw new EmbedError('ERR_VERIFY', `config.json hidden_size=${o.hidden_size} 与清单 dim=${spec.dim} 不符`);
    }
    if (f === 'tokenizer.json' && !o.model) {
      throw new EmbedError('ERR_VERIFY', 'tokenizer.json 里没有 model 字段');
    }
  } else {
    if (buf.length < 1 * MB) throw new EmbedError('ERR_VERIFY', `${f} 只有 ${buf.length}B，ONNX 权重不可能这么小`);
    if (buf[0] === 0x3c) throw new EmbedError('ERR_VERIFY', `${f} 开头是 '<'（HTML 错误页），不是 ONNX 二进制`);
  }
}

/**
 * 模型在不在；不在就下载。返回模型目录绝对路径。
 * @param {{embeddingModel?, embeddingModelDir?, home?}} cfg
 * @param {(p:{file:string,received:number,total:number,pct:number|null,source:string})=>void} [onProgress]
 */
export async function ensureModelDir(cfg = {}, onProgress) {
  const spec = specOf(cfg);
  const state = modelState(cfg);
  if (state.ok) return state.dir;

  const dir = state.dir;
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  const hashes = {};
  const sources = {};
  const t0 = Date.now();
  let host = null;                     // 第一个文件成功用的源，后续文件优先复用它（省掉每文件 10s 的连接超时）
  for (const f of spec.files) {
    const dest = path.join(dir, f);
    const old = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const { buf, source, url } = await downloadOne(spec, f, onProgress, host);
    host = source;
    verifyFile(spec, f, buf);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.part`, buf);
    fs.renameSync(`${dest}.part`, dest);
    files[f] = buf.length;
    hashes[f] = sha256(buf);
    sources[f] = source;
    onProgress?.({ file: f, received: buf.length, total: buf.length, pct: 100, source, done: true, url, replaced: old > 0 });
  }
  const manifest = {
    model: spec.id, repo: spec.repo, dim: spec.dim, dtype: spec.dtype, pooling: spec.pooling,
    files, sha256: hashes, sources, fetchedAt: new Date().toISOString(), ms: Date.now() - t0,
  };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  const after = modelState(cfg);
  if (!after.ok) throw new EmbedError('ERR_VERIFY', `下载完成后自检失败: ${after.reason}`);
  return dir;
}

/**
 * 稳定指纹（用于 sidecar 错配检测）：模型 id + 维度 + 归一化 + 权重摘要。
 * 不做全量 hash（24MB 每次启动都算太贵）：取文件大小 + 首 64KB + 尾 64KB 的 sha256 前 12 位。
 */
export function fingerprintOf(cfg = {}) {
  const spec = specOf(cfg);
  const onnx = modelState(cfg).ok ? path.join(modelDirOf(cfg), spec.files.at(-1)) : '';
  let digest = 'none';
  if (onnx && fs.existsSync(onnx)) {
    const size = fs.statSync(onnx).size;
    const fd = fs.openSync(onnx, 'r');
    try {
      const head = Buffer.alloc(Math.min(65536, size));
      fs.readSync(fd, head, 0, head.length, 0);
      const tailLen = Math.min(65536, size);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      digest = sha256(Buffer.concat([head, tail, Buffer.from(`${spec.id}:${size}`)])).slice(0, 12);
    } finally { fs.closeSync(fd); }
  }
  return `${spec.id}|dim=${spec.dim}|pool=${spec.pooling}|norm=l2|w=${digest}`;
}
