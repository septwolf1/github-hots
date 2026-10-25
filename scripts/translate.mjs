#!/usr/bin/env node
/**
 * 把 data/*.json 里的英文简介翻译成简体中文，写入 descriptionZh 字段。
 *
 * 两条通道，自动选择：
 *
 *   1) 默认：Google 翻译免密钥接口（translate.googleapis.com/translate_a/single）
 *      —— 不需要任何 API Key，开箱即用，适合本项目这种短句翻译场景
 *
 *   2) 可选：任意 OpenAI 兼容接口（DeepSeek / 通义 / OpenAI / 智谱 …）
 *      —— 只要设了 TRANSLATE_API_KEY 就会自动切过去，翻译质量更好
 *         TRANSLATE_BASE_URL=https://api.deepseek.com/v1
 *         TRANSLATE_API_KEY=sk-xxx
 *         TRANSLATE_MODEL=deepseek-chat
 *
 * 注：GitHub Models 已于 2026-07-30 正式下线，不再作为选项。
 *
 * 翻译结果按描述内容哈希缓存在 data/i18n-cache.json，
 * 相同描述不会重复请求。翻译失败不会让流程失败——保留英文，只输出 warning。
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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const API_KEY = process.env.TRANSLATE_API_KEY || '';
const BASE_URL = (process.env.TRANSLATE_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
const PROVIDER = API_KEY ? 'openai' : 'google';

const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
const BATCH_SIZE = 12;
const MAX_CHARS = 90;

/* ---------- 工具 ---------- */

function isMostlyChinese(s = '') {
  const visible = s.replace(/\s/g, '');
  if (!visible) return false;
  const cjk = (visible.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk / visible.length > 0.5;
}

const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function warn(msg) {
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

/* ---------- 通道 A：Google 免密钥 ---------- */

/**
 * 解析 Google 翻译返回的嵌套数组，拼成完整译文。
 * 返回形如 [[["你好","hello",null,null,10]],null,"en",...]
 * 长句会被切成多段，需要按顺序拼接。
 */
export function parseGoogleResponse(json) {
  if (!Array.isArray(json) || !Array.isArray(json[0])) {
    throw new Error('Google 返回格式异常');
  }
  return json[0]
    .map((seg) => (Array.isArray(seg) ? seg[0] : ''))
    .filter(Boolean)
    .join('')
    .trim();
}

async function translateGoogle(text) {
  const url =
    `${GOOGLE_URL}?client=gtx&sl=auto&tl=zh-CN&dt=t&q=` + encodeURIComponent(text);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const zh = parseGoogleResponse(json);
  if (!zh) throw new Error('译文为空');
  return zh;
}

/* ---------- 通道 B：OpenAI 兼容 ---------- */

async function translateOpenAI(texts) {
  const payload = texts.map((text, i) => ({ i, text }));

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            '你是资深技术译者，负责把 GitHub 项目简介翻译成简体中文。规则：\n' +
            '1. 保留专有名词和产品名原文，如 Claude Code、Cursor、MCP、Rust、Agent、LLM、API；\n' +
            '2. 不要加解释、不要扩写、不要加引号；\n' +
            `3. 每条译文控制在 ${MAX_CHARS} 字以内；\n` +
            '4. 只输出 JSON 数组，不要任何其它文字，不要用代码块包裹；\n' +
            '5. 格式：[{"i":0,"zh":"译文"}]',
        },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  let content = json?.choices?.[0]?.message?.content ?? '';
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回为空');

  content = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const s = content.indexOf('[');
  const e = content.lastIndexOf(']');
  if (s === -1 || e === -1) throw new Error('模型返回不是 JSON 数组');

  const arr = JSON.parse(content.slice(s, e + 1));
  const out = new Map();
  for (const row of arr) {
    if (typeof row?.i === 'number' && typeof row?.zh === 'string' && row.zh.trim()) {
      out.set(row.i, row.zh.trim());
    }
  }
  return out;
}

/* ---------- 预检 ---------- */

async function preflight() {
  try {
    if (PROVIDER === 'google') {
      const zh = await translateGoogle('hello world');
      return zh ? { ok: true } : { ok: false, reason: 'Google 接口返回空译文' };
    }
    const map = await translateOpenAI(['hello world']);
    return map.size > 0 ? { ok: true } : { ok: false, reason: '模型未返回有效结果' };
  } catch (err) {
    const hints = {
      'HTTP 401': 'API Key 无效，检查 TRANSLATE_API_KEY',
      'HTTP 403': 'Key 无权限或来源受限',
      'HTTP 404': `端点或模型不存在，检查 TRANSLATE_BASE_URL 与 TRANSLATE_MODEL（当前 ${BASE_URL} / ${MODEL}）`,
      'HTTP 429': '触发限流，稍后重试或减小 BATCH_SIZE',
    };
    const hint = Object.keys(hints).find((k) => err.message.includes(k));
    return { ok: false, reason: `${err.message}${hint ? ` —— ${hints[hint]}` : ''}` };
  }
}

/* ---------- 主流程 ---------- */

async function main() {
  console.log(`翻译通道：${PROVIDER === 'google' ? 'Google 免密钥接口' : `OpenAI 兼容（${BASE_URL} / ${MODEL}）`}`);

  const pre = await preflight();
  if (!pre.ok) {
    warn(`翻译预检失败，本次跳过翻译（保留英文）：${pre.reason}`);
    return;
  }
  console.log('预检通过');

  const cache = FORCE ? {} : await readJson(CACHE_PATH, {});

  // 1. 收集待翻译描述
  const files = {};
  const unique = new Map(); // text -> hash

  for (const since of PERIODS) {
    const p = path.join(DATA_DIR, `${since}.json`);
    const data = await readJson(p, null);
    if (!data || !Array.isArray(data.items)) continue;
    files[since] = { path: p, data };

    for (const item of data.items) {
      const text = (item.description || '').trim();
      if (!text || isMostlyChinese(text)) continue;
      if (!unique.has(text)) unique.set(text, hashOf(text));
    }
  }

  const allTexts = [...unique.keys()];
  const todo = allTexts.filter((t) => !cache[unique.get(t)]);
  console.log(`共 ${allTexts.length} 条唯一英文描述，其中 ${todo.length} 条待翻译`);

  if (DRY) {
    console.log('[dry] 只统计，不请求接口');
    return;
  }
  if (todo.length === 0) {
    console.log('全部命中缓存，无需翻译');
  }

  // 2. 翻译
  let translated = 0;
  let failed = 0;
  let firstError = '';

  if (PROVIDER === 'google') {
    for (let i = 0; i < todo.length; i++) {
      const text = todo[i];
      process.stdout.write(`  ${i + 1}/${todo.length} ... `);
      try {
        const zh = await translateGoogle(text);
        cache[unique.get(text)] = zh;
        translated++;
        console.log(zh.slice(0, 28) + (zh.length > 28 ? '…' : ''));
      } catch (err) {
        failed++;
        if (!firstError) firstError = err.message;
        console.log(`失败：${err.message}`);
      }
      await sleep(350); // 轻微限速，避免被 Google 拦
    }
  } else {
    const total = Math.ceil(todo.length / BATCH_SIZE);
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const chunk = todo.slice(i, i + BATCH_SIZE);
      process.stdout.write(`  批次 ${Math.floor(i / BATCH_SIZE) + 1}/${total}（${chunk.length} 条）... `);
      try {
        const result = await translateOpenAI(chunk);
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
        if (!firstError) firstError = err.message;
        console.log(`失败：${err.message}`);
      }
      await sleep(800);
    }
  }

  // 3. 写缓存
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');

  // 4. 注入 data/*.json
  let injected = 0;
  for (const since of Object.keys(files)) {
    const { path: p, data } = files[since];
    for (const item of data.items) {
      const text = (item.description || '').trim();
      if (!text || isMostlyChinese(text)) continue;
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
    warn(`${failed} 条描述翻译失败（原因：${firstError}），这些条目会显示英文原文`);
  }
}

/* 被 import 时只导出函数，不执行翻译；直接运行时才跑 main() */
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    warn(`翻译步骤异常，已跳过：${err.message}`);
  });
}
