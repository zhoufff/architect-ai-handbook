#!/usr/bin/env node
// 决策简报 1.0：读项目的地图 MD 和决策卡，生成一页精简版决策简报（HTML）。
// 用法：node brief.mjs --source <项目根> --output <HTML 路径>
// 零依赖，Node 18 及以上。只读项目文件，只写 --output 这一个文件；输出目录要已存在，且和项目在同一个盘（页面里全是相对链接）。
// 卡和地图 MD 按共享规程 03 的“决策卡写法”读（规则票附录 A、B）。必填的标签或段落读不出、状态不在五值内、取代关系两边对不上、
// 页面里的链接指向的文件不存在：一次列出哪个文件缺什么，退出码 1，不写页面，不猜。写“无”的照样显示“无”。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NONE = '无';
const STATUSES = ['未定', '已定', '否决', '暂缓', '已被某卡取代'];
const STATUS_CLASS = { 未定: 'open', 已定: 'ok', 否决: 'no', 暂缓: 'defer', 已被某卡取代: 'old' };
const CARD_LABELS = ['状态', '定于', '谁定的', '出处', '依赖', '取代', '影响哪些卡'];
const RELATIONS = ['依赖', '取代', '影响哪些卡'];
const SECTIONS = ['问题', '比较过的选项', '选择与理由', '影响', '前提', '依据', '后续', '暂缓原因'];
const FINDING = '查证结论'; // 研究卡用它代替“选择与理由”
const MAP_LABELS = ['轮次', '本轮范围', '要用户决定', '下一步', '上一轮简报'];
// 这些标签的值可以接着写在下面几行，到空行或下一个标签为止；其余标签只占一行
const CARD_MULTI = new Set(['谁定的', '出处', '依赖', '取代', '影响哪些卡']);
const MAP_MULTI = new Set(['要用户决定', '下一步']);
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
const LIST_ITEM = /^( *)([-*]|\d+[.)])\s+(.*)$/;
const CJK = /[⺀-鿿　-〿＀-￯]/;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slash = (p) => p.split(path.sep).join('/');
// Windows 上文件名不分大小写，按小写比对卡片
const fileKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const trimmed = (lines) => (lines ? lines.map((line) => line.trim()).filter(Boolean) : null);
const isNone = (lines) => Array.isArray(lines) && lines.length === 1 && lines[0] === NONE;
const roundName = (n) => (/^\d+$/.test(n) ? `第 ${n} 轮` : `第${n}轮`);
const topicOf = (card) => card.title.split('：')[0];
const pickOf = (card) => (card.title.includes('：') ? card.title.slice(card.title.indexOf('：') + 1) : card.title);

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

export class BriefError extends Error {
  constructor(problems, source) {
    const lines = ['决策简报：下面这些读不出或对不上，没有生成页面。卡和地图 MD 的写法见共享规程 03 的“决策卡写法”。'];
    let count = 0;
    for (const [file, messages] of problems.byFile) {
      if (file) lines.push(slash(path.relative(source, file)) || file);
      for (const message of messages) lines.push(`${file ? '  ' : ''}- ${message}`);
      count += messages.length;
    }
    lines.push(`共 ${count} 处。`);
    super(lines.join('\n'));
    this.name = 'BriefError';
    this.problems = problems;
  }
}

// ---------- 读 Markdown ----------

// 拆成：标题（第一个一级标题）、开头各行（第一个二级标题之前）、各二级标题段
function splitDoc(text) {
  const doc = { title: null, head: [], sections: [] };
  let current = null;
  for (const line of text.split('\n')) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) { current = { name: h2[1], lines: [] }; doc.sections.push(current); continue; }
    if (current) { current.lines.push(line); continue; }
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1 && doc.title === null) { doc.title = h1[1]; continue; }
    doc.head.push(line);
  }
  return doc;
}

// 开头的固定标签：“标签：值”，冒号用全角，一行一项。多行标签的值接着写在下面，到下一个标签为止，中间可以空行。
// 不属于任何标签的行记进 stray：卡片据此提示，地图 MD 的索引就在这里，不提示
function readHead(lines, labels, multi) {
  const fields = new Map();
  const messages = [];
  const halfWidth = new Set();
  const stray = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { if (current) current.push(''); continue; }
    const m = /^([^\s：:]+?)\s*([：:])\s*(.*)$/.exec(line);
    if (m && labels.includes(m[1])) {
      current = null;
      if (m[2] === ':') { halfWidth.add(m[1]); messages.push(`标签“${m[1]}”后面是半角冒号，要用全角“：”`); continue; }
      if (fields.has(m[1])) { messages.push(`标签“${m[1]}”写了两次`); continue; }
      const value = m[3] ? [m[3]] : [];
      fields.set(m[1], value);
      if (multi.has(m[1])) current = value;
      continue;
    }
    if (current) current.push(line);
    else stray.push(line.trim());
  }
  const missing = labels.filter((label) => !fields.has(label) && !halfWidth.has(label));
  if (missing.length) messages.push(`缺标签：${missing.join('、')}`);
  const empty = labels.filter((label) => fields.has(label) && !fields.get(label).some((line) => line.trim()));
  if (empty.length) messages.push(`标签没有内容（没有就写“无”）：${empty.join('、')}`);
  return { fields, messages, stray };
}

// 链接目标分类：网址、页内锚点、绝对路径（不许用）、相对路径（换成绝对路径）
function classify(baseDir, href) {
  if (/^(https?|mailto):/i.test(href)) return { kind: 'web' };
  if (href.startsWith('#')) return { kind: 'anchor' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[\\/]/.test(href)) return { kind: 'absolute' };
  const [file, hash = ''] = href.split('#');
  let decoded = file;
  try { decoded = decodeURI(file); } catch { /* 按原样找 */ }
  return { kind: 'file', abs: path.resolve(baseDir, decoded), hash };
}

// 状态五值。“已被某卡取代”接受两种写法：“已被某卡取代：[新卡](链接)”，或把“某卡”写成链接“已被[新卡](链接)取代”
function readStatus(text) {
  const links = [...text.matchAll(LINK)].map((m) => ({ text: m[1], href: m[2] }));
  const bare = text.replace(LINK, '').replace(/[\s：:，,。、（）()「」]/g, '');
  if (!links.length && STATUSES.slice(0, 4).includes(bare)) return { status: bare, links };
  if (bare === '已被某卡取代' || (bare === '已被取代' && links.length)) return { status: '已被某卡取代', links };
  return null;
}

function readCard(file, meta, problems) {
  const add = (message) => problems.add(file, message);
  const doc = splitDoc(readText(file));
  const card = { ...meta, file, anchor: null };

  let title = doc.title ? /^(决定|未定)：\s*(.+)$/.exec(doc.title) : null;
  if (title && title[1] === '决定' && /^未定：/.test(title[2])) title = [title[0], '未定', title[2].replace(/^未定：\s*/, '')];
  if (!title) add(doc.title ? `标题行应为“# 决定：结论句”，未定时“# 未定：问题一句”；现为“# ${doc.title}”` : '缺标题行“# 决定：结论句”（未定时“# 未定：问题一句”）');
  card.title = title ? title[2].trim() : doc.title || path.basename(file, '.md');

  const head = readHead(doc.head, CARD_LABELS, CARD_MULTI);
  head.messages.forEach(add);
  card.stray = head.stray;
  const value = (label) => trimmed(head.fields.get(label));

  card.status = null;
  card.statusLinks = [];
  const status = value('状态');
  if (status && status.length) {
    const read = readStatus(status.join(''));
    if (read) { card.status = read.status; card.statusLinks = read.links; } else add(`状态“${status.join('')}”不在五值内（${STATUSES.join('、')}）`);
  }

  card.date = null;
  const date = value('定于');
  if (date && date.length) {
    const text = date.join('');
    if (text === NONE) {
      if (card.status === '已定' || card.status === '否决') add(`状态是${card.status}，定于要写日期（如 2026-09-27）`);
    } else if (validDate(text)) card.date = text;
    else add(`定于应写日期（如 2026-09-27）或“无”，现为“${text}”`);
  }

  card.who = value('谁定的') || [];
  card.origin = value('出处') || [];
  // 关系：card[标签] 是链接（对卡、反查用），card.relationLines[标签] 是原行（显示用，保留链接后的说明）
  card.relationLines = {};
  for (const label of RELATIONS) {
    card[label] = [];
    const lines = value(label);
    card.relationLines[label] = !lines || isNone(lines) ? [] : lines;
    for (const line of card.relationLines[label]) {
      const found = [...line.matchAll(LINK)];
      if (!found.length) add(`“${label}”每行写卡名称和相对链接，这一行没有链接：${line}`);
      for (const m of found) card[label].push({ text: m[1], href: m[2] });
    }
  }

  card.sections = new Map();
  for (const s of doc.sections) {
    if (card.sections.has(s.name)) { add(`段落“## ${s.name}”写了两次`); continue; }
    card.sections.set(s.name, s.lines);
  }
  card.kind = !card.sections.has('选择与理由') && card.sections.has(FINDING) ? 'research' : 'decision';
  card.reasonName = card.kind === 'research' ? FINDING : '选择与理由';
  const needed = SECTIONS.map((name) => (name === '选择与理由' ? card.reasonName : name));
  card.extra = [...card.sections.keys()].filter((name) => !needed.includes(name));
  const missing = needed.filter((name) => !card.sections.has(name));
  if (missing.length) add(`缺段落：${missing.map((name) => (name === '选择与理由' ? '选择与理由（研究卡写“查证结论”）' : name)).join('、')}`);
  const blank = needed.filter((name) => card.sections.has(name) && !hasContent(card.sections.get(name)));
  if (blank.length) add(`段落是空的（没有内容就写“无”；只有表头的表格也算空）：${blank.join('、')}`);
  const noneIn = (name) => isNone(trimmed(card.sections.get(name)));

  if (card.status === '暂缓' && card.sections.has('暂缓原因') && noneIn('暂缓原因')) add('状态是暂缓，“暂缓原因”要写为什么不定、什么情况下重新考虑');
  card.premised = card.sections.has('前提') && hasContent(card.sections.get('前提')) && !noneIn('前提');

  // 影响里改旧决定的写法：“原值 → 本次 → 新值”，第一段可以带“某项：”
  card.changes = [];
  for (const raw of card.sections.get('影响') || []) {
    if (!raw.includes('→')) continue;
    const text = raw.trim().replace(/^(?:[-*]|\d+[.)])\s+/, '').replace(/\*\*/g, '');
    const parts = text.split('→').map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => !part)) { add(`“影响”里带“→”的行是改旧决定的写法，要写成“原值 → 本次 → 新值”三段；不是改旧决定就换别的写法：${text}`); continue; }
    const lead = /^([^：]+)：\s*(.+)$/.exec(parts[0]);
    card.changes.push({
      subject: lead && lead[1] !== '原值' ? lead[1] : null,
      from: lead ? lead[2] : parts[0],
      delta: parts[1].replace(/^本次：\s*/, ''),
      to: parts[2].replace(/^新值：\s*/, ''),
    });
  }
  return card;
}

function loadCards(source, problems, notes) {
  const root = path.join(source, '专题工作');
  if (!isDir(root)) { problems.add(root, '找不到专题目录（约定位置：专题工作/<专题>/决策卡/）'); return []; }
  const topics = fs.readdirSync(root).filter((topic) => isDir(path.join(root, topic, '决策卡'))).sort();
  const cards = [];
  const used = new Set();
  const cardName = /^\d{2,}-.+\.md$/;
  topics.forEach((topic, index) => {
    const dir = path.join(root, topic, '决策卡');
    const names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n) && isFile(path.join(dir, n))).sort();
    for (const name of names.filter((n) => !cardName.test(n))) notes.push(`${slash(path.relative(source, path.join(dir, name)))} 的文件名不是“NN-名称.md”，没有当作决策卡读`);
    for (const name of names.filter((n) => cardName.test(n))) {
      const num = name.match(/^\d+/)[0];
      const base = topics.length > 1 ? `card-${index + 1}-${num}` : `card-${num}`;
      let id = base;
      for (let k = 2; used.has(id); k += 1) id = `${base}-${k}`;
      used.add(id);
      cards.push(readCard(path.join(dir, name), { topic, num, id }, problems));
    }
  });
  if (!cards.length) problems.add(root, '没有找到决策卡（约定位置：专题工作/<专题>/决策卡/NN-名称.md）');
  return cards;
}

// 关系里的链接对到卡。取代两边要对上：新卡写了取代，旧卡状态就是“已被某卡取代”；旧卡状态行链到的卡也要写了取代它
function linkCards(cards, problems) {
  const byKey = new Map(cards.map((card) => [fileKey(card.file), card]));
  for (const card of cards) {
    for (const link of [...RELATIONS.flatMap((label) => card[label]), ...card.statusLinks]) {
      const target = classify(path.dirname(card.file), link.href);
      link.card = target.kind === 'file' ? byKey.get(fileKey(target.abs)) || null : null;
    }
  }
  for (const card of cards) {
    for (const link of card['取代']) {
      if (!link.card) { problems.add(card.file, `“取代”只能链到本项目的决策卡：[${link.text}](${link.href})；改 ADR 等别的旧决定，写在“影响”里的“原值 → 本次 → 新值”`); continue; }
      if (link.card.status && link.card.status !== '已被某卡取代') problems.add(link.card.file, `「${card.title}」的“取代”写了本卡，本卡状态应改为“已被某卡取代”并链到那张卡`);
    }
  }
  for (const card of cards) {
    card.replacedBy = cards.filter((other) => other['取代'].some((link) => link.card === card));
    card.dependents = cards.filter((other) => other !== card && other['依赖'].some((link) => link.card === card));
    if (card.status !== '已被某卡取代') continue;
    for (const link of card.statusLinks) {
      if (!link.card) problems.add(card.file, `状态行链到的不是本项目的决策卡：[${link.text}](${link.href})`);
      else if (!card.replacedBy.includes(link.card)) problems.add(card.file, `状态写被「${link.card.title}」取代，但那张卡的“取代”里没有本卡`);
    }
    if (!card.replacedBy.length && !card.statusLinks.length) problems.add(card.file, '状态是“已被某卡取代”，但状态行没有链到新卡，也没有哪张卡的“取代”写了本卡');
  }
}

function readMap(source, problems) {
  const file = path.join(source, '项目总览', 'md', '决策地图.md');
  if (!isFile(file)) { problems.add(file, '找不到地图 MD（约定位置：项目总览/md/决策地图.md）'); return null; }
  const add = (message) => problems.add(file, message);
  const doc = splitDoc(readText(file));
  const head = readHead(doc.head, MAP_LABELS, MAP_MULTI);
  head.messages.forEach(add);
  const text = (label) => (trimmed(head.fields.get(label)) || []).join('');
  const map = {
    file,
    project: doc.title ? doc.title.replace(/\s*决策地图\s*$/, '').trim() || null : null,
    round: null,
    prev: null,
    scope: text('本轮范围'),
    // 要用户决定、下一步保留原样的行（含缩进），下面几行的缩进就是条目的详情
    ask: head.fields.get('要用户决定') || [],
    next: head.fields.get('下一步') || [],
  };
  const round = text('轮次');
  if (round) {
    const m = /^第\s*(\S+?)\s*轮\s*[；;]\s*(\S+)$/.exec(round);
    if (m && validDate(m[2])) map.round = { n: m[1], date: m[2] };
    else add(`轮次应写成“第 N 轮；YYYY-MM-DD”，现为“${round}”`);
  }
  // 上一轮的日期取上一轮简报文件名里的日期（约定文件名 决策简报-第N轮-YYYYMMDD.html）
  const prev = text('上一轮简报');
  if (prev && prev !== NONE) {
    const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(prev);
    const href = m ? m[2] : prev;
    const target = classify(path.dirname(file), href);
    const d = target.kind === 'file' ? /(\d{4})-?(\d{2})-?(\d{2})/.exec(path.basename(target.abs)) : null;
    const date = d ? `${d[1]}-${d[2]}-${d[3]}` : null;
    if (target.kind !== 'file' || !/\.html?$/i.test(target.abs)) add(`上一轮简报应写相对链接，如 [第 1 轮简报](../html/决策简报-第1轮-20260912.html)，首轮写“无”；现为“${prev}”`);
    else if (!date || !validDate(date)) add(`上一轮简报的文件名里读不出日期：${path.basename(target.abs)}（约定文件名 决策简报-第N轮-YYYYMMDD.html，日期就是那一轮的轮次日期）`);
    else map.prev = { text: m ? m[1] : path.basename(target.abs), href, date };
  }
  if (map.round && map.prev && map.prev.date >= map.round.date) add(`上一轮简报的日期 ${map.prev.date} 应早于本轮的 ${map.round.date}`);
  return map;
}

// 读项目：地图 MD 和全部决策卡；有读不出的就抛 BriefError，列出全部问题。
// notes 是不挡生成、但简报不会显示的东西，成功时在终端提示
export function loadProject(source) {
  const problems = new Problems();
  const notes = [];
  const map = readMap(source, problems);
  const cards = loadCards(source, problems, notes);
  linkCards(cards, problems);
  if (problems.size) throw new BriefError(problems, source);
  for (const card of cards) {
    const rel = slash(path.relative(source, card.file));
    if (card.stray.length) notes.push(`${rel} 开头有不属于任何标签的行，简报不显示：${card.stray.join(' / ')}`);
    if (card.extra.length) notes.push(`${rel} 的 ${card.extra.map((name) => `“## ${name}”`).join('、')} 不是附录 A 的段落，简报不显示`);
  }
  return { source, map, cards, notes };
}

// ---------- 放进首屏五栏 ----------

// ② 定于在本轮的已定、否决卡；③ 它们改掉的旧决定；④ 带前提的、全部未定的决策卡、全部暂缓的卡。
// 研究卡不上首屏，没被取代的在④末尾列名
function place(brief) {
  const { map, cards } = brief;
  const inRound = (date) => Boolean(date) && (!map.prev || date > map.prev.date) && date <= map.round.date;
  const decisions = cards.filter((card) => card.kind === 'decision');
  const settled = decisions.filter((card) => card.status === '已定' || card.status === '否决');
  brief.decided = settled.filter((card) => inRound(card.date));
  for (const card of settled.filter((c) => c.date > map.round.date)) brief.notes.push(`${slash(path.relative(brief.source, card.file))} 定于 ${card.date}，晚于本轮轮次日期 ${map.round.date}，本轮首屏不显示`);
  brief.premised = brief.decided.filter((card) => card.status === '已定' && card.premised);
  brief.open = decisions.filter((card) => card.status === '未定');
  brief.deferred = decisions.filter((card) => card.status === '暂缓');
  brief.research = cards.filter((card) => card.kind === 'research' && card.status !== '已被某卡取代');
  for (const card of [...brief.decided, ...brief.open, ...brief.deferred]) card.anchor = card.id;
  // “影响”里写了“原值 → 本次 → 新值”的，每条一行；只写了取代、没写这一行的，每张旧卡一行
  brief.changes = [];
  for (const card of brief.decided.filter((c) => c.status === '已定')) {
    const olds = card['取代'].map((link) => link.card).filter(Boolean);
    if (card.changes.length) card.changes.forEach((change) => brief.changes.push({ card, olds, change }));
    else olds.forEach((old) => brief.changes.push({ card, olds: [old], change: null }));
  }
  brief.changes.forEach((row, index) => { row.id = `chg-${index + 1}`; });
}

// ---------- 渲染正文 ----------

const indentOf = (line) => line.match(/^ */)[0].length;
const joinLines = (parts) => parts.reduce((acc, part) => (acc ? acc + (CJK.test(acc.slice(-1)) || CJK.test(part[0]) ? '' : ' ') + part : part), '');

// 只认卡片里用到的写法：段落、按缩进嵌套的列表、表格、三级以下标题
function parseBlocks(lines) {
  const blocks = [];
  const isTable = (line) => line.trim().startsWith('|');
  const isHeading = (line) => /^#{3,6}\s+/.test(line);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const base = first[1].length;
      const ordered = /\d/.test(first[2]);
      const list = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
        const inner = base + m[2].length + 1;
        const body = [];
        i += 1;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j += 1;
            if (j < lines.length && indentOf(lines[j]) >= inner) { body.push(''); i += 1; continue; }
            break;
          }
          if (indentOf(lines[i]) < inner) break;
          body.push(lines[i].slice(inner));
          i += 1;
        }
        const text = [m[3]];
        let k = 0;
        while (k < body.length && body[k].trim() && !LIST_ITEM.test(body[k]) && !isTable(body[k]) && !isHeading(body[k])) {
          text.push(body[k].trim());
          k += 1;
        }
        list.items.push({ text: joinLines(text), children: parseBlocks(body.slice(k)) });
      }
      blocks.push(list);
      continue;
    }
    if (isTable(line)) {
      const rows = [];
      while (i < lines.length && isTable(lines[i])) { rows.push(lines[i].trim()); i += 1; }
      const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      if (rows.length > 1 && /^[\s|:-]+$/.test(rows[1])) blocks.push({ type: 'table', head: cells(rows[0]), rows: rows.slice(2).map(cells) });
      else blocks.push({ type: 'p', text: rows.join(' ') });
      continue;
    }
    const heading = /^#{3,6}\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ type: 'h', text: heading[1] }); i += 1; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && !isTable(lines[i]) && !isHeading(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'p', text: joinLines(para) });
  }
  return blocks;
}

// 段落有没有内容：只有表头、没有数据行的表格不算
function hasContent(lines) {
  return parseBlocks(lines).some((b) => b.type !== 'table' || b.rows.length > 0);
}

function blockText(blocks) {
  return blocks.map((b) => {
    if (b.type === 'list') return b.items.map((item) => `${item.text}\n${blockText(item.children)}`).join('\n');
    if (b.type === 'table') return [b.head, ...b.rows].map((row) => row.join(' ')).join('\n');
    return b.text;
  }).join('\n');
}

const fileHref = (abs, brief) => esc(encodeURI(slash(path.relative(path.dirname(brief.output), abs))));

// 指向卡片：本页有这张卡的详情就跳页内，没有就打开卡的原文
function cardLink(card, brief, label = card.title) {
  return `<a class="ref" href="${card.anchor ? `#${card.anchor}` : fileHref(card.file, brief)}">「${esc(label)}」</a>`;
}

// 页面里的一个链接。ctx：{ baseDir, file（来源文件，报错用）, where（标签或段落名）, brief }
function linkHtml(label, href, ctx) {
  const target = classify(ctx.baseDir, href);
  if (target.kind === 'web') return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  if (target.kind === 'anchor') return esc(label);
  const where = ctx.where ? `“${ctx.where}”` : '';
  if (target.kind === 'absolute') { ctx.brief.problems.add(ctx.file, `${where}要用相对链接：${href}`); return esc(label); }
  if (!fs.existsSync(target.abs)) { ctx.brief.problems.add(ctx.file, `${where}链接指向的文件不存在：${href}`); return esc(label); }
  const card = ctx.brief.cardByKey.get(fileKey(target.abs));
  if (card) return cardLink(card, ctx.brief, label);
  return `<a href="${fileHref(target.abs, ctx.brief)}${target.hash ? `#${esc(target.hash)}` : ''}">${esc(label)}</a>`;
}

function inline(text, ctx) {
  const emphasis = (part) => part.split('**').map((piece, index) => (index % 2 ? `<strong>${esc(piece)}</strong>` : esc(piece))).join('');
  let html = '';
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    html += emphasis(text.slice(last, m.index));
    html += m[1] !== undefined ? `<code>${esc(m[1])}</code>` : linkHtml(m[2], m[3], ctx);
    last = m.index + m[0].length;
  }
  return html + emphasis(text.slice(last));
}

// 首屏一行只放文字：链接只留名称（点开的详情里才有链接）
const plain = (text) => text.replace(INLINE, (whole, code, label) => (code !== undefined ? code : label)).replace(/\*\*/g, '');

function renderBlocks(blocks, ctx) {
  return blocks.map((b) => {
    if (b.type === 'p') return `<p>${inline(b.text, ctx)}</p>`;
    if (b.type === 'h') return `<h4>${inline(b.text, ctx)}</h4>`;
    if (b.type === 'table') {
      const th = b.head.map((h) => `<th>${inline(h, ctx)}</th>`).join('');
      const tr = b.rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, ctx)}</td>`).join('')}</tr>`).join('');
      return `<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
    }
    const items = b.items.map((item) => `<li>${inline(item.text, ctx)}${renderBlocks(item.children, ctx)}</li>`).join('');
    return b.ordered ? `<ol${b.start !== 1 ? ` start="${b.start}"` : ''}>${items}</ol>` : `<ul>${items}</ul>`;
  }).join('');
}

const cardCtx = (card, brief, where) => ({ baseDir: path.dirname(card.file), file: card.file, where, brief });
const mapCtx = (brief, where) => ({ baseDir: path.dirname(brief.map.file), file: brief.map.file, where, brief });

// 卡的一段。“依据”“后续”是一行一个，没写成列表时每行单独一条
function section(card, name, brief) {
  const lines = card.sections.get(name);
  const ctx = cardCtx(card, brief, name);
  const blocks = parseBlocks(lines);
  const rows = trimmed(lines);
  if ((name === '依据' || name === '后续') && blocks.length === 1 && blocks[0].type === 'p' && rows.length > 1) {
    return `<ul class="lines">${rows.map((line) => `<li>${inline(line, ctx)}</li>`).join('')}</ul>`;
  }
  return renderBlocks(blocks, ctx);
}

const field = (label, html) => `<div class="f"><div class="k">${label}</div><div class="v">${html}</div></div>`;
const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

function relations(card, brief) {
  const links = (label) => card.relationLines[label].map((line) => inline(line.replace(/^(?:[-*]|\d+[.)])\s+/, ''), cardCtx(card, brief, label)));
  // 反查：别的卡的“依赖”写了本卡，本卡的“影响哪些卡”却没写的，补在后面并注明
  const derived = card.dependents.filter((other) => !card['影响哪些卡'].some((link) => link.card === other))
    .map((other) => `${cardLink(other, brief)}<span class="why">（它的“依赖”写了本卡）</span>`);
  const join = (items) => (items.length ? items.join('、') : NONE);
  return kv([['依赖', join(links('依赖'))], ['影响哪些卡', join([...links('影响哪些卡'), ...derived])], ['取代', join(links('取代'))]]);
}

// 一张卡的详情：附录 A 的各段，照卡上的写法；“无”照样显示
function cardDetail(card, brief) {
  const lines = (label, list) => list.map((line) => inline(line, cardCtx(card, brief, label))).join('<br>');
  const approval = kv([
    ['状态', `<span class="st ${STATUS_CLASS[card.status]}">${esc(card.status)}</span>`],
    ['定于', esc(card.date || NONE)],
    ['谁定的', lines('谁定的', card.who)],
    ['出处', lines('出处', card.origin)],
  ]);
  return `<div class="detail">${[
    field('状态与批准', approval),
    field('问题', section(card, '问题', brief)),
    field('比较过的选项', section(card, '比较过的选项', brief)),
    field(card.reasonName, section(card, card.reasonName, brief)),
    field('影响', section(card, '影响', brief)),
    field('前提', section(card, '前提', brief)),
    field('依据', section(card, '依据', brief)),
    field('关系', relations(card, brief)),
    field('后续', section(card, '后续', brief)),
    field('暂缓原因', section(card, '暂缓原因', brief)),
    field('原文', `<a href="${fileHref(card.file, brief)}">打开这张卡的原文</a>`),
  ].join('')}</div>`;
}

// ---------- 首屏 ----------

function pairHtml(topic, main, full) {
  return `<span class="pair"><span class="topic" title="${esc(full)}">${topic}</span><span class="pick">${main}</span></span>`;
}

// 首屏一行：标题里有“：”时分两栏（话题｜结论），否则一栏
function titleCells(card) {
  return card.title.includes('：') ? pairHtml(esc(topicOf(card)), esc(pickOf(card)), card.title) : `<span class="pick">${esc(card.title)}</span>`;
}

const marks = (list) => (list.length ? `<span class="marks">${list.map(([cls, text]) => `<span class="mk ${cls}">${text}</span>`).join('')}</span>` : '');
const row = (id, summary, detail) => (detail ? `<details class="row" id="${id}"><summary>${summary}</summary>${detail}</details>` : `<div class="row plain" id="${id}">${summary}</div>`);
const column = (id, title, note, body) => `<section class="sec" id="${id}"><h2>${title}${note ? `<span class="n">${note}</span>` : ''}</h2>${body || `<p class="empty">${NONE}</p>`}</section>`;

// 地图 MD 里“要用户决定”“下一步”的条目：每个不缩进的行（写不写列表符号都行）是一条，
// 下面缩进的行和表格是这一条的详情。行首的 Tab 按四个空格算
function mapItems(lines) {
  const rows = lines.map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  if (isNone(trimmed(rows))) return null;
  const items = [];
  for (const line of rows) {
    const last = items[items.length - 1];
    if (!line.trim()) { if (last) last.detail.push(''); continue; }
    if (last && (indentOf(line) > 0 || line.startsWith('|'))) { last.detail.push(line); continue; }
    const m = LIST_ITEM.exec(line.trim());
    items.push({ text: m ? m[3] : line.trim(), detail: [] });
  }
  return items.map(({ text, detail }) => ({ text, children: detailBlocks(detail) }));
}

// 条目的详情：去掉共同的缩进；全是普通行时一行一条，否则按 Markdown 读
function detailBlocks(lines) {
  const filled = lines.filter((line) => line.trim());
  if (!filled.length) return [];
  const cut = Math.min(...filled.map(indentOf));
  const blocks = parseBlocks(lines.map((line) => line.slice(Math.min(cut, indentOf(line)))));
  if (blocks.length === 1 && blocks[0].type === 'p' && filled.length > 1) {
    return [{ type: 'list', ordered: false, start: 1, items: filled.map((line) => ({ text: line.trim(), children: [] })) }];
  }
  return blocks;
}

function itemRow(id, item, ctx, markList) {
  const linked = /\[[^\]]+\]\([^)\s]+\)/.test(item.text);
  const detail = linked || item.children.length ? `<div class="detail">${linked ? `<p>${inline(item.text, ctx)}</p>` : ''}${renderBlocks(item.children, ctx)}</div>` : '';
  return row(id, `<span class="main"><span class="pick">${esc(plain(item.text))}</span></span>${marks(markList)}`, detail);
}

function renderMast(brief) {
  const { map } = brief;
  const rejected = brief.decided.filter((card) => card.status === '否决').length;
  const settled = [
    brief.decided.length ? `本轮定了 ${brief.decided.length} 项${rejected ? `（其中否决 ${rejected} 项）` : ''}` : '本轮没有定下新的决定',
    brief.changes.length ? `改了 ${brief.changes.length} 处旧决定` : '没有改旧决定',
    brief.premised.length ? `${brief.premised.length} 项带前提` : '没有带前提的',
  ].join('，');
  const unsettled = [brief.open.length ? `未定 ${brief.open.length} 项` : '没有未定的', brief.deferred.length ? `暂缓 ${brief.deferred.length} 项` : ''].filter(Boolean).join('，');
  const prev = map.prev ? linkHtml(map.prev.text, map.prev.href, mapCtx(brief, '上一轮简报')) : '无（首轮）';
  return `<header class="head">
<div class="title">
<h1>${esc(roundName(map.round.n))}决策简报</h1>
<p class="headline">${settled}；${unsettled}。</p>
<p class="scope"><span class="label">本轮范围</span>${inline(map.scope, mapCtx(brief, '本轮范围'))}</p>
</div>
<table class="tb"><tbody>
<tr><th>项目</th><td>${esc(brief.project)}</td><th>日期</th><td>${esc(map.round.date)}</td></tr>
<tr><th>轮次</th><td>${esc(roundName(map.round.n))}</td><th>上一轮</th><td>${prev}</td></tr>
</tbody></table>
</header>`;
}

function renderAsk(brief) {
  const items = mapItems(brief.map.ask);
  if (!items) return `<section class="ask none" id="ask"><h2>① 要你决定</h2><p>${NONE}</p></section>`;
  const ctx = mapCtx(brief, '要用户决定');
  const rows = items.map((item, index) => itemRow(`ask-${index + 1}`, item, ctx, [])).join('');
  return `<section class="ask" id="ask"><h2>① 要你决定<span class="n">${items.length} 项，点开看选项、代价和推荐</span></h2>${rows}</section>`;
}

function renderDecided(brief) {
  const rows = brief.decided.map((card) => {
    const list = [];
    if (card.status === '否决') list.push(['no', '否决']);
    if (brief.premised.includes(card)) list.push(['pre', '带前提']);
    if (brief.changes.some((r) => r.card === card)) list.push(['rev', '△ 改了旧决定']);
    return row(card.anchor, `<span class="main">${titleCells(card)}</span>${marks(list)}`, cardDetail(card, brief));
  }).join('');
  const rejected = brief.decided.filter((card) => card.status === '否决').length;
  return column('decided', '② 本轮定了什么', `${brief.decided.length} 项${rejected ? `，其中否决 ${rejected} 项` : ''}；点开看选项、理由、影响和依据`, rows);
}

function renderChanges(brief) {
  const rows = brief.changes.map(({ id, card, olds, change }) => {
    const old = olds[0];
    const topic = change ? change.subject || topicOf(olds.length === 1 ? old : card) : topicOf(old);
    const value = change ? `<del>${esc(change.from)}</del> → ${esc(change.to)}` : `<del>${esc(pickOf(old))}</del> → ${esc(pickOf(card))}`;
    const detail = [
      field('改动', change ? kv([['原值', esc(change.from)], ['本次', esc(change.delta)], ['新值', esc(change.to)]]) : `<p><del>${esc(old.title)}</del> → ${esc(card.title)}</p>`),
      field('新决定', `${cardLink(card, brief)}<span class="why">定于 ${esc(card.date)}，点开看选项、理由和依据</span>`),
      // 箭头行说的是哪一处，程序对不到具体的旧卡：有箭头行时列新卡取代的全部卡，只写了取代时就是那一张
      change
        ? field('新卡取代的卡', olds.length ? olds.map((o) => cardLink(o, brief)).join('、') : `${NONE}<span class="why">这一处改的不是决策卡</span>`)
        : field('旧决定', `${cardLink(old, brief)}<span class="why">状态已改为“已被某卡取代”</span>`),
      field('原因', section(card, card.reasonName, brief)),
    ].join('');
    return row(id, `<span class="main">${pairHtml(esc(topic), value, topic)}</span>`, `<div class="detail">${detail}</div>`);
  }).join('');
  return column('changed', '③ 改了哪些旧决定', `${brief.changes.length} 处`, rows);
}

function renderPending(brief) {
  const premised = brief.premised.map((card) => row(`pre-${card.anchor}`, `<span class="main">${titleCells(card)}</span>${marks([['pre', '带前提']])}`,
    `<div class="detail">${field('前提', section(card, '前提', brief))}${field('完整决定', `${cardLink(card, brief)}<span class="why">在“本轮定了什么”里</span>`)}</div>`));
  const open = brief.open.map((card) => row(card.anchor, `<span class="main">${titleCells(card)}</span>${marks([['open', '未定']])}`, cardDetail(card, brief)));
  const deferred = brief.deferred.map((card) => row(card.anchor, `<span class="main">${titleCells(card)}</span>${marks([['defer', '暂缓']])}`, cardDetail(card, brief)));
  const researchLink = (card) => `${cardLink(card, brief)}${card.status === '未定' ? '' : `<span class="why">（${esc(card.status)}）</span>`}`;
  const research = brief.research.length ? `<p class="note">另有研究卡 ${brief.research.length} 张，只查证不决定，不列在这里：${brief.research.map(researchLink).join('、')}</p>` : '';
  const rows = [...premised, ...open, ...deferred].join('') || `<p class="empty">${NONE}</p>`;
  return column('pending', '④ 带前提或未定', `带前提 ${premised.length} 项，未定 ${open.length} 项，暂缓 ${deferred.length} 项`, rows + research);
}

function renderNext(brief) {
  const items = mapItems(brief.map.next);
  if (!items) return column('next', '⑤ 下一步', '', '');
  const ctx = mapCtx(brief, '下一步');
  const rows = items.map((item, index) => itemRow(`next-${index + 1}`, item, ctx, /用户/.test(`${item.text}\n${blockText(item.children)}`) ? [['you', '涉及你']] : [])).join('');
  return column('next', '⑤ 下一步', `${items.length} 条`, rows);
}

// ---------- 页面 ----------

// 核对页面里所有指向文件的相对链接都存在、页内跳转的目标都在
function checkLinks(html, output) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const files = new Set();
  const broken = [];
  let fileRefs = 0;
  let anchorRefs = 0;
  for (const m of html.matchAll(/\shref="([^"]*)"/g)) {
    const href = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (href.startsWith('#')) {
      anchorRefs += 1;
      if (!ids.has(decodeURIComponent(href.slice(1)))) broken.push(href);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    fileRefs += 1;
    let target = href.split('#')[0];
    try { target = decodeURI(target); } catch { /* 按原样找 */ }
    const abs = path.resolve(path.dirname(output), target);
    files.add(fileKey(abs));
    if (!fs.existsSync(abs)) broken.push(href);
  }
  return { fileRefs, fileCount: files.size, anchorRefs, broken };
}

const linkLine = (check) => `指向文件的链接 ${check.fileRefs} 处，指向 ${check.fileCount} 个文件，全部存在；页内跳转 ${check.anchorRefs} 处，目标都在。`;

// 版式沿用原型精简版：白纸图框、右上角图签、栏目名用施工图常用的长仿宋；
// 改了旧决定用红色三角和删除线（红线批注），带前提用荧光黄，否决用红，暂缓用土黄，涉及你用红底
const CSS = `
:root{--desk:#e6e9ec;--sheet:#fff;--ink:#23272b;--muted:#646d75;--rule:#d6dbe0;--rule-soft:#eceff2;--panel:#f4f6f7;--red:#bd3521;--red-soft:#fbeae6;--hl:#f6e59a;--hl-ink:#5c4700;--amber:#7a5a12;--amber-soft:#f3ead3;--blue:#1d5a96;--green:#2c6a44;
--drafting:"FangSong","STFangsong","仿宋",serif;--sans:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif}
*{box-sizing:border-box}
html{background:var(--desk)}
body{margin:0;color:var(--ink);font:14.5px/1.5 var(--sans)}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible,summary:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.sheet{max-width:1480px;margin:12px auto 40px;background:var(--sheet);border:1px solid var(--ink)}
.head{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:32px;align-items:start;padding:14px 26px 12px;border-bottom:1.5px solid var(--ink)}
h1{margin:0;font:400 28px/1.25 var(--drafting);letter-spacing:.08em}
.headline{margin:6px 0 0;font-size:17px;font-weight:600}
.scope{margin:5px 0 0;color:var(--muted);font-size:13.5px}
.tb{border-collapse:collapse;font-size:13px;width:auto;margin:2px 0 0;background:var(--sheet)}
.tb th,.tb td{border:1px solid var(--ink);padding:3px 10px;text-align:left;vertical-align:middle;font-weight:400;white-space:nowrap}
.tb th{font:400 14.5px/1.4 var(--drafting);color:var(--muted);background:var(--sheet)}
.ask{margin:12px 26px 0;padding:6px 14px 8px;border-left:4px solid var(--red);background:var(--red-soft)}
.ask.none{border-left-color:#9aa3ab;background:var(--panel);display:flex;align-items:baseline;column-gap:16px}
.ask h2{margin:0;font:400 18px/1.5 var(--drafting);display:flex;flex-wrap:wrap;align-items:baseline;column-gap:12px}
.ask p{margin:0}
.ask .row{border-bottom-color:rgba(189,53,33,.18)}
.ask .row:last-child{border-bottom:0}
.board{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,1fr);margin:12px 26px 0}
.col{min-width:0;padding-right:24px}
.col+.col{padding:0 0 0 24px;border-left:1px solid var(--rule)}
.sec{margin-bottom:14px}
.sec>h2{margin:0;padding-bottom:3px;border-bottom:1.5px solid var(--ink);font:400 19px/1.45 var(--drafting);display:flex;flex-wrap:wrap;align-items:baseline;column-gap:12px}
h2 .n{font:400 12.5px/1.4 var(--sans);color:var(--muted)}
.row{border-bottom:1px solid var(--rule-soft)}
.row>summary,.row.plain{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;align-items:start;padding:4px 2px 4px 18px;position:relative}
.row>summary{list-style:none;cursor:pointer}
.row>summary::-webkit-details-marker{display:none}
.row>summary::before{content:"";position:absolute;left:4px;top:11px;border-style:solid;border-width:4px 0 4px 6px;border-color:transparent transparent transparent #8b949c;transition:transform .15s}
.row[open]>summary::before{transform:rotate(90deg)}
.row>summary:hover{background:rgba(35,39,43,.04)}
.pair{display:grid;grid-template-columns:8em minmax(0,1fr);column-gap:14px}
.topic{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pick{font-weight:600}
del{color:var(--muted);text-decoration-color:var(--red);text-decoration-thickness:1.5px;font-weight:400}
.marks{display:flex;gap:6px;padding-top:1px}
.mk{font-size:12px;line-height:20px;padding:0 6px;white-space:nowrap;color:var(--muted);background:var(--panel)}
.mk.pre{background:var(--hl);color:var(--hl-ink)}
.mk.rev{background:none;color:var(--red);padding:0 2px}
.mk.no{background:var(--red-soft);color:var(--red)}
.mk.defer{background:var(--amber-soft);color:var(--amber)}
.mk.you{background:var(--red);color:#fff}
.empty{margin:0;padding:6px 2px 6px 18px;color:var(--muted)}
.note{margin:6px 0 0;padding:0 2px 0 18px;font-size:13px;color:var(--muted)}
.why{font-size:12.5px;color:var(--muted);margin-left:6px;font-weight:400}
.label{display:inline-block;font-size:12.5px;color:var(--muted);margin-right:8px}
.detail{margin:0 0 10px 18px;padding:6px 14px 8px;background:var(--panel);border-left:2px solid var(--ink);font-size:14px;font-weight:400}
.f{display:grid;grid-template-columns:6.5em minmax(0,1fr);column-gap:14px;padding:6px 0;border-top:1px solid #e0e4e8}
.f:first-child{border-top:0}
.f>.k{font:400 15px/1.5 var(--drafting);color:var(--muted)}
.v p,.detail>p{margin:0 0 4px}.v ul,.v ol,.detail>ul{margin:0 0 4px;padding-left:1.3em}.v li,.detail li{margin:1px 0}.v h4{margin:6px 0 2px;font-size:13.5px}
.v ul.lines{list-style:none;padding-left:0}
.kv{display:flex;flex-wrap:wrap;gap:4px 22px;margin:0 0 4px}
.kv div{display:flex;gap:8px}
.kv dt{color:var(--muted)}
.kv dd{margin:0}
.st{font-weight:600}.st.ok{color:var(--green)}.st.open{color:#8a5a00}.st.no{color:var(--red)}.st.defer{color:var(--amber)}.st.old{color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:13.5px;margin:2px 0 4px;background:var(--sheet)}
th,td{border:1px solid var(--rule);padding:4px 8px;text-align:left;vertical-align:top}
thead th{background:#f1f3f5;font-weight:600}
.tablewrap{overflow-x:auto}
.foot{margin:6px 26px 0;padding:10px 0 16px;border-top:1px solid var(--rule);font-size:13px;color:var(--muted)}
.foot p{margin:3px 0}
.flash{animation:flash 1.8s ease-out}
@keyframes flash{from{background:#fff2b0}to{background:transparent}}
@media (prefers-reduced-motion:reduce){.flash{animation:none}.row>summary::before{transition:none}}
@media (max-width:980px){.sheet{margin:0;border:0}.head{grid-template-columns:1fr;row-gap:10px;padding:12px 14px}.tb th,.tb td{white-space:normal}.ask,.board,.foot{margin-left:14px;margin-right:14px}.board{grid-template-columns:1fr}.col,.col+.col{display:contents}#decided{order:1}#changed{order:2}#pending{order:3}#next{order:4}.pair{grid-template-columns:6em minmax(0,1fr)}}
`;

// 点页内链接（如“新决定”里的卡名）：展开目标所在的折叠行，滚过去并闪一下
const JS = `
(function () {
  function openTarget(id) {
    var el = id && document.getElementById(id);
    if (!el) return;
    for (var node = el; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    el.scrollIntoView({ block: 'start' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href^="#"]');
    if (!link) return;
    var id = decodeURIComponent(link.getAttribute('href').slice(1));
    if (!document.getElementById(id)) return;
    event.preventDefault();
    history.pushState(null, '', '#' + id);
    openTarget(id);
  });
  window.addEventListener('hashchange', function () { openTarget(decodeURIComponent(location.hash.slice(1))); });
  if (location.hash) openTarget(decodeURIComponent(location.hash.slice(1)));
})();
`;

// 生成一页简报，返回 HTML（不写文件）；读不出或链接不对时抛 BriefError
export function buildBrief({ source, output }) {
  source = path.resolve(source);
  output = path.resolve(output);
  const early = new Problems();
  if (!isDir(source)) early.add('', `项目根不存在：${source}`);
  if (!isDir(path.dirname(output))) early.add('', `输出目录不存在：${path.dirname(output)}（生成器不建目录）`);
  if (isDir(output)) early.add('', `输出路径是个目录：${output}（要写成 .html 文件的路径）`);
  if (early.size) throw new BriefError(early, source);

  const brief = { ...loadProject(source), output, problems: new Problems() };
  if (path.isAbsolute(path.relative(path.dirname(output), source))) {
    brief.problems.add('', `输出和项目不在同一个盘，页面里没法用相对链接：请把 --output 放在项目里（约定位置 项目总览/html/）`);
    throw new BriefError(brief.problems, source);
  }
  brief.project = brief.map.project || path.basename(source);
  brief.cardByKey = new Map(brief.cards.map((card) => [fileKey(card.file), card]));
  place(brief);

  const body = `${renderMast(brief)}
${renderAsk(brief)}
<main class="board">
<div class="col">
${renderDecided(brief)}
${renderPending(brief)}
</div>
<div class="col">
${renderChanges(brief)}
${renderNext(brief)}
</div>
</main>`;
  if (brief.problems.size) throw new BriefError(brief.problems, source);

  let html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="决策简报 1.0">
<title>${esc(`${roundName(brief.map.round.n)}决策简报 · ${brief.project}`)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="sheet">
${body}
<footer class="foot">
<p>本页由决策简报 1.0 从项目的决策地图和决策卡生成，只读这些文件；决定以卡为准，改决定请改卡，再重新生成。</p>
<p>链接自检：<!--LINKCHECK--></p>
</footer>
</div>
<script>${JS}</script>
</body>
</html>
`;
  const check = checkLinks(html, output);
  if (check.broken.length) {
    check.broken.forEach((href) => brief.problems.add(output, `生成的页面里链接对不上：${href}`));
    throw new BriefError(brief.problems, source);
  }
  html = html.replace('<!--LINKCHECK-->', linkLine(check));
  return { html, brief, check };
}

// ---------- 命令行 ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const name = key.slice(2);
    if ((key === '--source' || key === '--output') && argv[i + 1] !== undefined && !(name in args)) {
      args[name] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`决策简报：不认识的参数：${key}`);
    }
  }
  if (!args.source || !args.output) throw new Error('决策简报：用法 node brief.mjs --source <项目根> --output <HTML 路径>，两项都要给出。');
  return args;
}

function main() {
  let args;
  let result;
  try {
    args = parseArgs(process.argv.slice(2));
    result = buildBrief(args);
  } catch (error) {
    if (!(error instanceof BriefError) && !/^决策简报：/.test(error.message)) throw error;
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const { html, brief, check } = result;
  const output = path.resolve(args.output);
  try {
    fs.writeFileSync(output, html, 'utf8');
  } catch (error) {
    console.error(`决策简报：写不进输出文件 ${output}（${error.code || error.message}）`);
    process.exitCode = 1;
    return;
  }
  const rejected = brief.decided.filter((card) => card.status === '否决').length;
  console.log(`决策简报：已生成 ${output}（${Buffer.byteLength(html)} 字节）`);
  console.log(`  ${roundName(brief.map.round.n)}，${brief.map.round.date}：定了 ${brief.decided.length} 项（其中否决 ${rejected} 项），改了旧决定 ${brief.changes.length} 处，带前提 ${brief.premised.length} 项，未定 ${brief.open.length} 项，暂缓 ${brief.deferred.length} 项；研究卡 ${brief.research.length} 张不上首屏`);
  console.log(`  链接自检：${linkLine(check)}`);
  for (const note of brief.notes) console.log(`  提示：${note}`);
}

// 作为命令运行时才执行；被测试导入时不执行。技能目录用目录链接安装时，两边按真实路径比
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) main();
