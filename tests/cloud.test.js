/**
 * 冒烟测试：内存版 wx storage mock 下，验证 db.js 的云端同步支撑能力
 * （脏数据、软删除墓碑、远端合并 LWW、身份迁移、退出账本不复活）。
 * 运行：node tests/cloud.test.js
 */

var assert = require('assert')
var path = require('path')

var ROOT = path.join(__dirname, '..')
var store = {}

global.wx = {
  getStorageSync: function (key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''
  },
  setStorageSync: function (key, value) {
    store[key] = value
  }
}

function freshDbModule() {
  var p = path.join(ROOT, 'utils/db.js')
  delete require.cache[require.resolve(p)]
  return require(p)
}

var passed = 0
var failed = 0

function test(name, fn) {
  try {
    for (var k in store) delete store[k]
    fn()
    passed++
    console.log('PASS  ' + name)
  } catch (e) {
    failed++
    console.log('FAIL  ' + name + '\n      ' + e.message)
  }
}

function remoteLedger(overrides) {
  var base = {
    id: 'L_remote',
    name: '家庭账本',
    ownerId: 'oid_owner',
    ownerName: '主人',
    createdAt: '2026-10-01T00:00:00.000Z',
    // 与服务端返回一致，固定配置版本，避免缺省时间取当前毫秒造成偶发失败。
    cfgAt: '2026-10-01T00:00:00.000Z',
    inviteCode: 'ABCD1234',
    members: [{ id: 'oid_owner', name: '主人', joinedAt: '2026-10-01T00:00:00.000Z' }]
  }
  for (var k in (overrides || {})) base[k] = overrides[k]
  return base
}

function remoteRecord(overrides) {
  var base = {
    id: 'R_remote',
    ledgerId: 'L_remote',
    memberId: 'oid_owner',
    memberName: '主人',
    type: 'expense',
    amount: 1200,
    category: 'food',
    date: '2026-10-02',
    note: '外卖',
    deleted: false,
    createdAt: '2026-10-02T01:00:00.000Z',
    updatedAt: '2026-10-02T01:00:00.000Z'
  }
  for (var k in (overrides || {})) base[k] = overrides[k]
  return base
}

/* ---------------- 脏数据与墓碑 ---------------- */

test('新增/修改记录标记脏数据，删除为墓碑，拉取可见', function () {
  var db = freshDbModule()
  db.init()
  var ledger = db.createLedger('测试账本')
  var rec = db.addRecord({ ledgerId: ledger.id, type: 'expense', amount: 990, category: 'food', date: '2026-10-05', note: '奶茶' })
  assert.ok(rec.dirty === true, '新增记录应标记脏数据')
  db.updateRecord(rec.id, { amount: 1500, type: 'expense', category: 'food', date: '2026-10-05', note: '奶茶加大杯' })
  var dirty = db.drainDirty()
  assert.strictEqual(dirty.length, 1, '应有 1 条待推送')
  assert.strictEqual(dirty[0].amount, 1500)
  assert.ok(dirty[0].updatedAt.indexOf('T') > 0, 'updatedAt 应为 ISO 字符串')

  db.clearDirty([rec.id])
  assert.strictEqual(db.drainDirty().length, 0, 'clearDirty 后无待推送')

  db.updateRecord(rec.id, { amount: 1500, type: 'expense', category: 'food', date: '2026-10-05', note: 'x' })
  assert.ok(db.deleteRecord(rec.id), '应返回删除成功')
  assert.strictEqual(db.recordsOf(ledger.id).length, 0, '软删除后列表不可见')
  var tomb = db.drainDirty()
  assert.strictEqual(tomb.length, 1)
  assert.strictEqual(tomb[0].deleted, true, '推送体应带墓碑标记')
  assert.ok(db.deleteRecord(rec.id) === false, '重复删除应返回 false')
})

test('drainDirty 不清理标记，推送失败可重试', function () {
  var db = freshDbModule()
  db.init()
  var ledger = db.currentLedger()
  db.addRecord({ ledgerId: ledger.id, type: 'income', amount: 100, category: 'salary', date: '2026-10-01', note: '' })
  assert.strictEqual(db.drainDirty().length, 1)
  assert.strictEqual(db.drainDirty().length, 1, 'drain 不应清理标记')
})

/* ---------------- 远端合并 ---------------- */

test('合并远端账本：新建、成员补名、邀请码回填、不抢占当前账本', function () {
  var db = freshDbModule()
  db.init()
  var localFirst = db.currentLedger().id
  assert.strictEqual(db.applyRemoteLedger(remoteLedger()), true)
  var l = db.getLedger('L_remote')
  assert.ok(l && l.name === '家庭账本' && l.inviteCode === 'ABCD1234', '账本应合并')
  assert.strictEqual(l.members['oid_owner'].name, '主人')
  assert.strictEqual(db.currentLedger().id, localFirst, '已有当前账本时不应被远端抢占')
  assert.strictEqual(db.applyRemoteLedger(remoteLedger()), false, '无变化的合并应返回 false')
  assert.strictEqual(db.applyRemoteLedger(remoteLedger({ name: '新名字' })), true)
  assert.strictEqual(db.getLedger('L_remote').name, '新名字')
})

test('合并远端记录：新增、LWW 覆盖、脏数据保护', function () {
  var db = freshDbModule()
  db.init()
  db.applyRemoteLedger(remoteLedger())
  assert.strictEqual(db.applyRemoteRecord(remoteRecord()), true)
  var r = db.getRecord('R_remote')
  assert.strictEqual(r.amount, 1200)
  assert.strictEqual(db.recordsOf('L_remote').length, 1)

  var older = remoteRecord({ amount: 1, note: '旧', updatedAt: '2026-10-01T00:00:00.000Z' })
  assert.strictEqual(db.applyRemoteRecord(older), false, '更旧的远端写入应被忽略')
  assert.strictEqual(db.getRecord('R_remote').amount, 1200, '金额不应被旧数据覆盖')

  var newer = remoteRecord({ amount: 2400, note: '新', updatedAt: '2026-10-03T00:00:00.000Z' })
  assert.strictEqual(db.applyRemoteRecord(newer), true)
  assert.strictEqual(db.getRecord('R_remote').amount, 2400)

  // 本地有未推送的更新时，远端旧写入不生效
  db.applyRemoteRecord(remoteRecord({ amount: 2400, note: '新', updatedAt: '2026-10-03T00:00:00.000Z' }))
  var local = db.getRecord('R_remote')
  local.dirty = true
  local.updatedAt = '2026-10-04T00:00:00.000Z'
  local.note = '本地改的'
  assert.strictEqual(db.applyRemoteRecord(remoteRecord({ note: '远端改的', amount: 2400, updatedAt: '2026-10-02T12:00:00.000Z' })), false)
  assert.strictEqual(local.note, '本地改的', '本地未推送数据应受保护')

  // 远端墓碑传播
  assert.strictEqual(db.applyRemoteRecord(remoteRecord({ deleted: true, updatedAt: '2026-10-05T00:00:00.000Z' })), true)
  assert.strictEqual(db.recordsOf('L_remote').length, 0, '远端删除后本地不可见')
})

test('非法远端数据被拒绝', function () {
  var db = freshDbModule()
  db.init()
  db.applyRemoteLedger(remoteLedger())
  assert.strictEqual(db.applyRemoteRecord(remoteRecord({ amount: -5 })), false)
  assert.strictEqual(db.applyRemoteRecord(remoteRecord({ date: '10月2日' })), false)
  assert.strictEqual(db.applyRemoteRecord(remoteRecord({ id: '' })), false)
  assert.strictEqual(db.applyRemoteRecord(remoteRecord({ ledgerId: 'L_不存在' })), true, '合并层不校验成员关系（服务端已校验）')
  // transfer 现在是合法类型；字段校验在服务端推送侧（换新 id，避免被前几条用例的 LWW 挡住）
  assert.strictEqual(db.applyRemoteRecord(remoteRecord({ id: 'R_tr', type: 'transfer', accountId: 'acc_wechat', transferTo: 'acc_bank', updatedAt: '2026-10-18T00:00:02.000Z' })), true)
})

/* ---------------- 身份迁移与退出 ---------------- */

test('replaceMyId：成员键、归属记录、ownerId 一起迁移', function () {
  var db = freshDbModule()
  db.init()
  var ledger = db.currentLedger()
  var oldId = db.getMe().id
  db.addRecord({ ledgerId: ledger.id, type: 'expense', amount: 100, category: 'food', date: '2026-10-01', note: 'a' })
  db.replaceMyId('oid_me')
  assert.strictEqual(db.getMe().id, 'oid_me')
  assert.ok(db.currentLedger().members['oid_me'], '成员表应换键')
  assert.ok(!db.currentLedger().members[oldId], '旧键应移除')
  assert.strictEqual(db.currentLedger().ownerId, 'oid_me', 'ownerId 应迁移')
  var recs = db.drainDirty()
  assert.strictEqual(recs[0].memberId, 'oid_me')
})

test('退出账本后，远端快照不会再把它拉回', function () {
  var db = freshDbModule()
  db.init()
  db.applyRemoteLedger(remoteLedger())
  assert.ok(db.getLedger('L_remote'))
  db.deleteLedger('L_remote')
  assert.strictEqual(db.getLedger('L_remote'), null)
  assert.strictEqual(db.applyRemoteLedger(remoteLedger()), false, '已退出的账本不应复活')
  var exported = db.exportLedgersForSync()
  assert.ok(!exported.some(function (l) { return l.id === 'L_remote' }), '退出账本不应再推送')
})

test('exportLedgersForSync：结构、ISO 时间戳、成员明细', function () {
  var db = freshDbModule()
  db.init()
  db.setMyName('我')
  var exported = db.exportLedgersForSync()
  assert.strictEqual(exported.length, 1)
  var l = exported[0]
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(l.createdAt), 'createdAt 应为 ISO')
  assert.ok(Array.isArray(l.members) && l.members.length === 1)
  assert.strictEqual(l.members[0].id, db.getMe().id)
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(l.members[0].joinedAt))
})

test('onChange 订阅与退订', function () {
  var db = freshDbModule()
  db.init()
  var hits = 0
  var off = db.onChange(function () { hits++ })
  db.setMyName(' triggers change')
  assert.ok(hits >= 1, '订阅应收到变更')
  off()
  var before = hits
  db.setMyName('no more')
  assert.strictEqual(hits, before, '退订后不应再收到')
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
