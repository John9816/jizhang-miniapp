const assert = require('assert')
const db = require('../utils/db')
const u = require('../utils/util')
let failures = 0, state
function setup() {
  const storage = {}
  state = { modal: null, toasts: [], routes: [] }
  global.getCurrentPages = () => [{}, {}]
  global.wx = {
    getStorageSync(k) { return storage[k] || '' }, setStorageSync(k, v) { storage[k] = v },
    getWindowInfo() { return { statusBarHeight: 20, windowHeight: 800 } },
    getMenuButtonBoundingClientRect() { return { top: 24, bottom: 56 } },
    enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {},
    showModal(o) { state.modal = o }, showToast(o) { state.toasts.push(o.title) },
    navigateTo(o) { state.routes.push(o.url); if (o.complete) o.complete() },
    navigateBack() { state.routes.push('back') }
  }
  db.init()
}
function page(name) {
  let definition
  global.Page = p => { definition = p }
  delete require.cache[require.resolve('../pages/' + name + '/' + name)]
  require('../pages/' + name + '/' + name)
  delete global.Page
  return Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(p, cb) { Object.assign(this.data, p); if (cb) cb() } })
}
function fields(patch) {
  return Object.assign({ name: '早餐', type: 'expense', amount: 1250, category: 'food', accountId: 'acc_wechat', note: '早餐豆浆' }, patch)
}
function save(patch, ledgerId) { return db.saveTemplate(ledgerId || db.currentLedger().id, fields(patch)) }
function test(name, fn) {
  try { setup(); fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
test('模板增改删独立于账单，重启保留，配置版本严格递增', () => {
  const ledger = db.currentLedger()
  ledger.cfgAt = '2030-01-01T00:00:00.000Z'
  const t = save()
  assert.equal(t.ok, true)
  assert.equal(db.recordsOf(ledger.id).length, 0)
  assert.equal(ledger.cfgAt, '2030-01-01T00:00:00.001Z')
  assert.equal(save({ id: t.template.id, name: '工作日早餐', amount: 1500 }).ok, true)
  assert.equal(db.templatesOf(ledger.id).length, 1)
  db.init()
  assert.equal(db.templatesOf(ledger.id)[0].amount, 1500)
  const copy = db.templatesOf(ledger.id); copy[0].amount = 1
  assert.equal(db.templatesOf(ledger.id)[0].amount, 1500)
  assert.equal(db.removeTemplate(ledger.id, t.template.id), true)
  assert.equal(db.templatesOf(ledger.id).length, 0)
  assert.equal(db.statsOf(ledger.id).expense, 0)
})
test('非法金额、类型、名称、分类与转账账户不能写入模板', () => {
  const invalid = [{ amount: 0 }, { amount: 12.5 }, { amount: Infinity }, { type: 'bogus' }, { name: ' ' }, { category: 'missing' }, { accountId: 'gone' }, { type: 'transfer', transferTo: 'acc_wechat' }, { type: 'transfer', transferTo: 'gone' }]
  invalid.forEach(p => assert.equal(save(p).ok, false, JSON.stringify(p)))
  assert.equal(db.templatesOf(db.currentLedger().id).length, 0)
  const t = save()
  assert.equal(save({ id: 'missing', name: '失效编辑' }).ok, false)
  assert.equal(db.templatesOf(db.currentLedger().id).length, 1)
  db.deleteLedger(db.currentLedger().id)
  assert.equal(db.getTemplate(t.template.ledgerId, t.template.id), null)
})
test('周期记账推进配置时保持模板版本递增，旧快照不能覆盖模板', () => {
  const ledgerId = db.currentLedger().id
  db.addRecurring(ledgerId, { name: '早餐', amount: 1000, type: 'expense', category: 'food', nextDate: '2026-10-25', cycle: 'monthly' })
  save()
  const ledger = db.getLedger(ledgerId)
  ledger.cfgAt = '2030-01-01T00:00:00.000Z'
  assert.equal(db.runDueRecurring(ledgerId, '2026-10-25').length, 1)
  assert.ok(ledger.cfgAt > '2030-01-01T00:00:00.000Z')
  db.applyRemoteLedger({ id: ledgerId, templates: [], cfgAt: '2030-01-01T00:00:00.000Z' })
  assert.equal(db.templatesOf(ledgerId).length, 1)
})
test('使用模板只预填今天日期，不立即记账，保留未保存提醒与原账本', () => {
  const ledgerId = db.currentLedger().id, t = save().template
  db.createLedger('旅行')
  const p = page('edit'); p.onLoad({ templateId: t.id, ledgerId })
  assert.equal(p.data.ledgerId, ledgerId)
  assert.equal(p.data.date, u.dateStr(new Date()))
  assert.equal(p.data.amountInput, '12.50')
  assert.equal(p.data.accountId, 'acc_wechat')
  assert.equal(p.hasUnsavedChanges(), true)
  assert.equal(db.recordsOf(ledgerId).length, 0)
  p.onUnload()
})
test('失效账户清除并提示，失效分类必须重新选择，转账账户缺失不能保存', () => {
  const ledgerId = db.currentLedger().id
  db.saveCategories(ledgerId, 'expense', [{ key: 'breakfast', name: '早餐', icon: '🍜' }])
  const t = save({ category: 'breakfast' }).template
  const transfer = save({ type: 'transfer', transferTo: 'acc_alipay' }).template
  db.saveCategories(ledgerId, 'expense', [{ key: 'dinner', name: '晚餐', icon: '🍜' }])
  db.saveAccounts(ledgerId, [])
  const p = page('edit'); p.onLoad({ templateId: t.id, ledgerId })
  assert.equal(p.data.accountId, '')
  assert.equal(p.data.category, '')
  assert.equal(p.data.canSave, false)
  p.onSaveContinue()
  assert.equal(db.recordsOf(ledgerId).length, 0)
  p.onUnload()
  const tr = page('edit'); tr.onLoad({ templateId: transfer.id, ledgerId })
  assert.equal(tr.data.transferTo, '')
  assert.equal(tr.data.canSave, false)
  assert.ok(tr.data.templateWarning)
  tr.onUnload()
})
test('新建和编辑模板复用表单，确认前不落库，保存不产生账单', () => {
  const ledgerId = db.currentLedger().id
  const p = page('edit'); p.onLoad({ asTemplate: '1', ledgerId })
  p.setData({ amountInput: '18.50', note: '咖啡' }); p.onSave()
  assert.equal(db.templatesOf(ledgerId).length, 0)
  state.modal.success({ confirm: true, content: '每日咖啡' }); state.modal.complete()
  assert.equal(db.templatesOf(ledgerId)[0].name, '每日咖啡')
  assert.equal(db.templatesOf(ledgerId)[0].amount, 1850)
  assert.equal(db.recordsOf(ledgerId).length, 0)
  p.onUnload()
  const t = db.templatesOf(ledgerId)[0]
  const edit = page('edit'); edit.onLoad({ editTemplateId: t.id, ledgerId })
  edit.setData({ amountInput: '20' }); edit.onSave()
  state.modal.success({ confirm: true, content: '每日咖啡' }); state.modal.complete()
  assert.equal(db.templatesOf(ledgerId).length, 1)
  assert.equal(db.templatesOf(ledgerId)[0].amount, 2000)
  edit.onUnload()
})
test('模板确认时已删除则不能静默新建，取消命名保留表单草稿', () => {
  const ledgerId = db.currentLedger().id, t = save().template
  const p = page('edit'); p.onLoad({ editTemplateId: t.id, ledgerId })
  p.setData({ amountInput: '66' }); p.onSave()
  state.modal.success({ confirm: false }); state.modal.complete()
  assert.equal(db.templatesOf(ledgerId)[0].amount, 1250)
  assert.equal(p.data.amountInput, '66')
  p.onSave(); db.removeTemplate(ledgerId, t.id)
  state.modal.success({ confirm: true, content: '早餐' }); state.modal.complete()
  assert.equal(db.templatesOf(ledgerId).length, 0)
  assert.equal(db.recordsOf(ledgerId).length, 0)
  p.onUnload()
})
test('详情存为模板只写配置，删除来源后仍可使用模板', () => {
  const ledgerId = db.currentLedger().id
  const record = db.addRecord(Object.assign(fields(), { ledgerId, date: '2026-10-01' }))
  const p = page('detail'); p.onLoad({ id: record.id }); p.onSaveTemplate()
  state.modal.success({ confirm: true, content: '常吃早餐' }); state.modal.complete()
  assert.equal(db.recordsOf(ledgerId).length, 1)
  const t = db.templatesOf(ledgerId)[0]
  db.deleteRecord(record.id)
  assert.equal(db.getTemplate(ledgerId, t.id).amount, 1250)
})
test('同步保留模板，旧客户端缺省字段不清空，较新空数组正确删除', () => {
  const ledgerId = db.currentLedger().id, t = save().template
  const exported = db.exportLedgersForSync().find(l => l.id === ledgerId)
  assert.equal(exported.templates[0].id, t.id)
  db.applyRemoteLedger({ id: ledgerId, cfgAt: '2031-01-01T00:00:00.000Z' })
  assert.equal(db.templatesOf(ledgerId).length, 1)
  db.applyRemoteLedger({ id: ledgerId, cfgAt: '2031-01-01T00:00:00.001Z', templates: [] })
  assert.equal(db.templatesOf(ledgerId).length, 0)
  const other = 'L_remote'
  db.applyRemoteLedger({ id: other, name: '远端', cfgAt: '2031-01-01T00:00:00.002Z', templates: [t] })
  assert.equal(db.templatesOf(other)[0].name, '早餐')
})
test('管理页使用/编辑路由保留原账本，删除取消无副作用', () => {
  const ledgerId = db.currentLedger().id, t = save().template
  const p = page('templates'); p.onLoad({ ledgerId }); p.onShow()
  assert.equal(p.data.templates[0].name, '早餐')
  p.useTemplate({ currentTarget: { dataset: { id: t.id } } })
  assert.ok(state.routes[0].includes('templateId=' + t.id))
  assert.ok(state.routes[0].includes('ledgerId=' + ledgerId))
  p.removeTemplate({ currentTarget: { dataset: { id: t.id } } })
  state.modal.success({ confirm: false }); state.modal.complete()
  assert.equal(db.templatesOf(ledgerId).length, 1)
  p.removeTemplate({ currentTarget: { dataset: { id: t.id } } })
  state.modal.success({ confirm: true }); state.modal.complete()
  assert.equal(p.data.templates.length, 0)
  p.onUnload()
})
if (failures) process.exit(1)
