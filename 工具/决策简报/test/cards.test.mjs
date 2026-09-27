// 读卡与报错：附录 A、B 的标签和段落、状态五值、取代与反查、链接自检、轮次范围。
// 每个测试把 examples/ 整份复制到临时目录，只改副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject, buildBrief } from '../scripts/brief.mjs';

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(tool, 'scripts', 'brief.mjs');

function sample(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-brief-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(tool, 'examples'), dir, { recursive: true });
  const root = path.join(dir, '示例项目');
  const topics = { rule: '借阅规则', sys: '系统与账号' };
  return {
    dir,
    root,
    map: path.join(root, '项目总览', 'md', '决策地图.md'),
    card: (topic, name) => path.join(root, '专题工作', topics[topic], '决策卡', name),
    output: path.join(dir, '测试输出.html'),
  };
}

function edit(file, from, to) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `样本里找不到：${from}`);
  fs.writeFileSync(file, text.replace(from, to));
}

const run = (s) => spawnSync(process.execPath, [script, '--source', s.root, '--output', s.output], { encoding: 'utf8', windowsHide: true });

// 期望报错停止：退出码 1，不写页面；返回报错全文
function fails(s) {
  const r = run(s);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(fs.existsSync(s.output), false, '报错时不应写页面');
  return r.stderr;
}

const detailOf = (html, id) => (new RegExp(`<details class="row" id="${id}">[\\s\\S]*?</details>`).exec(html) || [''])[0];

test('样本：附录 A 的标签和段落、附录 B 的地图头都读到了', (t) => {
  const s = sample(t);
  const { map, cards } = loadProject(s.root);
  const card = Object.fromEntries(cards.map((c) => [c.num, c]));
  assert.equal(cards.length, 8);
  assert.equal(map.project, '河畔书屋借阅小程序（虚构示例）');
  assert.deepEqual(map.round, { n: '2', date: '2026-09-19' });
  assert.equal(map.prev.date, '2026-09-12');
  assert.equal(map.scope, '借阅规则收尾：借阅上限、逾期处理和押金；离线借书先放一放');

  const six = card['06'];
  assert.equal(six.title, '借阅上限：每人最多同时借 5 本');
  assert.equal(six.status, '已定');
  assert.equal(six.date, '2026-09-18');
  assert.deepEqual(six.who, ['馆长（示例）']);
  assert.match(six.origin[0], /^\[第 2 轮讨论记录（示例）\]\(.+\) 第 3 条$/);
  assert.deepEqual(six['依赖'], []);
  assert.deepEqual(six['取代'].map((link) => link.card.num), ['02']);
  assert.deepEqual(six['影响哪些卡'].map((link) => link.card.num), ['03']);
  assert.deepEqual(six.changes, [{ subject: '借阅上限', from: '3 本', delta: '加 2 本', to: '5 本' }]);
  assert.deepEqual([...six.sections.keys()], ['问题', '比较过的选项', '选择与理由', '影响', '前提', '依据', '后续', '暂缓原因']);

  assert.deepEqual(card['01']['影响哪些卡'].map((link) => link.card.num), ['03', '07'], '多行标签：下一行接着写的链接也读到');
  assert.deepEqual(card['01'].dependents.map((c) => c.num).sort(), ['03', '07'], '依赖反查');
  assert.equal(card['02'].status, '已被某卡取代');
  assert.deepEqual(card['02'].replacedBy.map((c) => c.num), ['06']);
  assert.equal(card['03'].premised, true);
  assert.equal(card['06'].premised, false);
  assert.deepEqual(card['03'].changes, [{ subject: '逾期罚款', from: '每天 1 毛（书屋章程第 5 条）', delta: '取消罚款', to: '只发短信提醒' }]);
  assert.equal(card['04'].status, '否决');
  assert.equal(card['05'].status, '暂缓');
  assert.equal(card['07'].status, '未定');
  assert.equal(card['07'].date, null);
  assert.equal(card['07'].title, '志愿者要不要单独的管理账号');
  assert.equal(card['08'].kind, 'research');
  assert.equal(card['08'].reasonName, '查证结论');
  assert.ok(cards.every((c) => c.extra.length === 0));
});

test('缺标签、标签没内容、缺段落、段落是空的：一次列出哪个文件缺什么，退出码 1，不写页面', (t) => {
  const s = sample(t);
  edit(s.card('rule', '06-借阅上限五本.md'), '定于：2026-09-18\n', '');
  edit(s.card('rule', '06-借阅上限五本.md'), '## 前提\n无\n\n', '');
  edit(s.card('sys', '07-志愿者账号.md'), '出处：无', '出处：');
  edit(s.card('rule', '04-借书押金.md'), '## 后续\n无\n', '## 后续\n\n');
  edit(s.card('sys', '01-登录方式.md'), '# 决定：登录方式：读者用手机号加短信验证码登录', '# 登录方式');
  edit(s.map, '轮次：第 2 轮；2026-09-19\n', '');
  const err = fails(s);
  assert.match(err, /^决策简报：下面这些读不出或对不上，没有生成页面。/);
  assert.match(err, /项目总览\/md\/决策地图\.md\n {2}- 缺标签：轮次\n/);
  assert.match(err, /专题工作\/借阅规则\/决策卡\/06-借阅上限五本\.md\n {2}- 缺标签：定于\n {2}- 缺段落：前提\n/);
  assert.match(err, /07-志愿者账号\.md\n {2}- 标签没有内容（没有就写“无”）：出处\n/);
  assert.match(err, /04-借书押金\.md\n {2}- 段落是空的（没有内容就写“无”；只有表头的表格也算空）：后续\n/);
  assert.match(err, /01-登录方式\.md\n {2}- 标题行应为“# 决定：结论句”，未定时“# 未定：问题一句”；现为“# 登录方式”\n/);
  assert.match(err, /共 6 处。$/m);
});

test('状态要在五值内；标签用全角冒号；暂缓要写原因；已定、否决要写日期', (t) => {
  const s = sample(t);
  edit(s.card('rule', '04-借书押金.md'), '状态：否决', '状态：进行中');
  edit(s.card('rule', '03-逾期处理.md'), '状态：已定', '状态: 已定');
  edit(s.card('sys', '01-登录方式.md'), '定于：2026-09-10', '定于：无');
  edit(s.card('rule', '06-借阅上限五本.md'), '定于：2026-09-18', '定于：9月18日');
  const err = fails(s);
  assert.match(err, /04-借书押金\.md\n {2}- 状态“进行中”不在五值内（未定、已定、否决、暂缓、已被某卡取代）\n/);
  assert.match(err, /03-逾期处理\.md\n {2}- 标签“状态”后面是半角冒号，要用全角“：”\n/);
  assert.doesNotMatch(err, /缺标签：状态/, '半角冒号只报一次，不再报缺标签');
  assert.match(err, /01-登录方式\.md\n {2}- 状态是已定，定于要写日期（如 2026-09-27）\n/);
  assert.match(err, /06-借阅上限五本\.md\n {2}- 定于应写日期（如 2026-09-27）或“无”，现为“9月18日”\n/);

  // 暂缓原因只写“无”
  const s2 = sample(t);
  edit(s2.card('sys', '05-离线借书.md'), '## 暂缓原因\n断网很少，现在做离线登记不划算。试运行首月断网超过两次，或有一次超过半天，就重新提出。', '## 暂缓原因\n无');
  assert.match(fails(s2), /05-离线借书\.md\n {2}- 状态是暂缓，“暂缓原因”要写为什么不定、什么情况下重新考虑\n/);
});

test('“已被某卡取代”两种写法都认；状态行没写链接时由新卡的“取代”反查', (t) => {
  const s = sample(t);
  const old = s.card('rule', '02-借阅上限三本.md');
  edit(old, '状态：已被某卡取代：[借阅上限改为 5 本](06-借阅上限五本.md)', '状态：已被[借阅上限改为 5 本](06-借阅上限五本.md)取代');
  assert.equal(loadProject(s.root).cards.find((c) => c.num === '02').status, '已被某卡取代');
  edit(old, '状态：已被[借阅上限改为 5 本](06-借阅上限五本.md)取代', '状态：已被某卡取代');
  const card = loadProject(s.root).cards.find((c) => c.num === '02');
  assert.equal(card.status, '已被某卡取代');
  assert.deepEqual(card.replacedBy.map((c) => c.num), ['06']);
});

test('取代两边对不上就报错：旧卡状态没改、新卡没写取代、取代链到的不是卡', (t) => {
  const s = sample(t);
  edit(s.card('rule', '02-借阅上限三本.md'), '状态：已被某卡取代：[借阅上限改为 5 本](06-借阅上限五本.md)', '状态：已定');
  assert.match(fails(s), /02-借阅上限三本\.md\n {2}- 「借阅上限：每人最多同时借 5 本」的“取代”写了本卡，本卡状态应改为“已被某卡取代”并链到那张卡\n/);

  const s2 = sample(t);
  edit(s2.card('rule', '06-借阅上限五本.md'), '取代：[借阅上限 3 本](02-借阅上限三本.md)', '取代：无');
  assert.match(fails(s2), /02-借阅上限三本\.md\n {2}- 状态写被「借阅上限：每人最多同时借 5 本」取代，但那张卡的“取代”里没有本卡\n/);

  const s3 = sample(t);
  edit(s3.card('rule', '06-借阅上限五本.md'), '取代：[借阅上限 3 本](02-借阅上限三本.md)', '取代：[书屋章程](../../../资料/书屋章程.md)');
  assert.match(fails(s3), /06-借阅上限五本\.md\n {2}- “取代”只能链到本项目的决策卡：\[书屋章程\]\(\.\.\/\.\.\/\.\.\/资料\/书屋章程\.md\)；改 ADR 等别的旧决定，写在“影响”里的“原值 → 本次 → 新值”\n/);

  const s4 = sample(t);
  edit(s4.card('rule', '02-借阅上限三本.md'), '状态：已被某卡取代：[借阅上限改为 5 本](06-借阅上限五本.md)', '状态：已被某卡取代');
  edit(s4.card('rule', '06-借阅上限五本.md'), '取代：[借阅上限 3 本](02-借阅上限三本.md)', '取代：无');
  assert.match(fails(s4), /02-借阅上限三本\.md\n {2}- 状态是“已被某卡取代”，但状态行没有链到新卡，也没有哪张卡的“取代”写了本卡\n/);
});

test('影响哪些卡：卡上写的照显示；别的卡的“依赖”写了本卡而本卡没写的，反查补上并注明', (t) => {
  const s = sample(t);
  edit(s.card('sys', '07-志愿者账号.md'), '依赖：[登录方式](01-登录方式.md)', '依赖：[登录方式](01-登录方式.md)\n[逾期处理](../../借阅规则/决策卡/03-逾期处理.md)');
  const { html } = buildBrief({ source: s.root, output: s.output });
  assert.match(detailOf(html, 'card-1-03'), /<dt>影响哪些卡<\/dt><dd><a class="ref" href="#card-2-07">「志愿者要不要单独的管理账号」<\/a><span class="why">（它的“依赖”写了本卡）<\/span><\/dd>/);
  assert.match(detailOf(html, 'card-1-06'), /<dt>影响哪些卡<\/dt><dd><a class="ref" href="#card-1-03">「逾期处理」<\/a><\/dd>/);
});

test('“影响”里带箭头的行要写成三段', (t) => {
  const s = sample(t);
  edit(s.card('rule', '06-借阅上限五本.md'), '借阅上限：3 本 → 加 2 本 → 5 本', '借阅上限：3 本 → 5 本');
  assert.match(fails(s), /06-借阅上限五本\.md\n {2}- “影响”里带“→”的行是改旧决定的写法，要写成“原值 → 本次 → 新值”三段；不是改旧决定就换别的写法：借阅上限：3 本 → 5 本\n/);
});

test('只有表头、没有数据行的表格算空段落', (t) => {
  const s = sample(t);
  edit(s.card('rule', '06-借阅上限五本.md'), '## 前提\n无\n', '## 前提\n| 前提 | 谁负责满足 | 何时核实 | 不满足怎么办 |\n|---|---|---|---|\n');
  assert.match(fails(s), /06-借阅上限五本\.md\n {2}- 段落是空的（没有内容就写“无”；只有表头的表格也算空）：前提\n/);
});

test('多行标签写到下一个标签为止，中间空行不丢内容', (t) => {
  const s = sample(t);
  edit(s.card('sys', '07-志愿者账号.md'), '依赖：[登录方式](01-登录方式.md)', '依赖：[登录方式](01-登录方式.md)\n\n[逾期处理](../../借阅规则/决策卡/03-逾期处理.md)');
  edit(s.map, '  - 详情见[志愿者账号](../../专题工作/系统与账号/决策卡/07-志愿者账号.md)\n', '  - 详情见[志愿者账号](../../专题工作/系统与账号/决策卡/07-志愿者账号.md)\n\n- 借阅证要不要收工本费？\n  - 选项一：收 2 元。代价：要找零\n  - 选项二：什么都不做。代价：每年多花约 100 元（示例）\n');
  const { cards, map } = loadProject(s.root);
  assert.deepEqual(cards.find((c) => c.num === '07')['依赖'].map((link) => link.card.num), ['01', '03']);
  const { html } = buildBrief({ source: s.root, output: s.output });
  assert.match(html, /① 要你决定<span class="n">2 项/);
  assert.match(detailOf(html, 'ask-2'), /<li>选项一：收 2 元。代价：要找零<\/li><li>选项二：什么都不做。代价：每年多花约 100 元（示例）<\/li>/);
  assert.ok(map.next.length > 0);
});

test('要用户决定、下一步：不缩进的行一条，缩进的行是这一条的详情，写不写列表符号、用不用 Tab 都行', (t) => {
  const s = sample(t);
  edit(s.map, '下一步：\n- 主控：按新的借阅上限改借阅规则说明，通知重印借阅证，2026-09-22 之前\n- 前台管理员（示例）：9 月 22 日起每周一核对逾期名单\n- 用户：',
    '下一步：主控：按新的借阅上限改借阅规则说明，通知重印借阅证，2026-09-22 之前\n前台管理员（示例）：9 月 22 日起每周一核对逾期名单\n用户：');
  const text = fs.readFileSync(s.map, 'utf8');
  fs.writeFileSync(s.map, text.replace(/要用户决定：[\s\S]*?(?=下一步：)/, '要用户决定：志愿者要不要单独的管理账号？\n\t选项一：每人一个账号。代价：多三天开发（示例）\n\t选项二：共用前台账号。代价：出了错查不到是谁\n\t选项三：什么都不做。代价：志愿者只能纸本登记，周一再补录\n'));
  const { html } = buildBrief({ source: s.root, output: s.output });
  const rowOf = (id) => (new RegExp(`<(details|div) class="row[^"]*" id="${id}">[\\s\\S]*?</\\1>`).exec(html) || [''])[0];
  const next = [1, 2, 3].map((n) => (/<span class="pick">([^<]+)</.exec(rowOf(`next-${n}`)) || [])[1]);
  assert.deepEqual(next, ['主控：按新的借阅上限改借阅规则说明，通知重印借阅证，2026-09-22 之前', '前台管理员（示例）：9 月 22 日起每周一核对逾期名单', '用户：2026-10-01 之前定志愿者账号，见“要你决定”']);
  assert.deepEqual([1, 2, 3].map((n) => rowOf(`next-${n}`).includes('涉及你')), [false, false, true], '只有提到“用户”的那一条标“涉及你”');
  assert.match(html, /① 要你决定<span class="n">1 项/);
  assert.match(rowOf('ask-1'), /<span class="pick">志愿者要不要单独的管理账号？<\/span>[\s\S]*<ul><li>选项一：每人一个账号。代价：多三天开发（示例）<\/li><li>选项二：共用前台账号。代价：出了错查不到是谁<\/li><li>选项三：什么都不做。代价：志愿者只能纸本登记，周一再补录<\/li><\/ul>/);
});

test('研究卡可以被新的研究卡取代；④末尾只列没被取代的研究卡', (t) => {
  const s = sample(t);
  const old = s.card('sys', '08-网络断线查证.md');
  edit(old, '状态：未定', '状态：已被某卡取代：[网络断线复查](09-网络断线复查.md)');
  fs.writeFileSync(s.card('sys', '09-网络断线复查.md'), fs.readFileSync(old, 'utf8')
    .replace('# 未定：书屋网络一个月断几次', '# 未定：书屋网络断线复查')
    .replace('状态：已被某卡取代：[网络断线复查](09-网络断线复查.md)', '状态：未定')
    .replace('取代：无', '取代：[网络断线查证](08-网络断线查证.md)'));
  const { html } = buildBrief({ source: s.root, output: s.output });
  assert.match(html, /另有研究卡 1 张，只查证不决定，不列在这里：<a class="ref" href="[^"]+09-[^"]+">「书屋网络断线复查」<\/a><\/p>/);
});

test('关系行里链接后面的说明照样显示', (t) => {
  const s = sample(t);
  edit(s.card('rule', '06-借阅上限五本.md'), '影响哪些卡：[逾期处理](03-逾期处理.md)', '影响哪些卡：[逾期处理](03-逾期处理.md)：同时在外的书变多，提醒会增多');
  const { html } = buildBrief({ source: s.root, output: s.output });
  assert.match(detailOf(html, 'card-1-06'), /<dt>影响哪些卡<\/dt><dd><a class="ref" href="#card-1-03">「逾期处理」<\/a>：同时在外的书变多，提醒会增多<\/dd>/);
});

test('不挡生成、但简报不显示的东西在终端提示：多余段落、开头散行、不合命名的文件、定于晚于本轮', (t) => {
  const s = sample(t);
  edit(s.card('rule', '04-借书押金.md'), '## 暂缓原因\n无\n', '## 暂缓原因\n无\n\n## 查证结论\n示例：多写的一段。\n');
  edit(s.card('rule', '03-逾期处理.md'), '定于：2026-09-15\n', '定于：2026-09-15\n备注：试运行三个月后再议一次（示例）\n');
  fs.writeFileSync(s.card('rule', '9-打印机.md'), '# 决定：打印机放前台\n');
  edit(s.card('rule', '06-借阅上限五本.md'), '定于：2026-09-18', '定于：2026-09-20');
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /提示：专题工作\/借阅规则\/决策卡\/9-打印机\.md 的文件名不是“NN-名称\.md”，没有当作决策卡读/);
  assert.match(r.stdout, /提示：专题工作\/借阅规则\/决策卡\/03-逾期处理\.md 开头有不属于任何标签的行，简报不显示：备注：试运行三个月后再议一次（示例）/);
  assert.match(r.stdout, /提示：专题工作\/借阅规则\/决策卡\/04-借书押金\.md 的 “## 查证结论” 不是附录 A 的段落，简报不显示/);
  assert.match(r.stdout, /提示：专题工作\/借阅规则\/决策卡\/06-借阅上限五本\.md 定于 2026-09-20，晚于本轮轮次日期 2026-09-19，本轮首屏不显示/);
});

test('输出路径是个目录：中文报错，退出码 1', (t) => {
  const s = sample(t);
  fs.mkdirSync(s.output);
  const r = run(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /输出路径是个目录：.+测试输出\.html（要写成 \.html 文件的路径）/);
  assert.doesNotMatch(r.stderr, /EISDIR|at /);
});

test('链接自检：页面里的链接指向的文件不存在或写成绝对路径，报错停止', (t) => {
  const s = sample(t);
  edit(s.card('rule', '06-借阅上限五本.md'), '(../../../资料/试运行反馈.md)', '(../../../资料/不存在.md)');
  edit(s.card('rule', '03-逾期处理.md'), '(../../../资料/书屋章程.md)', '(D:/资料/书屋章程.md)');
  edit(s.map, '(../html/决策简报-第1轮-20260912.html)', '(../html/决策简报-第1轮-20260911.html)');
  const err = fails(s);
  assert.match(err, /06-借阅上限五本\.md\n {2}- “依据”链接指向的文件不存在：\.\.\/\.\.\/\.\.\/资料\/不存在\.md\n/);
  assert.match(err, /03-逾期处理\.md\n {2}- “依据”要用相对链接：D:\/资料\/书屋章程\.md\n/);
  assert.match(err, /决策地图\.md\n {2}- “上一轮简报”链接指向的文件不存在：\.\.\/html\/决策简报-第1轮-20260911\.html\n/);
});

test('轮次范围：上一轮简报的日期之后到本轮日期；首轮写“无”时本轮日期以前的都算', (t) => {
  const s = sample(t);
  assert.deepEqual(buildBrief({ source: s.root, output: s.output }).brief.decided.map((c) => c.num), ['03', '04', '06']);
  edit(s.map, '上一轮简报：[第 1 轮决策简报](../html/决策简报-第1轮-20260912.html)', '上一轮简报：无');
  const first = buildBrief({ source: s.root, output: s.output });
  assert.deepEqual(first.brief.decided.map((c) => c.num), ['03', '04', '06', '01'], '首轮：已被取代的 02 不算，01 算');
  assert.match(first.html, /<th>上一轮<\/th><td>无（首轮）<\/td>/);

  const s2 = sample(t);
  fs.copyFileSync(path.join(s2.root, '项目总览', 'html', '决策简报-第1轮-20260912.html'), path.join(s2.root, '项目总览', 'html', '上一轮.html'));
  edit(s2.map, '(../html/决策简报-第1轮-20260912.html)', '(../html/上一轮.html)');
  assert.match(fails(s2), /决策地图\.md\n {2}- 上一轮简报的文件名里读不出日期：上一轮\.html（约定文件名 决策简报-第N轮-YYYYMMDD\.html，日期就是那一轮的轮次日期）\n/);

  const s3 = sample(t);
  edit(s3.map, '(../html/决策简报-第1轮-20260912.html)', '(../html/决策简报-第1轮-20260920.html)');
  edit(s3.map, '轮次：第 2 轮；2026-09-19', '轮次：第二轮 2026-09-19');
  const err = fails(s3);
  assert.match(err, /决策地图\.md\n {2}- 轮次应写成“第 N 轮；YYYY-MM-DD”，现为“第二轮 2026-09-19”\n/);
});
