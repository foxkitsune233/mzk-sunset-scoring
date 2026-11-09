/* 算法自测：node test-scoring.js —— 逐条验证需求反推出的 C1~C6 */
const S = require('./scoring-core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2705 ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \u274c ' + name + (extra ? '  ' + extra : '')); }
}
function near(a, b, e) { return Math.abs(a - b) < (e || 1e-6); }
function allSame(arr, v) { return arr.every(x => near(x, v)); }
function matrix(n, fn) { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => fn(i, j))); }
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

console.log('\n=== 1. 老师举的三种情形：全员同分 100 / 90 / 60 → 每人都是 90 ===');
{
  const n = 10, G = 90;
  const r100 = S.compute(matrix(n, () => 100), { groupScore: G });
  const r90 = S.compute(matrix(n, () => 90), { groupScore: G });
  const r60 = S.compute(matrix(n, () => 60), { groupScore: G });
  ok('全员打100 → 每人 90', allSame(r100.scores, 90));
  ok('全员打90  → 每人 90', allSame(r90.scores, 90));
  ok('全员打60  → 每人 90', allSame(r60.scores, 90));
  ok('三种原始分结果完全相同（绝对分值无意义）',
    JSON.stringify(r100.scores) === JSON.stringify(r60.scores));
  ok('合计 = 90×10 = 900', near(r100.audit.sum, 900), '实际 ' + r100.audit.sum);
}

console.log('\n=== 2. 尺度无关 C5：所有原始分同乘 0.6，结果不变 ===');
{
  const n = 9, G = 88, rand = rng(20261109);
  const m = matrix(n, () => 55 + Math.round(rand() * 45));
  const scaled = m.map(row => row.map(v => v * 0.6));
  const a = S.compute(m, { groupScore: G }).scores;
  const b = S.compute(scaled, { groupScore: G }).scores;
  ok('M 与 0.6M 的最终得分逐人一致', a.every((x, i) => near(x, b[i], 1e-6)));
}

console.log('\n=== 3. 守恒 / 均值 / 有界 C1 C2 C4：n=8~11 × G 多取值 × 随机矩阵 ===');
{
  let cases = 0, bad = [];
  for (let n = 8; n <= 11; n++) {
    for (const G of [60, 75, 88, 90, 95, 100, 0]) {
      for (let t = 0; t < 30; t++) {
        const rand = rng(n * 1000 + G * 10 + t + 7);
        const m = matrix(n, () => Math.round(rand() * 100));
        const r = S.compute(m, { groupScore: G });
        cases++;
        if (!r.audit.allOk) bad.push({ n, G, t, sum: r.audit.sum, min: r.audit.min, max: r.audit.max });
      }
    }
  }
  ok(cases + ' 组随机用例全部满足 C1/C2/C4', bad.length === 0,
    bad.length ? '失败样例 ' + JSON.stringify(bad[0]) : '合计目标 = G×n 恒成立');
}

console.log('\n=== 4. 单调性 C6：收到评分越高，最终分越高 ===');
{
  const n = 10, G = 90;
  const m = matrix(n, (i, j) => 60 + j * 4);   // 第 j 人固定比前一人高 4 分
  const r = S.compute(m, { groupScore: G });
  let mono = true;
  for (let j = 1; j < n; j++) if (r.scores[j] < r.scores[j - 1] - 1e-9) mono = false;
  ok('w_0 < w_1 < ... < w_9 ⇒ s_0 < s_1 < ... < s_9', mono,
    '区间 ' + r.audit.min.toFixed(2) + ' ~ ' + r.audit.max.toFixed(2));
  ok('最高分不超 100', r.audit.max <= 100 + 1e-9);
}

console.log('\n=== 5. 自己那格留空：按列有效数平均，且每列 cnt 全一致（不泄露身份）===');
{
  const n = 10, G = 90;
  const m = matrix(n, (i, j) => (i === j ? null : 70 + j * 2));
  const direct = S.compute(m, { groupScore: G });
  const w = Array.from({ length: n }, (_, j) => 70 + j * 2);  // 每列 9 个有效分，均值即该值
  const viaAgg = S.computeFromWeights(w, { groupScore: G });
  ok('矩阵留空 == 直接喂聚合 w_j', direct.scores.every((x, i) => near(x, viaAgg.scores[i], 1e-6)));
  const cnts = Array.from({ length: n }, (_, j) => m.reduce((a, row) => a + (row[j] !== null ? 1 : 0), 0));
  ok('每列有效计数都 = n-1 = 9（空位不含身份信息）', cnts.every(c => c === 9));
  ok('合计仍 = 900', near(direct.audit.sum, 900));
}

console.log('\n=== 6. 整数显示（最大余数法）取整后总和仍守恒 ===');
{
  const n = 11, G = 90, rand = rng(999);
  const m = matrix(n, () => 40 + Math.round(rand() * 60));
  const r = S.compute(m, { groupScore: G });
  const shown = S.formatScores(r.scores, r.targetSum, 0).map(Number);
  ok('取整后合计 = 990', shown.reduce((a, b) => a + b, 0) === 990,
    '实际 ' + shown.reduce((a, b) => a + b, 0));
  ok('取整后仍全在 0~100', shown.every(x => x >= 0 && x <= 100));
}

console.log('\n=== 7. 边界：G=100 / G=0 / 存在一列完全无人打分 ===');
{
  const n = 8;
  ok('G=100 → 全员 100（平均分被锁死，无法再拉开）',
    allSame(S.compute(matrix(n, () => 50), { groupScore: 100 }).scores, 100));
  ok('G=0 → 全员 0',
    allSame(S.compute(matrix(n, () => 50), { groupScore: 0 }).scores, 0));
  const m = matrix(n, (i, j) => (i === j ? null : 80));
  m.forEach(row => { row[3] = null; });   // 第 4 人整列无分
  const r = S.compute(m, { groupScore: 90 });
  ok('整列无分不产生虚假极低分', r.audit.allOk, '最低 ' + r.audit.min.toFixed(2));
}

console.log('\n=== 8. 对照算法（总分池占比）同样守恒但不越界 ===');
{
  const n = 10, G = 90, rand = rng(42);
  const m = matrix(n, () => Math.round(rand() * 100));
  const r = S.compute(m, { groupScore: G, method: 'poolShare' });
  ok('合计 = 900 且 0~100', r.audit.allOk, '实际 ' + r.audit.sum.toFixed(6));
}

console.log('\n=== 9. 模拟后端聚合路径（「自己留空 / 剔除自评」规则）→ sums/cnts → 最终得分 ===');
{
  const n = 10, G = 90, rand = rng(555);
  const sums = new Array(n).fill(0), cnts = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;                       // 自己那格留空
      const v = 60 + Math.round(rand() * 40);
      sums[j] += v; cnts[j] += 1;                 // 原始行用完即弃，只留累加器
    }
  }
  const w = sums.map((s, j) => s / cnts[j]);
  const r = S.computeFromWeights(w, { groupScore: G, method: 'zeroSum' });
  ok('只凭聚合值即可算出结果，合计 = 900', r.audit.allOk, '实际 ' + r.audit.sum);
  ok('剔除自评规则下每列 cnt 都 = n-1，聚合值不含身份信息', cnts.every(c => c === n - 1));
  ok('0~100 且有区分度', r.audit.inRange && r.audit.spread > 0,
    '区间 ' + r.audit.min.toFixed(2) + ' ~ ' + r.audit.max.toFixed(2));
}

console.log('\n=== 10. 两个页面内联脚本语法检查 ===');
{
  const fs = require('fs');
  ['index.html', 'teacher.html'].forEach(f => {
    const h = fs.readFileSync(__dirname + '/' + f, 'utf8');
    const blocks = [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    let good = true, msg = '';
    blocks.forEach((m, i) => {
      try { new Function(m[1]); } catch (e) { good = false; msg += ' script' + i + ': ' + e.message; }
    });
    ok(f + ' 内联脚本可解析（' + blocks.length + ' 块）', good && blocks.length > 0, msg);
    const need = f === 'index.html'
      ? ['ruleNote','ruleLine','memberGrid','btnSubmit','codeWrap','roundInput']
      : ['gN','gScore','gSelf','gCode','nameGrid','rosterState','pasteBox','pasteInput',
         'btnApplyPaste','btnSaveRoster','btnClearRoster','btnCreate','vRound','resultBody'];
    const missing = need.filter(id => !h.includes('id="' + id + '"'));
    ok(f + ' 关键元素齐全（' + need.length + ' 个 id）', missing.length === 0, missing.join(','));
  });
}

console.log('\n=== 11. 新需求：允许自评（全组 n 人都打分，每列 cnt = n）===');
{
  const n = 10, G = 90, rand = rng(2026);
  const m = matrix(n, () => 55 + Math.round(rand() * 45));
  const r = S.compute(m, { groupScore: G });
  const cnts = Array.from({ length: n }, (_, j) => m.reduce((a, row) => a + (row[j] !== null ? 1 : 0), 0));
  ok('每列 cnt 都 = n（全填满，无空位、无身份信息）', cnts.every(c => c === n));
  ok('允许自评下守恒 / 均值 / 有界仍成立', r.audit.allOk, '合计 ' + r.audit.sum);
  const mNoSelf = m.map((row, i) => row.map((v, j) => (i === j ? null : v)));
  const r2 = S.compute(mNoSelf, { groupScore: G });
  ok('「自己留空」规则同样守恒', r2.audit.allOk);
  ok('两种规则都落在 0~100', r.audit.inRange && r2.audit.inRange);
  ok('两种规则的 w_j 不同（自评确实被计入 / 剔除）',
    !r.weights.every((x, i) => near(x, r2.weights[i])));
}

console.log('\n----------------------------------------');
console.log(pass + ' 通过 / ' + fail + ' 失败');
console.log('----------------------------------------\n');
process.exit(fail ? 1 : 0);
