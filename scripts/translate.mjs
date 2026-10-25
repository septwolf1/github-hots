#!/usr/bin/env node
/**
 * 把 data/*.json 里的英文简介翻译成简体中文，写入 descriptionZh 字段。
 *
 * 默认使用 GitHub Models（Actions 内置，免 API Key，公开仓库有免费额度）：
 *   - 鉴权用 GITHUB_TOKEN，workflow 需要 `permissions: models: read`
 *   - 模型默认 openai/gpt-4o-mini，可用 TRANSLATE_MODEL 覆盖
 *
 * 也可以换成任意 OpenAI 兼容接口（DeepSeek / 通义 / OpenAI 等）：
 *   TRANSLATE_BASE_URL=https://api.deepseek.com/v1
 *   TRANSLATE_API_KEY=sk-xxx
 *   TRANSLATE_MODEL=deepseek-chat
 *
 * 翻译结果按描述内容哈希缓存在 data/i18n-cache.json，
 * 相同描述不会重复调用，省额度也省时间。
 *
 * 翻译失败不会让流程失败——保留英文原文，只输出一条 warning。
 *
 * 用法： node scripts/translate.mjs [--force] [--dry]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_PATH = path.join(DATA_DIR, 'i18n-cache.json');
const PERIODS = ['daily', 'weekly', 'monthly'];

const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry');

const GITHUB_MODELS_URL = 'https://models.github.ai/inference/chat/completions';
const BASE_URL = (process.env.TRANSLATE_BASE_URL || '').replace(/\/+$/, '');
const ENDPOINT = BASE_URL ? `${BASE_URL}/chat/completions` : GITHUB_MODELS_URL;
const TOKEN = process.env.TRANSLATE_API_KEY || process.env.GITHUB_TOKEN || '';
const MODEL = process.env.TRANSLATE_MODEL || 'openai/gpt-4o-mini';

const BATCH_SIZE = 15;
const MAX_CHARS = 90;

/* ---------- 工具 ---------- */

/**
 * 判断是否"基本是中文"——用于跳过无需翻译的描述。
 * 注意不能简单用"包含中文"，因为很多项目简介是中英混排
 * （如 "Consider it done. ... · 想到，就能做到"），这类仍需翻译。
 */
function isMostlyChinese(s = '') {
  const visible = s.replace(/\s/g, '');
  if (!visible) return false;
  const cjk = (visible.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk / visible.length > 0.5;
}

const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function warn(msg) {
  // 在 Actions 日志里显示为黄色警告条
  console.log(`::warning::${msg}`);
  console.log(`[warn] ${msg}`);
}

async function readJson(p, fallback) {
  try {
    if (!existsSync(p)) return fallback;
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/* ---------- 调用模型 ---------- */

async function callModel(entries) {
  const payload = entries.map((e, i) => ({ i, text: e.text }));

  const body = {
    model: MODEL,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          '你是资深技术译者，负责把 GitHub 项目简介翻译成简体中文。规则：\n' +
          '1. 保留专有名词和产品名原文，如 Claude Code、Cursor、MCP、Rust、Agent、LLM、API；\n' +
          '2. 不要加解释、不要扩写、不要加书名号或引号；\n' +
          `3. 每条译文控制在 ${MAX_CHARS} 字以内，力求精炼准确；\n` +
          '4. 只输出 JSON 数组，不要输出任何其它文字、不要用 markdown 代码块包裹；\n' +
          '5. 输出格式：[{"i":0,"zh":"译文"},{"i":1,"zh":"译文"}]',
      },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  let content = json?.choices?.[0]?.message?.content ?? '';
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('模型返回内容为空');
  }

  // 去掉可能存在的 markdown 代码块
  content = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();

  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('模型返回内容不是 JSON 数组');

  const arr = JSON.parse(content.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('模型返回的不是数组');

  const out = new Map();
  for (const row of arr) {
    if (typeof row?.i === 'number' && typeof row?.zh === 'string' && row.zh.trim()) {
      out.set(row.i, row.zh.trim());
    }
  }
  return out;
}

async function translateWithRetry(entries, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      return await callModel(entries);
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

/* ---------- 主流程 ---------- */

async function main() {
  if (!TOKEN) {
    warn('没有可用的令牌（GITHUB_TOKEN 或 TRANSLATE_API_KEY），跳过翻译，保留英文简介');
    return;
  }

  const cache = FORCE ? {} : await readJson(CACHE_PATH, {});

  // 1. 收集所有需要翻译的描述
  const files = {};
  const unique = new Map(); // text -> hash

  for (const since of PERIODS) {
    const p = path.join(DATA_DIR, `${since}.json`);
    const data = await readJson(p, null);
    if (!data || !Array.isArray(data.items)) continue;
    files[since] = { path: p, data };

    for (const item of data.items) {
      const text = (item.description || '').trim();
      if (!text || isMostlyChinese(text)) continue; // 空描述、本身是中文的跳过
      if (!unique.has(text)) unique.set(text, hashOf(text));
    }
  }

  const allTexts = [...unique.keys()];
  const todo = allTexts.filter((t) => !cache[unique.get(t)]);

  console.log(`共 ${allTexts.length} 条唯一英文描述，其中 ${todo.length} 条待翻译`);

  if (DRY) {
    console.log('[dry] 只统计，不调用模型');
    return;
  }

  // 2. 分批翻译
  let translated = 0;
  let failed = 0;

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const chunk = todo.slice(i, i + BATCH_SIZE);
    const entries = chunk.map((text) => ({ text }));
    const n = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(todo.length / BATCH_SIZE);

    process.stdout.write(`  批次 ${n}/${total}（${chunk.length} 条）... `);
    try {
      const result = await translateWithRetry(entries);
      for (const [idx, zh] of result) {
        const text = chunk[idx];
        if (text) {
          cache[unique.get(text)] = zh;
          translated++;
        }
      }
      console.log(`ok（${result.size} 条）`);
    } catch (err) {
      failed += chunk.length;
      console.log(`失败：${err.message}`);
    }

    if (i + BATCH_SIZE < todo.length) {
      await new Promise((r) => setTimeout(r, 800)); // 轻微限速
    }
  }

  // 3. 写回缓存
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');

  // 4. 把译文注入 data/*.json
  let injected = 0;
  for (const since of Object.keys(files)) {
    const { path: p, data } = files[since];
    for (const item of data.items) {
      const text = (item.description || '').trim();
      if (!text || isMostlyChinese(text)) continue; // 本身是中文的不用注入，前端会回退到 description
      const zh = cache[hashOf(text)];
      if (zh) {
        item.descriptionZh = zh;
        injected++;
      }
    }
    await writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  console.log(`\n翻译完成：新增 ${translated} 条，注入 ${injected} 处，失败 ${failed} 条`);
  if (failed > 0) {
    warn(`${failed} 条描述翻译失败，这些条目会显示英文原文`);
  }
}

main().catch((err) => {
  // 翻译属于增强功能，任何异常都不应阻断主流程
  warn(`翻译步骤异常，已跳过：${err.message}`);
});
