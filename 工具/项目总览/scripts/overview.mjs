#!/usr/bin/env node
// 项目总览 1.0：读项目的总览 MD、地图 MD 和批准段引用的决策卡，生成一页项目总览（HTML）。
// 用法：node overview.mjs --source <项目根> --output <HTML 路径>；只查不写：node overview.mjs --check <项目根>
// 零依赖，Node 18 及以上。只读项目文件，只写 --output 这一个文件，--check 什么都不写。
// 写法按共享规程 03 的“总览 MD 头字段与分组”“地图 MD 头字段与批准段”“决策卡写法”读，校验按原型说明 7.5：
// 不合格的一次列出哪个文件哪里不对，退出码 1，不写页面；只提醒的项打印“提示”行，照常出页。
// 页面样式与交互照 原型/ 的定稿（2026-10-29），不加载任何外部字体、脚本、样式。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '项目总览 1.0';
const OVERVIEW_MD = '项目总览/md/总览.md';
const MAP_MD = '项目总览/md/决策地图.md';
const NONE = '无';
const STAGES = [['进入', '装、申请、登录'], ['使用', '日常使用'], ['管理', '管理员的事'], ['维护', '更新、反馈、备份'], ['后台', '看不见的部分']];
const STAGE_NAMES = STAGES.map(([name]) => name);
const STATUS = { '✅': 'done', 进行中: 'doing', 待完成: 'todo', 未定: 'open', 不做: 'no' };
const LABEL = { done: '已验收', doing: '进行中', todo: '待完成', open: '未定', no: '不做' };
const PROGRESS = { 已完成: 'done', 进行中: 'doing', 待完成: 'todo' };
const RLABEL = { done: '已完成', doing: '进行中', todo: '待完成' };
const ORDER = ['done', 'doing', 'todo', 'open', 'no'];
const OVERVIEW_LABELS = ['现状', '核对'];
const MAP_LABELS = ['轮次', '本轮范围', '要用户决定', '下一步'];
const MAP_IGNORED = ['上一轮简报']; // 决策简报时期的标签：认得，不用
const LISTS = [['do', '定了要做'], ['not', '定了不做 / 以后再说'], ['open', '还没定'], ['unchosen', '比较过、没选的做法']];
const LIMIT = { now: 40, topic: 25, groupName: 9, groupMin: 4, groupMax: 12, groups: 10 };
// 正文里不该出现的编号样式（原型说明 7.5 第 4 条）；出处只写在行尾 HTML 注释里
const CODES = [
  [/\bSpec(?:\s*[A-Z]?\d+)?\b/gi, '需求编号'],
  [/\b[A-Z]\d{2}\b/g, '票号或需求编号'], // T05、B58、A41；ES256、H264 这类技术名不算
  [/(?<![门车机船彩发邮支选股饭粮])票\s*[A-Z]?\d+/g, '票号'], // “门票 20 元”“发票 3 张”不算
  [/\d+\s*号?卡/g, '卡号'],
  [/\bADR\b/g, 'ADR 编号'],
  [/\b[vV]\d+(?:\.\d+)*\b/g, '版本号'],
  [/\b\d+\.\d+\.\d+\b/g, '版本号'],
];
const NEW_ROUND = /^##\s+第\s*(\d+)\s*轮\s*·\s*(\d{4}-\d{2}-\d{2})\s*·\s*(.+)$/;
// 像新写法（“轮”后跟“·”）却读不出：写错了，报错，不当旧写法放过
const NEAR_ROUND = /^##\s+第\s*\S+?\s*轮\s*·/;
const OLD_ROUND = /^##\s+第\s*\S+?\s*轮/;
const LIST_ITEM = /^([-*]|\d+[.)])\s+/;
const CJK = /[⺀-鿿　-〿＀-￯]/;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slash = (p) => p.split(path.sep).join('/');
// 字数：去掉空白后按字符（码点）数，中英文和标点各算一个（主控 2026-10-30 答复）
const chars = (s) => [...s.replace(/\s/g, '')].length;
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
// 注释换成同样多的换行，行号不变
const dropComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
const indentOf = (line) => line.replace(/\t/g, '    ').match(/^ */)[0].length;
const unlist = (s) => s.trim().replace(LIST_ITEM, '').trim();
const joinLines = (parts) => parts.reduce((acc, part) => (acc ? acc + (CJK.test(acc.slice(-1)) || CJK.test(part[0]) ? '' : ' ') + part : part), '');
const short = (s) => (chars(s) > 24 ? `${[...s].slice(0, 24).join('')}…` : s);
const count = (items, key = 's') => {
  const c = Object.fromEntries(ORDER.map((k) => [k, 0]));
  for (const it of items) c[it[key]] += 1;
  return c;
};

// ---------- 问题清单 ----------

// 按文件归集，报错时一次列全；同一处只记一次
class Problems {
  constructor() { this.byFile = new Map(); this.seen = new Set(); }
  add(file, message) {
    const key = `${file}\n${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (!this.byFile.has(file)) this.byFile.set(file, []);
    this.byFile.get(file).push(message);
  }
  get size() { return this.byFile.size; }
}

export class OverviewError extends Error {
  constructor(problems, source, notes = []) {
    const lines = ['项目总览：下面这些读不出或不合格，没有生成页面。写法见共享规程 03 的“总览 MD 头字段与分组”“地图 MD 头字段与批准段”“决策卡写法”。'];
    let total = 0;
    for (const [file, messages] of problems.byFile) {
      lines.push(`- ${slash(path.relative(source, file)) || file}`);
      for (const message of messages) lines.push(`  - ${message}`);
      total += messages.length;
    }
    lines.push(`共 ${total} 处。`);
    // 提示不挡生成，报错时也列出，改 MD 时一并看到
    for (const note of notes) lines.push(`  提示：${note}`);
    super(lines.join('\n'));
    this.name = 'OverviewError';
    this.problems = problems;
  }
}

// 一段正文里每处编号各报一条；同一处被两条样式扫到（如“Spec R12”里的“R12”）只报先扫到的
function scanCodes(text, where, file, problems) {
  const taken = [];
  for (const [re, kind] of CODES) {
    for (const m of text.matchAll(re)) {
      const [start, end] = [m.index, m.index + m[0].length];
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      problems.add(file, `${where}的正文里有${kind}样式“${m[0]}”：${short(text)}（出处只写在行尾注释里）`);
    }
  }
}

// ---------- 总览 MD ----------

function parseOverview(file, problems, notes) {
  const lines = dropComments(readText(file)).split('\n');
  const doc = { title: '', name: '', head: {}, intro: [], groups: [], arch: [], flow: [], seenArch: false, seenFeat: false };
  let section = 'top'; // top：H1 到第一个二级标题；feat、arch、skip
  let group = null;
  let para = [];
  let strayText = false;
  const flush = (target) => { if (para.length) { target.push(joinLines(para)); para = []; } };

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    const at = `第 ${i + 1} 行`;
    if (/^#\s/.test(line)) {
      if (!doc.title) doc.title = line.slice(2).trim();
      else problems.add(file, `${at}：一级标题只能有一个`);
      return;
    }
    if (/^##\s/.test(line)) {
      flush(section === 'top' ? doc.intro : doc.flow);
      const h = line.slice(3).trim();
      group = null;
      if (h === '功能清单') { section = 'feat'; doc.seenFeat = true; } else if (h === '技术架构') { section = 'arch'; doc.seenArch = true; } else {
        section = 'skip';
        notes.push(h === '完成情况' ? '总览 MD 的“完成情况”一节没有读：各数由生成器算' : `总览 MD 的二级标题“${h}”不是“功能清单”“技术架构”，没有读`);
      }
      return;
    }
    if (section === 'top') {
      const label = /^(现状|核对)(：|:)\s*(.*)$/.exec(line);
      if (label) {
        const [, name, colon, value] = label;
        if (colon === ':') problems.add(file, `${at}：头字段“${name}”用了半角冒号，要写“${name}：”`);
        if (name in doc.head) problems.add(file, `${at}：头字段“${name}”写了两次`);
        doc.head[name] = value.trim();
        return;
      }
      if (line.trim() === '') flush(doc.intro); else para.push(line.trim());
      return;
    }
    if (section === 'feat' && /^###\s/.test(line)) {
      const h = line.slice(4).trim();
      const cut = h.indexOf('：');
      const stage = cut < 0 ? '' : h.slice(0, cut).trim();
      const name = cut < 0 ? h : h.slice(cut + 1).trim();
      if (cut < 0) problems.add(file, `${at}：组标题“${h}”要写成“段名：组名”`);
      else if (!STAGE_NAMES.includes(stage)) problems.add(file, `${at}：段名“${stage}”不在五段（${STAGE_NAMES.join('、')}）里`);
      group = { stage, name, items: [], line: i + 1 };
      doc.groups.push(group);
      return;
    }
    if (line.trim().startsWith('|')) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return;
      if (section === 'feat') {
        if (cells[0] === '功能') return;
        if (!group) { problems.add(file, `${at}：功能行不在任何组里（前面要有“### 段名：组名”）`); return; }
        if (cells.length < 3) { problems.add(file, `${at}：功能行要三栏（功能、状态、还差什么 / 为什么）`); return; }
        const s = STATUS[cells[1]];
        const t = plain(cells[0]);
        if (!t) problems.add(file, `${at}：功能一栏是空的`);
        if (!s) problems.add(file, `${at}：状态“${cells[1]}”不在五个写法里（${Object.keys(STATUS).join('、')}）`);
        group.items.push({ s: s || 'open', badStatus: !s, t, n: plain(cells[2]), line: i + 1 });
      } else if (section === 'arch') {
        if (cells[0] === '部分') return;
        doc.arch.push([...cells, '', '', '', ''].slice(0, 4).map(plain));
      }
      return;
    }
    if (line.trim() === '') { if (section === 'arch') flush(doc.flow); return; }
    if (section === 'arch') para.push(line.trim());
    else if (section === 'feat') strayText = true;
  });
  flush(section === 'top' ? doc.intro : doc.flow);
  if (strayText) notes.push('总览 MD 的“功能清单”里有表格和组标题以外的文字，没有读');
  // “状态只有五种……”由页面图例表达，介绍段不写（03）
  const before = doc.intro.length;
  doc.intro = doc.intro.filter((p) => !p.startsWith('状态只有五种'));
  if (doc.intro.length < before) notes.push('总览 MD 介绍段里“状态只有五种……”一段没有上页面：按 03 介绍段不写，图例已表达');
  doc.intro = doc.intro.map(plain);
  doc.flow = doc.flow.map(plain);
  doc.name = doc.title.replace(/功能与架构总览$/, '').trim();
  return doc;
}

function checkOverview(doc, file, problems, notes) {
  if (!doc.title) problems.add(file, '缺一级标题“# <项目名> 功能与架构总览”');
  else if (!/功能与架构总览$/.test(doc.title) || !doc.title.replace(/功能与架构总览$/, '').trim()) problems.add(file, `一级标题“${doc.title}”要写成“<项目名> 功能与架构总览”`);

  for (const label of OVERVIEW_LABELS) {
    if (!(label in doc.head)) problems.add(file, `缺头字段“${label}：”（写在一级标题下面）`);
    else if (!doc.head[label]) problems.add(file, `头字段“${label}”没有内容`);
  }
  const now = doc.head.现状 || '';
  if (chars(now) > LIMIT.now) problems.add(file, `现状 ${chars(now)} 字，超过 ${LIMIT.now} 字：${now}`);
  if (doc.head.核对 && !validDate(doc.head.核对)) problems.add(file, `核对“${doc.head.核对}”要写成 YYYY-MM-DD`);
  if (!doc.seenFeat) problems.add(file, '缺“## 功能清单”一节');
  else if (!doc.groups.length) problems.add(file, '“功能清单”里没有读到组（三级标题“### 段名：组名”）');
  if (!doc.seenArch) problems.add(file, '缺“## 技术架构”一节');
  else if (!doc.arch.length) problems.add(file, '“技术架构”里没有读到表格行（部分、管什么、用的技术、像建筑里的）');

  let last = -1;
  const seen = new Map();
  for (const g of doc.groups) {
    const idx = STAGE_NAMES.indexOf(g.stage);
    if (idx >= 0 && idx < last) problems.add(file, `第 ${g.line} 行：段的顺序不对，“${g.stage}”出现在“${STAGE_NAMES[last]}”之后（组“${g.name}”）；顺序是 ${STAGE_NAMES.join(' → ')}`);
    last = Math.max(last, idx);
    if (g.items.length < LIMIT.groupMin || g.items.length > LIMIT.groupMax) problems.add(file, `第 ${g.line} 行：组“${g.name}”有 ${g.items.length} 项，一组要 ${LIMIT.groupMin} 到 ${LIMIT.groupMax} 项（超了拆、少了并）`);
    if (chars(g.name) > LIMIT.groupName) notes.push(`组名“${g.name}”${chars(g.name)} 字，超过 ${LIMIT.groupName} 字，页面上可能折行`);
    for (const it of g.items) {
      if (seen.has(it.t)) problems.add(file, `第 ${it.line} 行：功能“${short(it.t)}”在第 ${seen.get(it.t)} 行已出现过，一个功能只进一组`);
      else seen.set(it.t, it.line);
      if (it.s !== 'done' && !it.badStatus && !it.n) notes.push(`功能“${short(it.t)}”不是 ✅，第三栏“还差什么 / 为什么”是空的`);
    }
  }
  if (doc.groups.length > LIMIT.groups) problems.add(file, `共 ${doc.groups.length} 组，全部不超过 ${LIMIT.groups} 组`);

  scanCodes(now, '现状', file, problems);
  doc.intro.forEach((p) => scanCodes(p, '介绍段', file, problems));
  for (const g of doc.groups) {
    scanCodes(g.name, `组名“${g.name}”`, file, problems);
    for (const it of g.items) { scanCodes(it.t, `第 ${it.line} 行功能`, file, problems); scanCodes(it.n, `第 ${it.line} 行备注`, file, problems); }
  }
  doc.arch.forEach((row) => row.forEach((cell) => scanCodes(cell, `技术架构“${row[0]}”`, file, problems)));
  doc.flow.forEach((p) => scanCodes(p, '技术架构末尾的串讲段', file, problems));
}

// ---------- 地图 MD ----------

// 头字段：标签行之后接着写，到下一个标签为止；遇到标题或表格结束
function readMapHead(lines, file, problems) {
  const head = {};
  const known = [...MAP_LABELS, ...MAP_IGNORED];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#\s/.test(line)) continue;
    if (/^#/.test(line) || line.trim().startsWith('|')) break;
    const m = /^([^\s：:]{1,8})(：|:)\s*(.*)$/.exec(line);
    if (m && known.includes(m[1])) {
      if (m[2] === ':') problems.add(file, `第 ${i + 1} 行：头字段“${m[1]}”用了半角冒号`);
      if (m[1] in head) problems.add(file, `第 ${i + 1} 行：头字段“${m[1]}”写了两次`);
      cur = { inline: m[3].trim(), lines: [] };
      head[m[1]] = cur;
      continue;
    }
    if (cur && line.trim()) cur.lines.push(line);
  }
  for (const label of MAP_LABELS) {
    if (!head[label]) problems.add(file, `缺头字段“${label}：”`);
    else if (!head[label].inline && !head[label].lines.length) problems.add(file, `头字段“${label}”没有内容（没有就写“无”）`);
  }
  return head;
}

// 要用户决定：每件一行不缩进，子项缩进写在下面；每件五个要素
function readAsks(entry, notes) {
  if (!entry) return [];
  const asks = [];
  if (entry.inline && entry.inline !== NONE) asks.push({ q: plain(entry.inline), options: [] });
  for (const line of entry.lines) {
    const text = plain(unlist(line));
    if (indentOf(line) < 2 || !asks.length) { asks.push({ q: text, options: [] }); continue; }
    const a = asks[asks.length - 1];
    if (/^推荐/.test(text)) a.rec = text.replace(/^推荐(及理由)?[：:]?\s*/, '');
    else if (/^何时之前/.test(text)) a.by = text.replace(/^何时之前[：:]?\s*/, '');
    else if (/^(不定会挡住|会挡住)/.test(text)) a.blocks = text.replace(/^(不定会挡住|会挡住)[：:]?\s*/, '');
    else a.options.push(text);
  }
  asks.forEach((a, i) => {
    const missing = [];
    if (!a.options.length) missing.push('选项');
    if (!a.rec) missing.push('推荐');
    if (!a.by) missing.push('何时之前');
    if (!a.blocks) missing.push('不定会挡住什么');
    if (missing.length) notes.push(`“要用户决定”第 ${i + 1} 件“${short(a.q)}”缺：${missing.join('、')}（子项以“推荐”“何时之前”“不定会挡住”起头，其余算选项）`);
  });
  return asks;
}

function readItem(raw) {
  const refs = [];
  for (const [, inner] of raw.matchAll(/<!--([\s\S]*?)-->/g)) {
    for (const [, nums] of inner.matchAll(/((?:\d+\s*[、,，]\s*)*\d+)\s*卡/g)) refs.push(...nums.split(/\s*[、,，]\s*/).map(Number));
  }
  return { text: plain(raw.replace(/<!--[\s\S]*?-->/g, '')), refs };
}

function readRound(m, body, startLine, file, problems, notes) {
  const [, n, date, topic] = m;
  const r = { n: Number(n), date, topic: plain(topic), do: [], not: [], open: [], unchosen: [], next: null, line: startLine };
  const name = `第 ${n} 轮`;
  if (!validDate(date)) problems.add(file, `第 ${startLine} 行：${name}的日期“${date}”不是有效日期`);
  const seen = new Set();
  let cur = null;
  const push = (key, raw, at) => {
    const { text, refs } = readItem(raw);
    if (!text || text === NONE) return;
    if (key === 'do') {
      const p = /\s*[｜|]\s*进度[：:]\s*(\S+)$/.exec(text);
      if (!p) { problems.add(file, `${at}：${name}“定了要做”这一条没写进度（行尾“｜ 进度：已完成／进行中／待完成”）：${short(text)}`); return; }
      if (!PROGRESS[p[1]]) problems.add(file, `${at}：${name}“定了要做”的进度“${p[1]}”不在三个写法里（${Object.keys(PROGRESS).join('、')}）`);
      r.do.push({ t: text.slice(0, p.index).trim(), st: PROGRESS[p[1]] || 'todo', refs, line: at });
    } else if (key === 'not') r.not.push({ t: text, refs, line: at });
    else r[key].push({ t: text, line: at });
  };
  body.forEach((raw, k) => {
    const at = `第 ${startLine + 1 + k} 行`;
    const t = raw.trim();
    if (!t) return;
    const bare = t.replace(/\s/g, '');
    const list = LISTS.find(([, title]) => bare.startsWith(`${title.replace(/\s/g, '')}：`) || bare.startsWith(`${title.replace(/\s/g, '')}:`));
    if (list) {
      cur = list[0];
      if (seen.has(cur)) problems.add(file, `${at}：${name}的“${list[1]}”写了两次`);
      seen.add(cur);
      const rest = t.slice(t.search(/[：:]/) + 1).trim();
      if (rest) push(cur, rest, at);
      return;
    }
    if (/^接下来[：:]/.test(t)) { r.next = plain(t.replace(/^接下来[：:]\s*/, '')); cur = null; return; }
    if (cur) push(cur, t.replace(LIST_ITEM, ''), at);
  });
  for (const [key, title] of LISTS) if (!seen.has(key)) problems.add(file, `第 ${startLine} 行：${name}缺“${title}：”清单（没有内容写“无”）`);
  if (!r.next) problems.add(file, `第 ${startLine} 行：${name}缺“接下来：”一句`);
  if (chars(r.topic) > LIMIT.topic) problems.add(file, `第 ${startLine} 行：${name}的主题 ${chars(r.topic)} 字，超过 ${LIMIT.topic} 字：${r.topic}`);
  scanCodes(r.topic, `${name}主题`, file, problems);
  for (const key of ['do', 'not', 'open', 'unchosen']) for (const it of r[key]) scanCodes(it.t, `${it.line}${name}“${LISTS.find(([k]) => k === key)[1]}”`, file, problems);
  if (r.next) scanCodes(r.next, `${name}“接下来”`, file, problems);
  // 03：“定了要做”“定了不做 / 以后再说”每条行尾注释写决定所在的卡
  for (const it of [...r.do, ...r.not]) if (!it.refs.length) notes.push(`${name}“${short(it.t)}”行尾没有卡引用（<!-- NN 卡 -->），“为什么这样定”里不会有它`);
  return r;
}

function parseMap(file, problems, notes) {
  const lines = readText(file).split('\n');
  const head = readMapHead(lines, file, problems);
  const asks = readAsks(head.要用户决定, notes);
  const rounds = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '');
    const m = NEW_ROUND.exec(line);
    if (!m) {
      const title = line.replace(/^##\s+/, '');
      if (NEAR_ROUND.test(line)) problems.add(file, `第 ${i + 1} 行：批准段标题“${title}”读不出，要写成“## 第 N 轮 · YYYY-MM-DD · 主题”`);
      else if (OLD_ROUND.test(line)) notes.push(`地图 MD 的“${title}”是旧写法的批准段，没有读（新写法标题是“## 第 N 轮 · YYYY-MM-DD · 主题”）`);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !/^#{1,2}\s/.test(lines[j])) j += 1;
    rounds.push(readRound(m, lines.slice(i + 1, j), i + 1, file, problems, notes));
    i = j;
  }
  const byN = new Map();
  for (const r of rounds) {
    if (byN.has(r.n)) problems.add(file, `第 ${r.line} 行：第 ${r.n} 轮在第 ${byN.get(r.n)} 行已有一段，一轮只写一段`);
    else byN.set(r.n, r.line);
  }
  rounds.sort((a, b) => b.n - a.n);
  return { head, asks, rounds };
}

// ---------- 决策卡 ----------

function cardIndex(source) {
  const index = new Map();
  const topics = path.join(source, '专题工作');
  if (!isDir(topics)) return index;
  for (const topic of fs.readdirSync(topics).sort()) {
    const dir = path.join(topics, topic, '决策卡');
    if (!isDir(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const m = /^(\d+)-.+\.md$/.exec(name);
      if (!m || !isFile(path.join(dir, name))) continue;
      const n = Number(m[1]);
      if (!index.has(n)) index.set(n, []);
      index.get(n).push(path.join(dir, name));
    }
  }
  return index;
}

function sectionLines(lines, title) {
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i]); i += 1) out.push(lines[i]);
  return out.map((l) => l.trim()).filter(Boolean);
}

function readCard(file, problems) {
  const lines = dropComments(readText(file)).split('\n');
  const h1 = lines.find((l) => /^#\s/.test(l));
  if (!h1) problems.add(file, '缺一级标题“# 决定：…”');
  const three = sectionLines(lines, '给你的三句话');
  const reason = sectionLines(lines, '选择与理由') || [];
  const why = reason.map(unlist).find((l) => l.startsWith('为什么更好：'));
  return {
    file,
    title: plain((h1 || '').replace(/^#\s+/, '').replace(/^决定：/, '')),
    // 第四行“你要做的动作”写“无”时不上页面
    three: three && three.some((l) => l !== NONE) ? three.filter((l) => l !== NONE).map((l) => plain(unlist(l))) : null,
    why: why ? plain(why) : null,
  };
}

function attachWhys(rounds, source, mapFile, problems, notes) {
  const index = cardIndex(source);
  const cache = new Map();
  for (const r of rounds) {
    r.whys = [];
    const used = new Set();
    for (const it of [...r.do, ...r.not]) {
      for (const n of it.refs) {
        const nn = String(n).padStart(2, '0');
        const files = index.get(n) || [];
        if (!files.length) { problems.add(mapFile, `${it.line}：第 ${r.n} 轮引用的 ${nn} 卡在 专题工作/*/决策卡/ 下找不到（文件名要是“${nn}-名称.md”）`); continue; }
        if (files.length > 1) { problems.add(mapFile, `${it.line}：第 ${r.n} 轮引用的 ${nn} 卡有同号的 ${files.length} 张：${files.map((f) => slash(path.relative(source, f))).join('、')}`); continue; }
        if (used.has(files[0])) continue;
        used.add(files[0]);
        if (!cache.has(files[0])) cache.set(files[0], readCard(files[0], problems));
        const card = cache.get(files[0]);
        if (!card.three) { notes.push(`第 ${r.n} 轮引用的“${card.title}”（${nn} 卡）没有“给你的三句话”，“为什么这样定”里不出这一格`); continue; }
        if (!card.why) notes.push(`“${card.title}”（${nn} 卡）的“选择与理由”里没有以“为什么更好：”起头的一行，这一格只有三句话`);
        r.whys.push({ title: card.title, text: [...card.three, ...(card.why ? [card.why] : [])].join('\n') });
      }
    }
  }
}

// ---------- 读整个项目 ----------

export function loadProject(source) {
  source = path.resolve(source);
  const problems = new Problems();
  const notes = [];
  if (!isDir(source)) {
    problems.add(source, '项目根目录不存在');
    throw new OverviewError(problems, source);
  }
  const overviewFile = path.join(source, OVERVIEW_MD);
  const mapFile = path.join(source, MAP_MD);
  let doc = null;
  let map = null;
  if (!isFile(overviewFile)) {
    const old = ['功能地图.md', '功能与架构总览.md'].filter((n) => isFile(path.join(source, '项目总览/md', n)));
    problems.add(overviewFile, `找不到总览 MD${old.length ? `；同目录有 ${old.join('、')}，按 03 改名为 总览.md 并补头字段` : ''}`);
  } else {
    doc = parseOverview(overviewFile, problems, notes);
    checkOverview(doc, overviewFile, problems, notes);
  }
  if (!isFile(mapFile)) problems.add(mapFile, '找不到地图 MD');
  else {
    map = parseMap(mapFile, problems, notes);
    attachWhys(map.rounds, source, mapFile, problems, notes);
  }
  if (problems.size) throw new OverviewError(problems, source, notes);
  return { source, doc, map, notes };
}

// ---------- 页面零件 ----------

function bar(c, big = false, labels = LABEL) {
  const segs = ORDER.filter((k) => c[k]).map((k) => `<span class="seg ${k}" style="flex:${c[k]}" title="${labels[k] || LABEL[k]} ${c[k]}"></span>`).join('');
  return `<div class="bar${big ? ' big' : ''}">${segs}</div>`;
}

function legend(c, total) {
  const b = ORDER.filter((k) => c[k]).map((k) => `<button class="stat ${k}" data-f="${k}">${LABEL[k]} <b>${c[k]}</b></button>`).join('');
  return `<div class="legend"><span class="n">共 ${total} 项</span>${b}</div>`;
}

const itemHtml = (it) => `<li class="it" data-s="${it.s}"><span class="pill ${it.s}">${LABEL[it.s]}</span><div><div class="ft">${esc(it.t)}</div>${it.n ? `<div class="note">${esc(it.n)}</div>` : ''}</div></li>`;

function groupsHtml(groups) {
  const hints = Object.fromEntries(STAGES);
  const out = [];
  let lastStage = null;
  groups.forEach((g, i) => {
    if (g.stage !== lastStage) {
      out.push(`<div class="stage"><b>${esc(g.stage)}</b><span>${esc(hints[g.stage])}</span></div>`);
      lastStage = g.stage;
    }
    const c = count(g.items);
    const ovc = ORDER.filter((k) => c[k]).map((k) => `<i class="${k}">${LABEL[k]} ${c[k]}</i>`).join('　');
    out.push(`<details class="grp" id="g${i}"><summary class="gh"><span class="chev"></span><span class="ovn">${esc(g.name)}</span>${bar(c)}<span class="ovc">${ovc}</span></summary><ul>${g.items.map(itemHtml).join('')}</ul></details>`);
  });
  return `<div class="grps">${out.join('')}</div>`;
}

function archHtml(doc) {
  const rows = doc.arch.map((r) => `<div class="ar"><div class="an">${esc(r[0])}</div><div class="ad">${esc(r[1])}</div><div class="at">${esc(r[2])}</div><div class="ab">${esc(r[3])}</div></div>`).join('');
  return `<div class="ars">${rows}</div>${doc.flow.map((p) => `<div class="flow">${esc(p)}</div>`).join('')}`;
}

function askHtml(asks) {
  if (!asks.length) return '<section class="ask ask-none">现在没有要你定的事</section>';
  const parts = [`<section class="ask ask-has"><div class="askl">现在要你定的事 · ${asks.length} 件</div>`];
  for (const a of asks) {
    parts.push(`<p class="q">${esc(a.q)}</p>`);
    const tail = [a.rec && `推荐：${a.rec}`, a.by && `何时之前：${a.by}`, a.blocks && `不定会挡住：${a.blocks}`].filter(Boolean);
    const lis = [...a.options, ...(tail.length ? [tail.join('；')] : [])].map((x) => `<li>${esc(x)}</li>`).join('');
    if (lis) parts.push(`<details><summary>选项、推荐、何时之前</summary><ul>${lis}</ul></details>`);
  }
  parts.push('</section>');
  return parts.join('');
}

function roundsHtml(rounds) {
  if (!rounds.length) return '<p class="meta">地图 MD 里还没有新写法的批准段（“## 第 N 轮 · YYYY-MM-DD · 主题”）。</p>';
  const chips = [];
  const secs = [];
  rounds.forEach((r, i) => {
    const rc = count(r.do, 'st');
    chips.push(`<button class="rc${i === 0 ? ' on' : ''}" data-r="${i}"><span class="rn">第 ${r.n} 轮</span><small>${esc(r.date)}</small><span class="rtopic">${esc(r.topic)}</span>${r.do.length ? bar(rc, false, RLABEL) : ''}</button>`);
    const body = [];
    if (r.do.length) body.push(`<div class="rb do"><h4>定了要做</h4><ul class="plain">${r.do.map((d) => `<li class="it"><span class="pill ${d.st}">${RLABEL[d.st]}</span><div class="ft">${esc(d.t)}</div></li>`).join('')}</ul></div>`);
    if (r.whys.length) body.push(`<details class="why"><summary>为什么这样定 · ${r.whys.length} 条</summary>${r.whys.map((w) => `<div class="wc"><b>${esc(w.title)}</b><p>${esc(w.text)}</p></div>`).join('')}</details>`);
    const side = [];
    const box = (cls, title, list) => list.length && side.push(`<div class="rb ${cls}"><h4>${title}</h4><ul>${list.map((x) => `<li>${esc(x.t)}</li>`).join('')}</ul></div>`);
    box('no', '定了不做 / 以后再说', r.not);
    box('open', '还没定', r.open);
    box('un', '比较过、没选的做法', r.unchosen);
    if (side.length) body.push(`<div class="rside">${side.join('')}</div>`);
    if (r.next) body.push(`<p class="rnext">${esc(r.next)}</p>`);
    secs.push(`<section class="round${i === 0 ? '' : ' hide'}" data-r="${i}"><h3 class="rt">第 ${r.n} 轮　${esc(r.topic)}</h3><p class="meta">${esc(r.date)}</p>${body.join('')}</section>`);
  });
  return `<div class="rwrap"><div class="rchips">${chips.join('')}</div><div class="rbody">${secs.join('')}</div></div>`;
}

// ---------- 整页 ----------

const CSS = `
/* 项目总览页 · 定稿样式（原型 2026-10-29）：颜色只用在五种状态上，其余黑白灰；无外部依赖 */
:root {
  --bg: #f6f6f3; --card: #ffffff; --ink: #1d1f21; --sub: #5f6368; --line: #e3e3de;
  --done: #2e7d4f; --doing: #2f6fd1; --todo: #c27c0e; --open: #7a6aa8; --no: #9a9a94;
  --done-bg: #e5f2ea; --doing-bg: #e4edfb; --todo-bg: #fbf0dc; --open-bg: #eeebf6; --no-bg: #efefec;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #17181a; --card: #202124; --ink: #e8e8e6; --sub: #a0a3a8; --line: #33353a;
    --done: #5cc08a; --doing: #74a3f0; --todo: #e3a64a; --open: #a998d6; --no: #8a8c90;
    --done-bg: #1f3329; --doing-bg: #1f2a3d; --todo-bg: #3a2f1c; --open-bg: #2b2738; --no-bg: #2a2b2e;
  }
}
.done { --c: var(--done); --cbg: var(--done-bg); --g: "✓"; }
.doing { --c: var(--doing); --cbg: var(--doing-bg); --g: "◐"; }
.todo { --c: var(--todo); --cbg: var(--todo-bg); --g: "○"; }
.open { --c: var(--open); --cbg: var(--open-bg); --g: "?"; }
.no { --c: var(--no); --cbg: var(--no-bg); --g: "—"; }

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; }
main { max-width: 920px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 26px; margin: 0 0 10px; letter-spacing: .5px; }
.now { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
main > p.intro { font-size: 14px; line-height: 1.55; color: var(--sub); }
h2 { font-size: 18px; margin: 28px 0 10px; }
p { margin: 0 0 10px; }
.meta { color: var(--sub); font-size: 13px; }
/* 筛选、标签、轮次靠它藏起来；要压过后面 .it、.stage 的 display（原型里被压过，筛选时行藏不住） */
.hide { display: none !important; }
.lnk { font: inherit; font-size: 13px; font-weight: 400; color: var(--doing); background: none; border: 0; padding: 0;
  margin-left: 10px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }

/* 要你定的事：横幅在两个标签上方；有事用“未定”的紫色，没事一行灰字 */
.ask { margin: 14px 0 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.ask.ask-none { color: var(--sub); font-size: 14px; padding: 7px 14px; }
.ask.ask-none::before { content: "✓"; color: var(--done); font-weight: 700; margin-right: .4em; }
.ask.ask-has { border-color: var(--open); border-left-width: 4px; background: var(--open-bg); }
.ask .askl { color: var(--open); font-weight: 600; font-size: 14px; }
.ask .askl::before { content: "?"; display: inline-block; width: 1.25em; height: 1.25em; line-height: 1.25em; text-align: center;
  border-radius: 50%; background: var(--open); color: var(--card); font-weight: 700; margin-right: .45em; }
.ask .q { font-weight: 600; margin: 4px 0 0; }
.ask details { margin-top: 4px; font-size: 14px; }
.ask summary { cursor: pointer; color: var(--sub); }
.ask ul { margin: 4px 0 0; padding-left: 1.2em; }
.ask li { margin: 2px 0; }

/* 顶部两个标签 */
.tabs { display: flex; gap: 4px; margin: 16px 0 0; border-bottom: 1px solid var(--line); }
.tab { font: inherit; font-size: 15px; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 8px 14px; color: var(--sub); cursor: pointer; margin-bottom: -1px; }
.tab.on { color: var(--ink); border-bottom-color: var(--ink); font-weight: 600; }

/* 完成情况：一条总进度条，图例就是筛选按钮 */
.total { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px 10px; margin: 10px 0 8px; }
.bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; gap: 2px; }
.bar.big { height: 14px; border-radius: 7px; }
.seg { background: var(--c); }
.seg.no { opacity: .45; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 10px; font-size: 14px; }
.legend .n { color: var(--sub); margin-right: 6px; }
.legend .stat { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 14px; color: var(--ink);
  background: none; border: 1px solid transparent; border-radius: 999px; padding: 2px 10px 2px 8px; cursor: pointer; }
.legend .stat b { color: var(--c); }
.legend .stat::before { content: var(--g); color: var(--c); font-weight: 700; }
.legend .stat:hover { border-color: var(--line); }
.legend .stat.on { background: var(--cbg); border-color: var(--c); }
.hint { font-size: 12px; color: var(--sub); margin-bottom: 10px; }

/* 功能清单：一张卡；段标题一行小字分段，组行是折叠头（组名、小进度条、计数） */
.grps { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0 16px 4px; }
.grps > .grp + .grp, .grps > .grp + .stage { border-top: 1px solid var(--line); }
.stage { display: flex; align-items: baseline; gap: 10px; padding: 12px 0 2px; }
.stage b { font-size: 13px; letter-spacing: 1px; }
.stage span { font-size: 12px; color: var(--sub); }
.gh { list-style: none; display: grid; grid-template-columns: 1.1em 11em 1fr; gap: 2px 12px; align-items: center; padding: 8px 0; cursor: pointer; }
.gh::-webkit-details-marker { display: none; }
.gh .ovn { font-weight: 600; font-size: 14px; }
.gh .bar { grid-column: 3; }
.gh .ovc { grid-column: 3; font-size: 12px; color: var(--sub); }
.ovc i { font-style: normal; color: var(--c); }
.ovc i.no { color: var(--sub); }
.ovc i::before { content: var(--g); font-weight: 700; margin-right: .3em; }
.gh .chev { grid-row: span 2; color: var(--sub); font-size: 11px; }
.gh .chev::before { content: "▶"; display: inline-block; transition: transform .15s; }
.grp[open] > .gh .chev::before { transform: rotate(90deg); }
.grp[open] > .gh { padding-bottom: 6px; }
.grp ul { list-style: none; margin: 0; padding: 0 0 6px calc(1.1em + 12px); }
.it { display: grid; grid-template-columns: 5.4em 1fr; gap: 10px; padding: 6px 0; border-top: 1px solid var(--line); }
.it:first-child { border-top: 0; }
.grp .it:first-child { border-top: 1px dashed var(--line); }
.pill { font-size: 12px; border-radius: 999px; text-align: center; padding: 2px 0; height: fit-content; margin-top: 1px;
  color: var(--c); background: var(--cbg); white-space: nowrap; }
.pill::before { content: var(--g); font-weight: 700; margin-right: .3em; }
.it[data-s="no"] .ft { color: var(--sub); }
.note { font-size: 13px; color: var(--sub); }

/* 技术架构：放在“功能与架构”末尾 */
.ars { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 4px 16px; }
.ar { display: grid; grid-template-columns: 8.5em 1fr 1fr; gap: 2px 16px; padding: 8px 0; border-top: 1px solid var(--line); }
.ar:first-child { border-top: 0; }
.an { font-weight: 600; grid-row: span 2; }
.ad { grid-column: 2 / 4; }
.at, .ab { font-size: 13px; color: var(--sub); }
.ab::before { content: "像："; }
.flow { margin-top: 12px; padding: 12px 16px; border-left: 3px solid var(--doing); background: var(--card); border-radius: 0 10px 10px 0; }

/* 每轮决策：左边竖排时间线（最新在上），右边本轮内容 */
.rwrap { display: grid; grid-template-columns: 210px 1fr; gap: 20px; align-items: start; margin-top: 16px; }
.rchips { display: flex; flex-direction: column; gap: 2px; margin: 0; padding-left: 18px; position: sticky; top: 16px; }
.rchips::before { content: ""; position: absolute; left: 5px; top: 14px; bottom: 14px; width: 2px; background: var(--line); }
.rc { position: relative; font: inherit; text-align: left; background: none; border: 1px solid transparent; border-radius: 8px;
  padding: 6px 10px; color: var(--sub); cursor: pointer; }
.rc::before { content: ""; position: absolute; left: -18px; top: 13px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--bg); border: 2px solid var(--sub); }
.rc:hover { background: var(--card); }
.rc.on { background: var(--card); border-color: var(--line); color: var(--ink); }
.rc.on::before { background: var(--ink); border-color: var(--ink); }
.rc .rn { font-weight: 600; }
.rc small { font-size: 11px; color: var(--sub); margin-left: .5em; }
.rc .rtopic { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; line-height: 1.4; }
.rc .bar { height: 4px; gap: 1px; margin-top: 5px; border-radius: 2px; }
.round { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
.rt { color: var(--ink); font-size: 17px; margin: 0; }
.rb { margin-top: 12px; }
.rb h4 { margin: 0 0 6px; font-size: 13px; color: var(--sub); font-weight: 600; }
.rb ul { margin: 0; padding-left: 1.2em; }
.rb ul.plain { list-style: none; padding: 0; }
.rb li { margin: 2px 0; }
.rb.un li, .rb.no li { color: var(--sub); }
.rb.open li { color: var(--open); }
.rnext { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 14px; color: var(--sub); }
.rside { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-top: 12px; }
.rside .rb { margin: 0; padding: 10px 12px; background: var(--bg); border-radius: 8px; font-size: 14px; }
.rside .rb ul { padding-left: 1.1em; }

/* 为什么这样定：折叠在“定了要做”下面，展开是决策卡给你的三句话和“为什么更好”一行 */
.why { margin-top: 10px; font-size: 13px; }
.why summary { cursor: pointer; color: var(--doing); list-style: none; }
.why summary::-webkit-details-marker { display: none; }
.why summary::before { content: "▶"; display: inline-block; font-size: 10px; margin-right: 6px; transition: transform .15s; }
.why[open] summary::before { transform: rotate(90deg); }
.wc { margin-top: 8px; padding: 8px 12px; background: var(--bg); border-left: 3px solid var(--line); border-radius: 0 8px 8px 0; }
.wc b { display: block; margin-bottom: 4px; }
.wc p { margin: 0; white-space: pre-line; color: var(--sub); }

/* 手机宽度 */
@media (max-width: 640px) {
  .gh { grid-template-columns: 1.1em 1fr; }
  .gh .ovn, .gh .bar, .gh .ovc { grid-column: 2; }
  .gh .chev { grid-row: span 3; }
  .ar { grid-template-columns: 1fr; } .an { grid-row: auto; } .ad { grid-column: 1; }
  .rwrap { grid-template-columns: 1fr; }
  .rchips { position: static; flex-direction: row; overflow-x: auto; padding: 0 0 4px; gap: 8px; }
  .rchips::before, .rc::before, .rc .rtopic { display: none; }
  .rc { flex: 0 0 auto; background: var(--card); border-color: var(--line); }
}

@media (prefers-reduced-motion: reduce) { .gh .chev::before, .why summary::before { transition: none; } }
`;

const JS = `
(function () {
  var stats = document.querySelectorAll('.stat');
  var grps = document.querySelectorAll('.grp');
  var xall = document.getElementById('xall');
  function setAll(open) { grps.forEach(function (g) { g.open = open; }); xall.textContent = open ? '全部收起' : '全部展开'; }
  xall.addEventListener('click', function () { setAll(xall.textContent === '全部展开'); });
  // 段标题：它后面直到下一个段标题之间的组都藏起来了，它也藏
  function syncStages() {
    document.querySelectorAll('.stage').forEach(function (s) {
      var el = s.nextElementSibling, has = false;
      while (el && !el.classList.contains('stage')) {
        if (el.classList.contains('grp') && !el.classList.contains('hide')) has = true;
        el = el.nextElementSibling;
      }
      s.classList.toggle('hide', !has);
    });
  }
  // 按状态筛选：只作用于“功能与架构”标签里的清单；有命中的组自动展开
  function setFilter(f) {
    stats.forEach(function (x) { x.classList.toggle('on', !!f && x.dataset.f === f); });
    document.querySelectorAll('#p-feat .it').forEach(function (it) { it.classList.toggle('hide', !!f && it.dataset.s !== f); });
    grps.forEach(function (g) {
      var has = !!g.querySelector('.it:not(.hide)');
      g.classList.toggle('hide', !has);
      if (f && has) g.open = true;
    });
    syncStages();
  }
  stats.forEach(function (b) {
    b.addEventListener('click', function () {
      var f = b.classList.contains('on') ? null : b.dataset.f;
      setFilter(f);
      if (f) { var g = document.querySelector('.grp:not(.hide)'); if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('on', x === t); });
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('hide', p.id !== 'p-' + t.dataset.t); });
    });
  });
  document.querySelectorAll('.rc').forEach(function (c) {
    c.addEventListener('click', function () {
      document.querySelectorAll('.rc').forEach(function (x) { x.classList.toggle('on', x === c); });
      document.querySelectorAll('.round').forEach(function (r) { r.classList.toggle('hide', r.dataset.r !== c.dataset.r); });
    });
  });
})();
`;

export function renderPage(project) {
  const { doc, map } = project;
  const items = doc.groups.flatMap((g) => g.items);
  const total = count(items);
  const head = [
    `<h1>${esc(doc.name)} 项目总览</h1>`,
    `<p class="now">${esc(doc.head.现状)}</p>`,
    ...doc.intro.map((p) => `<p class="intro">${esc(p)}</p>`),
    `<p class="meta">${esc(`核对：${doc.head.核对}　·　由 ${OVERVIEW_MD} 和 ${MAP_MD} 生成`)}</p>`,
    askHtml(map.asks),
  ];
  const feat = [
    '<h2>完成情况</h2>',
    `<div class="total">${bar(total, true)}${legend(total, items.length)}</div>`,
    '<div class="hint">点一种状态只看这一种，再点一次看全部。</div>',
    '<h2>功能清单<button class="lnk" id="xall">全部展开</button></h2>',
    groupsHtml(doc.groups),
    '<h2>技术架构</h2>',
    archHtml(doc),
  ];
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${VERSION}">
<title>${esc(doc.name)} 项目总览</title>
<style>${CSS}</style>
</head>
<body>
<main>
${head.join('\n')}
<nav class="tabs"><button class="tab on" data-t="feat">功能与架构</button><button class="tab" data-t="rounds">每轮决策</button></nav>
<div class="panel" id="p-feat">
${feat.join('\n')}
</div>
<div class="panel hide" id="p-rounds">
${roundsHtml(map.rounds)}
</div>
</main>
<script>${JS}</script>
</body>
</html>
`;
}

export function summary(project) {
  const items = project.doc.groups.flatMap((g) => g.items);
  const c = count(items);
  const rounds = project.map.rounds;
  return [
    `功能 ${items.length} 项：${ORDER.map((k) => `${LABEL[k]} ${c[k]}`).join('，')}；${project.doc.groups.length} 组`,
    `每轮决策：读到 ${rounds.length} 轮${rounds.length ? `（${rounds.map((r) => `第 ${r.n} 轮`).join('、')}）` : ''}；要你定的事 ${project.map.asks.length} 件`,
  ];
}

export function buildOverview({ source }) {
  const project = loadProject(source);
  return { html: renderPage(project), project };
}

// ---------- 命令行 ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const name = String(key).slice(2);
    if (['--source', '--output', '--check'].includes(key) && argv[i + 1] !== undefined && !(name in args)) {
      args[name] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`项目总览：不认识的参数：${key}`);
    }
  }
  const usable = 'check' in args ? args.check && !args.source && !args.output : args.source && args.output;
  if (!usable) throw new Error('项目总览：用法 node overview.mjs --source <项目根> --output <HTML 路径>，两项都要给出；只查不写用 node overview.mjs --check <项目根>，不和前两项一起用。');
  return args;
}

function main() {
  let args;
  let result;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!args.check) {
      const output = path.resolve(args.output);
      if (isDir(output)) throw new Error(`项目总览：输出路径是个目录：${output}`);
      if (!isDir(path.dirname(output))) throw new Error(`项目总览：输出目录不存在：${path.dirname(output)}`);
    }
    result = buildOverview({ source: args.check || args.source });
  } catch (error) {
    if (!(error instanceof OverviewError) && !/^项目总览：/.test(error.message)) throw error;
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const { html, project } = result;
  if (args.check) {
    console.log('项目总览：只查不写，没有读不出或不合格的，可以生成；没有写任何文件。');
  } else {
    const output = path.resolve(args.output);
    try {
      fs.writeFileSync(output, html, 'utf8');
    } catch (error) {
      console.error(`项目总览：写不进输出文件 ${output}（${error.code || error.message}）`);
      process.exitCode = 1;
      return;
    }
    console.log(`项目总览：已生成 ${output}（${Buffer.byteLength(html)} 字节）`);
  }
  for (const line of summary(project)) console.log(`  ${line}`);
  for (const note of project.notes) console.log(`  提示：${note}`);
}

// 作为命令运行时才执行；被测试导入时不执行。技能目录用目录链接安装时，两边按真实路径比
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) main();
