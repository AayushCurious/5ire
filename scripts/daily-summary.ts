// scripts/daily-summary.ts
// 运行前：确保在 GitHub Actions 或本地 shell 中已设置：
//   - OPENAI_API_KEY：LLM 密钥（可替换为企业网关）
//   - OPENAI_BASE_URL：LLM API 地址（可替换为自建网关）
//   - LARK_WEBHOOK_URL：飞书自定义机器人 Webhook （也可替换为其他通知 Webhook ）
// 可选：
//   - PER_BRANCH_LIMIT：每个分支最多统计的"今日提交"条数（默认 200）
//   - DIFF_CHUNK_MAX_CHARS：单次送模的最大字符数（默认 80000）
//   - MODEL_NAME：指定模型名称（默认 gpt-4.1-mini）
//   - REPO：owner/repo（Actions 内自动注入）
//   - API_STYLE："azure"（默认，兼容旧行为）或 "openai"（标准 /v1/chat/completions 路径）
//   - BRANCH_CONCURRENCY：并发拉取分支提交的并发数（默认 8）
//   - COMMIT_CONCURRENCY：并发向 LLM 请求摘要的提交并发数（默认 4）
//   - CHUNK_CONCURRENCY：单个提交内并发处理 diff 分片的并发数（默认 3）
//   - LLM_TIMEOUT_MS：单次 LLM 请求超时（默认 60000）
//   - LLM_RETRIES：单次 LLM 请求失败重试次数（默认 2）

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";

const execFileAsync = promisify(execFile);

// ------- 环境变量 -------
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL || "";
const REPO = process.env.REPO || ""; // e.g. "org/repo"
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4.1-mini";
const PER_BRANCH_LIMIT = parseInt(process.env.PER_BRANCH_LIMIT || "200", 10);
const DIFF_CHUNK_MAX_CHARS = parseInt(process.env.DIFF_CHUNK_MAX_CHARS || "80000", 10);
const API_STYLE = (process.env.API_STYLE || "azure").toLowerCase(); // "azure" | "openai"
const BRANCH_CONCURRENCY = parseInt(process.env.BRANCH_CONCURRENCY || "8", 10);
const COMMIT_CONCURRENCY = parseInt(process.env.COMMIT_CONCURRENCY || "4", 10);
const CHUNK_CONCURRENCY = parseInt(process.env.CHUNK_CONCURRENCY || "3", 10);
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || "60000", 10);
const LLM_RETRIES = parseInt(process.env.LLM_RETRIES || "2", 10);

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// ------- 工具函数 -------

/**
 * Runs a shell command asynchronously (non-blocking) and returns trimmed stdout.
 * Uses execFile with `sh -c` so multiple invocations can run concurrently
 * instead of blocking the event loop like execSync does.
 * @param {string} cmd - The shell command to execute
 * @returns {Promise<string>} The trimmed stdout output from the command
 */
async function sh(cmd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", cmd], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 200, // 200MB, diffs can be large
    });
    return stdout.trim();
  } catch (e: any) {
    // Mirrors the previous `|| true` fallback behavior used throughout the script:
    // callers rely on empty string rather than a thrown error for "no output" cases.
    return (e?.stdout ? String(e.stdout) : "").trim();
  }
}

/**
 * Simple bounded-concurrency task runner (no external deps).
 * @param {number} concurrency - Max number of tasks running at once
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>} A limiter function
 */
function pLimit(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const run = queue.shift()!;
    run();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

// ------- 分支与提交收集（覆盖 origin/* 全分支）-------
const since = "midnight"; // 受 TZ=America/Los_Angeles 影响
const until = "now";
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/**
 * Represents metadata for a git commit
 */
type CommitMeta = {
  /** The commit SHA hash */
  sha: string;
  /** The commit title/message */
  title: string;
  /** The commit author name */
  author: string;
  /** The URL to view the commit */
  url: string;
  /** Array of branch names that contain this commit */
  branches: string[]; // 该提交归属的分支集合
};

const FILE_EXCLUDES = [
  ":!**/*.lock",
  ":!**/dist/**",
  ":!**/build/**",
  ":!**/.next/**",
  ":!**/.vite/**",
  ":!**/out/**",
  ":!**/coverage/**",
  ":!package-lock.json",
  ":!pnpm-lock.yaml",
  ":!yarn.lock",
  ":!**/*.min.*",
];

/**
 * Gets the diff for a commit in a single git call. Uses `diff-tree --root`
 * so both root commits and normal commits are handled without a separate
 * `rev-list --parents` + `hash-object` lookup (previously 2 extra spawns/commit).
 * @param {string} sha - The commit SHA to get the diff for
 * @returns {Promise<string>} The git diff output
 */
async function getDiff(sha: string): Promise<string> {
  const excludes = FILE_EXCLUDES.join(" ");
  return sh(
    `git diff-tree --root -p --no-commit-id -r --unified=0 --minimal ${sha} -- . ${excludes}`,
  );
}

/**
 * Splits a git patch into separate file parts
 * @param {string} patch - The git patch content
 * @returns {string[]} Array of individual file patches
 */
function splitPatchByFile(patch: string): string[] {
  if (!patch) return [];
  const parts = patch.split(/^diff --git.*$/m);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Chunks an array of strings by character size limit
 * @param {string[]} parts - Array of strings to chunk
 * @param {number} limit - Maximum character limit per chunk
 * @returns {string[]} Array of chunked strings
 */
function chunkBySize(parts: string[], limit = DIFF_CHUNK_MAX_CHARS): string[] {
  const out: string[] = [];
  let buf = "";
  // eslint-disable-next-line no-restricted-syntax
  for (const p of parts) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length > limit) {
      if (buf) out.push(buf);
      if (p.length > limit) {
        for (let i = 0; i < p.length; i += limit) {
          out.push(p.slice(i, i + limit));
        }
        buf = "";
      } else {
        buf = p;
      }
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ------- OpenAI Chat API -------

// Reused keep-alive agent so repeated chat() calls (one per diff chunk, one
// per commit merge, one for the daily rollup) don't each pay a fresh
// TCP/TLS handshake — meaningful savings when a day has many commits.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

/**
 * Represents the payload structure for OpenAI Chat API
 */
type ChatPayload = {
  /** The model name to use */
  model: string;
  /** Array of chat messages */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** Temperature setting for response randomness */
  temperature?: number;
};

/**
 * Sends a single chat request to the configured LLM endpoint (no retry).
 * @param {string} prompt - The prompt to send to the AI
 * @returns {Promise<string>} The AI response content
 */
function chatOnce(prompt: string): Promise<string> {
  const payload: ChatPayload = {
    model: MODEL_NAME,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  };
  const body = JSON.stringify(payload);
  const url = new URL(OPENAI_BASE_URL);

  const path =
    API_STYLE === "azure"
      ? `/openai/deployments/${MODEL_NAME}/chat/completions?api-version=2024-12-01-preview`
      : `/v1/chat/completions`;

  const headers: Record<string, string> =
    API_STYLE === "azure"
      ? {
          "Content-Type": "application/json",
          "api-key": OPENAI_API_KEY,
          "Content-Length": String(Buffer.byteLength(body)),
        }
      : {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Length": String(Buffer.byteLength(body)),
        };

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        agent: keepAliveAgent,
        hostname: url.hostname,
        path,
        method: "POST",
        headers,
        timeout: LLM_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d; // FIX: previous version discarded chunks (`data` was never reassigned),
          // so JSON.parse always threw and every chat() call effectively failed.
        });
        res.on("end", () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              const json = JSON.parse(data);
              const content = json?.choices?.[0]?.message?.content?.trim() || "";
              resolve(content);
            } else {
              reject(new Error(`LLM HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`LLM request timed out after ${LLM_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Sends a chat request with bounded retry + exponential backoff, so a
 * single transient network/API error doesn't sink an otherwise-good run.
 * @param {string} prompt - The prompt to send to the AI
 * @returns {Promise<string>} The AI response content
 */
async function chat(prompt: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await chatOnce(prompt);
    } catch (e) {
      lastErr = e;
      if (attempt < LLM_RETRIES) {
        const backoffMs = 500 * 2 ** attempt;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

// ------- 提示词 -------
/**
 * Generates a prompt for analyzing a commit diff chunk
 * @param {CommitMeta} meta - The commit metadata
 * @param {number} partIdx - The current part index (1-based)
 * @param {number} total - Total number of parts
 * @param {string} patch - The diff patch content
 * @returns {string} The formatted prompt
 */
function commitChunkPrompt(meta: CommitMeta, partIdx: number, total: number, patch: string) {
  return `你是一名资深工程师与发布经理。以下是提交 ${meta.sha.slice(0, 7)}（${meta.title}）的 diff 片段（第 ${partIdx}/${total} 段），请用中文输出结构化摘要：

提交信息：
- SHA: ${meta.sha}
- 标题: ${meta.title}
- 作者: ${meta.author}
- 分支: ${meta.branches.join(", ")}
- 链接: ${meta.url}

要求输出：
1) 变更要点（面向工程师与产品）：列出此片段涉及的主要改动与意图
2) 影响范围：模块/接口/关键文件
3) 风险&回滚点
4) 测试建议
注意：仅基于当前片段，不要臆测；不要贴长代码；如果只是格式化/重命名也请明确指出。

=== DIFF PART BEGIN ===
${patch}
=== DIFF PART END ===`;
}

/**
 * Generates a prompt for merging multiple commit chunk summaries
 * @param {CommitMeta} meta - The commit metadata
 * @param {string[]} parts - Array of chunk summaries to merge
 * @returns {string} The formatted prompt
 */
function commitMergePrompt(meta: CommitMeta, parts: string[]) {
  const joined = parts.map((p, i) => `【片段${i + 1}】\n${p}`).join("\n\n");
  return `下面是提交 ${meta.sha.slice(0, 7)} 的各片段小结，请合并为**单条提交**的最终摘要（中文），输出以下小节：
- 变更概述（不超过5条要点）
- 影响范围（模块/接口/配置）
- 风险与回滚点
- 测试建议
- 面向用户的可见影响（如有）

请避免重复、合并同类项，标注"可能不完整"当某些片段缺失或被截断。

=== 片段小结集合 BEGIN ===
${joined}
=== 片段小结集合 END ===`;
}

/**
 * Generates a prompt for creating a daily summary report
 * @param {string} dateLabel - The date label for the report
 * @param {Array} items - Array of commit metadata and summaries
 * @param {string} repo - The repository name
 * @returns {string} The formatted prompt
 */
function dailyMergePrompt(dateLabel: string, items: { meta: CommitMeta; summary: string }[], repo: string) {
  const body = items
    .map(
      (it) =>
        `[${it.meta.sha.slice(0, 7)}] ${it.meta.title} — ${it.meta.author} — ${it.meta.branches.join(", ")}\n${it.summary}`,
    )
    .join("\n\n---\n\n");

  return `请将以下"当日各提交摘要"整合成**当日开发变更日报（中文）**，输出结构如下：
# ${dateLabel} 开发变更日报（${repo})
1. 今日概览（不超过5条）
2. **按分支**的关键改动清单（每条含模块/影响、是否潜在破坏性）
3. 跨分支风险与回滚策略（如同一提交在多个分支、存在 cherry-pick/divergence）
4. 建议测试与验证清单
5. 其他备注（如重构/依赖升级/仅格式化）

=== 当日提交摘要 BEGIN ===
${body}
=== 当日提交摘要 END ===`;
}

// ------- 飞书 Webhook -------
/**
 * Posts a message to Lark (Feishu) webhook
 * @param {string} text - The text content to send
 * @returns {Promise<void>} Promise that resolves when the message is sent
 */
async function postToLark(text: string) {
  if (!LARK_WEBHOOK_URL) {
    console.log(`LARK_WEBHOOK_URL 未配置，以下为最终日报文本：\n\n${text}`);
    return;
  }
  const payload = JSON.stringify({ msg_type: "text", content: { text } });
  await new Promise<void>((resolve, reject) => {
    const url = new URL(LARK_WEBHOOK_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) },
      },
      (res) => {
        let respBody = "";
        res.on("data", (d) => { respBody += d; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Lark webhook HTTP ${res.statusCode}: ${respBody.slice(0, 300)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ------- 主流程 -------
(async () => {
  // 拉全远端（建议在 workflow 里执行：git fetch --all --prune --tags）
  // 这里再次保险 fetch 一次，避免本地调试遗漏
  await sh(`git fetch --all --prune --tags`);

  // 列出所有 origin/* 远端分支，排除 origin/HEAD
  const remoteBranches = (
    await sh(`git for-each-ref --format="%(refname:short)" refs/remotes/origin`)
  )
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => Boolean(s) && s !== "origin/HEAD");

  // 并发拉取各分支今日提交（有界并发，避免一次性打开过多子进程）
  const limitBranch = pLimit(BRANCH_CONCURRENCY);
  const branchEntries = await Promise.all(
    remoteBranches.map((rb) =>
      limitBranch(async () => {
        const out = await sh(
          `git log ${rb} --no-merges --since="${since}" --until="${until}" --pretty=format:%H --reverse`,
        );
        const shas = out.split("\n").map((s) => s.trim()).filter(Boolean);
        return [rb, shas.slice(-PER_BRANCH_LIMIT)] as const;
      }),
    ),
  );
  const branchToCommits = new Map<string, string[]>(branchEntries);

  // 反向映射：提交 → 出现的分支集合
  const shaToBranches = new Map<string, Set<string>>();
  // eslint-disable-next-line no-restricted-syntax
  for (const [rb, shas] of branchToCommits) {
    // eslint-disable-next-line no-restricted-syntax
    for (const sha of shas) {
      if (!shaToBranches.has(sha)) shaToBranches.set(sha, new Set());
      shaToBranches.get(sha)!.add(rb);
    }
  }

  // 在所有分支联合视图中获取今天的提交（按时间从早到晚），一次性带出 title/author，
  // 避免此前对每个提交再单独调用两次 `git show`（省下 2×N 次子进程）
  const rawLog = await sh(
    `git log --no-merges --since="${since}" --until="${until}" --all --pretty=format:"%H${FIELD_SEP}%s${FIELD_SEP}%an${RECORD_SEP}" --reverse`,
  );

  type LogRecord = { sha: string; title: string; author: string };
  const allRecordsOrdered: LogRecord[] = rawLog
    .split(RECORD_SEP)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, title, author] = rec.split(FIELD_SEP);
      return { sha, title: title ?? "", author: author ?? "" };
    });

  const seen = new Set<string>();
  const serverUrl = "https://github.com";
  const commitMetas: CommitMeta[] = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const rec of allRecordsOrdered) {
    if (seen.has(rec.sha)) continue;
    if (!shaToBranches.has(rec.sha)) continue; // 仅统计出现在 origin/* 的提交
    seen.add(rec.sha);
    const url = REPO ? `${serverUrl}/${REPO}/commit/${rec.sha}` : `${serverUrl}/commit/${rec.sha}`;
    const branches = Array.from(shaToBranches.get(rec.sha) || []).sort();
    commitMetas.push({ sha: rec.sha, title: rec.title, author: rec.author, url, branches });
  }

  if (commitMetas.length === 0) {
    console.log("📭 今天所有分支均无有效提交。结束。");
    process.exit(0);
  }

  // 提交内的分片摘要与提交间的摘要都用有界并发处理，显著缩短多提交场景下的总耗时，
  // 同时靠 COMMIT_CONCURRENCY/CHUNK_CONCURRENCY 控制对 LLM 网关的瞬时压力
  const limitChunk = pLimit(CHUNK_CONCURRENCY);
  const limitCommit = pLimit(COMMIT_CONCURRENCY);

  const perCommitFinal: { meta: CommitMeta; summary: string }[] = await Promise.all(
    commitMetas.map((meta) =>
      limitCommit(async () => {
        const fullPatch = await getDiff(meta.sha);

        if (!fullPatch || !fullPatch.trim()) {
          return {
            meta,
            summary: `（无有效业务改动或改动已被过滤，例如 lockfile/构建产物/二进制，或空提交）`,
          };
        }

        const fileParts = splitPatchByFile(fullPatch);
        const chunks = chunkBySize(fileParts, DIFF_CHUNK_MAX_CHARS);

        const partSummaries = await Promise.all(
          chunks.map((chunk, i) =>
            limitChunk(async () => {
              try {
                const sum = await chat(commitChunkPrompt(meta, i + 1, chunks.length, chunk));
                return sum || `（片段${i + 1}摘要为空）`;
              } catch (e: any) {
                return `（片段${i + 1}调用失败：${String(e?.message || e)}）`;
              }
            }),
          ),
        );

        let merged = "";
        try {
          merged = await chat(commitMergePrompt(meta, partSummaries));
        } catch {
          merged = partSummaries.join("\n\n");
        }

        return { meta, summary: merged };
      }),
    ),
  );

  // 保持原始时间顺序（Promise.all 保序，但显式排序以防未来改动引入乱序风险）
  const orderIndex = new Map(commitMetas.map((m, i) => [m.sha, i]));
  perCommitFinal.sort((a, b) => orderIndex.get(a.meta.sha)! - orderIndex.get(b.meta.sha)!);

  // 当地日期标签 YYYY-MM-DD
  const todayLabel = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

  // 汇总"当日总览"
  let daily = "";
  try {
    daily = await chat(dailyMergePrompt(todayLabel, perCommitFinal, REPO || "repository"));
  } catch (e: any) {
    daily = `（当日汇总失败，以下为逐提交原始小结拼接）\n\n${perCommitFinal
      .map((it) => `[${it.meta.sha.slice(0, 7)}] ${it.meta.title} — ${it.meta.branches.join(", ")}\n${it.summary}`)
      .join("\n\n---\n\n")}`;
  }

  // 发送飞书
  await postToLark(daily);
  console.log("✅ 已发送飞书日报。");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
