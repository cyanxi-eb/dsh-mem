# 面板契约（dsh-mem → 宿主会话页签「记忆库」）

> 读者：写 `index.mjs` / `package.json` / `cordis.patch.yml` 的人（本文件只描述**别人要接的线**，
> 不改那些文件）。客户端半已就位：`lib/client.js`（面板 UI）+ `lib/settings-schema.js`（设置真源）。
>
> 现状：**面板已挂上会话页签**。落点 `conversation.view`（list 插槽，与内建「对话 / 轨迹」同一排 tab）：
> `lib/client.js` 注册 `{ name:"conversation.view", id:"dsh-mem", order:20, label:()=>"记忆库" }`。
> 宿主出处（改版时按这三处核）：
> - `dsh-client-ui-conversation/lib/client.js:19810-19822` —— 每个 `conversation.view` 条目 → 一个 tab
>   （`{id: options.id, label: resolveSlotLabel(options.label) ?? options.id}`）；
> - `dsh-client-ui-conversation/lib/client.js:20056-20061` —— 插槽声明（`kind:"list"`, `scope:"session"`）；
> - 同排的两个内建：`dsh-client-ui-chat/lib/client.js:13256`（`id:"chat"`）、
>   `dsh-client-ui-trajectory/lib/client.js:8205`（`id:"trajectory"`，zh 词条 `view.trajectory` = 轨迹）。
>
> **不要把面板往 `settings.section` 注册**：宿主没有这个插槽（全量 grep 零命中），注册进去永远不渲染。
> 路由：`index.mjs` 用 `ctx.inject(["webServer"], host => host.effect(...))` 动态挂下面 5 条，
> `node test/routes.test.mjs` 逐条跑 handler。默认值只剩一份：`index.mjs` 的 `DEFAULTS`
> （本文件 §2 的表与它逐键相等，由测试 ⑥ 看住）。

## 1. 路由表

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 1 | GET | `/dsh-mem/panel/state` | 只读健康数据 + 当前生效 config + 能力探测 |
| 2 | PUT | `/dsh-mem/panel/settings` | 按 key 写回 config（body `{patch:{...}}`） |
| 3 | POST | `/dsh-mem/panel/models/download` | 启动模型下载任务，返回 `jobId` |
| 4 | GET | `/dsh-mem/panel/models/download?jobId=…` | 轮询进度（1s 一次） |
| 5 | POST | `/dsh-mem/panel/reindex` | 重建索引（面板已带二次确认） |

全部由 `ctx.inject(["webServer"], (host) => host.effect(() => host.webServer.register({ kind:"exact", path, handler }), "dsh-mem: panel routes"))`
注册（`register` 的 disposer 交给 effect cleanup，卸载 = 端口上不留残废路由），与 `dsh-purge` 同一套写法。
**静态 `inject` 里不放 `webServer`** —— 宿主里它是后挂服务，静态依赖会让 `apply` 等它，症状是
`/dsh-mem/panel/state` 一直 404（同一端口的 `/dsh-purge/*` 却是 200，因为 purge 用的是动态注入）。
客户端用**同源相对路径**取数 —— 路由必须挂在 GUI 所在的 webServer 上，不是另开端口。
响应一律 `application/json; charset=utf-8`。
错误形状统一：`{ "error": string, "code"?: string, "detail"?: string }`；非 2xx 时面板显示 `error` **原文**。

### 1.1 `GET /dsh-mem/panel/state` → 200

```json
{
  "db": "C:\\Users\\test\\.dsh\\mem\\<workspace>-dsh-mem.db",
  "dbBytes": 1365000,
  "sessions": 19, "turns": 266,
  "firstTs": 1761000000000, "lastTs": 1761200000000,
  "episodes": 66, "sealed": 22,
  "index": { "uncoveredTurns": 0, "danglingEpisodes": 0 },
  "rerank": { "mode": "lexical", "effective": "lexical", "degraded": false, "reason": "" },
  "embedding": { "enabled": false, "available": true, "model": "bge-small-zh-v1.5",
                 "modelDir": "C:\\...\\models", "modelPresent": false, "reason": "" },
  "config": { "rerank": "off", "rerankLexical": true, "episodeEnabled": true,
              "episodeClosureMinutes": 10, "episodeMaxChars": 4000,
              "embeddingEnabled": false, "embeddingModel": "bge-small-zh-v1.5",
              "embeddingModelDir": "", "embeddingFailFast": false }
}
```

- `firstTs/lastTs` 是 epoch 毫秒（`core.stats` 的 `firstTs/lastTs`）。
- `episodes` / `sealed` / `index.*` 由 episode 覆盖 pass 现算（`sealed` = `seal=1` 的行数）。
- `rerank.effective` 必须与 `lib/settings-schema.js` 的 `effectiveRerank()` 同源（别手抄一份）。
- `embedding.available` = `embed.isAvailable()`（推理依赖能不能 import）；
  `modelPresent` / `reason` / `modelDir` = `embed-models.modelState(cfg)` 的 `ok` / `reason` / `dir`
  （它按 manifest + 逐文件大小校验，比"目录存在"严格）。
- 库不存在（还没 ingest）不是错误：回 200，计数全 0，`db` 照给路径。真读不了才 500 + `error`。

### 1.2 `PUT /dsh-mem/panel/settings`

请求：`{ "patch": { "episodeClosureMinutes": 15 } }`（1–9 个键，白名单见 §2）。
200：`{ "config": { …完整 9 键… }, "ignored": ["未知键1", …], "warning": "可选" }`。
`warning` 的用途：**值存下了但没生效**要说清楚（面板在状态卡上方原样显示），典型是
`rerank=embedding` 而模型没下载 → `warning: "向量模型未下载，当前退回词面重排"`（`config.rerank` 仍是 `embedding`）。
`embeddingFailFast=true` 时改为 **409** `{ "error": "向量模型未下载：<modelDir>", "code": "model-missing", "model": "...", "modelDir": "..." }`
（口径：用户自己选了"宁可炸"）。落盘前必须过 `sanitizePanelConfig(patch, 当前config)`。

### 1.3 `POST /dsh-mem/panel/models/download`

请求：`{ "model": "bge-small-zh-v1.5", "modelDir": "" }`（`modelDir` 空 = `embed-models.modelBaseDir()`）。
实现直接包 `embed-models.ensureModelDir(cfg, onProgress)`（它已带多源回退、逐文件校验、manifest、自检），
**不要**在路由里重写下载逻辑。模型 id 必须过 `MODELS` 白名单，未知 → 400
`{ "error": "未知的 embeddingModel: xxx（可选: bge-small-zh-v1.5）", "code": "ERR_MODEL_UNKNOWN" }`。
202：`{ "jobId": "dl-<stamp>", "status": "running" }`；已有任务在跑 → 409 `{ "error": "已有下载任务在跑", "code": "busy", "jobId": "…" }`。

### 1.4 `GET /dsh-mem/panel/models/download?jobId=…`

200：`{ "jobId": "…", "status": "running|done|error", "file": "onnx/model_int8.onnx",
"received": 31457280, "total": 94371840, "percent": 33, "path": "C:\\...\\models\\bge-small-zh-v1.5", "error": "" }`。
字段映射：`onProgress({file,received,total,pct})` → `file/received/total/percent`（`pct` 可能为 null，
面板会按 `received/total` 自算）；`status=done` 时 `path` = `ensureModelDir()` 的返回值。
`status=error` 时 `error` 必须是 `EmbedError.message` **原文**（它已经把每个源的失败原因拼好了）——
面板只显示这一行，不翻译成"失败"。未知/过期 jobId → 404 `{ "error": "未知 jobId" }`。

### 1.5 `POST /dsh-mem/panel/reindex`

请求 `{}`。200：`{ "ok": true, "turns": 12, "episodes": 3, "sealed": 1, "ms": 834 }`
（增量 ingest 的写入行数 + 本轮新切/新封的 episode 数）。并发触发 → 409 `{ "error": "重建正在进行", "code": "busy" }`。

## 2. 设置项（config key / 类型 / 默认 / 边界）

| key | 类型 | 默认 | 边界 |
|---|---|---|---|
| `rerank` | enum | `lexical` | `off` / `lexical` / `embedding` |
| `rerankLexical` | boolean | `true` | — |
| `episodeEnabled` | boolean | `true` | — |
| `episodeClosureMinutes` | integer | `10` | 1–1440 |
| `episodeMaxChars` | integer | `4000` | 200–20000 |
| `embeddingEnabled` | boolean | `false` | — |
| `embeddingModel` | string | `bge-small-zh-v1.5` | `embed-models.MODELS` 白名单（当前仅 `bge-small-zh-v1.5`） |
| `embeddingModelDir` | string | `""` | ≤512；空 = 默认目录 |
| `embeddingFailFast` | boolean | `false` | — |

真源是 `index.mjs` 的 `DEFAULTS`；`lib/settings-schema.js` 只留 `BOUNDS` / `PANEL_KEYS` / `sanitizePanelConfig`
（默认值传 `base` 进去，文件里不再存一份）。九键是否两处一致由 `test/routes.test.mjs` ⑥ 逐键对账
（`/panel/state` 的 config ↔ `cordis.patch.yml` 的 config）；客户端 UI 表在 `lib/client.js`，键集合由
`test/client-smoke.mjs` ② 对账。
**生效模式**语义（`effectiveRerank`）：`off` → 不重排；`lexical` 受 `rerankLexical` 支配（关 = off + degraded）；
`embedding` 在模型缺失时**不假装成功**：有词面就退 `lexical`（degraded + reason），否则 `off`。

## 3. 需要别人接线（逐条，本文件作者没动这些文件）

1. **`package.json`**
   - `exports` 加 `"./client": "./lib/client.js"`（缺了 = 浏览器永不加载面板）。
   - `dsh.client` 加 `{ "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"], "immediately": true }`。
   - `files` 已含 `lib/`；若要发文档再加 `"docs/"`。
2. **`index.mjs`**
   - `inject` **只留 `'tools'`**；`webServer` 用 `ctx.inject(["webServer"], …)` 动态注入（见 §1 的写法）。
   - 启动时把面板落盘值叠到 loader config 上：`{ ...normalizeConfig(config), ...sanitizePanelConfig(读盘).config }`，
     9 个键透传给 `core` / 工具；`DEFAULTS` 直接 spread `PANEL_DEFAULTS`。
   - 注册 §1 的 5 条路由（`kind:"exact"`），`host.effect` 收尾；注册成功打一行
     `console.log("[dsh-mem] panel routes registered: /dsh-mem/panel/*")`，失败打 error 带原文。
   - 持久化：`$DSH_HOME/mem/panel-config.json`，写 tmp 再 `rename`（原子）。**不要去改 profile 里的
     `cordis.patch.yml`** —— 那是安装产物，重装即回滚。
3. **`cordis.patch.yml`**：现有 `config:` 块补上 §2 的 9 个键（值 = `PANEL_DEFAULTS`），注释写"面板可改"。
4. **`lib/core.mjs`（0.2 实现侧）**：`state` 需要的 `episodes` / `sealed` / `uncoveredTurns` /
   `danglingEpisodes` 四个数、reindex 入口（ingest + episode 覆盖 pass，返回本轮计数）。
   embedding 那侧已经落地，直接用：`embed.isAvailable()`、`embed-models.modelState()`、`ensureModelDir()`。
   面板不直接读库，这些全部经路由暴露。
5. **`README.md`**：入口写「会话页签 → 记忆库（dsh-mem）」（**不是**设置页；设置页在宿主里没有 `settings.section` 插槽）。

## 4. 冒烟验收（不重启宿主）

```powershell
cd D:\dsh-sp1\dsh-mem
node --check lib/client.js
node --check lib/settings-schema.js
node test/client-smoke.mjs
node test/routes.test.mjs
```

`test/client-smoke.mjs` mock `window.__ModuleLoader__` + `react` + `fetch`，用迷你 renderer
**真的展开面板的元素树**，断言：① 注册 id 逐字等于包名 `dsh-mem`（踩过事故：id ≠ 包名会让整个 web boot
不激活），且落点逐字等于 `conversation.view`；② 收起态零请求、点「展开」只拉 `/panel/state` 一条，
然后 ≥8 个设置项控件且字段表与 `settings-schema` 一致；③ 取数抛错时不炸、降级成
`读取失败：<原文>`；④ 越界值被收束、未知键进 `ignored`。

它**证明不了**的只有一件事：宿主是否加载了客户端半 —— 那取决于 §3.1 的 `exports`/`dsh.client`，
改完需要刷新页面（不必重启 dsh）。

## 5. 有意的降级（别"修"成中断）

- 面板默认**收起**：收起态零请求，点「展开」才拉 `/panel/state`（一进来不发 5 个接口）。
- 任一取数失败：状态卡显示 `读取失败：<原文>` + 重试按钮，设置控件照常渲染（默认值可用）。
- `require("react")` 失败 / 宿主无 `slots`：`apply` 打 warning 后直接返回，不注册面板、不抛。
- 模块顶层只有声明与 `load({ id, factory })`，没有任何 IO —— 面板坏掉不牵连宿主 boot。
