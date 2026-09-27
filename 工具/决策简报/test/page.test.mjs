// 页面：首屏五栏放对了卡、详情锚点都在、全中文、样本生成幂等、只写输出文件、命令行。
// 每个测试把 examples/ 整份复制到临时目录，只改副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBrief } from '../scripts/brief.mjs';

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(tool, 'scripts', 'brief.mjs');

function sample(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-brief-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(tool, 'examples'), dir, { recursive: true });
  return { dir, root: path.join(dir, '示例项目'), output: path.join(dir, '测试输出.html') };
}

const run = (s, cli = script) => spawnSync(process.execPath, [cli, '--source', s.root, '--output', s.output], { encoding: 'utf8', windowsHide: true });
const sectionOf = (html, id) => (new RegExp(`<section class="[^"]+" id="${id}">[\\s\\S]*?</section>`).exec(html) || [''])[0];
const rowsOf = (html, id) => [...sectionOf(html, id).matchAll(/<(?:details|div) class="row[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
const summaryOf = (html, id) => (new RegExp(`<details class="row" id="${id}"><summary>[\\s\\S]*?</summary>`).exec(html) || [''])[0];
const detailOf = (html, id) => (new RegExp(`<details class="row" id="${id}">[\\s\\S]*?</details>`).exec(html) || [''])[0];

// 目录下每个文件的相对路径加内容指纹，用来核对“只写了输出文件”
function tree(root) {
  const rows = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else rows.push(`${path.relative(root, file).split(path.sep).join('/')}|${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);
    }
  };
  walk(root);
  return rows;
}

test('首屏五栏：卡放对了栏，标记对，每条都有详情锚点', (t) => {
  const s = sample(t);
  const { html } = buildBrief({ source: s.root, output: s.output });
  const titles = [['ask', '① 要你决定'], ['decided', '② 本轮定了什么'], ['changed', '③ 改了哪些旧决定'], ['pending', '④ 带前提或未定'], ['next', '⑤ 下一步']];
  for (const [id, title] of titles) assert.match(html, new RegExp(`id="${id}"><h2>${title}`), title);

  assert.match(html, /<p class="headline">本轮定了 3 项（其中否决 1 项），改了 2 处旧决定，1 项带前提；未定 1 项，暂缓 1 项。<\/p>/);
  assert.deepEqual(rowsOf(html, 'ask'), ['ask-1']);
  assert.deepEqual(rowsOf(html, 'decided'), ['card-1-03', 'card-1-04', 'card-1-06']);
  assert.deepEqual(rowsOf(html, 'changed'), ['chg-1', 'chg-2']);
  assert.deepEqual(rowsOf(html, 'pending'), ['pre-card-1-03', 'card-2-07', 'card-2-05']);
  assert.deepEqual(rowsOf(html, 'next'), ['next-1', 'next-2', 'next-3']);

  assert.match(summaryOf(html, 'card-1-03'), /<span class="topic" title="逾期处理：只提醒，不罚款">逾期处理<\/span><span class="pick">只提醒，不罚款<\/span>[\s\S]*<span class="mk pre">带前提<\/span><span class="mk rev">△ 改了旧决定<\/span>/);
  assert.match(summaryOf(html, 'card-1-04'), /<span class="mk no">否决<\/span>/);
  assert.match(summaryOf(html, 'card-2-07'), /<span class="pick">志愿者要不要单独的管理账号<\/span><\/span><span class="marks"><span class="mk open">未定<\/span>/);
  assert.match(summaryOf(html, 'card-2-05'), /<span class="mk defer">暂缓<\/span>/);
  assert.match(sectionOf(html, 'next'), /<div class="row plain" id="next-3"><span class="main"><span class="pick">用户：2026-10-01 之前定志愿者账号，见“要你决定”<\/span><\/span><span class="marks"><span class="mk you">涉及你<\/span>/);
  assert.match(sectionOf(html, 'pending'), /另有研究卡 1 张，只查证不决定，不列在这里：<a class="ref" href="[^"#]+08-[^"]+\.md">「书屋网络一个月断几次」<\/a>/);

  // ③ 每处改动一行：原值划掉 → 新值；详情里有本次、新旧两张卡和原因
  assert.match(summaryOf(html, 'chg-1'), /逾期罚款<\/span><span class="pick"><del>每天 1 毛（书屋章程第 5 条）<\/del> → 只发短信提醒<\/span>/);
  assert.match(summaryOf(html, 'chg-2'), /借阅上限<\/span><span class="pick"><del>3 本<\/del> → 5 本<\/span>/);
  assert.match(detailOf(html, 'chg-1'), /<div class="k">新卡取代的卡<\/div><div class="v">无<span class="why">这一处改的不是决策卡<\/span>/);
  const change = detailOf(html, 'chg-2');
  assert.match(change, /<dt>原值<\/dt><dd>3 本<\/dd><\/div><div><dt>本次<\/dt><dd>加 2 本<\/dd><\/div><div><dt>新值<\/dt><dd>5 本<\/dd>/);
  assert.match(change, /<div class="k">新决定<\/div><div class="v"><a class="ref" href="#card-1-06">「借阅上限：每人最多同时借 5 本」<\/a>/);
  assert.match(change, /<div class="k">新卡取代的卡<\/div><div class="v"><a class="ref" href="[^"#]+02-[^"]+\.md">「借阅上限：每人最多同时借 3 本」<\/a><\/div>/);
  assert.match(change, /<div class="k">原因<\/div><div class="v"><p>放宽到 5 本。/);

  // 放上首屏的每张卡，点开都有附录 A 的各段（研究卡以外）
  for (const id of ['card-1-03', 'card-1-04', 'card-1-06', 'card-2-07', 'card-2-05']) {
    const detail = detailOf(html, id);
    for (const k of ['状态与批准', '问题', '比较过的选项', '选择与理由', '影响', '前提', '依据', '关系', '后续', '暂缓原因', '原文']) {
      assert.match(detail, new RegExp(`<div class="k">${k}</div>`), `${id} 缺“${k}”`);
    }
  }
  assert.match(detailOf(html, 'card-1-06'), /<dt>取代<\/dt><dd><a class="ref" href="[^"#]+02-[^"]+\.md">「借阅上限 3 本」<\/a>/);
  assert.match(detailOf(html, 'ask-1'), /<li>详情见<a class="ref" href="#card-2-07">「志愿者账号」<\/a><\/li>/);
});

test('③ 只写了取代、没写“原值 → 本次 → 新值”时，每张旧卡一行', (t) => {
  const s = sample(t);
  const six = path.join(s.root, '专题工作', '借阅规则', '决策卡', '06-借阅上限五本.md');
  const text = fs.readFileSync(six, 'utf8');
  assert.ok(text.includes('- 借阅上限：3 本 → 加 2 本 → 5 本\n'));
  fs.writeFileSync(six, text.replace('- 借阅上限：3 本 → 加 2 本 → 5 本\n', ''));
  const { html } = buildBrief({ source: s.root, output: s.output });
  assert.deepEqual(rowsOf(html, 'changed'), ['chg-1', 'chg-2']);
  assert.match(summaryOf(html, 'chg-2'), /借阅上限<\/span><span class="pick"><del>每人最多同时借 3 本<\/del> → 每人最多同时借 5 本<\/span>/);
  assert.match(detailOf(html, 'chg-2'), /<div class="k">旧决定<\/div><div class="v"><a class="ref" href="[^"#]+02-[^"]+\.md">「借阅上限：每人最多同时借 3 本」<\/a><span class="why">状态已改为“已被某卡取代”<\/span>/);
});

test('链接自检：页内跳转都有目标，指向文件的链接都是相对链接且文件存在', (t) => {
  const s = sample(t);
  const { html, check } = buildBrief({ source: s.root, output: s.output });
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const anchors = [...html.matchAll(/\shref="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length > 0);
  for (const id of anchors) assert.ok(ids.has(id), `页内跳转没有目标：#${id}`);
  const files = [...html.matchAll(/\shref="([^"#]+)"/g)].map((m) => m[1]);
  assert.ok(files.length > 0);
  for (const href of files) {
    assert.doesNotMatch(href, /^[a-z][a-z0-9+.-]*:|^\//i, `不是相对链接：${href}`);
    assert.ok(fs.existsSync(path.resolve(s.dir, decodeURI(href))), `文件不存在：${href}`);
  }
  assert.equal(check.fileRefs, files.length);
  assert.equal(check.anchorRefs, anchors.length);
  assert.match(html, new RegExp(`链接自检：指向文件的链接 ${files.length} 处，指向 \\d+ 个文件，全部存在；页内跳转 ${anchors.length} 处，目标都在。`));
});

test('全页中文：看得见的文字里没有英文字母', (t) => {
  const s = sample(t);
  const { html } = buildBrief({ source: s.root, output: s.output });
  const visible = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
  assert.doesNotMatch(visible, /[A-Za-z]/);
});

test('样本生成幂等：连着生成两次一字不差，也和入库的样本简报一致', (t) => {
  const s = sample(t);
  const first = run(s);
  assert.equal(first.status, 0, first.stderr);
  const once = fs.readFileSync(s.output);
  const second = run(s);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fs.readFileSync(s.output), once);
  const committed = fs.readFileSync(path.join(tool, 'examples', '决策简报-示例.html'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(once.toString('utf8'), committed, '入库的样本简报过期了：在本目录重新生成 examples/决策简报-示例.html');
});

test('只写 --output 这一个文件，项目里的文件一个不动', (t) => {
  const s = sample(t);
  const before = tree(s.dir);
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  const after = tree(s.dir);
  assert.deepEqual(before.filter((row) => !after.includes(row)), []);
  assert.deepEqual(after.filter((row) => !before.includes(row)).map((row) => row.split('|')[0]), ['测试输出.html']);
  assert.match(r.stdout, /第 2 轮，2026-09-19：定了 3 项（其中否决 1 项），改了旧决定 2 处，带前提 1 项，未定 1 项，暂缓 1 项；研究卡 1 张不上首屏/);
});

test('命令行：少参数、输出目录不存在都报错，退出码 1', (t) => {
  const s = sample(t);
  const missing = spawnSync(process.execPath, [script, '--source', s.root], { encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /两项都要给出/);
  const noDir = spawnSync(process.execPath, [script, '--source', s.root, '--output', path.join(s.dir, '没有这个目录', '简报.html')], { encoding: 'utf8', windowsHide: true });
  assert.equal(noDir.status, 1);
  assert.match(noDir.stderr, /输出目录不存在/);
});

test('技能用目录链接安装时，从链接路径运行也照常生成', (t) => {
  const s = sample(t);
  // 链到临时目录里的一份副本，不链本仓库
  const real = path.join(s.dir, '技能副本');
  fs.mkdirSync(path.join(real, 'scripts'), { recursive: true });
  fs.copyFileSync(script, path.join(real, 'scripts', 'brief.mjs'));
  const link = path.join(s.dir, '技能链接');
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const r = run(s, path.join(link, 'scripts', 'brief.mjs'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已生成/);
  assert.ok(fs.existsSync(s.output));
});
