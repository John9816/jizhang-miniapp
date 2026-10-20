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
  function columns(table) {
    return d.prepare('PRAGMA table_info(' + table + ')').all().map(function (r) { return r.name })
  }
  var ledgerCols = columns('ledgers')
  var ledgerAdd = [
    ['accounts_json', "ALTER TABLE ledgers ADD COLUMN accounts_json TEXT NOT NULL DEFAULT '[]'"],
    ['budget_json', "ALTER TABLE ledgers ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{\"monthlyTotal\":0,\"categoryBudgets\":{}}'"],
    ['recurring_json', "ALTER TABLE ledgers ADD COLUMN recurring_json TEXT NOT NULL DEFAULT '[]'"],
    ['categories_json', "ALTER TABLE ledgers ADD COLUMN categories_json TEXT NOT NULL DEFAULT '[]'"],
    ['challenges_json', "ALTER TABLE ledgers ADD COLUMN challenges_json TEXT NOT NULL DEFAULT '[]'"],
    ['cfg_at', "ALTER TABLE ledgers ADD COLUMN cfg_at TEXT NOT NULL DEFAULT ''"]
  ]
  ledgerAdd.forEach(function (pair) {
    if (ledgerCols.indexOf(pair[0]) < 0) d.exec(pair[1])
  })
  var recordCols = columns('records')
  var recordAdd = [
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
    ['phone', "ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''"]
  ]
  userAdd.forEach(function (pair) {
    if (userCols.indexOf(pair[0]) < 0) d.exec(pair[1])
  })
}

/* ---------------- 微信登录 ---------------- */

var accessTokenCache = { token: '', expiresAt: 0 }

/** 获取全局 access_token（缓存到过期前 3 分钟） */
async function getAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt) return accessTokenCache.token
  const appid = process.env.APPID || ''
  const secret = process.env.APPSECRET || ''
  if (!appid || !secret) return ''
  const url = 'https://api.weixin.qq.com/cgi-bin/token'
    + '?grant_type=client_credential'
    + '&appid=' + encodeURIComponent(appid)
    + '&secret=' + encodeURIComponent(secret)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(function () { ctrl.abort() }, 8000)
    const resp = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    const data = await resp.json()
    if (data.errcode || !data.access_token) {
      console.error('[jizhang-api] 取 access_token 失败:', data.errcode, data.errmsg)
      return ''
    }
    // 微信有效期 7200s，提前 3 分钟续
    accessTokenCache.token = data.access_token
    accessTokenCache.expiresAt = Date.now() + (Number(data.expires_in || 7000) - 180) * 1000
    return accessTokenCache.token
  } catch (e) {
    return ''
  }
}

/**
 * 用 getPhoneNumber 按钮回调的 code 换取真实手机号。
 * 返回 { phone } 或 { error }。
 * 注意：个人主体小程序通常无「手机号快速验证」权限，会拿到 errcode，此时走手动填写兜底。
 */
async function phoneFromCode(code) {
  if (process.env.MOCK_WX === '1') {
    // 本地/测试模式：不依赖微信接口，直接由 code 派生一个号码
    return { phone: '138' + String(code || '').replace(/\D/g, '').slice(0, 8) }
  }
  const token = await getAccessToken()
  if (!token) return { error: '服务端未配置 APPID/APPSECRET' }
  const url = 'https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=' + encodeURIComponent(token)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(function () { ctrl.abort() }, 8000)
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
      signal: ctrl.signal
    })
    clearTimeout(timer)
    const data = await resp.json()
    if (data.errcode) {
      // 40001 = secret 错误/无该权限；40013 = 无效 appid；86004 = 个人主体无权限
      return { error: '获取手机号失败(' + data.errcode + ')：' + (data.errmsg || ''), errcode: data.errcode }
    }
    const p = data.phone_info && (data.phone_info.purePhoneNumber || data.phone_info.phoneNumber) || ''
    if (!p) return { error: '微信未返回手机号' }
    return { phone: String(p) }
  } catch (e) {
    return { error: '微信服务网络异常，请稍后重试' }
  }
}

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
    return { openid: data.openid }
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

/** 完整用户资料（昵称/头像/手机号），无记录时返回空态 */
function userProfile(openid) {
  const row = db.prepare('SELECT openid, nickname, avatar, phone FROM users WHERE openid = ?').get(openid)
  return {
    id: openid,
    name: row ? (row.nickname || '') : '',
    avatar: row ? (row.avatar || '') : '',
    phone: row ? (row.phone || '') : ''
  }
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
    deleted: !!r.deleted,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function snapshot(openid, since) {
  const out = { ledgers: [], members: [], records: [], me: userProfile(openid) }
  const ledgers = db.prepare(
    'SELECT l.id, l.name, l.owner_openid, l.invite_code, l.created_at,'
    + ' l.accounts_json, l.budget_json, l.recurring_json, l.categories_json, l.challenges_json, l.cfg_at'
    + ' FROM ledgers l JOIN members m ON m.ledger_id = l.id'
    + ' WHERE m.openid = ? ORDER BY l.created_at'
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
    recRows = db.prepare(recBase + ' AND updated_at >= ? ORDER BY updated_at').all(...ids, since)
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
      categories: jsonColumn(l.categories_json, []),
      challenges: jsonColumn(l.challenges_json, []),
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
  const id = str(l.id, 64)
  if (!id) return
  const name = str(l.name, 20)
  const accountsJson = toJsonColumn(l.accounts, [], 200 * 1024)
  const budgetJson = toJsonColumn(l.budget, { monthlyTotal: 0, categoryBudgets: {} }, 64 * 1024)
  const recurringJson = toJsonColumn(l.recurring, [], 128 * 1024)
  const categoriesJson = toJsonColumn(l.categories, [], 128 * 1024)
  const challengesJson = toJsonColumn(l.challenges, [], 128 * 1024)
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
        '  categories_json = ?, challenges_json = ?, cfg_at = ? WHERE id = ?'
      ].join(' ')).run(accountsJson, budgetJson, recurringJson, categoriesJson, challengesJson, cfgAt, id)
    }
  } else {
    db.prepare([
      'INSERT INTO ledgers (id, name, owner_openid, invite_code, created_at,',
      '  accounts_json, budget_json, recurring_json, categories_json, challenges_json, cfg_at)',
      'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ].join(' '))
      .run(id, name || '共享账本', openid, genInviteCode(), isoOr(l.createdAt),
        accountsJson, budgetJson, recurringJson, categoriesJson, challengesJson, cfgAt || nowIso())
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
  const id = str(r.id, 64)
  const ledgerId = str(r.ledgerId, 64)
  if (!id || !ledgerId) return
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
  const existing = db.prepare('SELECT updated_at FROM records WHERE id = ?').get(id)
  if (existing && existing.updated_at >= updatedAt) return
  db.prepare([
    'INSERT INTO records (id, ledger_id, openid, member_name, type, amount, category, date, note, deleted, account_id, transfer_to, transfer_to_name, created_at, updated_at)',
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'ON CONFLICT(id) DO UPDATE SET',
    '  openid=excluded.openid, member_name=excluded.member_name, type=excluded.type,',
    '  amount=excluded.amount, category=excluded.category, date=excluded.date,',
    '  note=excluded.note, deleted=excluded.deleted, created_at=excluded.created_at,',
    '  account_id=excluded.account_id, transfer_to=excluded.transfer_to,',
    '  transfer_to_name=excluded.transfer_to_name,',
    '  updated_at=excluded.updated_at',
    'WHERE excluded.updated_at > records.updated_at'
  ].join('\n')).run(id, ledgerId, openid, memberName, type, amount, category, date, note, deleted, accountId, transferTo, transferToName, createdAt, updatedAt)
}

/* ---------------- 路由处理 ---------------- */

async function handleLogin(req, res) {
  const body = await readBody(req)
  const code = str(body.code, 64)
  if (code.length < 4) return sendJson(res, 400, { error: 'code 无效' })
  let openid
  if (process.env.MOCK_WX === '1') {
    openid = 'mock_' + code.slice(0, 40)
  } else {
    const r = await wxCode2Session(code)
    if (r.error) return sendJson(res, 401, { error: r.error })
    openid = r.openid
  }
  const nickname = str(body.nickname, 12)
  db.prepare([
    'INSERT INTO users (openid, nickname, created_at) VALUES (?,?,?)',
    'ON CONFLICT(openid) DO UPDATE SET nickname = CASE WHEN excluded.nickname != \'\' THEN excluded.nickname ELSE users.nickname END'
  ].join('\n')).run(openid, nickname, nowIso())
  const token = crypto.randomBytes(24).toString('hex')
  db.prepare('INSERT INTO sessions (token, openid, created_at) VALUES (?,?,?)').run(token, openid, nowIso())
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
  db.exec('BEGIN IMMEDIATE')
  try {
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
  const avatar = str(body.avatar, 512)
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

/** 绑定手机号：优先走微信 getPhoneNumber 的 code；失败时前端走手动填写 */
async function handlePhoneBind(req, res) {
  const openid = requireAuth(req, res)
  if (!openid) return
  const body = await readBody(req)
  db.prepare("INSERT OR IGNORE INTO users (openid, nickname, created_at) VALUES (?,?,?)")
    .run(openid, '', nowIso())
  const code = str(body.code, 128)
  const manual = str(body.phone, 20).replace(/[^\d+-]/g, '')
  if (code) {
    const r = await phoneFromCode(code)
    if (r.error) {
      // 个人主体无手机号权限时返回 ercode，前端据此切换成手动填写
      return sendJson(res, 400, { error: r.error, errcode: r.errcode || 0, needManual: true })
    }
    db.prepare('UPDATE users SET phone = ? WHERE openid = ?').run(r.phone, openid)
    return sendJson(res, 200, { ok: true, phone: r.phone })
  }
  if (!/^\d{7,20}$/.test(manual)) {
    return sendJson(res, 400, { error: '手机号格式不正确' })
  }
  db.prepare('UPDATE users SET phone = ? WHERE openid = ?').run(manual, openid)
  sendJson(res, 200, { ok: true, phone: manual })
}

const ROUTES = [
  ['POST', /^\/api\/login$/, handleLogin],
  ['GET', /^\/api\/sync$/, handleSyncGet],
  ['POST', /^\/api\/sync$/, handleSyncPost],
  ['POST', /^\/api\/ledgers\/join$/, handleJoin],
  ['POST', /^\/api\/ledgers\/invite$/, handleInviteRegen],
  ['POST', /^\/api\/user\/profile$/, handleProfileUpdate],
  ['POST', /^\/api\/user\/phone$/, handlePhoneBind],
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
