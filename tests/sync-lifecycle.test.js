/* 真实 db/cloud 模块，只有微信存储和 HTTP 边界使用内存替身。 */
var assert = require('assert')
var fs = require('fs')
var path = require('path')
var vm = require('vm')
var root = path.join(__dirname, '..')
var failed = 0
function device(store, snapshots) {
  store = store || {}
  var requests = []
  var timers = new Set()
  var wx = {
    getStorageSync: function (k) { return store[k] || '' },
    setStorageSync: function (k, v) { store[k] = v },
    login: function (o) { o.success({ code: 'test' }) },
    request: function (o) {
      requests.push(o)
      var snapshot = snapshots.shift()
      if (!snapshot) throw Error('缺少 HTTP 响应: ' + o.url)
      if (typeof snapshot === 'function') snapshot = snapshot(o)
      o.success({ statusCode: snapshot.status || 200, data: snapshot })
    }
  }
  var db, cloud
  function load(file) {
    var ctx = { module: { exports: {} }, wx: wx, console: console,
      setTimeout: function () { var id = {}; timers.add(id); return id },
      clearTimeout: function (id) { timers.delete(id) },
      require: function (name) {
        if (name === './db.js') return db
        if (name === './cloud.js') return cloud || { kick: function () {} }
        if (name === '../config.js') return { cloud: { enabled: true, apiBase: 'http://test' } }
        return require(path.resolve(root, 'utils', name))
      }
    }
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file })
    return ctx.module.exports
  }
  db = load('utils/db.js')
  cloud = load('utils/cloud.js')
  db.init()
  return { db: db, cloud: cloud, store: store, requests: requests, timers: timers }
}
function ledger(id) {
  return { id: id, name: '家庭账本', ownerId: 'me', createdAt: '2026-10-01T00:00:00.000Z',
    cfgAt: '2026-10-01T00:00:00.000Z', members: [{ id: 'me', name: '我' }] }
}
function snap(ledgers, removed) {
  return { ok: true, token: 't', me: { id: 'me', name: '我' }, ledgers: ledgers || [],
    removedLedgerIds: removed || [], members: [], records: [], serverTime: '2026-10-24T00:00:00.000Z' }
}
async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name) }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message) }
}
async function main() {
  await test('同步途中编辑保留待发送状态，下次确认后重启不再重复发送', async function () {
    var responses = [snap([ledger('L_home')]), snap([ledger('L_home')])]
    var d = device({}, responses)
    await d.cloud.sync()
    var r = d.db.addRecord({ ledgerId: 'L_home', type: 'expense', amount: 100, category: 'food', date: '2026-10-24', note: '原备注' })
    responses.push(function (request) {
      assert.strictEqual(request.data.records[0].note, '原备注')
      d.db.updateRecord(r.id, { type: 'expense', amount: 200, category: 'food', date: r.date, note: '同步中修改' })
      var response = snap([ledger('L_home')])
      response.records = request.data.records
      return response
    })
    await d.cloud.sync()
    assert.strictEqual(d.db.getRecord(r.id).note, '同步中修改')
    assert.strictEqual(d.db.drainDirty().length, 1)
    responses.push(function (request) {
      assert.strictEqual(request.data.records[0].amount, 200)
      var response = snap([ledger('L_home')])
      response.records = request.data.records
      return response
    })
    await d.cloud.sync()
    var cold = device(d.store, [])
    assert.strictEqual(cold.db.getRecord(r.id).note, '同步中修改')
    assert.strictEqual(cold.db.drainDirty().length, 0)
  })
  await test('新设备登录先恢复云端账本，不把自动生成的空账本推上去', async function () {
    var d = device({}, [snap([ledger('L_home')]), snap([ledger('L_home')])])
    await d.cloud.sync()
    assert.deepStrictEqual(Array.from(d.db.listLedgers(), function (l) { return l.id }), ['L_home'])
    assert.deepStrictEqual(Array.from(d.requests[1].data.ledgers, function (l) { return l.id }), ['L_home'])
  })
  await test('首次恢复云端时保留已记账或手动创建的本地账本', async function () {
    var d = device({}, [snap([ledger('L_home')]), snap([ledger('L_home')])])
    var local = d.db.currentLedger().id
    d.db.addRecord({ ledgerId: local, type: 'expense', amount: 100, category: 'food', date: '2026-10-24' })
    var manual = d.db.createLedger('旅行账本').id
    await d.cloud.sync()
    assert.ok(d.db.getLedger(local))
    assert.ok(d.db.getLedger(manual))
    assert.ok(d.db.getLedger('L_home'))
  })
  await test('旧版本机删除标记补传云端，重启仍阻止旧快照复活', async function () {
    var store = { 'jizhang.hidden.v1': JSON.stringify(['L_old']) }
    var d = device(store, [snap([ledger('L_old')]), snap([], ['L_old'])])
    await d.cloud.sync()
    assert.ok(d.requests[1].data.removedLedgerIds.indexOf('L_old') >= 0)
    assert.strictEqual(d.db.getLedger('L_old'), null)
    var cold = device(store, [snap([], ['L_old']), snap([], ['L_old'])])
    await cold.cloud.sync()
    assert.strictEqual(cold.db.applyRemoteLedger(ledger('L_old')), false)
  })
  await test('另一设备删除的账本先从本机移除，旧本机副本不再回推', async function () {
    var d = device({}, [snap([], ['L_home']), snap([], ['L_home'])])
    d.db.applyRemoteLedger(ledger('L_home'))
    d.db.flush()
    await d.cloud.sync()
    assert.strictEqual(d.db.getLedger('L_home'), null)
    assert.ok(!d.requests[1].data.ledgers.some(function (l) { return l.id === 'L_home' }))
  })
  await test('删除标记遇到同步失败保留，成功确认后才停止重发', async function () {
    var responses = [snap(), { ok: false, error: '断网', status: 500 }]
    var d = device({}, responses)
    var local = d.db.currentLedger().id
    d.db.deleteLedger(local)
    await d.cloud.sync()
    assert.ok(d.db.removedLedgerIds().indexOf(local) >= 0)
    responses.push(snap([], [local]))
    await d.cloud.sync()
    assert.strictEqual(d.db.removedLedgerIds().indexOf(local), -1)
  })
  await test('应用云端快照不会作为本地修改再次排队同步', async function () {
    var d = device({}, [snap(), snap()])
    await d.cloud.sync()
    assert.strictEqual(d.timers.size, 0, '云端读取产生了新同步任务，会每隔 1.5 秒循环刷新')
  })
  console.log('同步生命周期：' + (failed ? failed + ' 失败' : '全部通过'))
  if (failed) process.exitCode = 1
}
main()
