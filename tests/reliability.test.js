var assert = require('assert')
var store = {}
global.wx = {
  getStorageSync: function (key) { return store[key] || '' },
  setStorageSync: function (key, value) { store[key] = value }
}
var failures = 0
function test(name, fn) {
  store = {}
  delete require.cache[require.resolve('../utils/db.js')]
  var db = require('../utils/db.js')
  db.init()
  try { fn(db); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
function record(db) {
  return db.addRecord({ ledgerId: db.currentLedger().id, amount: 1200, type: 'expense', category: 'food', date: '2026-10-24', accountId: 'acc_wechat', note: '午饭' })
}
test('旧同步完成时保留期间修改的记录，即使发生在同一毫秒', function (db) {
  var rec = record(db)
  var sent = db.drainDirty()
  db.updateRecord(rec.id, { amount: 2500, type: 'expense', category: 'food', date: rec.date, note: '加餐' })
  db.getRecord(rec.id).updatedAt = sent[0].updatedAt
  db.clearDirty(sent)
  assert.strictEqual(db.drainDirty().length, 1)
  assert.strictEqual(db.drainDirty()[0].amount, 2500)
})
test('确认的记录停止重传，尚未确认的删除墓碑继续同步', function (db) {
  var a = record(db)
  var b = record(db)
  var sent = db.drainDirty()
  db.deleteRecord(b.id)
  db.clearDirty(sent)
  assert.strictEqual(db.getRecord(a.id).dirty, false)
  assert.strictEqual(db.drainDirty().length, 1)
  assert.strictEqual(db.drainDirty()[0].id, b.id)
  assert.strictEqual(db.drainDirty()[0].deleted, true)
})
test('无效转账编辑不会改变原记录或资产余额', function (db) {
  var rec = record(db)
  var before = JSON.stringify(rec)
  var balances = JSON.stringify(db.assetSummary(rec.ledgerId))
  assert.strictEqual(db.updateRecord(rec.id, { type: 'transfer', amount: 9900, accountId: 'acc_bank', transferTo: 'acc_bank' }), null)
  assert.strictEqual(JSON.stringify(db.getRecord(rec.id)), before)
  assert.strictEqual(JSON.stringify(db.assetSummary(rec.ledgerId)), balances)
})
test('编辑为不指定账户后，原账户流水和余额解除关联', function (db) {
  var rec = record(db)
  db.updateRecord(rec.id, { amount: 1200, type: 'expense', category: 'food', date: rec.date, accountId: '', note: '午饭' })
  assert.strictEqual(db.getRecord(rec.id).accountId || '', '')
  var acc = db.assetSummary(rec.ledgerId).accounts.filter(function (a) { return a.id === 'acc_wechat' })[0]
  assert.strictEqual(acc.balance, 0)
})
test('连续修改和删除产生递增版本，时钟回退也能同步', function (db) {
  var rec = record(db)
  rec.updatedAt = '2030-01-01T00:00:00.000Z'
  db.updateRecord(rec.id, { amount: 1300, type: 'expense', category: 'food', date: rec.date, note: '更新' })
  assert.strictEqual(rec.updatedAt, '2030-01-01T00:00:00.001Z')
  db.deleteRecord(rec.id)
  assert.strictEqual(rec.updatedAt, '2030-01-01T00:00:00.002Z')
})
if (failures) process.exitCode = 1
