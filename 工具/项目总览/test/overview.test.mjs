// 读与校验：总览 MD 头字段与分组、状态五值、段与组的校验、编号扫描、字数、地图 MD 批准段与旧写法提示、卡引用、要用户决定。
// 每个测试把 examples/ 整份复制到临时目录，只改副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, OverviewError } from '../scripts/overview.mjs';

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function sample(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-overview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(tool, 'examples'), dir, { recursive: true });
  const root = path.join(dir, '示例项目');
  const file = (rel) => path.join(root, rel);
  const edit = (rel, from, to) => {
    const text = fs.readFileSync(file(rel), 'utf8');
    assert.ok(text.includes(from), `样本里找不到要改的文字：${from}`);
    fs.writeFileSync(file(rel), text.replace(from, to));
  };
  return { root, file, edit };
}

const OV = '项目总览/md/总览.md';
const MAP = '项目总览/md/决策地图.md';

// 读不过时返回全部问题（拍平成一行一条），读得过时返回空数组
function problemsOf(root) {
  try { loadProject(root); return []; } catch (error) {
    if (!(error instanceof OverviewError)) throw error;
    return [...error.problems.byFile.values()].flat();
  }
}
const hasProblem = (list, re) => assert.ok(list.some((m) => re.test(m)), `问题清单里没有 ${re}：\n${list.join('\n')}`);

test('样本读得过：项目名、头字段、介绍段、五段分组、技术架构', (t) => {
  const s = sample(t);
  const { doc, notes } = loadProject(s.root);
  assert.equal(doc.name, '河畔书屋借阅小程序（虚构示例）');
  assert.equal(doc.head.现状, '试运行第三周：借还书已验收，志愿者账号等你定。');
  assert.equal(doc.head.核对, '2026-10-28');
  assert.equal(doc.intro.length, 2);
  assert.deepEqual(doc.groups.map((g) => `${g.stage}：${g.name}（${g.items.length}）`), [
    '进入：办证与登录（5）', '使用：找书与借书（6）', '使用：还书与续借（4）',
    '管理：书目与读者（4）', '维护：备份与更新（4）', '后台：服务器与短信（4）',
  ]);
  // 第三栏去掉注释作备注；注释里的卡号、票号不进正文
  const login = doc.groups[0].items[0];
  assert.deepEqual([login.s, login.n], ['done', '']);
  assert.equal(doc.groups[0].items[2].n, '家长和孩子两个账号怎么关联还在画界面，下周给你看');
  assert.equal(doc.arch.length, 5);
  assert.deepEqual(doc.arch[0], ['读者小程序', '读者办证、找书、预约、续借', '微信小程序：装在微信里的小应用，不用另外下载', '书屋的大门和阅览室']);
  assert.equal(doc.flow.length, 1);
  assert.ok(doc.flow[0].startsWith('读者在手机上点“借这本”'));
  assert.ok(!notes.some((n) => /组名/.test(n)), '样本组名都不超过 9 字');
});

test('状态只认五个写法，别的写法报错', (t) => {
  const s = sample(t);
  const { doc } = loadProject(s.root);
  const all = doc.groups.flatMap((g) => g.items.map((it) => it.s));
  assert.deepEqual(['done', 'doing', 'todo', 'open', 'no'].map((k) => all.filter((x) => x === k).length), [13, 4, 5, 2, 3]);
  s.edit(OV, '| 按书名、作者搜书，看在架还是借出 | ✅ |', '| 按书名、作者搜书，看在架还是借出 | 已完成 |');
  hasProblem(problemsOf(s.root), /状态“已完成”不在五个写法里/);
});

test('段名、段序、每组项数、组数、一个功能只进一组', (t) => {
  const s = sample(t);
  s.edit(OV, '### 维护：备份与更新', '### 运维：备份与更新');
  s.edit(OV, '### 进入：办证与登录', '### 管理：办证与登录');
  s.edit(OV, '| 馆长停用或恢复某位读者的借阅 | 待完成 | 停用的理由要不要写进记录，做的时候再问你 |\n', '');
  s.edit(OV, '| 前台扫书码还书，自动消掉借阅记录 | ✅ |', '| 按书名、作者搜书，看在架还是借出 | ✅ |');
  const list = problemsOf(s.root);
  hasProblem(list, /段名“运维”不在五段/);
  hasProblem(list, /段的顺序不对，“使用”出现在“管理”之后/);
  hasProblem(list, /组“书目与读者”有 3 项，一组要 4 到 12 项/);
  hasProblem(list, /功能“按书名、作者搜书，看在架还是借出”在第 \d+ 行已出现过/);
});

test('全部超过 10 组报错', (t) => {
  const s = sample(t);
  // 后台段再加 5 组，每组 4 项、功能各不相同，凑成 11 组
  const extra = [...'甲乙丙丁戊'].map((g) => ['', `### 后台：备用${g}`, '| 功能 | 状态 | 还差什么 / 为什么 |', '|---|---|---|',
    ...['一', '二', '三', '四'].map((k) => `| 备用功能${g}${k} | ✅ | |`)].join('\n')).join('\n');
  s.edit(OV, '\n## 技术架构', `${extra}\n\n## 技术架构`);
  hasProblem(problemsOf(s.root), /共 11 组，全部不超过 10 组/);
});

test('正文扫到票号、卡号、需求编号、版本号报错；行尾注释里的不算', (t) => {
  const cases = [['T05', '票号或需求编号'], ['33 卡', '卡号'], ['票 06', '票号'], ['ADR', 'ADR 编号'], ['Spec R12', '需求编号'], ['0.1.28', '版本号'], ['v1.7', '版本号']];
  for (const [code, kind] of cases) {
    const s = sample(t);
    s.edit(OV, '| 每晚自动备份到馆长的移动硬盘 | ✅ | |', `| 每晚自动备份到馆长的移动硬盘 | ✅ | 见 ${code} |`);
    hasProblem(problemsOf(s.root), new RegExp(`备注的正文里有${kind}样式“${code.replace('.', '\\.')}”`));
  }
  // 一段正文里几处编号一次列全，“Spec R12”只报一条
  const many = sample(t);
  many.edit(OV, '| 每晚自动备份到馆长的移动硬盘 | ✅ | |', '| 每晚自动备份到馆长的移动硬盘 | ✅ | 见 Spec R12 和 T05，0.1.28 起 |');
  const found = problemsOf(many.root).filter((m) => m.includes('备注的正文里'));
  assert.deepEqual(found.map((m) => /样式“([^”]+)”/.exec(m)[1]), ['Spec R12', 'T05', '0.1.28']);

  const s = sample(t);
  // 技术名不当票号：ES256 是两个字母加三位数字；“门票 20 元”不是票号
  s.edit(OV, '| 一台小主机加一个小数据库 |', '| 一台小主机加一个小数据库，签名用 ES256 |');
  s.edit(OV, '| 读者用手机号加短信验证码登录，不用记密码 | ✅ |', '| 读者用手机号加短信验证码登录，不用记密码 | ✅ | 比门票 20 元的活动省事 |');
  assert.deepEqual(problemsOf(s.root), []);
});

test('字数：现状超 40 字、主题超 25 字报错，组名超 9 字只提醒', (t) => {
  const s = sample(t);
  s.edit(OV, '现状：试运行第三周：借还书已验收，志愿者账号等你定。', `现状：${'一'.repeat(41)}`);
  s.edit(MAP, '## 第 3 轮 · 2026-10-28 · 逾期处理与押金', `## 第 3 轮 · 2026-10-28 · ${'二'.repeat(26)}`);
  const list = problemsOf(s.root);
  hasProblem(list, /现状 41 字，超过 40 字/);
  hasProblem(list, /第 3 轮的主题 26 字，超过 25 字/);

  const ok = sample(t);
  ok.edit(OV, '### 维护：备份与更新', '### 维护：备份、恢复与小程序更新');
  ok.edit(OV, '### 后台：服务器与短信', '### 后台：从 Admin 进后台');
  const { notes } = loadProject(ok.root);
  assert.ok(notes.includes('组名“备份、恢复与小程序更新”11 字，超过 9 字，页面上可能折行'));
  // 去掉空白按字符数：“从 Admin 进后台”算 9 字，不提醒
  assert.ok(!notes.some((n) => n.includes('从 Admin 进后台')));
});

test('头字段：缺“现状”“核对”或核对不是日期报错', (t) => {
  const s = sample(t);
  s.edit(OV, '现状：试运行第三周：借还书已验收，志愿者账号等你定。\n', '');
  s.edit(OV, '核对：2026-10-28', '核对：10 月 28 日');
  const list = problemsOf(s.root);
  hasProblem(list, /缺头字段“现状：”/);
  hasProblem(list, /核对“10 月 28 日”要写成 YYYY-MM-DD/);
});

test('批准段：新结构按轮读，最新在前；进度三值；旧写法按轮提示', (t) => {
  const s = sample(t);
  const { map, notes } = loadProject(s.root);
  assert.deepEqual(map.rounds.map((r) => [r.n, r.date, r.topic]), [[3, '2026-10-28', '逾期处理与押金'], [2, '2026-09-19', '登录与借阅上限']]);
  const r3 = map.rounds[0];
  assert.deepEqual(r3.do.map((d) => [d.t, d.st]), [
    ['到期前三天短信提醒，逾期只提醒、不罚款', 'done'],
    ['馆长每周看一次逾期名单，一键发提醒短信', 'doing'],
    ['借阅上限 5 本写进借阅证背面，重印一批', 'todo'],
  ]);
  assert.equal(r3.not.length, 2);
  assert.deepEqual(r3.open.map((x) => x.t), ['志愿者要不要各用一个账号：等你定，见页顶“现在要你定的事”']);
  assert.equal(r3.unchosen.length, 2);
  assert.equal(r3.next, '主控 2026-11-01 之前改借阅规则说明；你 2026-11-05 之前定志愿者账号。');
  assert.ok(notes.includes('地图 MD 的“第 1 轮批准记录（借阅规则起步，2026-09-12）”是旧写法的批准段，没有读（新写法标题是“## 第 N 轮 · YYYY-MM-DD · 主题”）'));
});

test('批准段：缺清单、缺进度、进度写错、正文带卡号都报错', (t) => {
  const s = sample(t);
  s.edit(MAP, '比较过、没选的做法：\n- 绘本另外再加 5 本：系统要区分书的类别，改动大\n', '');
  s.edit(MAP, '- 前台扫码借书，一本十秒内借出 ｜ 进度：已完成', '- 前台扫码借书，一本十秒内借出');
  s.edit(MAP, '一键发提醒短信 ｜ 进度：进行中', '一键发提醒短信 ｜ 进度：做了一半');
  s.edit(MAP, '- 不收押金：社区书屋不收钱', '- 不收押金（04 卡）：社区书屋不收钱');
  const list = problemsOf(s.root);
  hasProblem(list, /第 2 轮缺“比较过、没选的做法：”清单/);
  hasProblem(list, /第 2 轮“定了要做”这一条没写进度/);
  hasProblem(list, /第 3 轮“定了要做”的进度“做了一半”不在三个写法里/);
  hasProblem(list, /第 3 轮“定了不做 \/ 以后再说”的正文里有卡号样式“04 卡”/);
});

test('批准段：像新写法却读不出的标题、无效日期报错，不当旧写法放过；缺卡引用提示', (t) => {
  const s = sample(t);
  s.edit(MAP, '## 第 2 轮 · 2026-09-19 · 登录与借阅上限', '## 第 2 轮 · 2026-09-19 登录与借阅上限');
  s.edit(MAP, '## 第 3 轮 · 2026-10-28 ·', '## 第 3 轮 · 2026-13-45 ·');
  const list = problemsOf(s.root);
  hasProblem(list, /批准段标题“第 2 轮 · 2026-09-19 登录与借阅上限”读不出/);
  hasProblem(list, /第 3 轮的日期“2026-13-45”不是有效日期/);

  const ok = sample(t);
  assert.ok(loadProject(ok.root).notes.includes('第 2 轮“前台扫码借书，一本十秒内借出”行尾没有卡引用（<!-- NN 卡 -->），“为什么这样定”里不会有它'));
});

test('卡引用：取三句话和“为什么更好”一行，一卡一格，没有三句话的不出格', (t) => {
  const s = sample(t);
  const { map, notes } = loadProject(s.root);
  const [r3, r2] = map.rounds;
  assert.deepEqual(r3.whys.map((w) => w.title), ['借阅上限：每人最多同时借 5 本', '押金：不收押金']);
  assert.equal(r3.whys[1].text, '像公园的长椅，坐之前不用先交钱。\n选了不收押金，外区读者也一样。\n前台不用管钱、不用开收据；丢书靠提醒和登记找回。\n为什么更好：试运行一个月只丢了一本书（示例），为一本书让所有人交钱不值得。');
  // 第 2 轮 01 卡被引用两次，只出一格
  assert.deepEqual(r2.whys.map((w) => w.title), ['登录方式：手机号加短信验证码', '借阅上限：每人最多同时借 5 本']);
  assert.ok(notes.some((n) => n.startsWith('第 3 轮引用的“逾期处理：只提醒，不罚款”（03 卡）没有“给你的三句话”')));
});

test('卡引用：找不到、同号多张报错', (t) => {
  const s = sample(t);
  s.edit(MAP, '<!-- 04 卡 -->', '<!-- 09 卡 -->');
  fs.copyFileSync(s.file('专题工作/借阅规则/决策卡/02-借阅上限五本.md'), s.file('专题工作/系统与账号/决策卡/02-借阅上限副本.md'));
  const list = problemsOf(s.root);
  hasProblem(list, /第 3 轮引用的 09 卡在 专题工作\/\*\/决策卡\/ 下找不到/);
  hasProblem(list, /第 \d 轮引用的 02 卡有同号的 2 张/);
});

test('要用户决定：五个要素读出来；缺的提醒；写“无”就没有', (t) => {
  const s = sample(t);
  const { map } = loadProject(s.root);
  assert.equal(map.asks.length, 1);
  const a = map.asks[0];
  assert.equal(a.q, '志愿者要不要各用一个账号登录前台？');
  assert.equal(a.options.length, 3);
  assert.deepEqual([a.rec, a.by, a.blocks], ['每人一个账号，周末借还约占一半，出错要能查到人', '2026-11-05', '志愿者值班那张施工票开不了工']);

  s.edit(MAP, '  - 何时之前：2026-11-05\n', '');
  assert.ok(loadProject(s.root).notes.some((n) => /“要用户决定”第 1 件“志愿者要不要各用一个账号登录前台？”缺：何时之前/.test(n)));

  const none = sample(t);
  const text = fs.readFileSync(none.file(MAP), 'utf8');
  fs.writeFileSync(none.file(MAP), text.replace(/要用户决定：\n[\s\S]*?(?=下一步：)/, '要用户决定：无\n'));
  assert.deepEqual(loadProject(none.root).map.asks, []);
});

test('地图 MD 缺头字段、总览 MD 缺文件报错，且一次列全', (t) => {
  const s = sample(t);
  s.edit(MAP, '本轮范围：逾期处理和押金收尾；离线借书先放一放\n', '');
  fs.renameSync(s.file(OV), s.file('项目总览/md/功能地图.md'));
  const list = problemsOf(s.root);
  hasProblem(list, /缺头字段“本轮范围：”/);
  hasProblem(list, /找不到总览 MD；同目录有 功能地图.md/);
});
