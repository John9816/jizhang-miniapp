/**
 * 后端端到端冒烟测试：MOCK_WX 模式下以真实进程启动 server/server.js，
 * 用 fetch 打接口。覆盖登录、建账本、双设备同步合并、软删除墓碑、
 * 邀请码加入、LWW 冲突、越权推送、鉴权。
 */
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NODE = process.execPath
const PORT = 31337
const BASE = 'http://127.0.0.1:' + PORT
const SERVER = path.join(__dirname, '..', 'server', 'server.js')

let child = null
let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    passed++
    console.log('  ok - ' + name)
  }, function (e) {
    failed++
    console.error('  FAIL - ' + name + ': ' + (e && e.message))
  })
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

async function api(method, urlPath, body, token) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = 'Bearer ' + token
  const resp = await fetch(BASE + urlPath, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: resp.status, data: await resp.json() }
}

function iso(offsetMs) {
  return new Date(Date.now() + (offsetMs || 0)).toISOString()
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jizhang-test-'))
  const dbFile = path.join(tmpDir, 'test.db')

  child = spawn(NODE, [SERVER], {
    env: Object.assign({}, process.env, {
      MOCK_WX: '1',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_FILE: dbFile
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', function (d) { stderr += d })

  const deadline = Date.now() + 10000
  let up = false
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/healthz')
      if (r.ok) { up = true; break }
    } catch (e) { /* 还没起来 */ }
    await new Promise(function (r) { setTimeout(r, 150) })
  }
  if (!up) {
    console.error('服务未能在 10s 内启动，stderr:\n' + stderr)
    child.kill()
    process.exit(1)
  }

  console.log('server.test：真实后端进程（HTTP / MOCK_WX）')

  let tokenA = ''
  let tokenB = ''
  let tokenC = ''
  let openidA = ''
  let openidB = ''
  let openidC = ''
  let inviteCode = ''
  const ledgerId = 'L_home'
  const rec1Id = 'R_1'
  const rec2Id = 'R_2'
  const rec3Id = 'R_3'

  await test('设备 A / B / C 登录（mock code2session）', async function () {
    const a = await api('POST', '/api/login', { code: 'code-a', nickname: '小明' })
    const b = await api('POST', '/api/login', { code: 'code-b', nickname: '小红' })
    const c = await api('POST', '/api/login', { code: 'code-c', nickname: '老王' })
    assert(a.data.ok && b.data.ok && c.data.ok, '登录失败')
    tokenA = a.data.token
    tokenB = b.data.token
    tokenC = c.data.token
    openidA = a.data.me.id
    openidB = b.data.me.id
    openidC = c.data.me.id
    assert(openidA === 'mock_code-a' && openidB === 'mock_code-b', 'openid 映射错误')
    assert(a.data.me.name === '小明', '昵称未保存')
  })

  await test('A 创建账本并推送 2 条记录', async function () {
    const r = await api('POST', '/api/sync', {
      since: '',
      ledgers: [{
        id: ledgerId,
        name: '家庭账本',
        createdAt: iso(-86400000),
        ownerId: openidA,
        ownerName: '小明',
        members: [{ id: openidA, name: '小明', joinedAt: iso(-86400000) }]
      }],
      records: [
        { id: rec1Id, ledgerId: ledgerId, memberId: openidA, memberName: '小明', type: 'expense', amount: 3500, category: 'food', date: '2026-10-01', note: '午饭', deleted: false, createdAt: iso(-3600000), updatedAt: iso(-3600000) },
        { id: rec2Id, ledgerId: ledgerId, memberId: openidA, memberName: '小明', type: 'income', amount: 1200000, category: 'salary', date: '2026-10-02', note: '十月工资', deleted: false, createdAt: iso(-1800000), updatedAt: iso(-1800000) }
      ]
    }, tokenA)
    assert(r.data.ok, '同步失败: ' + JSON.stringify(r.data))
    assert(r.data.ledgers.length === 1 && r.data.ledgers[0].id === ledgerId, '账本未落库')
    assert(r.data.records.length === 2, '记录未落库，实际 ' + r.data.records.length)
    assert(!!r.data.ledgers[0].inviteCode && r.data.ledgers[0].inviteCode.length === 8, '邀请码未生成')
    inviteCode = r.data.ledgers[0].inviteCode
  })

  await test('增量拉取：since 晚于全部数据时为空', async function () {
    const none = await api('GET', '/api/sync?since=' + encodeURIComponent(iso(60000)), null, tokenA)
    assert(none.data.ok && none.data.records.length === 0, 'since 过滤失效')
    const all = await api('GET', '/api/sync?since=', null, tokenA)
    assert(all.data.records.length === 2, '全量拉取数量错误')
  })

  await test('B 凭邀请码加入账本（含历史记录）', async function () {
    const r = await api('POST', '/api/ledgers/join', { inviteCode: inviteCode, nickname: '小红' }, tokenB)
    assert(r.data.ok && r.data.ledgerId === ledgerId, '加入失败')
    assert(r.data.members.some(function (m) { return m.id === openidA && m.name === '小明' }), '成员快照缺 A')
    assert(r.data.records.length === 2, 'B 应看到 2 条历史记录，实际 ' + r.data.records.length)
    const again = await api('POST', '/api/ledgers/join', { inviteCode: inviteCode, nickname: '小红' }, tokenB)
    assert(again.data.ok, '重复加入应幂等')
    const bad = await api('POST', '/api/ledgers/join', { inviteCode: 'ZZZZZZZZ' }, tokenB)
    assert(bad.status === 404, '错误邀请码应 404')
  })

  await test('B 记 1 条，A 拉取能看到（双向同步）', async function () {
    const up = await api('POST', '/api/sync', {
      since: '',
      records: [{ id: rec3Id, ledgerId: ledgerId, memberId: openidB, memberName: '小红', type: 'expense', amount: 5800, category: 'transport', date: '2026-10-03', note: '打车', deleted: false, createdAt: iso(-600000), updatedAt: iso(-600000) }]
    }, tokenB)
    assert(up.data.ok, 'B 推送失败')
    const pull = await api('GET', '/api/sync?since=', null, tokenA)
    assert(pull.data.records.some(function (r) { return r.id === rec3Id }), 'A 未收到 B 的记录')
    assert(pull.data.members.some(function (m) { return m.id === openidB }), 'A 未同步到新成员')
  })

  await test('A 删除 R_2，墓碑传播到 B', async function () {
    const up = await api('POST', '/api/sync', {
      since: '',
      records: [{ id: rec2Id, ledgerId: ledgerId, memberId: openidA, memberName: '小明', type: 'income', amount: 1200000, category: 'salary', date: '2026-10-02', note: '十月工资', deleted: true, createdAt: iso(-1800000), updatedAt: iso(1000) }]
    }, tokenA)
    assert(up.data.ok, '删除推送失败')
    const pull = await api('GET', '/api/sync?since=', null, tokenB)
    const r2 = pull.data.records.find(function (r) { return r.id === rec2Id })
    assert(r2 && r2.deleted === true, 'B 未收到删除墓碑')
    assert(pull.data.records.length === 3, '墓碑记录应仍在快照中，实际 ' + pull.data.records.length)
  })

  await test('LWW：A 用旧 updatedAt 更新 R_3 应被忽略', async function () {
    const stale = iso(-7200000)
    const up = await api('POST', '/api/sync', {
      since: '',
      records: [{ id: rec3Id, ledgerId: ledgerId, memberId: openidA, memberName: '小明', type: 'expense', amount: 1, category: 'food', date: '2026-10-01', note: '旧数据', deleted: false, createdAt: stale, updatedAt: stale }]
    }, tokenA)
    assert(up.data.ok, '旧数据推送失败')
    const r3 = up.data.records.find(function (r) { return r.id === rec3Id })
    assert(r3.amount === 5800 && r3.note === '打车', '旧写入覆盖了新数据: ' + JSON.stringify(r3))
  })

  await test('越权：C 向他人账本推送记录应被忽略', async function () {
    const up = await api('POST', '/api/sync', {
      since: '',
      records: [{ id: 'R_hack', ledgerId: ledgerId, memberId: openidC, memberName: '老王', type: 'expense', amount: 999, category: 'food', date: '2026-10-03', note: 'hack', deleted: false, createdAt: iso(-1000), updatedAt: iso(-1000) }]
    }, tokenC)
    assert(up.data.ok, '同步接口应正常返回')
    const pull = await api('GET', '/api/sync?since=', null, tokenA)
    assert(!pull.data.records.some(function (r) { return r.id === 'R_hack' }), '越权记录落库了')
  })

  await test('未带 token 的请求应 401', async function () {
    const r = await api('GET', '/api/sync?since=')
    assert(r.status === 401, '应返回 401，实际 ' + r.status)
  })

  /* ---------- 账本级新模型同步 ---------- */

  await test('推送账本级配置（账户/预算/周期/分类）→ 快照返回', async function () {
    const cfgNow = iso(5000)
    const up = await api('POST', '/api/sync', {
      since: '',
      ledgers: [{
        id: ledgerId,
        name: '家庭账本',
        createdAt: iso(-86400000),
        ownerId: openidA,
        ownerName: '小明',
        members: [{ id: openidA, name: '小明', joinedAt: iso(-86400000) }],
        accounts: [{ id: 'acc_wechat', name: '微信钱包', type: 'wechat', initialBalance: 520000, sortIndex: 1 }],
        budget: { monthlyTotal: 300000, categoryBudgets: { food: 100000 } },
        recurring: [{ id: 'rr1', name: '房租', amount: 250000, cycle: 'monthly', nextDate: '2026-11-01' }],
        categories: [{ key: 'c1', name: '干饭', icon: '🍚', type: 'expense' }],
        cfgAt: cfgNow
      }]
    }, tokenA)
    assert(up.data.ok, '配置推送失败')
    const l = up.data.ledgers.find(function (x) { return x.id === ledgerId })
    assert(l && l.accounts.length === 1 && l.accounts[0].name === '微信钱包', '账户未同步')
    assert(l.budget && l.budget.monthlyTotal === 300000, '预算未同步')
    assert(l.recurring.length === 1 && l.recurring[0].name === '房租', '周期未同步')
    assert(l.categories.length === 1 && l.categories[0].name === '干饭', '分类未同步')
    assert(l.cfgAt === cfgNow, 'cfgAt 未同步')
    const pull = await api('GET', '/api/sync?since=', null, tokenB)
    const lb = pull.data.ledgers.find(function (x) { return x.id === ledgerId })
    assert(lb && lb.accounts[0].initialBalance === 520000, 'B 拉不到账户配置')
  })

  await test('cfgAt LWW：旧配置推送不得覆盖新配置', async function () {
    const up = await api('POST', '/api/sync', {
      since: '',
      ledgers: [{
        id: ledgerId, name: '家庭账本', createdAt: iso(-86400000), ownerId: openidA, ownerName: '小明',
        members: [{ id: openidA, name: '小明', joinedAt: iso(-86400000) }],
        accounts: [{ id: 'acc_x', name: '旧账户', type: 'other', initialBalance: 1 }],
        budget: { monthlyTotal: 1, categoryBudgets: {} },
        cfgAt: '2020-01-01T00:00:00.000Z'
      }]
    }, tokenA)
    assert(up.data.ok, '旧配置推送失败')
    const l = up.data.ledgers.find(function (x) { return x.id === ledgerId })
    assert(l.accounts[0].name === '微信钱包', '旧配置覆盖了新配置')
    assert(l.budget.monthlyTotal === 300000, '旧预算覆盖了新预算')
  })

  await test('transfer 记录：推送 / 拉取 / 缺字段拒绝', async function () {
    const ok = await api('POST', '/api/sync', {
      since: '',
      records: [{ id: 'R_tr1', ledgerId: ledgerId, memberId: openidA, memberName: '小明', type: 'transfer', amount: 5000, category: 'transfer', accountId: 'acc_wechat', transferTo: 'acc_bank', transferToName: '储蓄卡', date: '2026-10-10', note: '提现', deleted: false, createdAt: iso(-1000), updatedAt: iso(-1000) }]
    }, tokenA)
    assert(ok.data.ok, '转账推送失败')
    const pull = await api('GET', '/api/sync?since=', null, tokenB)
    const tr = pull.data.records.find(function (r) { return r.id === 'R_tr1' })
    assert(tr && tr.type === 'transfer' && tr.accountId === 'acc_wechat' && tr.transferTo === 'acc_bank', '转账字段未同步')
    const bad = await api('POST', '/api/sync', {
      since: '',
      records: [{ id: 'R_tr2', ledgerId: ledgerId, memberId: openidA, memberName: '小明', type: 'transfer', amount: 100, category: 'transfer', accountId: 'acc_wechat', date: '2026-10-11', note: '缺目标', deleted: false, createdAt: iso(-1000), updatedAt: iso(-1000) }]
    }, tokenA)
    assert(bad.data.ok, '接口应正常返回')
    const pull2 = await api('GET', '/api/sync?since=', null, tokenA)
    assert(!pull2.data.records.some(function (r) { return r.id === 'R_tr2' }), '缺 transferTo 的转账不应落库')
    const sameAcc = await api('POST', '/api/sync', {
      since: '',
      records: [{ id: 'R_tr3', ledgerId: ledgerId, memberId: openidA, memberName: '小明', type: 'transfer', amount: 100, category: 'transfer', accountId: 'acc_a', transferTo: 'acc_a', date: '2026-10-11', deleted: false, createdAt: iso(-1000), updatedAt: iso(-1000) }]
    }, tokenA)
    assert(sameAcc.data.ok, '接口应正常返回')
    const pull3 = await api('GET', '/api/sync?since=', null, tokenA)
    assert(!pull3.data.records.some(function (r) { return r.id === 'R_tr3' }), '同账户自转账不应落库')
  })

  await test('老库自动迁移：旧 schema 启动后新列就位', async function () {
    // 构造一个没有新列的旧库
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jizhang-legacy-'))
    const legacyDb = path.join(legacyDir, 'legacy.db')
    const sqlite = require('node:sqlite')
    const ld = new sqlite.DatabaseSync(legacyDb)
    ld.exec([
      'CREATE TABLE users (openid TEXT PRIMARY KEY, nickname TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL);',
      'CREATE TABLE sessions (token TEXT PRIMARY KEY, openid TEXT NOT NULL, created_at TEXT NOT NULL);',
      'CREATE TABLE ledgers (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_openid TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);',
      'CREATE TABLE members (ledger_id TEXT NOT NULL, openid TEXT NOT NULL, nickname TEXT NOT NULL DEFAULT \'\', joined_at TEXT NOT NULL, PRIMARY KEY (ledger_id, openid));',
      'CREATE TABLE records (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, openid TEXT NOT NULL, member_name TEXT NOT NULL DEFAULT \'\', type TEXT NOT NULL, amount INTEGER NOT NULL, category TEXT NOT NULL DEFAULT \'\', date TEXT NOT NULL DEFAULT \'\', note TEXT NOT NULL DEFAULT \'\', deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);'
    ].join('\n'))
    const now = new Date().toISOString()
    ld.prepare('INSERT INTO users (openid, nickname, created_at) VALUES (?,?,?)').run('mock_legacy-user', '老用户', now)
    ld.prepare('INSERT INTO ledgers (id, name, owner_openid, invite_code, created_at) VALUES (?,?,?,?,?)').run('L_legacy', '旧账本', 'mock_legacy-user', 'LEG00001', now)
    ld.prepare('INSERT INTO members (ledger_id, openid, nickname, joined_at) VALUES (?,?,?,?)').run('L_legacy', 'mock_legacy-user', '老用户', now)
    ld.prepare('INSERT INTO records (id, ledger_id, openid, member_name, type, amount, category, date, note, deleted, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('R_legacy', 'L_legacy', 'mock_legacy-user', '老用户', 'expense', 3200, 'food', '2026-10-01', '老记录', 0, now, now)
    ld.close()
    const srv = spawn(NODE, [SERVER], {
      env: Object.assign({}, process.env, { MOCK_WX: '1', PORT: '31399', HOST: '127.0.0.1', DATA_FILE: legacyDb }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let legacyStderr = ''
    srv.stderr.on('data', function (d) { legacyStderr += d })
    let legacyUp = false
    const dl = Date.now() + 8000
    while (Date.now() < dl) {
      try {
        const r = await fetch('http://127.0.0.1:31399/healthz')
        if (r.ok) { legacyUp = true; break }
      } catch (e) { /* 未起来 */ }
      await new Promise(function (r) { setTimeout(r, 150) })
    }
    assert(legacyUp, '迁移后服务未启动: ' + legacyStderr)
    // 登录走迁移实例的 31399 端口
    const lr = await fetch('http://127.0.0.1:31399/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'legacy-user', nickname: '老用户' }) })
    const lj = await lr.json()
    assert(lj.ok && lj.token, '迁移后登录失败')
    const sync = await fetch('http://127.0.0.1:31399/api/sync?since=', { headers: { Authorization: 'Bearer ' + lj.token } })
    const sj = await sync.json()
    const lrec = sj.records.find(function (r) { return r.id === 'R_legacy' })
    assert(lrec && lrec.amount === 3200, '老记录读不到')
    assert('accountId' in lrec, '新列未迁移到记录')
    const lledger = sj.ledgers.find(function (x) { return x.id === 'L_legacy' })
    assert(lledger && Array.isArray(lledger.accounts) && lledger.budget, '新列未迁移到账本')
    srv.kill()
    fs.rmSync(legacyDir, { recursive: true, force: true })
  })

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  child.kill()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error(e)
  if (child) child.kill()
  process.exit(1)
})
