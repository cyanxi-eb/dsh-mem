/**
 * dsh-mem 客户端半 —— 宿主**会话页签**「记忆库」。
 *
 * 落点是 `conversation.view`（list 插槽），与内建「对话 / 轨迹」同一排 tab：
 *   · dsh-client-ui-conversation/lib/client.js:19810-19822  ← 每个 conversation.view 条目
 *     直接变成 `{id: options.id, label: resolveSlotLabel(options.label) ?? options.id}` 一个 tab；
 *   · dsh-client-ui-conversation/lib/client.js:20056-20061  ← `conversation.view` 的声明
 *     （kind:"list", scope:"session"），父条目是 `conversation.session`；
 *   · dsh-client-ui-chat/lib/client.js:13256-13266          ← 内建「对话」= id:"chat", order:0；
 *   · dsh-client-ui-trajectory/lib/client.js:8205-8214      ← 内建「轨迹」= id:"trajectory", order:10。
 * 也就是说：**第三方插件自己就能注册会话 tab**，不需要任何 DOM 注入。
 *
 * 职责只有一件：把 0.2 的全部开关和只读健康数据摆出来，写回走宿主 HTTP 路由
 * （见 docs/PANEL-CONTRACT.md，路由表逐字一致）。本文件**不碰库、不碰文件系统**。
 *
 * 四条硬约束（踩过坑，别改）：
 *   1. `id` 必须逐字等于包名 `dsh-mem`。id ≠ 包名会让整个 web boot 不激活这个插件，
 *      症状是「界面进不去」，不是「面板不显示」。
 *   2. 模块顶层只做声明 + `load({...})`；任何取数失败只降级成自己这块的**文字错误**，
 *      React 拿不到时 apply 直接返回，绝不让宿主 boot 跟着炸。
 *   3. 主题跟随宿主：颜色一律 `var(--dsw-*)`，不写死色值。
 *   4. 面板默认**收起**，收起时不发任何请求；点「展开」才拿 /panel/state（一进来就轰 5 个
 *      接口会把窄容器和宿主启动都拖慢，也让冒烟测试分不清"没数据"和"没请求"）。
 */
window.__ModuleLoader__.load({
  id: "dsh-mem",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 只在工厂作用域里解析 react：宿主没给就整体降级，不 throw。 */
    let React = null;
    try { React = require("react"); } catch (e) { React = null; }

    const name = "dsh-mem";
    const inject = ["slots"];              // 只要 slots；webServer / 库读写都在宿主半
    const SLOT = "conversation.view";      // 会话页签插槽（见文件头证据）
    const BASE = "/dsh-mem/panel";         // 路由前缀，与 PANEL-CONTRACT.md 逐字一致
    const h = React && typeof React.createElement === "function" ? React.createElement : null;
    const { useState, useEffect, useCallback, useRef } = React || {};

    // ── 离线兜底值（**不是**真源）：面板显示一律以 /panel/state 的 config 为准，
    //    这里只在取数失败时让控件还有东西可渲染。值必须与 index.mjs 的 DEFAULTS 一致，
    //    由 test/client-smoke.mjs 逐键对账（漂了就红）。
    const DEFAULTS = {
      rerank: "lexical",
      rerankLexical: true,
      episodeEnabled: true,
      episodeClosureMinutes: 10,
      episodeMaxChars: 4000,
      embeddingEnabled: false,
      embeddingModel: "bge-small-zh-v1.5",
      embeddingModelDir: "",
      embeddingFailFast: true,
    };

    const FIELDS = [
      {
        key: "rerank", group: "检索", label: "重排模式", kind: "select",
        options: [["off", "关闭"], ["lexical", "词面（char 2+3gram TF-IDF）"], ["embedding", "向量（需已下载模型）"]],
        hint: "只对候选集重排，不单独作为检索入口。选「向量」而模型没下载时会显式提示，不会静默失败。",
      },
      {
        key: "rerankLexical", group: "检索", label: "词面重排", kind: "switch",
        hint: "关掉后即使模式选「词面」也不重排（结果与 0.1 逐字节一致）。",
      },
      {
        key: "episodeEnabled", group: "情景层", label: "情景层（episode）", kind: "switch",
        hint: "只存 turn 指针区间 + 指纹，不存摘要；证据永远回 mem_open 的原文。",
      },
      {
        key: "episodeClosureMinutes", group: "情景层", label: "闭合静默阈值", kind: "number",
        min: 1, max: 1440, step: 1, unit: "分钟",
        hint: "会话文件 mtime 超过它才算闭合（1–1440，默认 10）。调小 = 更早封段。",
      },
      {
        key: "episodeMaxChars", group: "情景层", label: "单段字数上限", kind: "number",
        min: 200, max: 20000, step: 100, unit: "字",
        hint: "一个 turn 超过它就按单元边界再切（200–20000，默认 4000）。",
      },
      {
        key: "embeddingEnabled", group: "向量层", label: "向量层", kind: "switch",
        hint: "默认关。开之前先下载模型（见下方「向量模型」）。",
      },
      {
        key: "embeddingModel", group: "向量层", label: "模型", kind: "text",
        placeholder: "bge-small-zh-v1.5",
        hint: "默认 bge-small-zh-v1.5（宿主按 MODELS 白名单校验）。换模型必须重建索引。",
      },
      {
        key: "embeddingModelDir", group: "向量层", label: "模型目录", kind: "text",
        placeholder: "留空 = 默认目录",
        hint: "留空就用宿主默认目录；填了就是绝对路径。",
      },
      {
        key: "embeddingFailFast", group: "向量层", label: "模型缺失时立即报错", kind: "switch",
        hint: "关 = 退回词面重排并在面板提示；开 = 直接失败（宁可炸也不写零向量）。",
      },
    ];

    /** 收起态那一行摘要用的最小字段（不请求也能显示的部分只有这些）。 */
    const SUMMARY_FIELDS = [
      { key: "rerank", label: "重排" },
      { key: "episodeEnabled", label: "情景层" },
      { key: "embeddingEnabled", label: "向量层" },
    ];

    /** 只读状态行：缺字段一律「—」，取数函数本身不抛。 */
    const STATUS_ROWS = [
      { label: "库路径", get: (d) => (d.db ? String(d.db) : "—") },
      { label: "库大小", get: (d) => fmtBytes(d.dbBytes) },
      { label: "会话数", get: (d) => fmtNum(d.sessions) },
      { label: "turn 数", get: (d) => fmtNum(d.turns) },
      { label: "epoch", get: (d) => `${fmtTs(d.firstTs)} → ${fmtTs(d.lastTs)}` },
      { label: "episode 数", get: (d) => fmtNum(d.episodes) },
      { label: "已封区间", get: (d) => fmtNum(d.sealed) },
      {
        label: "rerank 生效",
        get: (d) => {
          const r = d.rerank || {};
          const mode = r.effective || r.mode || "off";
          return r.degraded ? `${mode}（已降级：${r.reason || "上游不可用"}）` : String(mode);
        },
      },
      {
        label: "embedding",
        get: (d) => {
          const e = d.embedding || {};
          if (!e.available) return `不可用${e.reason ? `：${e.reason}` : ""}`;
          return e.modelPresent ? `${e.model || "?"} 已就绪` : `${e.model || "?"} 模型未下载${e.reason ? `（${e.reason}）` : ""}`;
        },
      },
      { label: "未覆盖 turn", get: (d) => fmtNum((d.index || {}).uncoveredTurns) },
      { label: "悬空 episode", get: (d) => fmtNum((d.index || {}).danglingEpisodes) },
    ];

    // ── 样式：全用宿主 token，深色/浅色主题自动跟随 ──────────────────────────────
    const S = {
      root: {
        flex: "1 1 auto", minHeight: 0, overflowY: "auto",
        padding: "10px 20px 16px", fontSize: 12,
      },
      // 收起态：一行，够窄也不换行崩掉
      bar: {
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "6px 0", marginBottom: 2,
      },
      barTitle: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" },
      barMeta: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, inherit)" },
      card: {
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))",
        borderRadius: 10, padding: "12px 14px", marginBottom: 12,
      },
      title: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)", marginBottom: 8 },
      row: { display: "flex", gap: 12, alignItems: "baseline", padding: "3px 0", fontSize: 12 },
      keyName: { width: 116, flex: "0 0 auto", color: "var(--dsw-alias-label-secondary, inherit)" },
      val: { color: "var(--dsw-alias-label-primary, inherit)", wordBreak: "break-all" },
      field: { padding: "7px 0", borderTop: "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.18))" },
      label: { display: "block", fontSize: 12, marginBottom: 3, color: "var(--dsw-alias-label-primary, inherit)" },
      hint: { fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary, inherit)", marginTop: 3, whiteSpace: "pre-wrap" },
      err: {
        fontSize: 11, lineHeight: "16px", marginTop: 3, whiteSpace: "pre-wrap",
        color: "var(--dsw-alias-state-business-primary, #c0392b)",
      },
      input: {
        background: "var(--dsw-specific-input-major, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
        borderRadius: 6, padding: "3px 6px", fontSize: 12, minWidth: 220, outline: "none",
      },
      btn: {
        background: "var(--dsw-alias-button-elevated-fill, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
        borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer",
      },
      btnPri: {
        background: "var(--dsw-alias-brand-primary, #4f8cff)",
        color: "var(--dsw-alias-label-primary-foreground, #fff)",
        border: "1px solid var(--dsw-alias-brand-primary, #4f8cff)",
        borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer",
      },
    };

    // ── 纯工具（无状态、不抛）─────────────────────────────────────────────────
    const errText = (e) => {
      const m = e && e.message ? String(e.message) : String(e == null ? "" : e);
      return m.trim() ? m : "未知错误";
    };

    function fmtNum(v) {
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
      if (v == null) return "—";
      return String(v);
    }

    function fmtBytes(n) {
      const x = typeof n === "number" && Number.isFinite(n) ? n : NaN;
      if (!Number.isFinite(x) || x < 0) return "—";
      const units = ["B", "KB", "MB", "GB"];
      let v = x, i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
      return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
    }

    function fmtTs(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 统一取数：非 2xx 把**服务端原文**带出来（面板显示原文，不显示「失败」两个字）。 */
    async function fetchJson(path, init) {
      const opts = { ...(init || {}) };
      if (opts.body != null && !opts.headers) opts.headers = { "content-type": "application/json" };
      const res = await fetch(path, opts);
      let text = "";
      try { text = await res.text(); } catch (e) { text = ""; }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (!res.ok) {
        const msg = (data && (data.error || data.message)) || (text ? text.slice(0, 400) : "") || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    }

    /** 从 state / PUT 响应里挑出面板认识的键，缺的补默认值。 */
    function pickConfig(payload) {
      const src = (payload && (payload.config || payload.settings)) || {};
      const out = { ...DEFAULTS };
      for (const f of FIELDS) {
        if (Object.prototype.hasOwnProperty.call(src, f.key)) out[f.key] = src[f.key];
      }
      return out;
    }

    const IDLE_DL = { status: "idle", percent: 0, received: 0, total: 0, file: "", path: "", error: "" };

    // ── 面板 ────────────────────────────────────────────────────────────────
    function DshMemPanel() {
      const [open, setOpen] = useState(false);      // 默认收起：收起 = 零请求
      const [data, setData] = useState(null);
      const [config, setConfig] = useState(DEFAULTS);
      const [error, setError] = useState("");
      const [loading, setLoading] = useState(false);
      const [saving, setSaving] = useState("");
      const [fieldErrors, setFieldErrors] = useState({});
      const [warning, setWarning] = useState("");
      const [dl, setDl] = useState(IDLE_DL);
      const [job, setJob] = useState({ status: "idle", message: "", error: "" });
      const [confirming, setConfirming] = useState(false);
      const timer = useRef(0);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const d = await fetchJson(`${BASE}/state`);
          setData(d && typeof d === "object" ? d : null);
          setConfig(pickConfig(d));
          setError("");
        } catch (e) {
          setData(null);
          setError(errText(e));
        } finally {
          setLoading(false);
        }
      }, []);

      // 只有「展开」过才取数：收起的页签不发任何请求。
      useEffect(() => {
        if (open) load();
        return () => {
          if (timer.current) { try { clearTimeout(timer.current); } catch (e) { /* ignore */ } timer.current = 0; }
        };
      }, [open, load]);

      const save = async (key, value) => {
        setSaving(key);
        setConfig((c) => ({ ...c, [key]: value }));
        setFieldErrors((m) => ({ ...m, [key]: "" }));
        setWarning("");
        try {
          const r = await fetchJson(`${BASE}/settings`, {
            method: "PUT",
            body: JSON.stringify({ patch: { [key]: value } }),
          });
          if (r && r.config) setConfig(pickConfig({ config: r.config }));
          // 宿主可以对「存下了但没生效」的写入回一条 warning（例如选向量层但模型没下载）。
          if (r && r.warning) setWarning(String(r.warning));
          // 重排/向量开关会改变 state 里的「生效模式 / 可用性」，写完刷一次状态卡。
          if (key.indexOf("rerank") === 0 || key.indexOf("embedding") === 0) load();
        } catch (e) {
          setFieldErrors((m) => ({ ...m, [key]: errText(e) }));
        } finally {
          setSaving("");
        }
      };

      const commitNumber = (f, raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        save(f.key, Math.min(f.max, Math.max(f.min, Math.round(n))));
      };

      function pollDownload(jobId) {
        fetchJson(`${BASE}/models/download?jobId=${encodeURIComponent(jobId)}`)
          .then((r) => {
            const next = {
              status: (r && r.status) || "running",
              percent: (r && r.percent) || 0,
              received: (r && r.received) || 0,
              total: (r && r.total) || 0,
              file: (r && r.file) || "",
              path: (r && r.path) || "",
              error: (r && r.error) || "",
            };
            setDl(next);
            if ((next.status === "running" || next.status === "queued" || next.status === "starting") && typeof setTimeout === "function") {
              timer.current = setTimeout(() => pollDownload(jobId), 1000);
            }
          })
          .catch((e) => setDl((d) => ({ ...d, status: "error", error: errText(e) })));
      }

      async function startDownload() {
        if (timer.current) { try { clearTimeout(timer.current); } catch (e) { /* ignore */ } timer.current = 0; }
        setDl({ status: "starting", percent: 0, received: 0, total: 0, file: "", path: "", error: "" });
        try {
          const r = await fetchJson(`${BASE}/models/download`, {
            method: "POST",
            body: JSON.stringify({ model: config.embeddingModel, modelDir: config.embeddingModelDir }),
          });
          const jobId = r && r.jobId;
          if (!jobId) throw new Error("宿主没有返回 jobId（路由 /dsh-mem/panel/models/download 未接线？）");
          setDl((d) => ({ ...d, status: (r && r.status) || "running" }));
          pollDownload(jobId);
        } catch (e) {
          setDl({ status: "error", percent: 0, received: 0, total: 0, file: "", path: "", error: errText(e) });
        }
      }

      async function doReindex() {
        setConfirming(false);
        setJob({ status: "running", message: "重建中…", error: "" });
        try {
          const r = await fetchJson(`${BASE}/reindex`, { method: "POST", body: "{}" });
          const msg = `完成：turn ${fmtNum(r && r.turns)}｜episode ${fmtNum(r && r.episodes)}｜已封 ${fmtNum(r && r.sealed)}｜${fmtNum(r && r.ms)} ms`;
          setJob({ status: "done", message: msg, error: "" });
          load();
        } catch (e) {
          setJob({ status: "error", message: "", error: errText(e) });
        }
      }

      const renderField = (f) => {
        const v = config[f.key];
        const fe = fieldErrors[f.key];
        const busy = saving === f.key;
        let ctl;
        if (f.kind === "switch") {
          ctl = h("input", {
            type: "checkbox", checked: v === true, disabled: busy,
            onChange: (e) => save(f.key, e.target.checked),
          });
        } else if (f.kind === "select") {
          ctl = h("select", {
            value: v == null ? "" : String(v), disabled: busy, style: S.input,
            onChange: (e) => save(f.key, e.target.value),
          }, f.options.map(([val, text]) => h("option", { key: val, value: val }, text)));
        } else if (f.kind === "number") {
          ctl = h("input", {
            type: "number", min: f.min, max: f.max, step: f.step,
            defaultValue: v == null ? "" : String(v),
            key: `${f.key}:${String(v)}`,
            disabled: busy, style: { ...S.input, minWidth: 96 },
            onBlur: (e) => commitNumber(f, e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") commitNumber(f, e.target.value); },
          });
        } else {
          ctl = h("input", {
            type: "text", placeholder: f.placeholder || "",
            defaultValue: v == null ? "" : String(v),
            key: `${f.key}:${String(v)}`,
            disabled: busy, style: S.input,
            onBlur: (e) => save(f.key, e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") save(f.key, e.target.value); },
          });
        }
        return h("div", { key: f.key, style: S.field },
          h("label", { style: S.label }, f.unit ? `${f.label}（${f.unit}）` : f.label),
          h("div", null, ctl),
          f.hint ? h("div", { style: S.hint }, f.hint) : null,
          fe ? h("div", { style: S.err }, `保存失败：${fe}`) : null,
        );
      };

      const statusCard = h("div", { style: S.card },
        h("div", { style: S.title }, "索引状态"),
        loading ? h("div", { style: S.hint }, "读取中…") : null,
        error
          ? h("div", { style: S.err }, `读取失败：${error}`,
            h("button", { style: { ...S.btn, marginLeft: 8 }, onClick: () => load() }, "重试"))
          : null,
        warning ? h("div", { style: S.hint }, `⚠ ${warning}`) : null,
        data
          ? STATUS_ROWS.map((r) => h("div", { style: S.row, key: r.label },
            h("span", { style: S.keyName }, r.label),
            h("span", { style: S.val }, r.get(data))))
          : null,
      );

      const dlPercent = dl.total > 0
        ? Math.min(100, Math.round((dl.received / dl.total) * 100))
        : Math.max(0, Math.min(100, dl.percent || 0));
      const running = dl.status === "running" || dl.status === "queued" || dl.status === "starting";
      const dlCard = h("div", { style: S.card },
        h("div", { style: S.title }, "向量模型"),
        h("div", { style: S.hint }, `当前模型：${config.embeddingModel || "—"}｜目录：${config.embeddingModelDir || "默认"}`),
        h("div", { style: { marginTop: 8 } },
          h("button", { style: running ? S.btn : S.btnPri, onClick: startDownload, disabled: running }, running ? "下载中…" : "下载模型")),
        running
          ? h("div", { style: S.hint },
            `进度：${dlPercent}%（${fmtBytes(dl.received)} / ${dl.total ? fmtBytes(dl.total) : "未知"}）${dl.file ? `｜${dl.file}` : ""}`)
          : null,
        dl.status === "done" ? h("div", { style: S.hint }, `已下载到 ${dl.path || "（宿主未返回路径）"}`) : null,
        dl.error ? h("div", { style: S.err }, `下载失败：${dl.error}`) : null,
      );

      const jobCard = h("div", { style: S.card },
        h("div", { style: S.title }, "维护"),
        h("div", { style: S.hint }, "重建会重扫会话日志并重切 episode；已封区间不动，只补未覆盖的 turn。"),
        confirming
          ? h("div", { style: { marginTop: 8 } },
            h("span", { style: S.hint }, "确定重建索引？"),
            h("button", { style: { ...S.btnPri, marginLeft: 8 }, onClick: doReindex }, "确认重建"),
            h("button", { style: { ...S.btn, marginLeft: 6 }, onClick: () => setConfirming(false) }, "取消"))
          : h("div", { style: { marginTop: 8 } },
            h("button", { style: S.btn, onClick: () => setConfirming(true), disabled: job.status === "running" },
              job.status === "running" ? "重建中…" : "重建索引")),
        job.message ? h("div", { style: { ...S.hint, marginTop: 6 } }, job.message) : null,
        job.error ? h("div", { style: S.err }, `重建失败：${job.error}`) : null,
      );

      const groups = [];
      for (const f of FIELDS) {
        let g = null;
        for (const cand of groups) if (cand.name === f.group) { g = cand; break; }
        if (!g) { g = { name: f.group, fields: [] }; groups.push(g); }
        g.fields.push(f);
      }

      // 收起态摘要：只读本地兜底值，不联网；打开后换成真实 config。
      const summary = SUMMARY_FIELDS.map((f) => {
        const v = config[f.key];
        const shown = typeof v === "boolean" ? (v ? "开" : "关") : String(v == null ? "—" : v);
        return `${f.label} ${shown}`;
      }).join(" · ");

      const bar = h("div", { style: S.bar },
        h("span", { style: S.barTitle }, "记忆库（dsh-mem）"),
        h("span", { style: S.barMeta }, summary),
        h("button", {
          style: S.btn, onClick: () => setOpen((v) => !v),
          "aria-expanded": open ? "true" : "false",
        }, open ? "收起" : "展开"),
      );

      return h("div", { style: S.root },
        bar,
        open ? statusCard : h("div", { style: S.hint }, "点「展开」读取索引状态与 9 个开关（收起时不发请求）。"),
        open ? groups.map((g) => h("div", { style: S.card, key: g.name },
          h("div", { style: S.title }, g.name),
          g.fields.map(renderField))) : null,
        open ? dlCard : null,
        open ? jobCard : null,
      );
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    function apply(ctx) {
      try {
        if (!h || typeof useState !== "function") {
          try { console.warn("[dsh-mem] 客户端拿不到 react，面板不注册（宿主其余功能不受影响）"); } catch (e) { /* ignore */ }
          return;
        }
        const slots = ctx && ctx.slots;
        if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
          try { console.warn("[dsh-mem] 宿主没有 slots 服务，面板不注册"); } catch (e) { /* ignore */ }
          return;
        }
        // 会话页签：与内建「对话 / 轨迹」同一排（conversation.view 是 list 插槽，id 即 tab id）。
        slots.inject(SLOT, () => slots.register(
          { name: SLOT, id: name, order: 20, label: () => "记忆库" },
          () => h(DshMemPanel, null),
        ));
      } catch (e) {
        try { console.warn("[dsh-mem] 面板注册失败：", errText(e)); } catch (e2) { /* ignore */ }
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    exports.default = apply;
    /** 只读自省面：smoke 测试用它和 lib/settings-schema.js 对账（键集合 + 默认值 + 落点）。 */
    exports.panelMeta = { id: name, slot: SLOT, base: BASE, fields: FIELDS, defaults: DEFAULTS };
    return module.exports;
  },
});
