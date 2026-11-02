/**
 * 固定的 12 条自然语言查询评测集（P0 / P2 的判据都跑这一份）。
 *
 * 口径：
 *   - `q`      用户会真的这么问的整句中文（**不带空格**，即老实现把整句当一个 trigram 短语的那种）
 *   - `answer` 目标轮原文里的一段**唯一**子串（答案已知 = 这段字只出现在那一轮里）
 *   - 判定      R@3：`run(q, 3)` 的 3 条结果里，任一结果的**整轮原文**包含 `answer` 即算命中
 *
 * 为什么用 `answer` 而不是写死 turn id：库是可丢弃重建的派生索引，id 会变；
 * 而"答案原话"不随重建变化，这也逼着评测跟着原文走（I3：证据永远是原文）。
 * `run(q, k)` 由调用方提供，必须返回 `{ mode, hits, rows: [{ pointer, text }] }`（text = 整轮原文）。
 */
export const QUERIES12 = [
  { q: '视频莫名打不开是什么原因', answer: 'H.265 解码器' },
  { q: '插件更新以后版本落后了要怎么办', answer: 'update-blocked: refused while agents are running' },
  { q: '控制台里的方块和乱码是怎么来的', answer: '代码页是 936' },
  { q: '进程还活着但一直卡住不动', answer: '看不见的对话框' },
  { q: '字体的覆盖率怎么逐个查表确认', answer: '直接读字体的 cmap 表' },
  { q: '转写模型加载失败缺什么后端', answer: 'fbank 特征提取后端' },
  { q: '分支上的高性能版本还在不在', answer: 'feature/high-performance' },
  { q: '视频工具依赖的二进制从哪里取', answer: '从 npm 包中取出静态二进制' },
  { q: '固定一个静态地址要用什么命令', answer: 'Set-NetIPInterface -Dhcp Enabled' },
  { q: '登录失败是因为端口每次随机', answer: '每条 cookie 的名字都是按' },
  { q: '什么时候开始返回鉴权错误的', answer: '401 从 2026-10-30 05:36 就开始了' },
  { q: '这个插件需要有个开关能关掉', answer: '但是要有开关能在特定任务取消' },
];

/** R@3：三条结果的整轮原文里有没有包含答案原话。 */
export function recallAt3(run, queries = QUERIES12, k = 3) {
  const rows = [];
  let hit = 0;
  for (const { q, answer } of queries) {
    const r = run(q, k);
    const ok = (r.rows || []).some((x) => String(x.text ?? '').includes(answer));
    if (ok) hit++;
    rows.push({ q, ok, mode: r.mode, hits: r.hits, answer, got: (r.rows || []).map((x) => x.pointer) });
  }
  return { r3: +(hit / queries.length).toFixed(3), hit, n: queries.length, rows };
}
