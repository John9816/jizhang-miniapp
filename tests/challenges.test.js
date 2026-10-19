/**
 * 存钱挑战数据层单测：创建 / 存入取出 / 达成排序 / 删除 / 跨设备同步。
 * 运行：node tests/challenges.test.js
 */
var assert = require('assert')
var path = require('path')

var store = {}
global.wx = {
  getStorageSync: function (k) { return store[k] || '' },
  setStorageSync: function (k, v) { store[k] = String(v) },
  removeStorageSync: function (k) { delete store[k] }
}

var passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok -', name)
  } catch (e) {
    console.error('  FAIL -', name, '\n   ', e && e.message)
    process.exitCode = 1
  }
}

function freshDbModule() {
  var p = path.resolve(__dirname, '../utils/db.js')
  delete require.cache[p]
  return require(p)
}

console.log('challenges.test:')

test('新账本默认没有挑战', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  assert.deepStrictEqual(db.challengesOf(db.currentLedger().id), [])
})

test('创建挑战：金额、进度、文案正确', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var c = db.addChallenge(L, { name: '旅行基金', target: 500000, deadline: '2027-03-01' })
  assert.ok(c && c.id, '应返回挑战对象')
  assert.strictEqual(c.target, 500000)
  assert.strictEqual(c.saved, 0)
  assert.strictEqual(c.pct, 0)
  assert.strictEqual(c.targetText, '5,000.00')
  assert.strictEqual(c.leftText, '5,000.00')
  var list = db.challengesOf(L)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].name, '旅行基金')
})

test('目标金额必须大于 0', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  assert.strictEqual(db.addChallenge(L, { name: '无效', target: 0 }), null)
  assert.strictEqual(db.challengesOf(L).length, 0)
})

test('存入 / 取出：累计正确，取出不会变负数', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var c = db.addChallenge(L, { name: '相机', target: 300000 })

  db.depositChallenge(L, c.id, 100000)
  assert.strictEqual(db.challengesOf(L)[0].saved, 100000)

  db.depositChallenge(L, c.id, 50000)
  assert.strictEqual(db.challengesOf(L)[0].saved, 150000)
  assert.strictEqual(db.challengesOf(L)[0].pct, 50)

  db.depositChallenge(L, c.id, -80000)
  assert.strictEqual(db.challengesOf(L)[0].saved, 70000)

  // 取超额 → 归零而不是负数
  db.depositChallenge(L, c.id, -999999)
  assert.strictEqual(db.challengesOf(L)[0].saved, 0)
})

test('达成目标后 done=true 且排到后面', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var a = db.addChallenge(L, { name: '先建的目标', target: 100000 })
  var b = db.addChallenge(L, { name: '后建的目标', target: 100000 })
  db.depositChallenge(L, a.id, 100000)

  var list = db.challengesOf(L)
  assert.strictEqual(list.length, 2)
  assert.strictEqual(list[0].id, b.id, '进行中的应排在已达成之前')
  assert.strictEqual(list[1].done, true)
  assert.strictEqual(list[1].pct, 100)
})

test('进度百分比不因超额超过 100', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var c = db.addChallenge(L, { name: '超额', target: 100000 })
  db.depositChallenge(L, c.id, 150000)
  assert.strictEqual(db.challengesOf(L)[0].pct, 100)
  assert.strictEqual(db.challengesOf(L)[0].saved, 150000)
})

test('截止日期：daysLeft 按今天计算', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var u = require('../utils/util.js')
  var future = u.dateStr(new Date(Date.now() + 10 * 86400000))
  var c = db.addChallenge(L, { name: '十天', target: 100000, deadline: future })
  var view = db.challengesOf(L)[0]
  assert.strictEqual(view.daysLeft, 10)
  assert.strictEqual(view.daysLeftAbs, 10)

  var past = u.dateStr(new Date(Date.now() - 3 * 86400000))
  db.updateChallenge(L, c.id, { deadline: past })
  var v2 = db.challengesOf(L)[0]
  assert.strictEqual(v2.daysLeft, -3)
  assert.strictEqual(v2.daysLeftAbs, 3)
})

test('删除挑战', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var c = db.addChallenge(L, { name: '待删除', target: 1000 })
  assert.strictEqual(db.removeChallenge(L, c.id), true)
  assert.strictEqual(db.challengesOf(L).length, 0)
  assert.strictEqual(db.removeChallenge(L, 'not-exist'), false)
})

test('导出与远端合并携带挑战（跨设备一致）', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var c = db.addChallenge(L, { name: '同步验证', target: 200000 })
  db.depositChallenge(L, c.id, 66000)

  var pushed = db.exportLedgersForSync()[0]
  assert.ok(Array.isArray(pushed.challenges), '导出应包含 challenges')
  assert.strictEqual(pushed.challenges.length, 1)
  assert.strictEqual(pushed.challenges[0].saved, 66000)

  // 另一台设备：空库 → 应用远端账本
  var db2 = freshDbModule()
  store = {}
  db2.init()
  var remote = JSON.parse(JSON.stringify(pushed))
  remote.id = 'L_remote'
  remote.cfgAt = new Date(Date.now() + 5000).toISOString()
  db2.applyRemoteLedger(remote)
  var list2 = db2.challengesOf('L_remote')
  assert.strictEqual(list2.length, 1)
  assert.strictEqual(list2[0].name, '同步验证')
  assert.strictEqual(list2[0].pct, 33)
})

test('老数据没有 challenges 字段时自动补齐为空数组', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  // 手写一份不含 challenges 的账本，模拟旧版本数据
  var raw = JSON.parse(store['jizhang.db.v1'])
  delete raw.ledgers[0].challenges
  store['jizhang.db.v1'] = JSON.stringify(raw)

  var db2 = freshDbModule()
  db2.init()
  var L = db2.currentLedger().id
  assert.deepStrictEqual(db2.challengesOf(L), [])
  assert.doesNotThrow(function () { db2.addChallenge(L, { name: '兼容', target: 100 }) })
})

console.log('\n' + passed + ' tests passed')
