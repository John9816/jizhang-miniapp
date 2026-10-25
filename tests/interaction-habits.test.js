const assert = require('assert')
const db = require('../utils/db')
let failed = 0, state
function setup() {
  const storage = {}
  state = { routes: [], modal: null, actionSheet: null, hiddenKeyboard: 0 }
  global.getCurrentPages = () => [{}, {}]
  global.wx = {
    getStorageSync(k) { return storage[k] || '' }, setStorageSync(k, v) { storage[k] = v },
    getWindowInfo() { return { statusBarHeight: 20, windowHeight: 800 } },
    getMenuButtonBoundingClientRect() { return { top: 24, bottom: 56 } },
    enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {}, showToast() {},
    showModal(o) { state.modal = o }, showActionSheet(o) { state.actionSheet = o },
    hideKeyboard() { state.hiddenKeyboard++ },
    navigateBack() { state.routes.push('back') },
    navigateTo(o) { state.routes.push(o.url); if (o.complete) o.complete() }
  }
  db.init()
}
function page(name, options) {
  let definition
  global.Page = p => { definition = p }
  delete require.cache[require.resolve('../pages/' + name + '/' + name)]
  require('../pages/' + name + '/' + name)
  delete global.Page
  const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(patch, cb) { Object.assign(this.data, patch); if (cb) cb() } })
  p.onLoad(options || {})
  return p
}
function test(name, fn) {
  try { setup(); fn(); console.log('PASS ' + name) }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message) }
}
test('普通保存立即返回原页面，快速连点只生成一笔', () => {
  const p = page('edit')
  p.appendDigit('8'); p.onSave(); p.onSave()
  assert.equal(db.recordsOf(db.currentLedger().id).length, 1)
  assert.deepEqual(state.routes, ['back'])
  p.onUnload()
})
test('连续记账由显式开关决定，同一个保存键保留分类日期账户', () => {
  const p = page('edit')
  assert.equal(p.data.continueEntry, false)
  p.toggleContinue(); p.setData({ date: '2026-10-01', accountId: 'acc_wechat', note: '早餐' })
  p.appendDigit('8'); p.onSave(); p.onSave()
  assert.equal(db.recordsOf(db.currentLedger().id).length, 1)
  assert.deepEqual(state.routes, [])
  assert.equal(p.data.amountInput, '')
  assert.equal(p.data.note, '')
  assert.equal(p.data.date, '2026-10-01')
  assert.equal(p.data.accountId, 'acc_wechat')
  assert.equal(p.data.continueEntry, true)
  assert.equal(p.hasUnsavedChanges(), false)
  p.onUnload()
})
test('编辑和模板表单不能开启连续记账', () => {
  const ledgerId = db.currentLedger().id
  const r = db.addRecord({ ledgerId, type: 'expense', amount: 100, category: 'food', date: '2026-10-01' })
  for (const options of [{ id: r.id }, { asTemplate: '1', ledgerId }]) {
    const p = page('edit', options); p.toggleContinue()
    assert.equal(p.data.continueEntry, false); p.onUnload()
  }
})
test('备注编辑让出数字键盘区域，收起键盘保留金额备注且忽略迟到事件', () => {
  const p = page('edit'); p.appendDigit('8')
  p.onNoteFocus(); p.onNoteKeyboard({ detail: { height: 320 } })
  p.onNoteInput({ detail: { value: '早餐豆浆' } })
  assert.equal(p.data.noteFocused, true)
  assert.equal(p.data.keyboardHeight, 320)
  p.finishNote()
  assert.equal(state.hiddenKeyboard, 1)
  assert.equal(p.data.noteFocused, false)
  assert.equal(p.data.keyboardHeight, 0)
  p.onNoteKeyboard({ detail: { height: 320 } })
  assert.equal(p.data.keyboardHeight, 0)
  assert.equal(p.data.note, '早餐豆浆')
  assert.equal(p.data.amountInput, '8')
  assert.equal(p.hasUnsavedChanges(), true)
  p.onNoteFocus(); p.onNoteKeyboard({ detail: { height: 320 } })
  p.onNoteKeyboard({ detail: { height: 0 } })
  assert.equal(p.data.noteFocused, true)
  assert.equal(p.data.keyboardHeight, 0)
  p.onNoteBlur()
  p.onUnload()
})
test('快速收起后重新编辑备注，旧键盘关闭事件不能取消新焦点', () => {
  const p = page('edit')
  p.onNoteFocus(); p.onNoteKeyboard({ detail: { height: 320 } })
  p.finishNote(); p.onNoteFocus()
  p.onNoteKeyboard({ detail: { height: 0 } })
  p.onNoteKeyboard({ detail: { height: 320 } })
  assert.equal(p.data.noteFocused, true)
  assert.equal(p.data.keyboardHeight, 320)
  p.onUnload()
})
test('长按退格清空金额和计算，不清空备注、分类与账户', () => {
  const p = page('edit')
  p.setData({ note: '早餐', amountInput: '8', calcBase: 1200, calcOp: '+', calcHint: '12.00 +', accountId: 'acc_wechat' })
  p.clearAmount()
  assert.equal(p.data.amountInput, '')
  assert.equal(p.data.calcBase, 0)
  assert.equal(p.data.calcOp, '')
  assert.equal(p.data.canSave, false)
  assert.equal(p.data.note, '早餐')
  assert.equal(p.data.accountId, 'acc_wechat')
  p.onUnload()
})
test('点模板直接预填，更多操作取消不跳转，删除仍需确认', () => {
  const ledgerId = db.currentLedger().id
  const t = db.saveTemplate(ledgerId, { name: '早餐', type: 'expense', amount: 800, category: 'food' }).template
  const p = page('templates', { ledgerId })
  const e = { currentTarget: { dataset: { id: t.id } } }
  p.openTemplateMenu(e)
  state.actionSheet.fail({ errMsg: 'showActionSheet:fail cancel' }); state.actionSheet.complete()
  assert.equal(state.routes.length, 0)
  assert.equal(db.templatesOf(ledgerId).length, 1)
  p.openTemplateMenu(e)
  state.actionSheet.success({ tapIndex: 1 }); state.actionSheet.complete()
  assert.ok(state.modal)
  state.modal.success({ confirm: false }); state.modal.complete()
  assert.equal(db.templatesOf(ledgerId).length, 1)
  p.useTemplate(e)
  assert.ok(state.routes[0].includes('templateId=' + t.id))
  p.onUnload()
})
test('账单页打开即显示记录，筛选默认收起，清空关键词保留已选条件', () => {
  const ledgerId = db.currentLedger().id
  db.addRecord({ ledgerId, type: 'expense', amount: 800, category: 'food', date: '2026-10-01', note: '早餐' })
  db.addRecord({ ledgerId, type: 'income', amount: 1000, category: 'salary', date: '2026-10-01', note: '工资' })
  const p = page('search')
  assert.equal(p.data.searched, true)
  assert.equal(p.data.results.length, 2)
  assert.equal(p.data.showFilters, false)
  p.setData({ type: 'expense', q: '不存在' }); p.doSearch()
  assert.equal(p.data.results.length, 0)
  p.clearQuery()
  assert.equal(p.data.results.length, 1)
  assert.equal(p.data.type, 'expense')
  assert.equal(p.data.filterCount, 1)
  p.resetFilters()
  assert.equal(p.data.results.length, 2)
  assert.equal(p.data.filterCount, 0)
})
test('首页全部账单承接当前月份与成员，统计钻取继续保留分类', () => {
  const index = page('index')
  index.setData({ monthKey: '2026-02', memberFilter: 'member B' })
  index.goSearch()
  const url = state.routes[0]
  assert.ok(url.includes('start=2026-02-01'))
  assert.ok(url.includes('end=2026-02-28'))
  assert.ok(url.includes('memberId=member%20B'))
  const p = page('search', { start: '2026-02-01', end: '2026-02-28', memberId: 'member B' })
  assert.equal(p.data.memberId, 'member B')
  assert.equal(p.data.start, '2026-02-01')
  assert.equal(p.data.type, '')
  const stats = page('search', { type: 'expense', category: 'food', start: '2026-02-01', end: '2026-02-28' })
  assert.equal(stats.data.category, 'food')
})
test('错误筛选展开修正，正确应用后收起并展示结果', () => {
  const p = page('search')
  p.setData({ start: '2026-10-25', end: '2026-10-01', showFilters: true })
  p.applyFilters()
  assert.equal(p.data.showFilters, true)
  assert.ok(p.data.filterError)
  p.setData({ start: '2026-10-01' }); p.applyFilters()
  assert.equal(p.data.filterError, '')
  assert.equal(p.data.showFilters, false)
  assert.equal(p.data.filterCount, 1)
})
test('默认账户为第二个账户时切转账，自动选不同转入账户，同账户误触不破坏选择', () => {
  const p = page('edit')
  p.setData({ accountId: p.data.accounts[1].id })
  p.toggleTransfer()
  assert.notEqual(p.data.accountId, p.data.transferTo)
  const target = p.data.transferTo
  p.setAccount({ currentTarget: { dataset: { id: p.data.accountId, field: 'to' } } })
  assert.equal(p.data.transferTo, target)
  p.onUnload()
})
test('详情更多取消不改账单，再记只预填，删除仍需二次确认', () => {
  const ledgerId = db.currentLedger().id
  const r = db.addRecord({ ledgerId, type: 'expense', amount: 800, category: 'food', date: '2026-10-01' })
  const p = page('detail', { id: r.id })
  p.openMore(); const menu = state.actionSheet
  assert.deepEqual(menu.itemList, ['再记一笔', '存为常用模板', '删除账单'])
  p.openMore(); assert.equal(state.actionSheet, menu)
  menu.fail({ errMsg: 'showActionSheet:fail cancel' }); menu.complete()
  assert.equal(db.recordsOf(ledgerId).length, 1)
  assert.equal(state.modal, null)
  p.openMore(); state.actionSheet.success({ tapIndex: 0 }); state.actionSheet.complete()
  assert.ok(state.routes[0].includes('copyId=' + encodeURIComponent(r.id)))
  assert.equal(db.recordsOf(ledgerId).length, 1)
  p.openMore(); state.actionSheet.success({ tapIndex: 2 }); state.actionSheet.complete()
  assert.equal(state.modal.confirmText, '删除账单')
  state.modal.success({ confirm: false }); state.modal.complete()
  assert.equal(db.recordsOf(ledgerId).length, 1)
})
test('详情更多等待选择期间账单被同步删除，不能复制或保存旧模板', () => {
  const ledgerId = db.currentLedger().id
  const r = db.addRecord({ ledgerId, type: 'expense', amount: 800, category: 'food', date: '2026-10-01' })
  const p = page('detail', { id: r.id })
  p.openMore(); const menu = state.actionSheet
  db.deleteRecord(r.id)
  menu.success({ tapIndex: 1 }); menu.complete()
  assert.equal(state.modal, null)
  assert.equal(db.templatesOf(ledgerId).length, 0)
  p.openMore(); assert.equal(state.actionSheet, menu)
})
test('我的管理分组保留所有功能，状态入口始终进入设置且连点只打开一次', () => {
  const p = page('profile')
  const actions = p.data.menuGroups.flatMap(group => group.items.map(item => item.action))
  assert.deepEqual(actions.sort(), ['goBudget', 'goCategories', 'goChallenge', 'goImport', 'goLedger', 'goReconcile', 'goRecurring', 'goSettings', 'goTemplates'].sort())
  for (const phase of ['ready', 'failed', 'off']) {
    state.routes = []; p._navigating = false
    p.setData({ account: { phase } })
    p.onStatusTap(); p.onStatusTap()
    assert.deepEqual(state.routes, ['/pages/settings/settings'])
  }
  p._navigating = false; state.routes = []
  p.onMenuTap({ currentTarget: { dataset: { action: 'goRecurring' } } })
  assert.deepEqual(state.routes, ['/pages/recurring/recurring'])
  p.onUnload()
})
test('成员管理可从账本页进入，首页收拢后功能仍可达', () => {
  const p = page('ledger'); p.goMembers()
  assert.deepEqual(state.routes, ['/pages/members/members'])
  p.onUnload()
})
test('我的导航失败可以重试，从子页面返回后可以再次进入', () => {
  const p = page('profile')
  let pending
  const navigate = wx.navigateTo
  wx.navigateTo = o => { pending = o; state.routes.push(o.url) }
  p.goSettings(); p.goSettings()
  assert.equal(state.routes.length, 1)
  pending.fail({ errMsg: 'navigateTo:fail' })
  p.goSettings()
  assert.equal(state.routes.length, 2)
  p.onShow(); p.goBudget()
  assert.equal(state.routes[2], '/pages/budget/budget')
  wx.navigateTo = navigate
  p.onUnload()
})
if (failed) process.exit(1)
