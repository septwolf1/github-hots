/**
 * Google 翻译响应解析测试。
 * 运行： node test/translate.test.mjs
 */
import assert from 'node:assert/strict';
import {
  parseGoogleResponse,
  parseMyMemoryResponse,
  parseBingResponse,
  applyGlossary,
} from '../scripts/translate.mjs';

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('\nparseGoogleResponse');

// 真实返回结构：[[["译文","原文",null,null,10]],null,"en",...]
check('单段译文', () =>
  assert.equal(
    parseGoogleResponse([[['你好，世界', 'Hello, world', null, null, 10]], null, 'en']),
    '你好，世界'
  ));

check('多段按顺序拼接', () =>
  assert.equal(
    parseGoogleResponse([
      [
        ['一个会走路的', 'A biped', null, null, 3],
        ['小鸭子机器人', ' duck robot', null, null, 3],
      ],
      null,
      'en',
    ]),
    '一个会走路的小鸭子机器人'
  ));

check('忽略空段', () =>
  assert.equal(
    parseGoogleResponse([[['有效内容', 'valid', null, null, 3], [null, 'x']], null, 'en']),
    '有效内容'
  ));

check('去除首尾空白', () =>
  assert.equal(
    parseGoogleResponse([[['  带空格  ', 'spaced', null, null, 3]], null, 'en']),
    '带空格'
  ));

check('结构异常时抛错', () =>
  assert.throws(() => parseGoogleResponse({ error: 'x' }), /格式异常/));

check('空数组抛错', () => assert.throws(() => parseGoogleResponse([]), /格式异常/));

console.log('\nparseMyMemoryResponse');

check('正常返回', () =>
  assert.equal(
    parseMyMemoryResponse({
      responseStatus: 200,
      responseData: { translatedText: '一只小型双足鸭子机器人' },
    }),
    '一只小型双足鸭子机器人'
  ));

check('解码 HTML 实体', () =>
  assert.equal(
    parseMyMemoryResponse({
      responseStatus: 200,
      responseData: { translatedText: 'A &amp; B &lt;c&gt;' },
    }),
    'A & B <c>'
  ));

check('非 200 状态抛错', () =>
  assert.throws(
    () =>
      parseMyMemoryResponse({
        responseStatus: 429,
        responseDetails: 'TOO MANY REQUESTS',
        responseData: { translatedText: '' },
      }),
    /429/
  ));

check('识别限流警告文案', () =>
  assert.throws(
    () =>
      parseMyMemoryResponse({
        responseStatus: 200,
        responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS' },
      }),
    /MYMEMORY WARNING/
  ));

check('空译文抛错', () =>
  assert.throws(() =>
    parseMyMemoryResponse({ responseStatus: 200, responseData: { translatedText: '  ' } })
  ));

console.log('\nparseBingResponse');

check('正常返回', () =>
  assert.equal(
    parseBingResponse([{ translations: [{ text: '面向编码智能体的安全审计技能', to: 'zh-Hans' }] }]),
    '面向编码智能体的安全审计技能'
  ));

check('结构异常抛错', () =>
  assert.throws(() => parseBingResponse([{ translations: [] }]), /译文为空/));

console.log('\napplyGlossary');

check('代理商 → 智能体', () =>
  assert.equal(applyGlossary('一个AI代理商'), '一个AI智能体'));

check('编码代理 → 编码智能体', () =>
  assert.equal(applyGlossary('编码代理技能'), '编码智能体技能'));

check('反向代理不被误改', () =>
  assert.equal(applyGlossary('配置反向代理'), '配置反向代理'));

check('双子座 → Gemini', () =>
  assert.equal(applyGlossary('将双子座的能力带入终端'), '将Gemini的能力带入终端'));

check('高级客服代表 → 高级智能体', () =>
  assert.equal(applyGlossary('从基本概念到高级客服代表'), '从基本概念到高级智能体'));

check('人工智能 → AI', () =>
  assert.equal(applyGlossary('让你的人工智能更好'), '让你的AI更好'));

check('无匹配时原样返回', () =>
  assert.equal(applyGlossary('一个微型双足鸭机器人'), '一个微型双足鸭机器人'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
