#!/usr/bin/env node
/**
 * 把 data/*.json 里的英文简介翻译成简体中文，写入 descriptionZh 字段。
 *
 * 两条通道，自动选择：
 *
 *   1) 默认：免密钥通道，按顺序自动降级
 *      - Google 翻译（translate.googleapis.com/translate_a/single）
 *      - MyMemory（api.mymemory.translated.net）—— 对机房 IP 更友好
 *      注意：Google 会拦截 GitHub Actions 的机房 IP（HTTP 429），
 *      预检发现不通会自动切到 MyMemory，无需人工干预。
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

/* ---------- 通道 A2：MyMemory（免密钥，对机房 IP 更友好） ---------- */

function decodeEntities(s = '') {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function parseMyMemoryResponse(json) {
  const status = json?.responseStatus;
  const raw = json?.responseData?.translatedText;
  if (status !== undefined && status !== 200) {
    throw new Error(`接口返回 ${status}：${json?.responseDetails || ''}`);
  }
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('译文为空');
  const zh = decodeEntities(raw).trim();
  // 超限时 MyMemory 会把警告文案塞进译文里
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID (SOURCE|EMAIL)/i.test(zh)) {
    throw new Error(zh.slice(0, 60));
  }
  return zh;
}

async function translateMyMemory(text) {
  const url =
    'https://api.mymemory.translated.net/get?langpair=en%7Czh-CN&q=' +
    encodeURIComponent(text);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseMyMemoryResponse(await res.json());
}

/* 免密钥通道，按顺序尝试，前一个失败自动换下一个（质量由高到低） */
const FREE_CHAIN = [
  { id: 'bing', name: 'Bing 翻译', fn: (t) => translateBing(t), delay: 250 },
  { id: 'google', name: 'Google', fn: translateGoogle, delay: 350 },
  { id: 'mymemory', name: 'MyMemory', fn: translateMyMemory, delay: 600 },
];

/* ---------- 通道 A3：Bing（微软 Edge 内置翻译，免密钥，技术文本质量最好） ---------- */

let bingToken = null;
let bingTokenExp = 0;

async function getBingToken() {
  if (bingToken && Date.now() < bingTokenExp) return bingToken;
  const res = await fetch('https://edge.microsoft.com/translate/auth', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`取令牌失败 HTTP ${res.status}`);
  const token = (await res.text()).trim();
  if (!token) throw new Error('令牌为空');
  bingToken = token;
  bingTokenExp = Date.now() + 8 * 60 * 1000; // JWT 约 10 分钟有效，留 2 分钟余量
  return token;
}

export function parseBingResponse(json) {
  const zh = json?.[0]?.translations?.[0]?.text;
  if (typeof zh !== 'string' || !zh.trim()) throw new Error('译文为空');
  return zh.trim();
}

async function translateBing(text) {
  const token = await getBingToken();
  const res = await fetch(
    'https://api-edge.cognitive.microsofttranslator.com/translate?to=zh-Hans&api-version=3.0',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify([{ Text: text }]),
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (res.status === 401) {
    bingToken = null; // 令牌过期，下次重新取
    throw new Error('HTTP 401 令牌失效');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseBingResponse(await res.json());
}

/* ---------- 术语纠正 ---------- */

/**
 * 机器翻译（尤其是 MyMemory）在技术语境下经常误译，
 * 这里做一层确定性的后处理。只针对 AI/开源领域的固定表达，
 * 不会影响正常词汇。
 */
const GLOSSARY = [
  [/高级客服代表/g, '高级智能体'],
  [/客服代表/g, '智能体'],
  [/代理商/g, '智能体'],
  [/(?<!反向)代理/g, '智能体'],
  [/双子座/g, 'Gemini'],
  [/防\s*AI\s*倾斜/g, '反 AI 味'],
  [/AI\s*倾斜/g, 'AI 味'],
  [/人工智能/g, 'AI'],
  [/Claude\s*准则/g, 'Claude Code'], // 产品名被误译
  [/考虑一下吧/g, '说到做到'], // "Consider it done" 的意译
  [/座席线束/g, '智能体框架'], // agent harness
  [/座席/g, '智能体'], // agent 被译成"座席"
  [/线束/g, '框架'], // harness 被译成"线束"
  [/后见之明/g, 'Hindsight'], // 项目名不该意译
  [/Agent\s*harness\s*/gi, '智能体框架'], // 先匹配带 Agent 的，避免变成"Agent 智能体框架"
  [/AI\s*harness\s*/gi, 'AI 智能体框架'],
  [/harness\s*/gi, '智能体框架'],
];

export function applyGlossary(s = '') {
  let out = s;
  for (const [re, to] of GLOSSARY) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, ' ').trim();
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
  // 配了自己的 Key，就只走 OpenAI 兼容通道
  if (API_KEY) {
    try {
      const map = await translateOpenAI(['hello world']);
      if (map.size === 0) return { ok: false, reason: '模型未返回有效结果' };
      return {
        ok: true,
        provider: { id: 'openai', name: `OpenAI 兼容（${BASE_URL} / ${MODEL}）`, delay: 800 },
      };
    } catch (err) {
      const hints = {
        'HTTP 401': 'API Key 无效，检查 TRANSLATE_API_KEY',
        'HTTP 403': 'Key 无权限或来源受限',
        'HTTP 404': `端点或模型不存在，检查 TRANSLATE_BASE_URL 与 TRANSLATE_MODEL（当前 ${BASE_URL} / ${MODEL}）`,
        'HTTP 429': '触发限流，稍后重试或减小 BATCH_SIZE',
      };
      const hit = Object.keys(hints).find((k) => err.message.includes(k));
      return { ok: false, reason: `${err.message}${hit ? ` —— ${hints[hit]}` : ''}` };
    }
  }

  // 免密钥通道：按顺序逐个探测，用第一个能通的
  const reasons = [];
  for (const p of FREE_CHAIN) {
    try {
      const zh = await p.fn('hello world');
      if (zh) {
        console.log(`预检：${p.name} 可用`);
        return { ok: true, provider: p };
      }
      reasons.push(`${p.name} 返回空译文`);
    } catch (err) {
      reasons.push(`${p.name} ${err.message}`);
      console.log(`预检：${p.name} 不可用（${err.message}），尝试下一个`);
    }
  }
  return { ok: false, reason: `所有免密钥通道均不可用 —— ${reasons.join('；')}` };
}

/* ---------- 主流程 ---------- */

async function main() {
  const pre = await preflight();
  if (!pre.ok) {
    warn(`翻译预检失败，本次跳过翻译（保留英文）：${pre.reason}`);
    return;
  }
  let primary = pre.provider;
  console.log(`翻译通道：${primary.name}`);

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

  if (primary.id === 'openai') {
    const total = Math.ceil(todo.length / BATCH_SIZE);
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const chunk = todo.slice(i, i + BATCH_SIZE);
      process.stdout.write(`  批次 ${Math.floor(i / BATCH_SIZE) + 1}/${total}（${chunk.length} 条）... `);
      try {
        const result = await translateOpenAI(chunk);
        for (const [idx, zh] of result) {
          const text = chunk[idx];
          if (text) {
            cache[unique.get(text)] = applyGlossary(zh);
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
  } else {
    // 免密钥通道：逐条翻译，当前通道连续失败 3 次就自动降级到下一个
    let streak = 0;

    for (let i = 0; i < todo.length; i++) {
      const text = todo[i];
      process.stdout.write(`  ${i + 1}/${todo.length} ... `);

      let zh = null;
      let usedName = primary.name;

      // 先用当前通道
      try {
        zh = await primary.fn(text);
        streak = 0;
      } catch (err) {
        streak++;
        // 当前通道失败，立刻用备用通道兜底
        for (const p of FREE_CHAIN.filter((x) => x.id !== primary.id)) {
          try {
            zh = await p.fn(text);
            usedName = p.name;
            break;
          } catch {
            /* 继续试下一个 */
          }
        }
        if (!zh && !firstError) firstError = `${primary.name} ${err.message}`;

        // 连续失败说明当前通道整体不可用，降级
        if (streak >= 3) {
          const next = FREE_CHAIN.find((x) => x.id !== primary.id);
          if (next) {
            console.log(`\n  [降级] ${primary.name} 连续失败 ${streak} 次，切换到 ${next.name}`);
            primary = next;
            streak = 0;
          }
        }
      }

      if (zh) {
        zh = applyGlossary(zh);
        cache[unique.get(text)] = zh;
        translated++;
        console.log(`${zh.slice(0, 26)}${zh.length > 26 ? '…' : ''}${usedName !== primary.name ? `（${usedName}）` : ''}`);
      } else {
        failed++;
        console.log('失败');
      }

      await sleep(primary.delay);
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
