var assert = require('assert')
var db = require('../utils/db.js')
var u = require('../utils/util.js')
var failures = 0
function loadPage(name) {
  var definition
  global.Page = function (p) { definition = p }
  delete require.cache[require.resolve('../pages/' + name + '/' + name + '.js')]
  require('../pages/' + name + '/' + name + '.js')
  delete global.Page
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData: function (patch, cb) { Object.assign(this.data, patch); if (cb) cb() }
  })
}
function setup() {
  var store = {}
  var state = { routes: [], toasts: [], modal: null }
  global.getCurrentPages = function () { return [{}, {}] }
  global.wx = {
    getStorageSync: function (k) { return store[k] || '' },
    setStorageSync: function (k, v) { store[k] = v },
    getWindowInfo: function () { return { statusBarHeight: 20, windowHeight: 800 } },
    getMenuButtonBoundingClientRect: function () { return { top: 24, bottom: 56 } },
    enableAlertBeforeUnload: function () {}, disableAlertBeforeUnload: function () {},
    showToast: function (o) { state.toasts.push(o.title) },
    showModal: function (o) { state.modal = o },
    navigateTo: function (o) { state.routes.push(o.url); if (o.complete) o.complete() },
    navigateBack: function () { state.routes.push('back') }
  }
  db.init()
  state.ledger = db.currentLedger()
  return state
}
function add(fields) {
  return db.addRecord(Object.assign({ ledgerId: db.currentLedger().id, amount: 1234, type: 'expense', category: 'food', date: '2026-10-01', note: '午饭', accountId: 'acc_wechat' }, fields))
}
function test(name, fn) {
  try { fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}

test('账单详情显示自定义分类与原账本，编辑返回后更新金额', function () {
  var s = setup()
  db.saveCategories(s.ledger.id, 'expense', [{ key: 'pet', name: '猫咪', icon: '🐱' }])
  var r = add({ category: 'pet' })
  var p = loadPage('detail')
  p.onLoad({ id: r.id }); p.onShow()
  assert.strictEqual(p.data.record.categoryName, '猫咪')
  assert.strictEqual(p.data.record.ledgerName, s.ledger.name)
  assert.strictEqual(p.data.record.accountName, '微信钱包')
  p.onHide()
  db.updateRecord(r.id, Object.assign({}, r, { amount: 5000 }))
  p.onShow()
  assert.strictEqual(p.data.record.amountText, '50.00')
  p.onUnload()
})
test('详情打开期间远端删除记录后禁用编辑和再记，不展示旧数据', function () {
  var s = setup(), r = add(), p = loadPage('detail')
  p.onLoad({ id: r.id }); p.onShow()
  db.deleteRecord(r.id)
  assert.strictEqual(p.data.unavailable, true)
  assert.strictEqual(p.data.record, null)
  p.onEdit(); p.onRepeat()
  assert.deepStrictEqual(s.routes, [])
  p.onUnload()
})
test('再记一笔只打开预填表单，不立即增加记录', function () {
  var s = setup(), r = add(), p = loadPage('detail')
  p.onLoad({ id: r.id }); p.onRepeat()
  assert.strictEqual(s.routes[0], '/pages/edit/edit?copyId=' + encodeURIComponent(r.id))
  var e = loadPage('edit'); e.onLoad({ copyId: r.id })
  assert.strictEqual(e.data.editingId, '')
  assert.strictEqual(e.data.date, u.dateStr(new Date()))
  assert.strictEqual(e.data.amountInput, '12.34')
  assert.strictEqual(e.data.note, '午饭')
  assert.strictEqual(e.hasUnsavedChanges(), true)
  assert.strictEqual(db.recordsOf(s.ledger.id).length, 1)
})
test('复制转账保留类型，但已删除账户不能参与保存', function () {
  var s = setup()
  var r = add({ type: 'transfer', accountId: 'acc_wechat', transferTo: 'acc_alipay', transferToName: '支付宝' })
  db.saveAccounts(s.ledger.id, db.accountsOf(s.ledger.id).filter(function (a) { return a.id !== 'acc_alipay' }))
  var p = loadPage('edit'); p.onLoad({ copyId: r.id })
  assert.strictEqual(p.data.mode, 'transfer')
  assert.strictEqual(p.data.transferTo, '')
  assert.strictEqual(p.data.canSave, false)
  p.onSaveContinue()
  assert.strictEqual(db.recordsOf(s.ledger.id).length, 1)
})
test('复制所属原账本而非当前账本，失效来源不可创建空白账单', function () {
  var s = setup(), r = add()
  var other = db.createLedger('另一个账本')
  db.setCurrentLedger(other.id)
  var p = loadPage('edit'); p.onLoad({ copyId: r.id })
  assert.strictEqual(p.data.ledgerId, s.ledger.id)
  var bad = loadPage('edit'); bad.onLoad({ copyId: 'missing' })
  bad.setData({ amountInput: '99' }); bad.onSaveContinue()
  assert.strictEqual(bad.data.recordUnavailable, true)
  assert.strictEqual(db.recordsOf(other.id).length, 0)
})
test('保存并继续只写一笔，保留选择、清空金额备注计算，并停留原页', function () {
  var s = setup(), p = loadPage('edit'); p.onLoad({})
  p.setData({ amountInput: '2', calcBase: 1000, calcOp: '+', calcHint: '10.00 +', note: '早餐', date: '2026-10-02', category: 'food', accountId: 'acc_wechat' })
  p.onSaveContinue(); p.onSaveContinue()
  var records = db.recordsOf(s.ledger.id)
  assert.strictEqual(records.length, 1)
  assert.strictEqual(records[0].amount, 1200)
  assert.strictEqual(p.data.amountInput, '')
  assert.strictEqual(p.data.note, '')
  assert.strictEqual(p.data.calcOp, '')
  assert.strictEqual(p.data.calcBase, 0)
  assert.strictEqual(p.data.date, '2026-10-02')
  assert.strictEqual(p.data.accountId, 'acc_wechat')
  assert.strictEqual(p.data.canSave, false)
  assert.strictEqual(p.hasUnsavedChanges(), false)
  assert.deepStrictEqual(s.routes, [])
  p.appendDigit('5'); p.onSaveContinue()
  assert.strictEqual(db.recordsOf(s.ledger.id).length, 2)
})
test('编辑模式不允许通过连续保存另建账单', function () {
  var s = setup(), r = add(), p = loadPage('edit'); p.onLoad({ id: r.id })
  p.onSaveContinue()
  assert.strictEqual(db.recordsOf(s.ledger.id).length, 1)
  assert.strictEqual(p.data.saving, false)
})
test('账户行打开编辑且负余额原样往返，净资产没有变号', function () {
  var s = setup()
  db.saveAccounts(s.ledger.id, [{ id: 'debt', name: '信用卡', type: 'credit', initialBalance: -300050 }])
  var p = loadPage('assets'); p.onLoad()
  p.editAccount({ currentTarget: { dataset: { id: 'debt' } } })
  assert.strictEqual(p.data.showManage, true)
  assert.strictEqual(p.data.editInitial, '-3000.50')
  p.saveAccount()
  assert.strictEqual(db.accountsOf(s.ledger.id)[0].initialBalance, -300050)
  assert.strictEqual(p.data.accounts[0].balanceAbsText, '3,000.50')
})
test('账户金额非法时保留原账户，负数开关支持数字键盘输入负债', function () {
  var s = setup(), p = loadPage('assets'); p.onLoad()
  p.editAccount({ currentTarget: { dataset: { id: 'acc_wechat' } } })
  p.onEditInitial({ detail: { value: '12.3.4' } }); p.saveAccount()
  assert.strictEqual(p.data.showManage, true)
  assert.strictEqual(db.accountsOf(s.ledger.id).find(function (a) { return a.id === 'acc_wechat' }).initialBalance, 0)
  p.onEditInitial({ detail: { value: '88.25' } }); p.toggleBalanceSign(); p.saveAccount()
  assert.strictEqual(db.accountsOf(s.ledger.id).find(function (a) { return a.id === 'acc_wechat' }).initialBalance, -8825)
})
test('编辑期间账户被删除不能以错误状态提示保存成功', function () {
  var s = setup(), p = loadPage('assets'); p.onLoad()
  p.editAccount({ currentTarget: { dataset: { id: 'acc_wechat' } } })
  db.saveAccounts(s.ledger.id, [])
  p.saveAccount()
  assert.strictEqual(p.data.showManage, true)
  assert.ok(s.toasts.some(function (t) { return t.indexOf('不存在') >= 0 }))
})
test('资产页同步更新余额但保留账户编辑草稿，隐藏后停止刷新', function () {
  setup()
  var p = loadPage('assets'); p.onLoad(); p.onShow()
  p.editAccount({ currentTarget: { dataset: { id: 'acc_wechat' } } })
  p.onEditName({ detail: { value: '编辑中的昵称' } })
  add({ amount: 100 })
  assert.strictEqual(p.data.accounts.find(function (a) { return a.id === 'acc_wechat' }).balance, -100)
  assert.strictEqual(p.data.editName, '编辑中的昵称')
  p.onHide()
  add({ amount: 200 })
  assert.strictEqual(p.data.accounts.find(function (a) { return a.id === 'acc_wechat' }).balance, -100)
  p.onShow()
  assert.strictEqual(p.data.accounts.find(function (a) { return a.id === 'acc_wechat' }).balance, -300)
  p.onUnload()
})
test('删除全部账户后重启仍为空，云端较新空列表也能正确清空', function () {
  var s = setup()
  db.saveAccounts(s.ledger.id, [])
  assert.deepStrictEqual(db.accountsOf(s.ledger.id), [])
  db.init()
  assert.deepStrictEqual(db.accountsOf(s.ledger.id), [])
  db.saveAccounts(s.ledger.id, [{ id: 'test', name: '测试账户', type: 'cash', initialBalance: 0 }])
  db.applyRemoteLedger({ id: s.ledger.id, accounts: [], cfgAt: new Date(Date.now() + 60000).toISOString() })
  db.flush()
  assert.deepStrictEqual(db.accountsOf(s.ledger.id), [])
  db.init()
  assert.deepStrictEqual(db.accountsOf(s.ledger.id), [])
})
test('云端新账本明确空账户不会生成默认账户，缺失字段仍兼容老数据', function () {
  setup()
  db.applyRemoteLedger({ id: 'remote-empty', accounts: [], members: [] })
  db.applyRemoteLedger({ id: 'remote-old', members: [] })
  assert.deepStrictEqual(db.accountsOf('remote-empty'), [])
  assert.ok(db.accountsOf('remote-old').length > 0)
})
test('预算日均与月末估算按自然日计算，未来已记支出单独计入', function () {
  var insight = require('../utils/budget-insight.js')
  var result = insight.calculate(100000, [
    { type: 'expense', amount: 20000, date: '2026-10-01' },
    { type: 'expense', amount: 10000, date: '2026-10-31' },
    { type: 'income', amount: 900000, date: '2026-10-01' },
    { type: 'transfer', amount: 900000, date: '2026-10-01' },
    { type: 'expense', amount: 900000, date: '2026-09-30' }
  ], new Date(2026, 9, 10))
  assert.strictEqual(result.remaining, 70000)
  assert.strictEqual(result.daysLeft, 22)
  assert.strictEqual(result.dailyAvailable, 3181)
  assert.strictEqual(result.projected, 72000)
  assert.strictEqual(result.futureExpense, 10000)
})
test('预算超支日均不为负，月底和闰年剩余天数正确', function () {
  var insight = require('../utils/budget-insight.js')
  var r = insight.calculate(100, [{ type: 'expense', amount: 200, date: '2024-02-29' }], new Date(2024, 1, 29))
  assert.strictEqual(r.daysLeft, 1)
  assert.strictEqual(r.dailyAvailable, 0)
  assert.strictEqual(r.remaining, -100)
  assert.strictEqual(insight.calculate(0, [], new Date()).enabled, false)
})
test('本月有消费时仍可给零消费分类设置预算，展示自定义分类名称', function () {
  var s = setup()
  db.saveCategories(s.ledger.id, 'expense', [{ key: 'pet', name: '猫咪', icon: '🐱' }, { key: 'food', name: '吃饭', icon: '🍜' }])
  add({ date: u.dateStr(new Date()), category: 'food' })
  db.saveBudget(s.ledger.id, { monthlyTotal: 100000, categoryBudgets: { pet: 10000 } })
  var p = loadPage('budget'); p.onLoad()
  assert.ok(p.data.expCategories.some(function (c) { return c.key === 'pet' }))
  assert.strictEqual(p.data.categoryBudgets[0].name, '猫咪')
})
test('资产汇总按实际正负余额拆分，筛选包含转入流水', function () {
  var s=setup();db.saveAccounts(s.ledger.id,[{id:'a',type:'bank',name:'储蓄',initialBalance:10000},{id:'b',type:'credit',name:'信用卡',initialBalance:-3000}])
  add({type:'transfer',accountId:'a',transferTo:'b',amount:1000})
  var p=loadPage('assets');p.onLoad()
  assert.strictEqual(p.data.totalAssetsText,'90.00');assert.strictEqual(p.data.totalDebtText,'20.00')
  p.filterAccount({currentTarget:{dataset:{id:'b'}}})
  assert.strictEqual(p.data.records.length,1);assert.strictEqual(p.data.recordGroups[0].records[0].amountText,'+10.00')
})
test('余额校准使用保存时最新流水，保留历史且不增加收支', function () {
  var s=setup();var p=loadPage('assets');p.onLoad()
  p.calibrateAccount({currentTarget:{dataset:{id:'acc_wechat'}}})
  p.onEditInitial({detail:{value:'100'}})
  add({accountId:'acc_wechat',amount:2000})
  p.saveAccount()
  assert.strictEqual(db.assetSummary(s.ledger.id).accounts.find(a=>a.id==='acc_wechat').balance,10000)
  assert.strictEqual(db.recordsOf(s.ledger.id).length,1)
  assert.strictEqual(db.accountsOf(s.ledger.id).find(a=>a.id==='acc_wechat').initialBalance,12000)
})
if (failures) process.exitCode = 1
