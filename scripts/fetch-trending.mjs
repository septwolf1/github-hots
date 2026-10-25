#!/usr/bin/env node
/**
 * 抓取 GitHub Trending 三个周期（daily / weekly / monthly），
 * 解析成结构化 JSON 写入 data/ 目录。
 *
 * 零依赖，Node 18+ 原生 fetch 即可运行。
 * 用法： node scripts/fetch-trending.mjs [--only=daily]
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const PERIODS = ['daily', 'weekly', 'monthly'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const targets = onlyArg ? [onlyArg.split('=')[1]] : PERIODS;

/* ---------- 工具函数 ---------- */

function decodeEntities(s = '') {
  const map = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&#x27;': "'", '&apos;': "'", '&nbsp;': ' ',
  };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z#0-9x]+;/gi, (m) => map[m] ?? m);
}

function stripTags(s = '') {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "44,858" -> 44858 ; "1.2k" -> 1200 ; "12.3m" -> 12300000 */
function parseCount(text) {
  if (!text) return 0;
  const t = String(text).replace(/,/g, '').trim().toLowerCase();
  const m = t.match(/([\d.]+)\s*([km])?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1;
  return Math.round(n * mult);
}

/* ---------- 解析 ---------- */

/**
 * 把一个 <article class="Box-row"> 块解析成对象。
 * 结构依赖 GitHub 当前 DOM，若改版需调整这里。
 */
function parseArticle(block) {
  // 仓库名：h2 内第一个 href="/owner/repo"
  const h2 = block.match(/<h2[\s\S]*?<\/h2>/i)?.[0] ?? '';
  const href = h2.match(/href="\/([^"?#]+)"/)?.[1];
  if (!href || !/^[^/]+\/[^/]+$/.test(href)) return null;

  const [owner, name] = href.split('/');

  // 描述
  const descRaw = block.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '';

  // 语言
  const language = stripTags(
    block.match(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ''
  ) || null;

  // star / fork 总数
  const starsRaw = block.match(/href="\/[^"]*\/stargazers"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '';
  const forksRaw = block.match(/href="\/[^"]*\/forks"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '';

  // 周期内新增："2,264 stars today" / "stars this week" / "stars this month"
  const gainedMatch = block.match(/([\d,.]+[km]?)\s+stars?\s+(?:today|this\s+week|this\s+month)/i);

  return {
    repo: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
    description: stripTags(descRaw),
    language,
    stars: parseCount(stripTags(starsRaw)),
    forks: parseCount(stripTags(forksRaw)),
    gained: gainedMatch ? parseCount(gainedMatch[1]) : 0,
  };
}

function parseTrending(html) {
  // 按 article 切块；Box-row 是 GitHub Trending 每个仓库的容器
  const blocks = html.split(/<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>/i).slice(1);
  const items = [];
  for (const b of blocks) {
    const item = parseArticle(b);
    if (item) items.push(item);
  }
  // 按周期内新增 star 降序，重新编号
  items.sort((a, b) => b.gained - a.gained);
  return items.map((it, i) => ({ rank: i + 1, ...it }));
}

/* ---------- 抓取 ---------- */

async function fetchHtml(url, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw lastErr;
}

/* ---------- 主流程 ---------- */

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  let failed = 0;

  for (const since of targets) {
    const url = `https://github.com/trending?since=${since}`;
    process.stdout.write(`[${since}] fetching ${url} ... `);
    try {
      const html = await fetchHtml(url);
      const items = parseTrending(html);

      if (items.length === 0) {
        // 解析出 0 条通常意味着 GitHub 改版或返回了验证页，必须报错而不是写入空数据
        throw new Error(
          `parsed 0 items (html ${html.length} bytes) — 可能是页面改版或触发了反爬验证`
        );
      }

      const payload = {
        since,
        generatedAt: new Date().toISOString(),
        source: url,
        count: items.length,
        items,
      };

      const out = path.join(DATA_DIR, `${since}.json`);
      await writeFile(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      console.log(`ok — ${items.length} repos, top: ${items[0].repo} +${items[0].gained}`);
    } catch (err) {
      failed++;
      console.error(`FAILED — ${err.message}`);
    }
  }

  // meta.json：给前端显示"最后更新时间"，即便某个周期失败也能用
  const meta = { updatedAt: new Date().toISOString() };
  const metaPath = path.join(DATA_DIR, 'meta.json');
  if (existsSync(metaPath)) {
    try {
      Object.assign(meta, JSON.parse(await readFile(metaPath, 'utf8')));
      meta.updatedAt = new Date().toISOString();
    } catch {
      /* 忽略损坏的旧 meta */
    }
  }
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  if (failed > 0) {
    console.error(`\n${failed}/${targets.length} 个周期抓取失败`);
    process.exit(1);
  }
  console.log('\n全部完成');
}

/* 被 import 时只导出函数，不执行抓取；直接运行时才跑 main() */
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { parseTrending, parseArticle, parseCount, stripTags, decodeEntities };
