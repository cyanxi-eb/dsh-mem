---
name: dsh-mem
description: 从本机 DSH 会话日志（session.v4.jsonl.zstd）按原话检索历史——回忆上次说过什么、查某个决定/报错/路径/版本出处在哪、要"原话"而不是结论时用它。只回 sessionId#seq 指针 + 原文切片（零依赖、零 API、零常驻，插件内 4 个工具 + 同名 CLI）。
whenToUse: 用户说"上次那个…""我们之前决定过什么""找一下当时说的原话/报错/退出码/路径/版本""这结论哪一轮定的"，或你要为某个断言找回原文证据时。也用于盘点：本工作区历史里到底聊过几次某主题；以及把一份 .md/.txt 搬进本地记忆、导出/导入迁移。
---

# dsh-mem — 本地记忆层（指针 + 原文，无 LLM）

真相源是 DSH 自己写的只追加日志；本工具只做派生索引，库在 `$DSH_HOME/mem/<hash8>-<目录名>.db`
（`DSH_HOME` 缺省 `~/.dsh`，**永不写进仓库**）。插件装好后直接用 `dsh-mem`；没装插件时
`node <本插件仓库>/bin/dsh-mem.mjs` 是同一份实现。

## 命令（真实用法）

```powershell
dsh-mem ingest [--all] [--dry-run]                 # 增量入库；--all 忽略水位全量重扫
dsh-mem search "dsh-purge 四层体检" --k 8          # 每条: score  sessionId#seq  [user|asst]  原文≤120字
dsh-mem open "07f38d2c-22f6-40d3-b11d-a41f176a25c2#seq=293" --context 2   # 按指针取回原文，可带前后各 N 轮
dsh-mem stats [--json]                             # 会话数 / 轮次 / 库大小 / 水位
dsh-mem ingest --file notes.md --source notes      # 吃 .md/.txt/.jsonl，按段落切块入库
dsh-mem export --out mem.ndjson                    # 首行 header + 一行一个 turn
dsh-mem import mem.ndjson [--dry-run]              # 校验 schema、幂等
dsh-mem selftest                                   # 14 项自检（临时库，不碰真库）
```

`ingest` 默认覆盖**全部**会话（不按文件大小抽样），重复跑幂等（`UNIQUE(session,seq)` + `INSERT OR IGNORE`），
`stats` 轮次不变；多进程同时 `ingest` 抢 `<db>.lock`，抢不到就打印并跳过，不崩。
退出码：`0` 正常 / `1` 用法 / `2` 指针不存在（附最近 3 个候选）/ `3` 读不到输入（sessions 目录、库、空库）/ `4` 解压损坏。
空结果**不算成功**：空库、目录不存在一律非 0 退出并说明原因。

## 三条不变量

- **I1 原文永不改写**：`turn.text` 是源记录 `content[].text` 的逐字镜像，只 INSERT，永不 UPDATE。
- **I2 索引可丢弃**：删掉 `.db` 重跑 `ingest` 100% 重建；不存在"只有库里才有"的事实。
- **I3 只回指针 + 原文切片**：返回 `(sessionId, seq)` + 子串；不摘要、不转述、不补全、不推断。0 命中就返回 0。

> **红线**：这里只回指针和原文；不许把检索结果转述成结论后再断言——转述就是记忆退化的入口。

## 取舍（实测踩出来的，别改回去）

- FTS5 必须 `tokenize='trigram'`：`unicode61` 对中文只在被空白/标点切开时命中；`NEAR` 在 trigram 下失效，多词只能 `AND`。
- `bm25()` 不能出现在 UNION 子查询里（报 `unable to use function bm25 in the requested context`）：FTS 与 LIKE 两条语句分开跑，在 JS 里合并排序。
- <3 字符的词（"提权"）trigram 索引无效，走 `text LIKE '%…%'` 兜底。
- 多帧 zstd：单次 `zstdDecompressSync` 已解全部帧，且对截断抛 `Z_BUF_ERROR`；逐帧 fallback 只在它抛错后跑——中途帧坏 → 报错退出 `4`；尾帧不完整（会话正在写）→ 打 `[warn]` 且**不推进水位**，下次重读，绝不静默丢数据。

## 用的时候

- 先 `search` 拿指针，再 `open` 取原话。`search` 的切片只用来判断"要不要展开"，**证据永远是 `open` 的输出**。
- 回答"上次说过什么"时，给出能被对方自己 `open <指针>` 复核的引用；回不到原话就说"库里没有"，不要说"大概/应该是"。
- 检索范围：真用户轮（`source.kind==='user'`）+ 助手可见正文。注入的 runtime-context / skill-catalog / reasoning / tool-call 不入库。
- 不在目标工作区时用 `--workspace <path>` 指定；一工作区一库，按 `<hash8>-<目录名>.db` 分片。
- 插件里对应工具：`mem_search` / `mem_open` / `mem_ingest` / `mem_stats`，参数更少（`query,k` / `pointer,context`）。

## 隐私闸（入库前）

```powershell
dsh-mem ingest --dry-run --redact 'sk-[A-Za-z0-9]{20,}' --exclude '*scratch*'
# → 将入库 N 条、命中 redact M 条、跳过 X 个路径；未写库
```

插件里配 `config.redact` / `config.excludePaths`；命中 redact 的整段替换成 `[redacted]`，
命中 excludePaths 的会话/文件不解析、不入库、不写水位。

## 改完先跑这个

```powershell
dsh-mem selftest    # 14 项：解码/抽取/幂等/trigram/LIKE/0命中/open/坏指针/空库/水位/redact/excludePaths
node --test         # 25 项：含 round-trip、插件加载、与老实现逐字节等价
```

改完再跑一次 `ingest` + `stats`，轮次应与改之前一致。

## 能 / 不能

- **能**：找回本工作区历史对话里的原话、决定、报错、路径、版本号，给出可复核指针；查"上次说过什么""这题聊过几次"；任意中文子串命中；把纯文本搬进库；NDJSON 导出/导入迁移。
- **不能**：跨工作区检索（一库一片）、语义/同义词（纯子串 trigram，换个说法就不命中）、摘要与推理（有意不做）、跨会话去重与矛盾仲裁（新旧原样并排，由人看原文裁决）；`fact` 表只影响排序且不导出，`prune`（降权淘汰）尚未实现。
