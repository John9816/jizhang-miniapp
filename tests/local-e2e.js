/**
 * 本地端到端测试：完整模拟「开发者工具（设备A）+ 第二台设备（设备B）」的全过程。
 * 前置：本地后端已启动（MOCK_WX=1，http://127.0.0.1:3123，见 README 本地测试章节）。
 * 用法：node tests/local-e2e.js
 */
'use strict'

var BASE = process.env.JZ_LOCAL_BASE || 'http://127.0.0.1:3123'
var passed = 0
var failed = 0

function api(method, path, body, token) {
  return fetch(BASE + path, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j } }) })
}

function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok - ' + msg) }
  else { failed++; console.log('  FAIL - ' + msg) }
}

function iso() { return new Date().toISOString() }
var LEDGER = 'L-local-' + Date.now()
var REC1 = 'R-local-a1-' + Date.now()
var REC2 = 'R-local-a2-' + Date.now()
var REC_FRIEND = 'R-local-b1-' + Date.now()
var REC_SECRET = 'R-local-secret-' + Date.now()

console.log('本地 E2E：设备A（开发者工具） + 设备B（tests/local-second-device.js 同逻辑）\n')

// ---- 阶段 1：设备A 登录并建账本（等价于开发者工具首次登录 + 自动建账）----
console.log('[1/7] 设备A 登录')
var A = null
api('POST', '/api/login', { code: 'local-devA', nickname: '我' }).then(function (r) {
  ok(r.json.token && r.json.me, 'A 登录拿到 token 与身份')
  A = r.json
  return api('POST', '/api/sync', {
    since: '',
    ledgers: [{
      id: LEDGER, name: '本地测试账本', createdAt: iso(),
      ownerId: A.me.id, ownerName: A.me.name,
      members: [{ id: A.me.id, name: A.me.name, joinedAt: iso() }]
    }],
    records: [
      { id: REC1, ledgerId: LEDGER, memberId: A.me.id, memberName: A.me.name, type: 'expense', amount: 3200, category: '餐饮', date: '2026-10-18', note: '午餐', createdAt: iso(), updatedAt: iso(), deleted: 0 },
      { id: REC2, ledgerId: LEDGER, memberId: A.me.id, memberName: A.me.name, type: 'income', amount: 100000, category: '工资', date: '2026-10-18', note: '10月工资', createdAt: iso(), updatedAt: iso(), deleted: 0 }
    ]
  }, A.token)
}).then(function (r) {
  ok(r.json.ok, 'A 推送账本 + 2 条记录成功')
  var l = (r.json.ledgers || []).filter(function (x) { return x.id === LEDGER })[0]
  ok(l && l.inviteCode, '服务端为账本生成邀请码：' + (l && l.inviteCode))
  var recs = (r.json.records || []).filter(function (x) { return x.ledgerId === LEDGER })
  ok(recs.length === 2, '快照里 A 看到自己的 2 条记录')

  // ---- 阶段 2：设备B 凭邀请码加入 ----
  console.log('\n[2/7] 设备B 凭邀请码加入')
  return api('POST', '/api/login', { code: 'local-devB', nickname: '测试好友' }).then(function (rb) {
    ok(rb.json.token, 'B 登录成功')
      return api('POST', '/api/ledgers/join', { inviteCode: l.inviteCode, nickname: '测试好友' }, rb.json.token).then(function (rj) {
      ok(rj.json.ok, 'B 凭邀请码加入账本')
      var members = (rj.json.members || []).filter(function (m) { return m.ledgerId === LEDGER })
      ok(members.length === 2 && members.some(function (m) { return m.name === '测试好友' }), 'B 的账本成员有 2 人（含刚加入的自己）')
      var recsB = (rj.json.records || []).filter(function (x) { return x.ledgerId === LEDGER })
      ok(recsB.length === 2, 'B 立刻看到 A 的 2 条历史记录')
      return rb.json
    })
  })
}).then(function (B) {
  // ---- 阶段 3：B 回记一笔，A 拉增量 ----
  console.log('\n[3/7] B 记账 → A 拉取')
  var t3 = iso()
  return api('POST', '/api/sync', {
    since: '',
    ledgers: [],
    records: [{ id: REC_FRIEND, ledgerId: LEDGER, memberId: B.me.id, memberName: '测试好友', type: 'expense', amount: 8850, category: '餐饮', date: '2026-10-18', note: '朋友用模拟设备记的', createdAt: iso(), updatedAt: iso(), deleted: 0 }]
  }, B.token).then(function () {
    return api('GET', '/api/sync?since=' + t3, null, A.token).then(function (r) {
      if (process.env.JZ_DEBUG) console.log('    [debug] since=' + t3 + ' status=' + r.status + ' records=' + JSON.stringify((r.json.records || []).map(function (x) { return { id: x.id, ledgerId: x.ledgerId, updatedAt: x.updatedAt } })))
      var recs = (r.json.records || []).filter(function (x) { return x.ledgerId === LEDGER })
      ok(recs.some(function (x) { return x.id === REC_FRIEND }), 'A 拉到了 B 的新记录（增量同步）')
    })
  })
}).then(function () {
  // ---- 阶段 4：删除墓碑传播 ----
  console.log('\n[4/7] A 删除一条 → B 看到墓碑')
  var t4 = iso()
  return api('POST', '/api/sync', {
    since: '', ledgers: [],
    records: [{ id: REC1, ledgerId: LEDGER, memberId: A.me.id, memberName: A.me.name, type: 'expense', amount: 3200, category: '餐饮', date: '2026-10-18', note: '午餐', createdAt: iso(), updatedAt: iso(), deleted: 1 }]
  }, A.token).then(function () {
    return api('POST', '/api/login', { code: 'local-devB', nickname: '测试好友' }).then(function (rb) {
      return api('GET', '/api/sync?since=' + t4, null, rb.json.token).then(function (r) {
        if (process.env.JZ_DEBUG) console.log('    [debug] since=' + t4 + ' status=' + r.status + ' records=' + JSON.stringify((r.json.records || []).map(function (x) { return { id: x.id, ledgerId: x.ledgerId, updatedAt: x.updatedAt, deleted: x.deleted } })))
        var rec = (r.json.records || []).filter(function (x) { return x.id === REC1 })[0]
        ok(rec && rec.deleted === true, 'B 看到 REC1 已标记删除（墓碑传播）')
      })
    })
  })
}).then(function () {
  // ---- 阶段 5：越权拦截（非成员不能往别人账本写）----
  console.log('\n[5/7] 非成员越权写入应被丢弃')
  var SECRET_LEDGER = 'L-local-secret-' + Date.now()
  return api('POST', '/api/sync', {
    since: '',
    ledgers: [{ id: SECRET_LEDGER, name: 'A 的私密账本', createdAt: iso(), ownerId: A.me.id, ownerName: A.me.name, members: [{ id: A.me.id, name: A.me.name, joinedAt: iso() }] }],
    records: []
  }, A.token).then(function () {
    return api('POST', '/api/login', { code: 'local-devB', nickname: '测试好友' }).then(function (rb) {
      return api('POST', '/api/sync', {
        since: '', ledgers: [],
        records: [{ id: REC_SECRET, ledgerId: SECRET_LEDGER, memberId: rb.json.me.id, memberName: '测试好友', type: 'expense', amount: 1, category: '其他', date: '2026-10-18', note: '越权写入', createdAt: iso(), updatedAt: iso(), deleted: 0 }]
      }, rb.json.token).then(function () {
        return api('GET', '/api/sync?since=', null, A.token).then(function (r) {
          var recs = (r.json.records || []).filter(function (x) { return x.ledgerId === SECRET_LEDGER })
          ok(recs.length === 0, 'B 的越权记录未被写入 A 的私密账本')
        })
      })
    })
  })
}).then(function () {
  // ---- 阶段 6：鉴权 ----
  console.log('\n[6/7] 无 token 访问')
  return api('GET', '/api/sync?since=').then(function (r) {
    ok(r.status === 401, '无 token 的 sync 返回 401')
  })
}).then(function () {
  // ---- 阶段 7：数据库落盘 ----
  console.log('\n[7/7] 数据落盘校验')
  var fs = require('fs')
  var path = require('path')
  var sqlite = require('node:sqlite')
  var dbFile = path.join(__dirname, '..', 'server', 'data', 'jizhang.db')
  ok(fs.existsSync(dbFile), '数据库文件存在：' + dbFile)
  var d = new sqlite.DatabaseSync(dbFile)
  var n = d.prepare('SELECT COUNT(*) c FROM records').get().c
  ok(n >= 3, '库里已有 ' + n + ' 条记录（删掉的墓碑也在，会上报给各端）')
  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
  process.exit(failed ? 1 : 0)
}).catch(function (e) {
  console.error('\n运行中断: ' + e.stack)
  process.exit(1)
})
