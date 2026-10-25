const assert = require('assert')
const db = require('../utils/db')
const parser = require('../utils/billParser')
let failures = 0, storage, toasts
function setup() {
  storage = {}; toasts = []
  global.wx = {
    getStorageSync: k => storage[k] || '', setStorageSync: (k, v) => { storage[k] = v },
    showToast: o => toasts.push(o), navigateTo() {}
  }
  db.init()
}
function row(patch) {
  return Object.assign({ src: 'wechat', txn: '', date: '2026-10-25', time: '2026-10-25 09:30:00', type: 'expense', amount: 1200, party: '早餐店', note: '豆浆套餐', category: 'food', channel: '零钱', line: 2 }, patch)
}
function page() {
  let def
  global.Page = p => { def = p }
  delete require.cache[require.resolve('../pages/import/import')]
  require('../pages/import/import'); delete global.Page
  const p = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(v) { Object.assign(this.data, v) } })
  p.onLoad(); return p
}
function parsed(rows) {
  return { src: 'wechat', rows, stats: { incomeCents: 0, expenseCents: rows.length * 1200, firstDate: '2026-10-25', lastDate: '2026-10-25', skipped: { dup: 0 } } }
}
function test(name, fn) {
  try { setup(); fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
test('无单号：同日同金额不同时间、方向、商品的真实流水不误删，完全重复才跳过', () => {
  const csv = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号\n' + [
    '2026-10-25 09:30:00,消费,早餐店,豆浆套餐,支出,12.00,零钱,支付成功,/,/',
    '2026-10-25 10:30:00,消费,早餐店,豆浆套餐,支出,12.00,零钱,支付成功,/,/',
    '2026-10-25 09:30:00,消费,早餐店,豆浆套餐,收入,12.00,零钱,支付成功,/,/',
    '2026-10-25 09:30:00,消费,早餐店,面条,支出,12.00,零钱,支付成功,/,/',
    '2026-10-25 09:30:00,消费,早餐店,豆浆套餐,支出,12.00,零钱,支付成功,/,/'
  ].join('\n')
  const result = parser.parseText(csv)
  assert.equal(result.rows.length, 4)
  assert.equal(result.stats.skipped.dup, 1)
  assert.equal(result.rows[1].time, '2026-10-25 10:30:00')
})
test('无单号：重启后、编辑备注金额后再次导入仍使用原始交易身份', () => {
  const id = db.currentLedger().id
  const first = db.importRows(id, [row()])
  db.updateRecord(first.added[0], { amount: 1500, type: 'expense', date: '2026-10-24', category: 'food', note: '修改后的备注' })
  db.init()
  const second = db.importRows(id, [row()])
  assert.equal(second.added.length, 0)
  assert.equal(second.dupes, 1)
  assert.equal(db.recordsOf(id).length, 1)
})
test('导入预检只读，重复与新增分类明确；不以同金额的手记账单自动判重', () => {
  const id = db.currentLedger().id
  db.addRecord({ ledgerId: id, amount: 1200, type: 'expense', date: '2026-10-25', category: 'food', note: '豆浆套餐' })
  db.importRows(id, [row({ txn: 'one' })])
  const before = JSON.stringify(storage)
  const preview = db.previewImportRows(id, [row({ txn: 'one' }), row({ txn: 'two' }), row({ txn: 'two' }), row({ amount: -1 })])
  assert.equal(preview.rows.length, 1)
  assert.equal(preview.dupes, 2)
  assert.equal(preview.invalid, 1)
  assert.equal(JSON.stringify(storage), before)
})
test('去重在单次额度前执行，重复前缀不会阻塞后续新增流水', () => {
  const id = db.currentLedger().id
  const existing = Array.from({ length: 50 }, (_, i) => row({ txn: 'old-' + i }))
  db.importRows(id, existing)
  const result = db.importRows(id, existing.concat([row({ txn: 'new-1' }), row({ txn: 'new-2' })]), { limit: 1 })
  assert.equal(result.added.length, 1)
  assert.equal(result.dupes, 50)
  assert.equal(result.remaining, 1)
})
test('换设备实际同步序列化保留交易身份，确认同步能清理脏标记', () => {
  const id = db.currentLedger().id
  db.importRows(id, [row({ txn: 'sync-1' }), row()])
  const payload = JSON.parse(JSON.stringify(db.drainDirty()))
  assert.equal(payload[0].external.txn, 'sync-1')
  db.clearDirty(payload)
  assert.equal(db.drainDirty().length, 0)
  storage = {}; db.init()
  db.applyRemoteLedger({ id, name: '同步账本', members: [], createdAt: '2026-10-01T00:00:00.000Z' })
  payload.forEach(r => db.applyRemoteRecord(r))
  assert.equal(db.importRows(id, [row({ txn: 'sync-1' }), row()]).dupes, 2)
})
test('导入页面预览排除已有记录，导入后计数归零，重复点击不重复写账', () => {
  const id = db.currentLedger().id
  db.importRows(id, [row({ txn: 'one' })])
  const p = page()
  p.applyResult(parsed([row({ txn: 'one' }), row({ txn: 'two' })]), '测试.csv')
  assert.equal(p.data.summary.count, 1)
  assert.equal(p.data.duplicateCount, 1)
  p.doImport(); p.doImport()
  assert.equal(db.recordsOf(id).length, 2)
  assert.equal(p.data.importResult.added, 1)
  assert.equal(p.data.summary.count, 0)
  p.onUnload()
})
test('预览期间其他设备同步同一流水，提交重新判重且保留原账单', () => {
  const p = page(), id = db.currentLedger().id
  p.applyResult(parsed([row({ txn: 'late' })]), '')
  db.importRows(id, [row({ txn: 'late' })])
  p.doImport()
  assert.equal(db.recordsOf(id).length, 1)
  assert.equal(p.data.summary.count, 0)
  p.onUnload()
})
test('旧版无单号记录可判重且身份补传，旧全局键迁移后不污染其他账本', () => {
  const id = db.currentLedger().id
  const old = db.addRecord({ ledgerId: id, type: 'expense', amount: 1200, date: '2026-10-25', category: 'food', note: '豆浆套餐', external: { src: 'wechat', txn: '', party: '早餐店' } })
  db.clearDirty([old.id])
  const raw = JSON.parse(storage['jizhang.db.v1'])
  raw.records.forEach(r => { delete r.importIdentitySynced; r.dirty = false })
  raw.imported = { 'wechat#legacy-one': true }
  storage['jizhang.db.v1'] = JSON.stringify(raw)
  db.init()
  assert.equal(db.importRows(id, [row()]).dupes, 1)
  assert.equal(db.drainDirty().length, 1, '旧版未同步的身份应补传')
  db.clearDirty(JSON.parse(JSON.stringify(db.drainDirty())))
  db.flush(); db.init()
  assert.equal(db.drainDirty().length, 0, '迁移不能每次启动重复补传')
  const second = db.createLedger('其他账本')
  assert.equal(db.importRows(second.id, [row({ txn: 'legacy-one' })]).added.length, 1)
  assert.equal(db.importRows(id, [row({ txn: 'legacy-one' })]).dupes, 1)
})
test('旧身份补传不提升财务版本，不能覆盖其他设备较新的金额或删除状态', () => {
  const id = db.currentLedger().id
  const old = db.addRecord({ ledgerId: id, type: 'expense', amount: 1200, date: '2026-10-25', category: 'food', note: '豆浆套餐', external: { src: 'wechat', txn: 'old-synced' } })
  const raw = JSON.parse(storage['jizhang.db.v1'])
  const legacy = raw.records.find(r => r.id === old.id)
  delete legacy.importIdentitySynced
  legacy.dirty = false
  legacy.updatedAt = '2026-10-01T00:00:00.000Z'
  storage['jizhang.db.v1'] = JSON.stringify(raw)
  db.init()
  assert.equal(db.getRecord(old.id).updatedAt, '2026-10-01T00:00:00.000Z')
  assert.equal(db.applyRemoteRecord(Object.assign({}, legacy, { external: null, amount: 2500, deleted: true, updatedAt: '2026-10-02T00:00:00.000Z' })), true)
  const pending = db.drainDirty()[0]
  assert.equal(pending.amount, 2500)
  assert.equal(pending.deleted, true)
  assert.equal(pending.identityOnly, true)
})
test('相同财务版本收到补齐的交易身份也要合并，避免老设备再次导入', () => {
  const id = db.currentLedger().id
  const remote = { id: 'R_equal', ledgerId: id, type: 'expense', amount: 1200, category: 'food', date: '2026-10-25', note: '豆浆套餐', updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' }
  db.applyRemoteRecord(remote)
  const changed = db.applyRemoteRecord(Object.assign({}, remote, { external: { src: 'wechat', txn: 'equal-one' } }))
  assert.equal(changed, true)
  assert.equal(db.importRows(id, [row({ txn: 'equal-one' })]).dupes, 1)
  assert.equal(db.getRecord('R_equal').updatedAt, remote.updatedAt)
})
process.exitCode = failures ? 1 : 0
