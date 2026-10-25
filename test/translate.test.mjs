/**
 * Google 翻译响应解析测试。
 * 运行： node test/translate.test.mjs
 */
import assert from 'node:assert/strict';
import { parseGoogleResponse } from '../scripts/translate.mjs';

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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
