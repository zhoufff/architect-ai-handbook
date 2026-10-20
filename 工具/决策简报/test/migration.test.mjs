// 迁移示例：改写前是旧写法，--check 列出缺口；改写后按迁移指南改好，--check 通过，也能生成首份简报。
// 把 examples/ 整份复制到临时目录，只改副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(tool, 'scripts', 'brief.mjs');
const node = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });

test('迁移示例：改写前报缺口；改写后 --check 通过，生成首份简报', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-brief-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(tool, 'examples', '迁移示例'), dir, { recursive: true });

  const before = node('--check', path.join(dir, '改写前'));
  assert.equal(before.status, 1);
  assert.match(before.stderr, /项目总览\/md\/决策地图\.md\n {2}- 缺标签：轮次、本轮范围、要用户决定、下一步、上一轮简报\n/);
  assert.match(before.stderr, /01-报修入口\.md\n {2}- 标题行应为“# 决定：结论句”，未定时“# 未定：问题一句”；现为“# 报修入口”\n/);
  assert.match(before.stderr, /共 10 处。/);

  const root = path.join(dir, '改写后');
  const check = node('--check', root);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /第 4 轮，2026-09-27：定了 3 项（其中否决 0 项），改了旧决定 1 处，带前提 1 项，未定 0 项，暂缓 0 项；研究卡 1 张不上首屏/);
  assert.doesNotMatch(check.stdout, /提示：/, '旧头部行放在五个标签之后，不进首屏也不出提示');

  fs.mkdirSync(path.join(root, '项目总览', 'html'));
  const output = path.join(root, '项目总览', 'html', '决策简报-第4轮-20260927.html');
  const made = node('--source', root, '--output', output);
  assert.equal(made.status, 0, made.stderr);
  const html = fs.readFileSync(output, 'utf8');
  assert.match(html, /<span class="topic" title="夜间报修：夜间只收漏水、停电两类紧急报修">夜间报修<\/span>/, '拆出的卡上了“本轮定了什么”');
  assert.match(html, /报修渠道<\/span><span class="pick"><del>“只做电话报修”（ADR 0001）<\/del> → 小程序为主、电话备用<\/span>/, '改 ADR 的整行进了“改了哪些旧决定”');
  assert.equal((html.match(/id="next-\d+"/g) || []).length, 2, '下一步只有两条，旧头部行没混进去');
});
