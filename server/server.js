#!/usr/bin/env node
/**
 * 记账本小程序 · 自部署后端
 * 零第三方依赖：内置 node:sqlite（要求 Node >= 22.5，推荐 24 LTS）+ node:https。
 *
 * 接口清单
 *   POST /api/login           微信登录（AppSecret 仅保存在本服务，绝不下发小程序）
 *   GET  /api/sync?since=     拉取增量（ledgers / members / records）
 *   POST /api/sync            推送本机变更，并按 since 拉取增量
 *   POST /api/ledgers/join    凭邀请码加入账本
 *   POST /api/ledgers/invite  重新生成邀请码
 *   GET  /healthz             健康检查
 *
 * 同步语义：按 updated_at 最后写入者胜（LWW）；删除以 deleted 墓碑传播。
 * 数据结构与前端 utils/db.js 的本地模型一一对应（金额单位为分）。
 */

'use strict'

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

let DatabaseSync = null
try {
  DatabaseSync = require('node:sqlite').DatabaseSync
} catch (e) {
  console.error('[jizhang-api] 当前 Node 不支持内置 node:sqlite，请使用 Node >= 22.5（推荐 24 LTS）：' + process.version)
  process.exit(1)
}

/* ---------------- 配置加载（.env，无需 dotenv） ---------------- */

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!m) continue
    let v = (m[2] || '').trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadEnvFile(path.join(__dirname, '.env'))

let db = null

/* ---------------- 小工具 ---------------- */

function nowIso() {
  return new Date().toISOString()
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 64)
}

/** 头像上限：压缩后的 dataURL 约几 KB~几十 KB，给足冗余但拒绝超大串 */
const AVATAR_MAX = 200000

/** 头像白名单校验：只放行 http(s) 地址或图片类 dataURL，越界一律丢弃避免脏数据入库 */
function sanitizeAvatar(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s.slice(0, 512)
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) return s.slice(0, AVATAR_MAX)
  return ''
}

/** 账本封面上限：封面只在列表/图标位展示，比头像还小，120KB 足够且不拖大同步包 */
const COVER_MAX = 120000

/**
 * 封面白名单校验：{ kind:'preset', key } 或 { kind:'image', image:dataURL }，
 * 其余（含伪造 kind / 非图片 dataURL / 超大串）一律回退默认预设。
 */
function sanitizeCover(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { kind: 'preset', key: 'default' }
  if (v.kind === 'image') {
    const img = String(v.image == null ? '' : v.image).trim()
    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) {
      return { kind: 'image', image: img.slice(0, COVER_MAX) }
    }
    return { kind: 'preset', key: 'default' }
  }
  const key = String(v.key == null ? '' : v.key).trim().slice(0, 20)
  return { kind: 'preset', key: key || 'default' }
}

function isoOr(v) {
  if (typeof v === 'number' && isFinite(v)) return new Date(v).toISOString()
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v
  return nowIso()
}

/** 安全解析 JSON 列；类型不符或损坏时回退默认值 */
function jsonColumn(v, fallback) {
  try {
    var parsed = JSON.parse(String(v == null ? '' : v))
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return fallback
  } catch (e) {
    return fallback
  }
}

/** JSON 列序列化：限制体积，防恶意大对象 */
function toJsonColumn(v, fallback, maxLen) {
  try {
    var s = JSON.stringify(v === undefined || v === null ? fallback : v)
    if (s.length > maxLen) return JSON.stringify(fallback)
    return s
  } catch (e) {
    return JSON.stringify(fallback)
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = []
    let size = 0
    req.on('data', function (c) {
      size += c.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', function () {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(new Error('JSON 解析失败'))
      }
    })
    req.on('error', reject)
  })
}

function readText(req) {
  return new Promise(function (resolve, reject) {
    const chunks = []
    let size = 0
    req.on('data', function (c) {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/* ---------------- 个人虚拟支付（道具直购） ---------------- */

/**
 * 商品白名单：productId → 价格(分) + 是否发放 VIP。
 * 默认走 env（VPAY_PRODUCT_VIP / VPAY_PRODUCT_VIP_PRICE）；未配置时给开发/测试兜底值，
 * 生产环境务必在 .env 填真实道具信息（价格须与 MP 后台道具一致）。
 */
function vpayProduct(productId) {
  const vipPid = process.env.VPAY_PRODUCT_VIP || 'vip_perm'
  const vipPrice = parseInt(process.env.VPAY_PRODUCT_VIP_PRICE || '3000', 10)
  if (productId && productId === vipPid) return { productId: vipPid, price: isFinite(vipPrice) ? vipPrice : 3000, grantVip: true }
  return null
}

/** 支付签名 paySig：HMAC-SHA256(AppKey, "requestVirtualPayment&" + signData) */
function calcPaySig(signData) {
  return crypto.createHmac('sha256', process.env.VPAY_APP_KEY || '').update('requestVirtualPayment&' + signData).digest('hex')
}

/** 用户态签名 signature：HMAC-SHA256(sessionKey, signData) */
function calcUserSig(signData, sessionKey) {
  return crypto.createHmac('sha256', sessionKey || '').update(signData).digest('hex')
}

/** 业务单号：T + 时间戳(base36) + 随机，8~32 位且不以 _ 开头，保证唯一 */
function genOutTradeNo() {
  return ('T' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex')).slice(0, 32)
}

/** 微信侧订单是否已支付（字段名随版本可能变化，宽松判定） */
function wxOrderIsPaid(data) {
  if (!data || data.errcode) return false
  return data.state === 2 || data.payed === 1 || data.pay_result === 1 ||
    (data.order_info && (data.order_info.state === 2 || data.order_info.payed === 1))
}

/** 调用微信 query_order（B 端签名：uri 为实际路径） */
async function queryWxOrder(openid, outTradeNo) {
  const body = JSON.stringify({ openid: openid, env: 0, order_id: outTradeNo })
  const paySig = crypto.createHmac('sha256', process.env.VPAY_APP_KEY || '').update('/xpay/query_order&' + body).digest('hex')
  const ctrl = new AbortController()
  const timer = setTimeout(function () { ctrl.abort() }, 8000)
  try {
    const resp = await fetch('https://api.weixin.qq.com/xpay/query_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'pay_sig': paySig },
      body: body,
      signal: ctrl.signal
    })
    return await resp.json()
  } catch (e) {
    return { errcode: -1, errmsg: 'query_order 网络异常' }
  } finally {
    clearTimeout(timer)
  }
}

/** 发货（永久 VIP）：以 wx_order_id 幂等；订单行缺失时按 openid+product 补建 */
function deliverVip(openid, productId, outTradeNo, wxOrderId) {
  const p = vpayProduct(productId)
  if (!p || !p.grantVip) return false
  const now = nowIso()
  const exist = db.prepare('SELECT 1 FROM orders WHERE wx_order_id = ? AND deliver_at != \'\'').get(wxOrderId || '')
  if (exist) return true
  db.exec('BEGIN IMMEDIATE')
  try {
    let o = db.prepare('SELECT out_trade_no FROM orders WHERE out_trade_no = ?').get(outTradeNo)
    if (!o) {
      db.prepare('INSERT INTO orders (out_trade_no, openid, product_id, amount, status, attach, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(outTradeNo, openid, productId, p.price, 0, openid, now)
    }
    db.prepare('UPDATE orders SET wx_order_id = ?, status = 1, paid_at = ?, deliver_at = ? WHERE out_trade_no = ? AND deliver_at = \'\'')
      .run(wxOrderId || outTradeNo, now, now, outTradeNo)
    db.prepare('UPDATE users SET vip = 1, vip_at = ? WHERE openid = ?').run(now, openid)
    db.exec('COMMIT')
    return true
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[jizhang-api] 发货失败:', e && e.message)
    return false
  }
}

/** 下单签名：返回前端拉起支付所需的 payData 字段 */
async function handlePayOrder(req, res) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const body = await readBody(req)
  const productId = str(body.productId, 64)
  const p = vpayProduct(productId)
  if (!p) return sendJson(res, 400, { error: '未知的商品' })
  const sessionKey = getSessionKey(openid)
  if (!sessionKey) return sendJson(res, 400, { error: '登录态已失效，请重启小程序后重试' })
  const outTradeNo = genOutTradeNo()
  const signDataObj = {
    offerId: process.env.VPAY_OFFER_ID || '',
    buyQuantity: 1,
    env: 0,
    currencyType: 'CNY',
    productId: p.productId,
    goodsPrice: p.price,
    outTradeNo: outTradeNo,
    attach: openid
  }
  const signData = JSON.stringify(signDataObj)
  db.prepare('INSERT INTO orders (out_trade_no, openid, product_id, amount, status, attach, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(outTradeNo, openid, p.productId, p.price, 0, openid, nowIso())
  sendJson(res, 200, {
    ok: true,
    signData: signData,
    mode: 'short_series_goods',
    paySig: calcPaySig(signData),
    signature: calcUserSig(signData, sessionKey)
  })
}

/** 兜底查单：前端轮询 / 后端主动确认 */
async function handlePayQuery(req, res) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const body = await readBody(req)
  const outTradeNo = str(body.outTradeNo || body.order_id, 64)
  if (!outTradeNo) return sendJson(res, 400, { error: '缺少订单号' })
  if (process.env.MOCK_WX === '1') {
    const o = db.prepare('SELECT status FROM orders WHERE out_trade_no = ?').get(outTradeNo)
    return sendJson(res, 200, { ok: true, mock: true, state: o ? o.status : 0 })
  }
  const data = await queryWxOrder(openid, outTradeNo)
  sendJson(res, 200, data)
}

/** VIP 状态：已购直接返回；未购但有未发货订单则主动 query_order 兜底发货 */
async function handleVipStatus(req, res) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const cur = db.prepare('SELECT vip FROM users WHERE openid = ?').get(openid)
  if (cur && cur.vip) return sendJson(res, 200, { ok: true, vip: true, paid: true })
  const pend = db.prepare('SELECT out_trade_no, product_id FROM orders WHERE openid = ? AND status = 0 ORDER BY created_at DESC LIMIT 1').get(openid)
  if (pend && process.env.MOCK_WX !== '1') {
    const data = await queryWxOrder(openid, pend.out_trade_no)
    if (wxOrderIsPaid(data)) deliverVip(openid, pend.product_id, pend.out_trade_no, data.wx_order_id || data.order_id || '')
  }
  const after = db.prepare('SELECT vip FROM users WHERE openid = ?').get(openid)
  const vip = !!(after && after.vip)
  sendJson(res, 200, { ok: true, vip: vip, paid: vip })
}

/** 微信发货推送（XML）。GET 回显 MP 消息推送验证；POST 解析并幂等发货 */
async function handlePayNotify(req, res, url) {
  if (req.method === 'GET') {
    const echostr = url ? (url.searchParams.get('echostr') || '') : ''
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(echostr)
    return
  }
  let xml = ''
  try { xml = await readText(req) } catch (e) { xml = '' }
  const field = function (tag) {
    let m = xml.match(new RegExp('<' + tag + '\\s*>\\s*<!\\[CDATA\\[(.*?)\\]\\]>\\s*<\\/' + tag + '>', 'i'))
    if (m) return m[1]
    m = xml.match(new RegExp('<' + tag + '\\s*>(.*?)<\\/' + tag + '>', 'i'))
    return m ? m[1].trim() : ''
  }
  const event = field('Event')
  if (event && event !== 'xpay_goods_deliver_notify') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' })
    res.end('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[ignored]]></ErrMsg></xml>')
    return
  }
  const openid = field('OpenId')
  const outTradeNo = field('OutTradeNo')
  const wxOrderId = field('MchOrderNo')
  const productId = field('ProductId')
  if (openid && outTradeNo) deliverVip(openid, productId, outTradeNo, wxOrderId)
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' })
  res.end('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>')
}

/* ---------------- 数据库 ---------------- */

function initSchema(d) {
  d.exec('PRAGMA journal_mode=WAL')
  d.exec('PRAGMA busy_timeout=5000')
  d.exec([
    'CREATE TABLE IF NOT EXISTS users (',
    '  openid TEXT PRIMARY KEY,',
    '  nickname TEXT NOT NULL DEFAULT \'\',',
    '  created_at TEXT NOT NULL',
    ')'
  ].join('\n'))
  d.exec([
    'CREATE TABLE IF NOT EXISTS sessions (',
    '  token TEXT PRIMARY KEY,',
    '  openid TEXT NOT NULL,',
    '  created_at TEXT NOT NULL',
    ')'
  ].join('\n'))
  d.exec([
    'CREATE TABLE IF NOT EXISTS ledgers (',
    '  id TEXT PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  owner_openid TEXT NOT NULL,',
    '  invite_code TEXT NOT NULL UNIQUE,',
    '  created_at TEXT NOT NULL',
    ')'
  ].join('\n'))
  d.exec([
    'CREATE TABLE IF NOT EXISTS members (',
    '  ledger_id TEXT NOT NULL,',
    '  openid TEXT NOT NULL,',
    '  nickname TEXT NOT NULL DEFAULT \'\',',
    '  joined_at TEXT NOT NULL,',
    '  PRIMARY KEY (ledger_id, openid)',
    ')'
  ].join('\n'))
  d.exec([
    'CREATE TABLE IF NOT EXISTS records (',
    '  id TEXT PRIMARY KEY,',
    '  ledger_id TEXT NOT NULL,',
    '  openid TEXT NOT NULL,',
    '  member_name TEXT NOT NULL DEFAULT \'\',',
    '  type TEXT NOT NULL,',
    '  amount INTEGER NOT NULL,',
    '  category TEXT NOT NULL DEFAULT \'\',',
    '  date TEXT NOT NULL DEFAULT \'\',',
    '  note TEXT NOT NULL DEFAULT \'\',',
    '  deleted INTEGER NOT NULL DEFAULT 0,',
    '  account_id TEXT NOT NULL DEFAULT \'\',',
    '  transfer_to TEXT NOT NULL DEFAULT \'\',',
    '  transfer_to_name TEXT NOT NULL DEFAULT \'\',',
    '  created_at TEXT NOT NULL,',
    '  updated_at TEXT NOT NULL',
    ')'
  ].join('\n'))
  d.exec('CREATE INDEX IF NOT EXISTS idx_records_ledger_updated ON records(ledger_id, updated_at)')
  d.exec('CREATE INDEX IF NOT EXISTS idx_members_openid ON members(openid)')
  d.exec('CREATE INDEX IF NOT EXISTS idx_sessions_openid ON sessions(openid)')
  migrateSchema(d)
}

/**
 * 老库升级：账本级配置列 + 记录账户/转账列 + 用户资料列（头像/手机号）。
 * SQLite ALTER TABLE ADD COLUMN 幂等（按 pragma 判断），对既有数据零影响。
 */
function migrateSchema(d) {
  // 账号级移除标记独立保存；共享成员的数据和访问不受影响。
  d.exec('CREATE TABLE IF NOT EXISTS removed_ledgers (openid TEXT NOT NULL, ledger_id TEXT NOT NULL, removed_at TEXT NOT NULL, PRIMARY KEY (openid, ledger_id))')
  function columns(table) {
    return d.prepare('PRAGMA table_info(' + table + ')').all().map(function (r) { return r.name })
  }
  var ledgerCols = columns('ledgers')
  var ledgerAdd = [
    ['accounts_json', "ALTER TABLE ledgers ADD COLUMN accounts_json TEXT NOT NULL DEFAULT '[]'"],
    ['budget_json', "ALTER TABLE ledgers ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{\"monthlyTotal\":0,\"categoryBudgets\":{}}'"],
    ['recurring_json', "ALTER TABLE ledgers ADD COLUMN recurring_json TEXT NOT NULL DEFAULT '[]'"],
    ['templates_json', "ALTER TABLE ledgers ADD COLUMN templates_json TEXT NOT NULL DEFAULT '[]'"],
    ['categories_json', "ALTER TABLE ledgers ADD COLUMN categories_json TEXT NOT NULL DEFAULT '[]'"],
    ['challenges_json', "ALTER TABLE ledgers ADD COLUMN challenges_json TEXT NOT NULL DEFAULT '[]'"],
    ['cover_json', "ALTER TABLE ledgers ADD COLUMN cover_json TEXT NOT NULL DEFAULT '{\"kind\":\"preset\",\"key\":\"default\"}'"],
    ['cfg_at', "ALTER TABLE ledgers ADD COLUMN cfg_at TEXT NOT NULL DEFAULT ''"]
  ]
  ledgerAdd.forEach(function (pair) {
    if (ledgerCols.indexOf(pair[0]) < 0) d.exec(pair[1])
  })
  var recordCols = columns('records')
  var recordAdd = [
    ['external_at', "ALTER TABLE records ADD COLUMN external_at TEXT NOT NULL DEFAULT ''"],
    ['external_json', "ALTER TABLE records ADD COLUMN external_json TEXT NOT NULL DEFAULT 'null'"],
    ['account_id', "ALTER TABLE records ADD COLUMN account_id TEXT NOT NULL DEFAULT ''"],
    ['transfer_to', "ALTER TABLE records ADD COLUMN transfer_to TEXT NOT NULL DEFAULT ''"],
    ['transfer_to_name', "ALTER TABLE records ADD COLUMN transfer_to_name TEXT NOT NULL DEFAULT ''"]
  ]
  recordAdd.forEach(function (pair) {
    if (recordCols.indexOf(pair[0]) < 0) d.exec(pair[1])
  })
  // 用户资料：头像（微信 CDN 临时地址，用前需重新拉取）、手机号（个人主体拿不到时的兜底）
  var userCols = columns('users')
  var userAdd = [
    ['avatar', "ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''"],
    ['phone', "ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''"],
    ['vip', "ALTER TABLE users ADD COLUMN vip INTEGER NOT NULL DEFAULT 0"],
    ['vip_at', "ALTER TABLE users ADD COLUMN vip_at TEXT NOT NULL DEFAULT ''"]
  ]
  userAdd.forEach(function (pair) {
    if (userCols.indexOf(pair[0]) < 0) d.exec(pair[1])
  })
  // 会话表：补 session_key 列，用于个人虚拟支付的用户态签名（signature）
  var sessionCols = columns('sessions')
  if (sessionCols.indexOf('session_key') < 0) {
    d.exec("ALTER TABLE sessions ADD COLUMN session_key TEXT NOT NULL DEFAULT ''")
  }
  // 订单表（个人虚拟支付：道具直购，一次性买断）：wx_order_id 为平台单号，幂等去重键
  d.exec([
    'CREATE TABLE IF NOT EXISTS orders (',
    '  out_trade_no TEXT PRIMARY KEY,',
    '  openid TEXT NOT NULL,',
    '  product_id TEXT NOT NULL,',
    '  wx_order_id TEXT NOT NULL DEFAULT \'\',',
    '  amount INTEGER NOT NULL,',
    '  status INTEGER NOT NULL DEFAULT 0,',
    '  attach TEXT NOT NULL DEFAULT \'\',',
    '  created_at TEXT NOT NULL,',
    '  paid_at TEXT NOT NULL DEFAULT \'\',',
    '  deliver_at TEXT NOT NULL DEFAULT \'\'',
    ')'
  ].join('\n'))
  d.exec('CREATE INDEX IF NOT EXISTS idx_orders_wx ON orders(wx_order_id)')
}

/* ---------------- 微信登录 ---------------- */

async function wxCode2Session(code) {
  const appid = process.env.APPID || ''
  const secret = process.env.APPSECRET || ''
  if (!appid || !secret) return { error: '服务端未配置 APPID/APPSECRET' }
  const url = 'https://api.weixin.qq.com/sns/jscode2session'
    + '?appid=' + encodeURIComponent(appid)
    + '&secret=' + encodeURIComponent(secret)
    + '&js_code=' + encodeURIComponent(code)
    + '&grant_type=authorization_code'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(function () { ctrl.abort() }, 8000)
    const resp = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    const data = await resp.json()
    if (data.errcode) return { error: '微信登录失败(' + data.errcode + ')' }
    if (!data.openid) return { error: '微信登录失败：未返回 openid' }
    // session_key 用于个人虚拟支付的用户态签名（signature），必须持久化
    return { openid: data.openid, session_key: data.session_key || '' }
  } catch (e) {
    return { error: '微信服务网络异常，请稍后重试' }
  }
}

function genInviteCode() {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase()
    const dup = db.prepare('SELECT 1 FROM ledgers WHERE invite_code = ?').get(code)
    if (!dup) return code
  }
  return crypto.randomBytes(6).toString('hex').toUpperCase()
}

function userNickname(openid) {
  const row = db.prepare('SELECT nickname FROM users WHERE openid = ?').get(openid)
  return row ? row.nickname : ''
}

/** 完整用户资料（昵称/头像/手机号/会员），无记录时返回空态 */
function userProfile(openid) {
  const row = db.prepare('SELECT openid, nickname, avatar, vip, vip_at FROM users WHERE openid = ?').get(openid)
  return {
    id: openid,
    name: row ? (row.nickname || '') : '',
    avatar: row ? (row.avatar || '') : '',
    vip: !!(row && row.vip),
    vipAt: row ? (row.vip_at || '') : ''
  }
}

/** 取用户最近一次登录的 session_key（个人虚拟支付用户态签名用）；缺失返回空串 */
function getSessionKey(openid) {
  const row = db.prepare('SELECT session_key FROM sessions WHERE openid = ? ORDER BY created_at DESC LIMIT 1').get(openid)
  return row && row.session_key ? row.session_key : ''
}

function requireAuth(req, res) {
  const auth = req.headers.authorization || ''
  const m = auth.match(/^Bearer\s+([a-f0-9]{16,128})$/i)
  if (!m) {
    sendJson(res, 401, { error: '未登录或登录已过期，请重新打开小程序' })
    return null
  }
  const row = db.prepare('SELECT openid FROM sessions WHERE token = ?').get(m[1])
  if (!row) {
    sendJson(res, 401, { error: '未登录或登录已过期，请重新打开小程序' })
    return null
  }
  return row.openid
}

/* ---------------- 快照组装 ---------------- */

/** 导入快照只做边界清洗；去重指纹由客户端统一生成。保持后端可独立部署。 */
function normalizeExternal(value) {
  if (!value || typeof value !== 'object' || !str(value.src, 16)) return null
  const out = {
    src: str(value.src, 16), txn: str(value.txn, 128), party: str(value.party, 200),
    date: str(value.date, 10), time: str(value.time, 19), type: str(value.type, 16),
    amount: Math.round(Number(value.amount) || 0), note: str(value.note, 500), channel: str(value.channel, 100)
  }
  if (out.date && out.type && out.amount > 0) out.version = 2
  return out
}

function toClientRecord(r) {
  return {
    id: r.id,
    ledgerId: r.ledger_id,
    memberId: r.openid,
    memberName: r.member_name || '',
    type: r.type,
    amount: r.amount,
    category: r.category,
    accountId: r.account_id || '',
    transferTo: r.transfer_to || '',
    transferToName: r.transfer_to_name || '',
    date: r.date,
    note: r.note,
    external: normalizeExternal(jsonColumn(r.external_json, null)),
    deleted: !!r.deleted,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function snapshot(openid, since) {
  const out = { ledgers: [], members: [], records: [], me: userProfile(openid) }
  out.removedLedgerIds = db.prepare('SELECT ledger_id FROM removed_ledgers WHERE openid = ?').all(openid).map(r => r.ledger_id)
  const ledgers = db.prepare(
    'SELECT l.id, l.name, l.owner_openid, l.invite_code, l.created_at,'
    + ' l.accounts_json, l.budget_json, l.recurring_json, l.templates_json, l.categories_json, l.challenges_json, l.cover_json, l.cfg_at'
    + ' FROM ledgers l JOIN members m ON m.ledger_id = l.id'
    + ' WHERE m.openid = ? AND NOT EXISTS (SELECT 1 FROM removed_ledgers x WHERE x.openid = m.openid AND x.ledger_id = l.id) ORDER BY l.created_at'
  ).all(openid)
  const ids = ledgers.map(function (l) { return l.id })
  if (!ids.length) return out
  const ph = ids.map(function () { return '?' }).join(',')
  const membersSql = 'SELECT ledger_id, openid, nickname, joined_at FROM members WHERE ledger_id IN (' + ph + ') ORDER BY joined_at'
  const members = db.prepare(membersSql).all(...ids)
  let recRows
  const recBase = 'SELECT * FROM records WHERE ledger_id IN (' + ph + ')'
  if (since) {
    // >= 而非 >：推送与拉取可能落在同一毫秒（seen serverTime 竞态）。
    // 客户端按记录 ID + LWW 去重，重复推送无害。
    recRows = db.prepare(recBase + ' AND (updated_at >= ? OR external_at >= ?) ORDER BY updated_at').all(...ids, since, since)
  } else {
    recRows = db.prepare(recBase + ' ORDER BY updated_at').all(...ids)
  }
  // 昵称解析（含历史遗留成员）
  const nameIds = []
  ledgers.forEach(function (l) { nameIds.push(l.owner_openid) })
  members.forEach(function (m) { nameIds.push(m.openid) })
  recRows.forEach(function (r) { nameIds.push(r.openid) })
  const uniq = Array.from(new Set(nameIds))
  const names = {}
  if (uniq.length) {
    const up = uniq.map(function () { return '?' }).join(',')
    const userRows = db.prepare('SELECT openid, nickname FROM users WHERE openid IN (' + up + ')').all(...uniq)
    userRows.forEach(function (u) { names[u.openid] = u.nickname })
  }
  out.ledgers = ledgers.map(function (l) {
    return {
      id: l.id,
      name: l.name,
      ownerId: l.owner_openid,
      ownerName: names[l.owner_openid] || '',
      createdAt: l.created_at,
      inviteCode: l.invite_code,
      accounts: jsonColumn(l.accounts_json, []),
      budget: jsonColumn(l.budget_json, { monthlyTotal: 0, categoryBudgets: {} }),
      recurring: jsonColumn(l.recurring_json, []),
      templates: jsonColumn(l.templates_json, []),
      categories: jsonColumn(l.categories_json, []),
      challenges: jsonColumn(l.challenges_json, []),
      cover: jsonColumn(l.cover_json, { kind: 'preset', key: 'default' }),
      cfgAt: l.cfg_at || ''
    }
  })
  out.members = members.map(function (m) {
    return { ledgerId: m.ledger_id, id: m.openid, name: m.nickname || names[m.openid] || '成员', joinedAt: m.joined_at }
  })
  out.records = recRows.map(function (r) {
    const c = toClientRecord(r)
    if (!c.memberName) c.memberName = names[r.openid] || ''
    return c
  })
  return out
}

/* ---------------- 推送应用 ---------------- */

function applyLedgerPush(openid, l) {
  if (!l || typeof l !== 'object') return
  const id = str(l.id, 64)
  if (!id) return
  if (db.prepare('SELECT 1 FROM removed_ledgers WHERE openid = ? AND ledger_id = ?').get(openid, id)) return
  const name = str(l.name, 20)
  const accountsJson = toJsonColumn(l.accounts, [], 200 * 1024)
  const budgetJson = toJsonColumn(l.budget, { monthlyTotal: 0, categoryBudgets: {} }, 64 * 1024)
  const recurringJson = toJsonColumn(l.recurring, [], 128 * 1024)
  const templatesJson = toJsonColumn(Array.isArray(l.templates) ? l.templates.slice(0, 50) : [], [], 128 * 1024)
  const categoriesJson = toJsonColumn(l.categories, [], 128 * 1024)
  const challengesJson = toJsonColumn(l.challenges, [], 128 * 1024)
  const coverJson = toJsonColumn(sanitizeCover(l.cover), { kind: 'preset', key: 'default' }, COVER_MAX + 200)
  const cfgAt = str(l.cfgAt, 40)
  let row = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(id)
  if (row) {
    const isMember = !!db.prepare('SELECT 1 FROM members WHERE ledger_id = ? AND openid = ?').get(id, openid)
    if (!isMember && row.owner_openid !== openid) return
    if (name && name !== row.name) db.prepare('UPDATE ledgers SET name = ? WHERE id = ?').run(name, id)
    // 账本级配置：按 cfgAt LWW，旧配置不覆盖新配置
    if (cfgAt && cfgAt > row.cfg_at) {
      db.prepare([
        'UPDATE ledgers SET accounts_json = ?, budget_json = ?, recurring_json = ?,',
        '  categories_json = ?, challenges_json = ?, cover_json = ?, templates_json = ?, cfg_at = ? WHERE id = ?'
      ].join(' ')).run(accountsJson, budgetJson, recurringJson, categoriesJson, challengesJson, coverJson,
        Array.isArray(l.templates) ? templatesJson : row.templates_json, cfgAt, id)
    }
  } else {
    db.prepare([
      'INSERT INTO ledgers (id, name, owner_openid, invite_code, created_at,',
      '  accounts_json, budget_json, recurring_json, categories_json, challenges_json, cover_json, templates_json, cfg_at)',
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ].join(' '))
      .run(id, name || '共享账本', openid, genInviteCode(), isoOr(l.createdAt),
        accountsJson, budgetJson, recurringJson, categoriesJson, challengesJson, coverJson, templatesJson, cfgAt || nowIso())
    row = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(id)
  }
  const membersIn = Array.isArray(l.members) ? l.members.slice(0, 200) : []
  for (const m of membersIn) {
    const mid = str(m && m.id, 64)
    if (!mid) continue
    const mname = str(m && m.name, 12)
    const exist = db.prepare('SELECT nickname FROM members WHERE ledger_id = ? AND openid = ?').get(id, mid)
    if (!exist) {
      db.prepare('INSERT INTO members (ledger_id, openid, nickname, joined_at) VALUES (?,?,?,?)')
        .run(id, mid, mname || '成员', isoOr(m && m.joinedAt))
    } else if (mname && mname !== exist.nickname) {
      db.prepare('UPDATE members SET nickname = ? WHERE ledger_id = ? AND openid = ?').run(mname, id, mid)
    }
  }
  db.prepare('INSERT OR IGNORE INTO members (ledger_id, openid, nickname, joined_at) VALUES (?,?,?,?)')
    .run(id, openid, userNickname(openid) || '成员', nowIso())
}

function applyRecordPush(openid, r) {
  if (!r || typeof r !== 'object') return
  const id = str(r.id, 64)
  const ledgerId = str(r.ledgerId, 64)
  if (!id || !ledgerId) return
  if (db.prepare('SELECT 1 FROM removed_ledgers WHERE openid = ? AND ledger_id = ?').get(openid, ledgerId)) return
  const memberOk = !!db.prepare('SELECT 1 FROM members WHERE ledger_id = ? AND openid = ?').get(ledgerId, openid)
  if (!memberOk) return
  const type = r.type === 'income' ? 'income' : (r.type === 'transfer' ? 'transfer' : 'expense')
  const amount = Math.round(Number(r.amount))
  if (!isFinite(amount) || amount <= 0 || amount > 1e12) return
  const date = str(r.date, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
  const accountId = str(r.accountId, 64)
  const transferTo = str(r.transferTo, 64)
  const transferToName = str(r.transferToName, 24)
  if (type === 'transfer') {
    // 转账必须两端账户都在，且目标账户属于同一账本配置（宽松校验：服务端存字符串，客户端消费）
    if (!accountId || !transferTo || accountId === transferTo) return
  }
  const updatedAt = isoOr(r.updatedAt)
  const createdAt = isoOr(r.createdAt)
  const deleted = r.deleted ? 1 : 0
  const memberName = str(r.memberName, 24)
  const note = str(r.note, 200)
  const category = type === 'transfer' ? 'transfer' : str(r.category, 32)
  const external = JSON.stringify(normalizeExternal(r.external))
  const existing = db.prepare('SELECT updated_at, ledger_id, external_json FROM records WHERE id = ?').get(id)
  if (existing && existing.ledger_id !== ledgerId) return
  // 旧设备只补传交易身份，不修改金额、删除标记或财务版本。
  if (existing && external !== 'null' && (!existing.external_json || existing.external_json === 'null')) {
    db.prepare('UPDATE records SET external_json = ?, external_at = ? WHERE id = ?').run(external, nowIso(), id)
  }
  if (r.identityOnly) return
  if (existing && existing.updated_at >= updatedAt) return
  db.prepare([
    'INSERT INTO records (id, ledger_id, openid, member_name, type, amount, category, date, note, deleted, account_id, transfer_to, transfer_to_name, created_at, updated_at, external_json)',
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'ON CONFLICT(id) DO UPDATE SET',
    '  openid=excluded.openid, member_name=excluded.member_name, type=excluded.type,',
    '  amount=excluded.amount, category=excluded.category, date=excluded.date,',
    '  note=excluded.note, deleted=excluded.deleted, created_at=excluded.created_at,',
    '  account_id=excluded.account_id, transfer_to=excluded.transfer_to,',
    '  transfer_to_name=excluded.transfer_to_name,',
    "  external_json=CASE WHEN excluded.external_json = 'null' THEN records.external_json ELSE excluded.external_json END,",
    '  updated_at=excluded.updated_at',
    'WHERE excluded.updated_at > records.updated_at'
  ].join('\n')).run(id, ledgerId, openid, memberName, type, amount, category, date, note, deleted, accountId, transferTo, transferToName, createdAt, updatedAt, external)
}

/* ---------------- 路由处理 ---------------- */

async function handleLogin(req, res) {
  const body = await readBody(req)
  const code = str(body.code, 64)
  if (code.length < 4) return sendJson(res, 400, { error: 'code 无效' })
  let openid
  let sessionKey = ''
  if (process.env.MOCK_WX === '1') {
    openid = 'mock_' + code.slice(0, 40)
    sessionKey = 'mock_session_' + code.slice(0, 24)
  } else {
    const r = await wxCode2Session(code)
    if (r.error) return sendJson(res, 401, { error: r.error })
    openid = r.openid
    sessionKey = r.session_key || ''
  }
  const nickname = str(body.nickname, 12)
  db.prepare([
    'INSERT INTO users (openid, nickname, created_at) VALUES (?,?,?)',
    'ON CONFLICT(openid) DO UPDATE SET nickname = CASE WHEN excluded.nickname != \'\' THEN excluded.nickname ELSE users.nickname END'
  ].join('\n')).run(openid, nickname, nowIso())
  const token = crypto.randomBytes(24).toString('hex')
  db.prepare('INSERT INTO sessions (token, openid, session_key, created_at) VALUES (?,?,?,?)').run(token, openid, sessionKey, nowIso())
  sendJson(res, 200, Object.assign({
    ok: true,
    token: token,
    me: userProfile(openid),
    serverTime: nowIso()
  }, snapshot(openid, '')))
}

async function handleSyncGet(req, res, url) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const since = str((url.searchParams.get('since') || ''), 40)
  sendJson(res, 200, Object.assign({ ok: true, serverTime: nowIso() }, snapshot(openid, since)))
}

async function handleSyncPost(req, res) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const body = await readBody(req)
  const ledgersIn = Array.isArray(body.ledgers) ? body.ledgers.slice(0, 100) : []
  const recordsIn = Array.isArray(body.records) ? body.records.slice(0, 2000) : []
  const removed = Array.isArray(body.removedLedgerIds) ? body.removedLedgerIds.slice(0, 1000) : []
  db.exec('BEGIN IMMEDIATE')
  try {
    const remove = db.prepare('INSERT OR IGNORE INTO removed_ledgers (openid, ledger_id, removed_at) VALUES (?,?,?)')
    for (const id of removed) {
      if (typeof id === 'string' && id.trim()) remove.run(openid, str(id, 64), nowIso())
    }
    for (const l of ledgersIn) applyLedgerPush(openid, l)
    for (const r of recordsIn) applyRecordPush(openid, r)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  const since = str(body.since, 40)
  sendJson(res, 200, Object.assign({ ok: true, serverTime: nowIso() }, snapshot(openid, since)))
}

async function handleJoin(req, res) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const body = await readBody(req)
  const code = str(body.inviteCode, 32).toUpperCase()
  if (!code) return sendJson(res, 400, { error: '请输入邀请码' })
  const ledger = db.prepare('SELECT id FROM ledgers WHERE invite_code = ?').get(code)
  if (!ledger) return sendJson(res, 404, { error: '邀请码无效，请检查后重试' })
  const nickname = str(body.nickname, 12) || userNickname(openid) || '成员'
  db.prepare('INSERT OR IGNORE INTO members (ledger_id, openid, nickname, joined_at) VALUES (?,?,?,?)')
    .run(ledger.id, openid, nickname, nowIso())
  db.prepare('DELETE FROM removed_ledgers WHERE openid = ? AND ledger_id = ?').run(openid, ledger.id)
  sendJson(res, 200, Object.assign({ ok: true, ledgerId: ledger.id, serverTime: nowIso() }, snapshot(openid, '')))
}

async function handleInviteRegen(req, res) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const body = await readBody(req)
  const id = str(body.ledgerId, 64)
  const ledger = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(id)
  if (!ledger) return sendJson(res, 404, { error: '账本不存在' })
  const isMember = !!db.prepare('SELECT 1 FROM members WHERE ledger_id = ? AND openid = ?').get(id, openid)
  if (!isMember && ledger.owner_openid !== openid) return sendJson(res, 403, { error: '只有账本成员可以生成邀请码' })
  const code = genInviteCode()
  db.prepare('UPDATE ledgers SET invite_code = ? WHERE id = ?').run(code, id)
  sendJson(res, 200, { ok: true, inviteCode: code })
}

/** 更新我的资料：昵称 + 头像（来自微信 chooseAvatar / 头像昵称填写能力） */
async function handleProfileUpdate(req, res) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const body = await readBody(req)
  const nickname = str(body.nickname, 12)
  // 头像允许两种形态：http(s) 地址，或前端压缩后的 dataURL（微信头像是临时路径，必须持久化后才能长期用）
  const rawAvatar = str(body.avatar, AVATAR_MAX)
  const avatar = sanitizeAvatar(rawAvatar)
  // 保证用户行存在（首次云端登录时可能还没写）
  db.prepare("INSERT OR IGNORE INTO users (openid, nickname, avatar, created_at) VALUES (?,?,?,?)")
    .run(openid, nickname, avatar, nowIso())
  if (nickname) db.prepare('UPDATE users SET nickname = ? WHERE openid = ?').run(nickname, openid)
  if (avatar) db.prepare('UPDATE users SET avatar = ? WHERE openid = ?').run(avatar, openid)
  // 昵称变了，成员表里的展示名同步刷新（历史数据友好）
  if (nickname) {
    db.prepare('UPDATE members SET nickname = ? WHERE openid = ?').run(nickname, openid)
  }
  sendJson(res, 200, { ok: true, me: userProfile(openid) })
}

const ROUTES = [
  ['POST', /^\/api\/login$/, handleLogin],
  ['GET', /^\/api\/sync$/, handleSyncGet],
  ['POST', /^\/api\/sync$/, handleSyncPost],
  ['POST', /^\/api\/ledgers\/join$/, handleJoin],
  ['POST', /^\/api\/ledgers\/invite$/, handleInviteRegen],
  ['POST', /^\/api\/user\/profile$/, handleProfileUpdate],
  ['POST', /^\/api\/pay\/order$/, handlePayOrder],
  ['POST', /^\/api\/pay\/query$/, handlePayQuery],
  ['GET', /^\/api\/pay\/notify$/, handlePayNotify],
  ['POST', /^\/api\/pay\/notify$/, handlePayNotify],
  ['GET', /^\/api\/vip\/status$/, handleVipStatus],
  ['GET', /^\/healthz$/, function (req, res) { sendJson(res, 200, { ok: true, ts: nowIso() }) }]
]

async function handler(req, res) {
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch (e) {
    return sendJson(res, 400, { error: '非法请求' })
  }
  for (const route of ROUTES) {
    if (req.method === route[0] && route[1].test(url.pathname)) {
      try {
        return await route[2](req, res, url)
      } catch (e) {
        console.error('[jizhang-api] 处理失败:', e && e.message)
        if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' })
        return
      }
    }
  }
  sendJson(res, 404, { error: 'Not Found' })
}

/* ---------------- 启动 ---------------- */

function start() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const dbFile = process.env.DATA_FILE || path.join(dataDir, 'jizhang.db')
  db = new DatabaseSync(dbFile)
  initSchema(db)

  const port = Number(process.env.PORT || 443)
  const host = process.env.HOST || '0.0.0.0'
  const keyPath = process.env.CERT_KEY || ''
  const chainPath = process.env.CERT_CHAIN || ''
  let server
  if (keyPath && chainPath && fs.existsSync(keyPath) && fs.existsSync(chainPath)) {
    server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(chainPath) },
      handler
    )
  } else {
    server = http.createServer(handler)
    console.warn('[jizhang-api] 未配置证书，以 HTTP 启动（仅限本地测试或 EdgeOne 回源场景）')
  }
  return new Promise(function (resolve) {
    server.listen(port, host, function () {
      console.log('[jizhang-api] listening on ' + host + ':' + port + (server instanceof https.Server ? ' (https)' : ' (http)'))
      resolve(server)
    })
  })
}

process.on('SIGINT', function () { try { if (db) db.close() } catch (e) {} process.exit(0) })
process.on('SIGTERM', function () { try { if (db) db.close() } catch (e) {} process.exit(0) })

if (require.main === module) {
  start().catch(function (e) {
    console.error('[jizhang-api] 启动失败:', e)
    process.exit(1)
  })
}

module.exports = { start: start }
