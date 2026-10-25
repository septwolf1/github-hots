/**
 * 解析逻辑单元测试：用贴近 GitHub 真实结构的 fixture 验证正则。
 * 运行： node test/parse.test.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseTrending, parseCount, stripTags } from '../scripts/fetch-trending.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

console.log('\nparseCount / stripTags');

check('千分位数字', () => assert.equal(parseCount('44,858'), 44858));
check('k 后缀', () => assert.equal(parseCount('1.2k'), 1200));
check('m 后缀', () => assert.equal(parseCount('2.5m'), 2500000));
check('空值', () => assert.equal(parseCount(''), 0));
check('剥离标签', () => assert.equal(stripTags('<svg class="x"></svg>\n  44,858\n'), '44,858'));
check('解码实体', () => assert.equal(stripTags('a &amp; b &lt;c&gt;'), 'a & b <c>'));

const html = await readFile(path.join(HERE, 'fixture.html'), 'utf8');
const items = parseTrending(html);

console.log('\nparseTrending');

check('抓到全部 4 条', () => assert.equal(items.length, 4));

check('按新增 star 降序重排', () => {
  const gained = items.map((i) => i.gained);
  assert.deepEqual(gained, [2264, 1200, 896, 6492].sort((a, b) => b - a));
});

check('rank 连续且从 1 开始', () => {
  assert.deepEqual(items.map((i) => i.rank), [1, 2, 3, 4]);
});

check('榜首是新增最高的 t3code', () =>
  assert.equal(items[0].repo, 'pingdotgg/t3code'));
check('榜首新增 6,492', () => assert.equal(items[0].gained, 6492));

const top = items.find((i) => i.repo === 'cloudflare/security-audit-skill');
check('榜首仓库名正确', () => assert.equal(top.repo, 'cloudflare/security-audit-skill'));
check('榜首总 star', () => assert.equal(top.stars, 44858));
check('榜首 fork', () => assert.equal(top.forks, 2782));
check('榜首今日新增', () => assert.equal(top.gained, 2264));
check('榜首语言', () => assert.equal(top.language, 'JavaScript'));
check('榜首 URL', () =>
  assert.equal(top.url, 'https://github.com/cloudflare/security-audit-skill'));
check('描述不含 HTML', () =>
  assert.ok(!/[<>]/.test(top.description) && top.description.startsWith('A coding-agent skill')));

const ebook = items.find((i) => i.repo === 'jbiaojerry/ebook-treasure-chest');
check('中文描述解码正确', () =>
  assert.equal(ebook.description, '欢迎来到电子书下载宝库 & 各类电子书下载链接 <合集>'));
check('k 后缀新增量', () => assert.equal(ebook.gained, 1200));

const t3 = items.find((i) => i.repo === 'pingdotgg/t3code');
check('无描述时为 null 安全（空串）', () => assert.equal(t3.description, ''));
check('无语言时 language 为 null', () => assert.equal(t3.language, null));

console.log('\n异常输入');

check('空 HTML 返回空数组', () => assert.equal(parseTrending('<html></html>').length, 0));
check('垃圾 HTML 不抛异常', () =>
  assert.equal(parseTrending('<article class="Box-row">乱码</article>').length, 0));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
