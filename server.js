/*!
 * 组内匿名互评 · 简单后端
 * ------------------------------------------------------------------
 * 启动：npm install && npm start        （默认 http://0.0.0.0:8090）
 * 配置：config.json → mongoUri / dbName / host / port
 *
 * 【匿名落地方式】—— 结构性保证，不靠"不显示"的约定：
 *   1. 数据库里只有 n 个聚合累加器 sums[j] / cnts[j]，
 *      收到一行评分后立刻按列累加，原始行随即丢弃、永不入库；
 *   2. 不写 IP、UA、账号、提交时间戳、提交顺序；
 *   3. 一次性随机码随机分发、不与学生姓名绑定；
 *   4. 两种自评规则下每列 cnt 都完全一致（允许自评 = n，剔除自评 = n-1），
 *      既没有逐行数据、也没有空位差异，反推不出任何打分人身份；
 *   5. 学生端接口永不返回任何分数，结果接口需 adminKey（仅老师端持有）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const ScoringCore = require('./scoring-core.js');
const config = require('./config.json');

const ROUNDS = () => db.collection('rounds');
let db;

function randStr(len, alphabet) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
const ROUND_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_CHARS = '0123456789';

/* ---------------- 老师端登录密码（随机生成、持久化、重启不变） ---------------- */
const TEACHER_PASS_FILE = path.join(__dirname, 'teacher-pass.json');
function loadTeacherPass() {
  try {
    const j = JSON.parse(fs.readFileSync(TEACHER_PASS_FILE, 'utf8'));
    if (j && j.password) return j.password;
  } catch (e) {}
  // 12 位随机密码（去掉易混淆字符），写入文件并限制仅属主可读
  const pwd = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
  try {
    fs.writeFileSync(TEACHER_PASS_FILE, JSON.stringify({ password: pwd, createdAt: new Date().toISOString() }), { mode: 0o600 });
    console.log('[TEACHER] 老师端随机密码已生成并保存到 teacher-pass.json：' + pwd);
  } catch (e) { console.error('[WARN] 无法写入 teacher-pass.json：' + e.message); }
  return pwd;
}
const TEACHER_PASS = loadTeacherPass();
// 登录会话：token -> 过期时间戳（内存态，重启清空但密码持久）
const teacherSessions = new Map();
function newTeacherToken() {
  const t = crypto.randomBytes(24).toString('hex');
  teacherSessions.set(t, Date.now() + 8 * 3600 * 1000);
  return t;
}
function validTeacherToken(t) {
  if (!t) return false;
  const exp = teacherSessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { teacherSessions.delete(t); return false; }
  return true;
}
function getCookie(req, name) {
  const c = req.headers.cookie;
  if (!c) return '';
  const m = c.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function fail(res, code, msg) { json(res, code, { ok: false, error: msg }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function serveHtml(res, file) {
  const p = path.join(__dirname, file);
  fs.readFile(p, (err, buf) => {
    if (err) return fail(res, 500, '页面文件缺失: ' + file);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/* 静态资源（背景图、图标等）：仅放行白名单后缀，并防目录穿越 */
const STATIC_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.webp': 'image/webp'
};
function serveStatic(res, rel) {
  const ext = path.extname(rel).toLowerCase();
  const mime = STATIC_MIME[ext];
  if (!mime) return fail(res, 404, '资源不存在');
  const p = path.join(__dirname, rel);
  if (p !== path.normalize(p) || !p.startsWith(path.join(__dirname, path.sep))) {
    return fail(res, 403, '非法路径');
  }
  fs.readFile(p, (err, buf) => {
    if (err) return fail(res, 404, '资源不存在');
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  });
}

/* ---------------- 老师端：登录 / 登出 / 登录页 ---------------- */
function serveTeacherLogin(res) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>老师端登录 · mzk 互评器</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:linear-gradient(160deg,#0b1d28,#0b2530 60%,#0a2b39);color:#e8f4f7}
.login{width:min(360px,90vw);padding:30px 26px;border:1px solid rgba(255,255,255,.14);background:rgba(13,37,49,.55);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 20px 60px rgba(0,10,20,.4)}
.login h1{font-size:18px;margin:0 0 4px;font-weight:600;letter-spacing:.02em}
.login .sub{margin:0 0 22px;color:#8fb6c2;font-size:12.5px}
.login label{display:block;font-size:12px;color:#9fc1cc;margin-bottom:7px;letter-spacing:.03em}
.login input{width:100%;min-height:44px;padding:11px 13px;background:rgba(2,16,26,.55);border:1px solid rgba(120,180,196,.3);color:#eef9fb;font-size:15px;outline:none;transition:.15s}
.login input:focus{border-color:#5fb9c9;box-shadow:inset 3px 0 0 #5fb9c9}
.login .btn{width:100%;margin-top:16px;min-height:44px;border:1px solid #0b7b93;background:#0b7b93;color:#f2fdff;font-size:14px;font-weight:600;cursor:pointer;transition:.15s}
.login .btn:hover{background:#046176}
.login .err{color:#f1a3aa;font-size:12.5px;min-height:18px;margin-top:10px}
.login .foot{margin-top:18px;font-size:11px;color:#6f95a1;text-align:center}
</style></head><body><div class="login"><h1>mzk sunset互评器</h1><p class="sub">老师端 · 需要密码登录</p><form id="f"><label for="pw">老师端密码</label><input type="password" id="pw" autocomplete="current-password" placeholder="请输入密码"><button class="btn" type="submit" id="b">登录</button><div class="err" id="e"></div></form><div class="foot">此页面仅老师使用，学生请勿访问</div></div><script>
document.getElementById('f').onsubmit=function(e){
 e.preventDefault(); var b=document.getElementById('b'); document.getElementById('e').textContent='';
 b.disabled=true; b.textContent='登录中…';
 fetch('/api/teacher/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})})
 .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
 .then(function(x){ if(x.ok&&x.j.ok){ location.href='/teacher'; } else { document.getElementById('e').textContent=(x.j&&x.j.error)||'登录失败'; b.disabled=false; b.textContent='登录'; } })
 .catch(function(){ document.getElementById('e').textContent='网络错误'; b.disabled=false; b.textContent='登录'; });
};
</script></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
async function teacherLogin(req, res) {
  const b = await readBody(req);
  if (String(b.password) === TEACHER_PASS) {
    const token = newTeacherToken();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'mzk_t=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800'
    });
    res.end(JSON.stringify({ ok: true }));
  } else {
    fail(res, 401, '密码错误');
  }
}
function teacherLogout(res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': 'mzk_t=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
  });
  res.end(JSON.stringify({ ok: true }));
}

/* ---------------- 老师端：创建轮次 ---------------- */
async function createRound(req, res) {
  const b = await readBody(req);
  const members = Array.isArray(b.members) ? b.members.map(x => String(x).trim()) : [];
  const n = members.length;
  const G = Number(b.groupScore);
  if (n < 8 || n > 11) return fail(res, 400, '小组人数需为 8~11 人，当前 ' + n);
  if (members.some(x => !x)) return fail(res, 400, '组员姓名不能为空');
  if (new Set(members).size !== n) return fail(res, 400, '组员姓名不能重复');
  if (!isFinite(G) || G < 0 || G > 100) return fail(res, 400, '老师给小组的分需在 0~100');

  // 主流程：只用「一个互评码」(= roundId)。一次性提交码是可选的加强防重复，默认关闭。
  const requireCode = b.requireCode === true;
  // 自评规则：默认「允许自评」（全组 n 人含自己都要打分）；false = 自己留空、剔除自评。
  const allowSelf = b.allowSelf !== false;
  const roundId = randStr(6, ROUND_CHARS);
  const adminKey = crypto.randomBytes(24).toString('hex');
  const doc = {
    roundId,
    groupName: String(b.groupName || '第 1 组').trim(),
    groupScore: G,
    n,
    members,
    adminKey,
    requireCode,
    allowSelf,
    // 随机码不绑定任何姓名；只记录是否用过，防重复提交
    codes: requireCode
      ? Array.from({ length: n }, () => ({ code: randStr(6, CODE_CHARS), used: false }))
      : [],
    // 只存聚合累加器，绝不存逐行原始评分
    sums: new Array(n).fill(0),
    cnts: new Array(n).fill(0),
    submitted: 0,
    closed: false,
    createdAt: new Date()
  };
  try { await ROUNDS().insertOne(doc); }
  catch (e) { return fail(res, 500, '互评码冲突，请重试'); }

  json(res, 200, {
    ok: true, roundId, adminKey, requireCode,
    codes: doc.codes.map(c => c.code),
    studentUrl: '/?round=' + roundId
  });
}

/* ---------------- 学生端：拿名单（不含任何分数 / G / 码） ---------------- */
async function getConfig(res, roundId) {
  const r = await ROUNDS().findOne({ roundId }, { projection: { _id: 0, adminKey: 0, codes: 0, sums: 0, cnts: 0 } });
  if (!r) return fail(res, 404, '互评码不存在');
  // G 是公开的小组基准分，不含任何个人评分信息，返回它便于老师端显示
  json(res, 200, {
    ok: true, roundId: r.roundId, groupName: r.groupName,
    groupScore: r.groupScore, n: r.n, members: r.members, requireCode: r.requireCode,
    allowSelf: r.allowSelf !== false, submitted: r.submitted, closed: r.closed
  });
}

/* ---------------- 学生端：匿名提交一行评分 ---------------- */
async function submit(req, res) {
  const b = await readBody(req);
  const roundId = String(b.roundId || '').toUpperCase();
  const r = await ROUNDS().findOne({ roundId });
  if (!r) return fail(res, 404, '互评码不存在');
  if (r.closed) return fail(res, 403, '本轮打分已结束');
  if (r.submitted >= r.n) return fail(res, 403, '本轮已收齐 ' + r.n + ' 份评分');

  const scores = b.scores;
  if (!Array.isArray(scores) || scores.length !== r.n) return fail(res, 400, '评分数量与小组人数不符');

  let valid = 0;
  const inc = {};
  for (let j = 0; j < r.n; j++) {
    const v = scores[j];
    if (v === null || v === undefined || v === '') continue;   // 自己那格留空 → 跳过
    const num = Number(v);
    if (!isFinite(num) || num < 0 || num > 100) return fail(res, 400, '第 ' + (j + 1) + ' 项需为 0~100 或留空');
    inc['sums.' + j] = num;
    inc['cnts.' + j] = 1;
    valid++;
  }
  const allowSelf = r.allowSelf !== false;
  if (allowSelf && valid !== r.n)
    return fail(res, 400, '请给全组 ' + r.n + ' 位同学都打分（含本人），不能有空格');
  if (!allowSelf && valid < r.n - 1)
    return fail(res, 400, '请给其余 ' + (r.n - 1) + ' 位同学打分（本人那格留空）');
  inc.submitted = 1;

  // 原子抢占一次性码 + 累加聚合值，一步完成；原始 scores 变量出作用域即丢弃，不写库
  let filter = { roundId, closed: false, submitted: { $lt: r.n } };
  const update = { $inc: inc };
  if (r.requireCode) {
    const code = String(b.code || '').trim();
    if (!code) return fail(res, 400, '请填写老师发的匿名提交码');
    filter['codes'] = { $elemMatch: { code, used: false } };
    update.$set = { 'codes.$[c].used': true };
    const out = await ROUNDS().findOneAndUpdate(filter, update, {
      arrayFilters: [{ 'c.code': code, 'c.used': false }],
      returnDocument: 'after'
    });
    if (!out) return fail(res, 400, '提交码无效或已使用');
    json(res, 200, { ok: true, submitted: out.submitted, n: r.n });
  } else {
    const out = await ROUNDS().findOneAndUpdate(filter, update, { returnDocument: 'after' });
    if (!out) return fail(res, 400, '提交失败，请重试');
    json(res, 200, { ok: true, submitted: out.submitted, n: r.n });
  }
}

/* ---------------- 老师端：结果（唯一能看到最终得分的接口） ---------------- */
async function getResult(req, res, roundId) {
  const r = await ROUNDS().findOne({ roundId });
  if (!r) return fail(res, 404, '互评码不存在');
  if (req.headers['x-admin-key'] !== r.adminKey) return fail(res, 401, '无权查看成绩，请从老师端进入');

  const valid = [], w = new Array(r.n);
  for (let j = 0; j < r.n; j++) {
    if (r.cnts[j] > 0) { w[j] = r.sums[j] / r.cnts[j]; valid.push(w[j]); }
  }
  const fallback = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : r.groupScore;
  for (let j = 0; j < r.n; j++) if (r.cnts[j] === 0) w[j] = fallback;

  const result = ScoringCore.computeFromWeights(w, { groupScore: r.groupScore, method: 'zeroSum' });
  json(res, 200, {
    ok: true,
    roundId: r.roundId, groupName: r.groupName,
    groupScore: r.groupScore, n: r.n, members: r.members,
    submitted: r.submitted, closed: r.closed, complete: r.submitted >= r.n,
    // 只回聚合值与结果，不回 sums/cnts 明细、不回 codes、不回任何逐行数据
    weights: w, k: result.k,
    scores: result.scores,
    displayed: ScoringCore.formatScores(result.scores, result.targetSum, 2),
    audit: result.audit
  });
}

async function closeRound(req, res, roundId) {
  const r = await ROUNDS().findOne({ roundId });
  if (!r) return fail(res, 404, '互评码不存在');
  if (req.headers['x-admin-key'] !== r.adminKey) return fail(res, 401, '无权操作');
  await ROUNDS().updateOne({ roundId }, { $set: { closed: true } });
  json(res, 200, { ok: true, closed: true });
}

/** 老师换设备后凭 adminKey 取回一次性码（学生端无此接口） */
async function getCodes(req, res, roundId) {
  const r = await ROUNDS().findOne({ roundId });
  if (!r) return fail(res, 404, '互评码不存在');
  if (req.headers['x-admin-key'] !== r.adminKey) return fail(res, 401, '无权查看');
  json(res, 200, { ok: true, requireCode: r.requireCode, codes: r.codes.map(c => c.code) });
}

/* ---------------- 路由 ---------------- */
async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveHtml(res, 'index.html');
    if (req.method === 'GET' && (p === '/teacher' || p === '/teacher.html')) {
      if (!validTeacherToken(getCookie(req, 'mzk_t'))) return serveTeacherLogin(res);
      return serveHtml(res, 'teacher.html');
    }
    if (req.method === 'POST' && p === '/api/teacher/login') return await teacherLogin(req, res);
    if (req.method === 'POST' && p === '/api/teacher/logout') return teacherLogout(res);
    if (req.method === 'POST' && p === '/api/round') {
      if (!validTeacherToken(getCookie(req, 'mzk_t'))) return fail(res, 401, '请先在老师端登录');
      return await createRound(req, res);
    }
    if (req.method === 'POST' && p === '/api/submit') return await submit(req, res);
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/round\/([^/]+)\/config$/))) return await getConfig(res, decodeURIComponent(m[1]));
    if (req.method === 'GET' && (m = p.match(/^\/api\/round\/([^/]+)\/progress$/))) {
      const r = await ROUNDS().findOne({ roundId: decodeURIComponent(m[1]) }, { projection: { _id: 0, n: 1, submitted: 1, closed: 1 } });
      return r ? json(res, 200, { ok: true, submitted: r.submitted, n: r.n, closed: r.closed }) : fail(res, 404, '互评码不存在');
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/round\/([^/]+)\/result$/))) return await getResult(req, res, decodeURIComponent(m[1]));
    if (req.method === 'GET' && (m = p.match(/^\/api\/round\/([^/]+)\/codes$/))) return await getCodes(req, res, decodeURIComponent(m[1]));
    if (req.method === 'POST' && (m = p.match(/^\/api\/round\/([^/]+)\/close$/))) return await closeRound(req, res, decodeURIComponent(m[1]));
    if (p === '/health') return json(res, 200, { ok: true, mongo: !!db });
    if (req.method === 'GET' && /^\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/.test(p)) return serveStatic(res, p);
    return fail(res, 404, '接口不存在');
  } catch (e) {
    console.error('[ERR]', e);
    if (!res.headersSent) fail(res, 500, e.message || '服务器内部错误');
  }
}

async function main() {
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    db = client.db(config.dbName);
    await ROUNDS().createIndex({ roundId: 1 }, { unique: true });
    console.log('[OK] MongoDB 已连接：' + config.dbName);
  } catch (e) {
    console.error('[FATAL] MongoDB 连接失败：' + e.message);
    console.error('        请检查 config.json 的 mongoUri / dbName');
    process.exit(1);
  }
  http.createServer(handle).listen(config.port, config.host, () => {
    console.log('[OK] 组内互评服务已启动');
    console.log('     学生端  http://<服务器IP>:' + config.port + '/?round=<轮次号>');
    console.log('     老师端  http://<服务器IP>:' + config.port + '/teacher');
  });
}
main();
