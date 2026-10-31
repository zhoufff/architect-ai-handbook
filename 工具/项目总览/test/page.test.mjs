// 页面与命令行：完成情况计数、页面关键元素、筛选只作用于功能面板、全中文、样本生成幂等、只写输出文件、只查不写、坏样本不出页。
// 每个测试把 examples/ 整份复制到临时目录，只改副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildOverview } from '../scripts/overview.mjs';

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(tool, 'scripts', 'overview.mjs');

function sample(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-overview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(tool, 'examples'), dir, { recursive: true });
  return { dir, root: path.join(dir, '示例项目'), output: path.join(dir, '测试输出.html') };
}

const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });

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

test('完成情况：总进度条和图例的计数由生成器算', (t) => {
  const { html } = buildOverview({ source: sample(t).root });
  assert.match(html, /<span class="n">共 27 项<\/span>/);
  const legend = [...html.matchAll(/<button class="stat (\w+)" data-f="\w+">(\S+) <b>(\d+)<\/b><\/button>/g)].map((m) => `${m[2]} ${m[3]}`);
  assert.deepEqual(legend, ['已验收 13', '进行中 4', '待完成 5', '未定 2', '不做 3']);
  assert.match(html, /<div class="bar big"><span class="seg done" style="flex:13"/);
  // 组头计数：办证与登录 5 项
  assert.match(html, /<span class="ovn">办证与登录<\/span><div class="bar">[\s\S]*?<span class="ovc"><i class="done">已验收 2<\/i>　<i class="todo">待完成 1<\/i>　<i class="open">未定 1<\/i>　<i class="no">不做 1<\/i><\/span>/);
});

test('页面关键元素：标题区、横幅、两个标签、组折叠、技术架构、时间线、为什么这样定', (t) => {
  const { html } = buildOverview({ source: sample(t).root });
  assert.match(html, /<title>河畔书屋借阅小程序（虚构示例） 项目总览<\/title>/);
  assert.match(html, /<h1>河畔书屋借阅小程序（虚构示例） 项目总览<\/h1>\n<p class="now">试运行第三周：借还书已验收，志愿者账号等你定。<\/p>/);
  assert.match(html, /<p class="meta">核对：2026-10-28　·　由 项目总览\/md\/总览\.md 和 项目总览\/md\/决策地图\.md 生成<\/p>/);
  assert.match(html, /<section class="ask ask-has"><div class="askl">现在要你定的事 · 1 件<\/div><p class="q">志愿者要不要各用一个账号登录前台？<\/p><details><summary>选项、推荐、何时之前<\/summary>/);
  assert.match(html, /<li>推荐：每人一个账号，周末借还约占一半，出错要能查到人；何时之前：2026-11-05；不定会挡住：志愿者值班那张施工票开不了工<\/li>/);
  assert.match(html, /<button class="tab on" data-t="feat">功能与架构<\/button><button class="tab" data-t="rounds">每轮决策<\/button>/);
  assert.equal([...html.matchAll(/<details class="grp" id="g\d+">/g)].length, 6, '六个组都是收起的折叠');
  assert.equal([...html.matchAll(/<div class="stage"><b>/g)].length, 5, '五段各一个段标题');
  assert.match(html, /<button class="lnk" id="xall">全部展开<\/button>/);
  assert.equal([...html.matchAll(/<div class="ar">/g)].length, 5);
  assert.match(html, /<div class="flow">读者在手机上点/);
  // 时间线最新在上，默认显示最新一轮
  assert.match(html, /<button class="rc on" data-r="0"><span class="rn">第 3 轮<\/span><small>2026-10-28<\/small>/);
  assert.match(html, /<button class="rc" data-r="1"><span class="rn">第 2 轮<\/span>/);
  assert.match(html, /<section class="round" data-r="0"><h3 class="rt">第 3 轮　逾期处理与押金<\/h3>/);
  assert.match(html, /<section class="round hide" data-r="1">/);
  assert.match(html, /<details class="why"><summary>为什么这样定 · 2 条<\/summary><div class="wc"><b>借阅上限：每人最多同时借 5 本<\/b>/);
  assert.match(html, /<span class="pill doing">进行中<\/span><div class="ft">馆长每周看一次逾期名单，一键发提醒短信<\/div>/);
});

test('没有要用户决定的事：横幅只有一行灰字', (t) => {
  const s = sample(t);
  const map = path.join(s.root, '项目总览/md/决策地图.md');
  fs.writeFileSync(map, fs.readFileSync(map, 'utf8').replace(/要用户决定：\n[\s\S]*?(?=下一步：)/, '要用户决定：无\n'));
  const { html } = buildOverview({ source: s.root });
  assert.match(html, /<section class="ask ask-none">现在没有要你定的事<\/section>/);
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ''), /ask-has/);
});

test('筛选只作用于功能面板；页面不加载外部资源；看得见的文字没有英文字段名和状态词', (t) => {
  const { html } = buildOverview({ source: sample(t).root });
  assert.match(html, /querySelectorAll\('#p-feat \.it'\)/);
  assert.doesNotMatch(html, /<link\b|<script\s+src|@import|url\(/);
  const visible = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(visible, /\b(done|doing|todo|open|no|feat|rounds)\b/);
});

test('样本生成幂等：入库的样本页和现在生成的一字不差', (t) => {
  const s = sample(t);
  const r = cli('--source', s.root, '--output', s.output);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(s.output, 'utf8'), fs.readFileSync(path.join(tool, 'examples/总览-示例.html'), 'utf8'));
  const again = path.join(s.dir, '第二次.html');
  cli('--source', s.root, '--output', again);
  assert.equal(fs.readFileSync(again, 'utf8'), fs.readFileSync(s.output, 'utf8'));
});

test('命令行：成功时打印路径、计数、轮次和提示；只写输出文件', (t) => {
  const s = sample(t);
  const before = tree(s.root);
  const r = cli('--source', s.root, '--output', s.output);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(s.root), before, '项目目录一个文件都没变');
  assert.match(r.stdout, /^项目总览：已生成 .*测试输出\.html（\d+ 字节）\n/);
  assert.match(r.stdout, /\n {2}功能 27 项：已验收 13，进行中 4，待完成 5，未定 2，不做 3；6 组\n/);
  assert.match(r.stdout, /\n {2}每轮决策：读到 2 轮（第 3 轮、第 2 轮）；要你定的事 1 件\n/);
  assert.match(r.stdout, /\n {2}提示：地图 MD 的“第 1 轮批准记录（借阅规则起步，2026-09-12）”是旧写法的批准段，没有读/);
});

test('只查不写：--check 什么文件都不写，打印同样的计数', (t) => {
  const s = sample(t);
  const before = tree(s.dir);
  const r = cli('--check', s.root);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(s.dir), before);
  assert.match(r.stdout, /^项目总览：只查不写，没有读不出或不合格的，可以生成；没有写任何文件。\n {2}功能 27 项/);
});

test('坏样本：退出码 1，按文件列出问题，不写页面', (t) => {
  const s = sample(t);
  const ov = path.join(s.root, '项目总览/md/总览.md');
  fs.writeFileSync(ov, fs.readFileSync(ov, 'utf8').replace('### 维护：备份与更新', '### 运维：备份与更新'));
  const before = tree(s.dir);
  const r = cli('--source', s.root, '--output', s.output);
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(s.output), false);
  assert.deepEqual(tree(s.dir), before);
  assert.match(r.stderr, /^项目总览：下面这些读不出或不合格，没有生成页面。/);
  assert.match(r.stderr, /\n- 项目总览\/md\/总览\.md\n {2}- 第 \d+ 行：段名“运维”不在五段（进入、使用、管理、维护、后台）里\n共 1 处。/);
  // 只查不写报同样的问题
  const c = cli('--check', s.root);
  assert.equal(c.status, 1);
  assert.equal(c.stderr, r.stderr);
});

test('命令行参数：缺项、混用、输出目录不存在都报错，不写文件', (t) => {
  const s = sample(t);
  for (const args of [['--source', s.root], ['--check', s.root, '--output', s.output], ['--bogus', 'x']]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^项目总览：/);
  }
  const r = cli('--source', s.root, '--output', path.join(s.dir, '没有的目录', '总览.html'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /项目总览：输出目录不存在/);
});
