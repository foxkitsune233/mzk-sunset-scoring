/*!
 * 组内互评 · 分数重分配核心算法（零和偏差重分配）
 * ------------------------------------------------------------------
 * 只根据"需要的结果"反推，不采用需求方给的算法：
 *   C1 守恒：Σ 每人最终分 = 老师给小组的分 G × 小组人数 n
 *   C2 均值：平均最终分 = G
 *   C3 无差异：组内互评若无任何差异，则每人最终分都 = G
 *              （故"全员打100 / 全员打90 / 全员打60"三种情形结果完全相同）
 *   C4 有界：0 ≤ 每人最终分 ≤ 100
 *   C5 尺度无关：所有原始分同时乘同一常数，最终结果不变
 *   C6 单调：某人收到的评分相对越高，最终分越高
 *
 * 匿名：本模块只接收"每人收到的平均分" w_j（聚合值），
 *       不接收、不存储、不输出任何逐行原始评分或打分人身份。
 *
 * 浏览器：<script src="scoring-core.js"></script> → window.ScoringCore
 * Node  ：const ScoringCore = require('./scoring-core.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScoringCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EPS = 1e-9;

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /** 把分数钳制到 [0,100]，并把被钳掉的总量摊回未触边者，使总和精确回到 targetSum */
  function reconcile(raw, targetSum) {
    var s = raw.map(function (x) { return clamp(x, 0, 100); });
    var n = s.length;
    for (var iter = 0; iter < 200; iter++) {
      var sum = s.reduce(function (a, b) { return a + b; }, 0);
      var delta = targetSum - sum;
      if (Math.abs(delta) < 1e-7) break;
      var idx = [];
      for (var i = 0; i < n; i++) {
        if (delta > 0 && s[i] < 100 - 1e-9) idx.push(i);
        else if (delta < 0 && s[i] > 1e-9) idx.push(i);
      }
      if (!idx.length) break;
      var ws = idx.map(function (i) { return delta > 0 ? (100 - s[i]) : s[i]; });
      var wsum = ws.reduce(function (a, b) { return a + b; }, 0);
      if (wsum < EPS) break;
      for (var k = 0; k < idx.length; k++) {
        s[idx[k]] = clamp(s[idx[k]] + delta * ws[k] / wsum, 0, 100);
      }
    }
    return s;
  }

  /** 逐条校验 C1/C2/C4 */
  function audit(s, G) {
    var n = s.length;
    var sum = s.reduce(function (a, b) { return a + b; }, 0);
    var min = Math.min.apply(null, s), max = Math.max.apply(null, s);
    var conserved = Math.abs(sum - G * n) < 1e-6;
    var meanOk = Math.abs(sum / n - G) < 1e-6;
    var inRange = min >= -1e-9 && max <= 100 + 1e-9;
    return {
      n: n, targetSum: G * n, sum: sum, conserved: conserved,
      average: sum / n, meanOk: meanOk, min: min, max: max,
      inRange: inRange, spread: max - min,
      allOk: conserved && meanOk && inRange
    };
  }

  /**
   * 核心分配：s_j = G + k·d_j，d_j = w_j − w̄，Σd_j = 0
   *   Σs_j = nG + k·Σd_j = nG        → C1/C2 恒成立，与 k 无关
   *   k = min( (100−G)/d_max , G/(−d_min) )  → 在不越 0~100 前提下最大化区分度
   *   w→c·w ⇒ d→c·d、k→k/c ⇒ k·d 不变     → C5
   */
  function allocate(w, G, method) {
    w = w.map(function (x) { var v = Number(x); return isFinite(v) ? v : 0; });
    var n = w.length;
    G = clamp(Number(G), 0, 100);
    var mean = w.reduce(function (a, b) { return a + b; }, 0) / n;
    var d = w.map(function (x) { return x - mean; });
    var dMax = 0, dMin = 0;
    d.forEach(function (x) { if (x > dMax) dMax = x; if (x < dMin) dMin = x; });

    var k = null, raw;
    if (method === 'poolShare') {
      var wsum = w.reduce(function (a, b) { return a + b; }, 0);
      raw = wsum < EPS ? new Array(n).fill(G) : w.map(function (x) { return (G * n) * x / wsum; });
    } else {
      method = 'zeroSum';
      k = 0;
      if (dMax > EPS || dMin < -EPS) {
        k = Infinity;
        if (dMax > EPS) k = Math.min(k, (100 - G) / dMax);
        if (dMin < -EPS) k = Math.min(k, G / (-dMin));
        if (!isFinite(k) || k < 0) k = 0;
      }
      raw = d.map(function (x) { return G + k * x; });
    }

    var scores = reconcile(raw, G * n);
    return {
      method: method, scores: scores, raw: raw, weights: w, mean: mean,
      deviations: d, k: k, groupScore: G, n: n, targetSum: G * n,
      audit: audit(scores, G)
    };
  }

  /** 入口 1（推荐）：直接喂聚合后的"每人收到平均分"，后端用这个 */
  function computeFromWeights(weights, options) {
    var opts = options || {};
    return allocate(weights, opts.groupScore === undefined ? 90 : opts.groupScore, opts.method);
  }

  /**
   * 入口 2：喂完整 n×n 矩阵（本地自测 / 单机模式用），只按列聚合，不看行身份。
   * null / 空串 = 该打分人跳过此人（例如"自己那格留空"），不计入分子也不计入分母。
   */
  function compute(matrix, options) {
    var opts = options || {};
    var n = matrix.length;
    var excludeSelf = opts.excludeSelf === true;
    var sums = new Array(n).fill(0);
    var cnts = new Array(n).fill(0);
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (excludeSelf && i === j) continue;
        var cell = matrix[i][j];
        if (cell === null || cell === undefined || cell === '') continue;
        var v = Number(cell);
        if (!isFinite(v)) continue;
        sums[j] += v;
        cnts[j] += 1;
      }
    }
    var valid = [], w = new Array(n);
    for (var j2 = 0; j2 < n; j2++) {
      if (cnts[j2] > 0) { w[j2] = sums[j2] / cnts[j2]; valid.push(w[j2]); }
    }
    // 整列无人打分时用其它列的均值兜底，避免凭空造出一个极端低分把 k 压死
    var fallback = valid.length ? valid.reduce(function (a, b) { return a + b; }, 0) / valid.length : 90;
    for (var j3 = 0; j3 < n; j3++) if (cnts[j3] === 0) w[j3] = fallback;
    return allocate(w, opts.groupScore === undefined ? 90 : opts.groupScore, opts.method);
  }

  /**
   * 显示精度：整数模式用"最大余数法"，保证取整后总和仍精确守恒。
   * digits: 2 | 1 | 0
   */
  function formatScores(scores, targetSum, digits) {
    if (digits === undefined) digits = 2;
    if (digits > 0) return scores.map(function (x) { return x.toFixed(digits); });
    var floors = scores.map(function (x) { return Math.floor(x + 1e-9); });
    var total = Math.round(targetSum);
    var remain = total - floors.reduce(function (a, b) { return a + b; }, 0);
    var order = scores.map(function (x, i) {
      return { i: i, r: x - Math.floor(x + 1e-9) };
    }).sort(function (a, b) { return b.r - a.r; });
    for (var t = 0; t < remain && t < order.length; t++) floors[order[t].i] += 1;
    for (var t2 = 0; t2 < -remain && t2 < order.length; t2++) {
      var i = order[order.length - 1 - t2].i;
      if (floors[i] > 0) floors[i] -= 1;
    }
    return floors.map(String);
  }

  return {
    compute: compute, computeFromWeights: computeFromWeights, allocate: allocate,
    audit: audit, reconcile: reconcile, formatScores: formatScores, clamp: clamp
  };
});
