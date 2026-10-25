const assert = require('assert')
const db = require('../utils/db')
let failures = 0
function test(name, run) {
  try { setup(); run(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
let store, modal, toasts
function setup() {
  store = {}; modal = null; toasts = []
  global.wx = {
    getStorageSync(k) { return store[k] || '' }, setStorageSync(k, v) { store[k] = v },
    showModal(o) { modal = o }, showToast(o) { toasts.push(o.title) }
  }
  db.init()
}
function add(fields) {
  return db.addRecord(Object.assign({ ledgerId: db.currentLedger().id, type: 'expense', amount: 1250, category: 'food', date: '2026-10-25', note: '午饭', accountId: 'acc_wechat' }, fields))
}
function page() {
  let definition
  global.Page = p => { definition = p }
  delete require.cache[require.resolve('../pages/recycle/recycle')]
  require('../pages/recycle/recycle')
  delete global.Page
  return Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(p) { Object.assign(this.data, p) } })
}
test('恢复原账单而非新建：收支、余额、导入来源及重启保持一致', () => {
  const ledger = db.currentLedger().id
  const r = add({ external: { src: 'wechat', txn: 'txn-1', party: '饭店' } })
  db.deleteRecord(r.id)
  assert.equal(db.statsOf(ledger).expense, 0)
  assert.equal(db.assetSummary(ledger).accounts.find(a => a.id === 'acc_wechat').balance, 0)
  assert.equal(db.deletedRecordsOf(ledger).length, 1)
  assert.equal(db.restoreRecord(r.id).ok, true)
  assert.equal(db.restoreRecord(r.id).ok, false)
  assert.equal(db.recordsOf(ledger).length, 1)
  assert.equal(db.recordsOf(ledger)[0].id, r.id)
  assert.equal(db.recordsOf(ledger)[0].external.txn, 'txn-1')
  assert.equal(db.statsOf(ledger).expense, 1250)
  assert.equal(db.assetSummary(ledger).accounts.find(a => a.id === 'acc_wechat').balance, -1250)
  db.init()
  assert.equal(db.deletedRecordsOf(ledger).length, 0)
  assert.equal(db.recordsOf(ledger)[0].id, r.id)
})
test('删除同步的旧确认和旧快照不能覆盖刚恢复的账单', () => {
  const r = add(); db.deleteRecord(r.id)
  const sent = db.drainDirty().find(x => x.id === r.id)
  assert.equal(db.restoreRecord(r.id).ok, true)
  assert.ok(r.updatedAt > sent.updatedAt)
  db.clearDirty([sent])
  assert.equal(r.dirty, true)
  assert.equal(db.applyRemoteRecord(sent), false)
  assert.equal(r.deleted, false)
  assert.equal(db.drainDirty().find(x => x.id === r.id).deleted, false)
})
test('恢复转账只改变两端余额，不增加收入支出', () => {
  const ledger = db.currentLedger().id
  const r = add({ type: 'transfer', transferTo: 'acc_alipay', amount: 3000 })
  db.deleteRecord(r.id)
  assert.equal(db.restoreRecord(r.id).ok, true)
  const accounts = db.assetSummary(ledger).accounts
  assert.equal(accounts.find(a => a.id === 'acc_wechat').balance, -3000)
  assert.equal(accounts.find(a => a.id === 'acc_alipay').balance, 3000)
  assert.equal(db.statsOf(ledger).expense, 0)
  assert.equal(db.statsOf(ledger).income, 0)
})
test('转账原账户失效时拒绝恢复，普通账单保留历史账户关联', () => {
  const ledger = db.currentLedger().id
  const transfer = add({ type: 'transfer', transferTo: 'acc_alipay' })
  const expense = add()
  db.deleteRecord(transfer.id); db.deleteRecord(expense.id)
  db.saveAccounts(ledger, [])
  assert.equal(db.restoreRecord(transfer.id).ok, false)
  assert.equal(transfer.deleted, true)
  assert.equal(db.restoreRecord(expense.id).ok, true)
  assert.equal(expense.accountId, 'acc_wechat')
  assert.equal(db.statsOf(ledger).expense, 1250)
})
test('已移除账本不能通过恢复账单复活，普通编辑不能改动墓碑', () => {
  const r = add(); db.deleteRecord(r.id)
  assert.equal(db.updateRecord(r.id, Object.assign({}, r, { amount: 9900 })), null)
  assert.equal(r.amount, 1250)
  db.deleteLedger(r.ledgerId)
  assert.equal(db.restoreRecord(r.id).ok, false)
  assert.deepEqual(db.deletedRecordsOf(), [])
})
test('回收站按账本筛选并搜索，取消不恢复，确认后列表与余额刷新', () => {
  const first = db.currentLedger().id
  const r = add()
  const second = db.createLedger('旅行').id
  const other = add({ ledgerId: second, note: '高铁票' })
  db.deleteRecord(r.id); db.deleteRecord(other.id)
  const p = page(); p.onLoad(); p.onShow()
  assert.equal(p.data.totalCount, 2)
  p.onKeyword({ detail: { value: '高铁' } })
  assert.deepEqual(p.data.records.map(x => x.id), [other.id])
  p.onKeyword({ detail: { value: '' } })
  p.onLedgerChange({ detail: { value: String(p.data.ledgers.findIndex(x => x.id === first)) } })
  assert.deepEqual(p.data.records.map(x => x.id), [r.id])
  p.onRestore({ currentTarget: { dataset: { id: r.id } } })
  modal.success({ confirm: false }); modal.complete()
  assert.equal(r.deleted, true)
  p.onRestore({ currentTarget: { dataset: { id: r.id } } })
  modal.success({ confirm: true }); modal.complete()
  assert.equal(r.deleted, false)
  assert.equal(p.data.records.length, 0)
  assert.equal(p.data.totalCount, 1)
  assert.equal(db.statsOf(first).expense, 1250)
  p.onUnload()
})
test('确认恢复前远端再次恢复或账本被移除，不产生重复或错误成功提示', () => {
  const r = add(); db.deleteRecord(r.id)
  const p = page(); p.onLoad(); p.onShow()
  p.onRestore({ currentTarget: { dataset: { id: r.id } } })
  db.deleteLedger(r.ledgerId)
  modal.success({ confirm: true }); modal.complete()
  assert.ok(!toasts.includes('账单已恢复'))
  assert.equal(p.data.records.length, 0)
  p.onUnload()
})
test('同一外部交易已重新入账时阻止重复恢复，其他账本和来源不误拦截', () => {
  const original = add({ external: { src: 'wechat', txn: 'stable-1' } })
  db.deleteRecord(original.id)
  const duplicate = add({ external: { src: 'wechat', txn: 'stable-1' } })
  assert.equal(db.restoreRecord(original.id).ok, false)
  assert.equal(db.statsOf(original.ledgerId).expense, 1250)
  db.deleteRecord(duplicate.id)
  add({ external: { src: 'alipay', txn: 'stable-1' } })
  add({ ledgerId: db.createLedger('旅行').id, external: { src: 'wechat', txn: 'stable-1' } })
  assert.equal(db.restoreRecord(original.id).ok, true)
})
test('多笔删除记录分页不遗漏，同步更新搜索时保留关键词，隐藏后停止刷新', () => {
  const records = Array.from({ length: 35 }, (_, i) => add({ note: '午饭' + i }))
  records.forEach(r => db.deleteRecord(r.id))
  const p = page(); p.onLoad(); p.onShow()
  assert.equal(p.data.records.length, 30)
  assert.equal(p.data.hasMore, true)
  p.onReachBottom()
  assert.equal(new Set(p.data.records.map(r => r.id)).size, 35)
  assert.equal(p.data.hasMore, false)
  p.onKeyword({ detail: { value: '午饭34' } })
  db.restoreRecord(records[34].id)
  assert.equal(p.data.keyword, '午饭34')
  assert.equal(p.data.matchedCount, 0)
  p.onHide()
  db.restoreRecord(records[0].id)
  assert.equal(p.data.totalCount, 34)
  p.onShow()
  assert.equal(p.data.totalCount, 33)
  p.onUnload()
})
if (failures) process.exit(1)
