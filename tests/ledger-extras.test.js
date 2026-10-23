/**
 * 账本级新模型单测：账户 / 预算 / 周期记账 / 自定义分类 / 搜索 / 导出 / 远端合并。
 * 运行：node tests/ledger-extras.test.js
 */
var assert = require('assert')
var fs = require('fs')
var path = require('path')

/* ---- 最小 wx mock（复用 cloud.test 的模式） ---- */
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

console.log('ledger-extras.test:')

/* ---------------- 账户 ---------------- */

test('新账本默认带 4 个账户；资产汇总按收支转账计余额', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  assert.strictEqual(db.accountsOf(L).length, 4)
  db.addRecord({ ledgerId: L, type: 'income', amount: 10000, category: 'salary', date: '2026-10-01', accountId: 'acc_wechat' })
  db.addRecord({ ledgerId: L, type: 'expense', amount: 3200, category: 'food', date: '2026-10-02', accountId: 'acc_wechat' })
  db.addTransfer({ ledgerId: L, fromId: 'acc_wechat', toId: 'acc_bank', toName: '储蓄卡', amount: 5000, date: '2026-10-03' })
  var s = db.assetSummary(L)
  var wechat = s.accounts.filter(function (a) { return a.id === 'acc_wechat' })[0]
  var bank = s.accounts.filter(function (a) { return a.id === 'acc_bank' })[0]
  assert.strictEqual(wechat.balance, 1800) // 100 - 32 - 50
  assert.strictEqual(bank.balance, 5000)
  assert.strictEqual(s.netWorth, 6800)
})

test('saveAccounts：裁剪长度、排序、非法项过滤', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var out = db.saveAccounts(L, [
    { name: '招行卡', type: 'bank', initialBalance: 12345 },
    { name: '', type: 'cash' },
    { name: '公交卡', type: 'other', initialBalance: 5000 }
  ])
  assert.strictEqual(out.length, 2)
  assert.strictEqual(out[0].name, '招行卡')
  assert.strictEqual(out[0].initialBalance, 12345)
  assert.strictEqual(out[1].name, '公交卡')
  assert.strictEqual(db.accountsOf(L)[0].name, '招行卡')
})

test('资产汇总：房产/车产按估值计入固定资产分组，信用卡进负债分组', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  // 现金 5000 + 房产估值 2000000 + 车产估值 80000 + 信用卡 -3000
  db.saveAccounts(L, [
    { name: '现金', type: 'cash', initialBalance: 500000 },
    { name: '自住房', type: 'house', initialBalance: 200000000 },
    { name: '家用车', type: 'car', initialBalance: 8000000 },
    { name: '招行信用卡', type: 'credit', initialBalance: -300000 }
  ])
  var s = db.assetSummary(L)
  assert.strictEqual(s.netWorth, 500000 + 200000000 + 8000000 - 300000)
  var byGroup = {}
  s.groups.forEach(function (g) { byGroup[g.key] = g })
  assert.strictEqual(byGroup.fixed.total, 208000000) // 房产 + 车产
  assert.strictEqual(byGroup.fixed.accounts.length, 2)
  assert.strictEqual(byGroup.debt.total, -300000)
  assert.strictEqual(byGroup.fund.total, 500000)
  var house = byGroup.fixed.accounts.filter(function (a) { return a.type === 'house' })[0]
  assert.strictEqual(house.isFixed, true)
  assert.strictEqual(house.typeName, '房产')
  // 记账页已屏蔽固定资产账户；db 层仍按余额公式计算（防御性，UI 上不应发生）
  db.addRecord({ ledgerId: L, type: 'expense', amount: 1000, category: 'food', date: '2026-10-05', accountId: house.id })
  assert.strictEqual(db.assetSummary(L).groups.filter(function (g) { return g.key === 'fixed' })[0].total, 208000000 - 1000)
})

test('转账校验：同账户、缺目标被拒绝', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  assert.strictEqual(db.addTransfer({ ledgerId: L, fromId: 'acc_wechat', toId: 'acc_wechat', amount: 100, date: '2026-10-01' }), null)
  assert.strictEqual(db.addTransfer({ ledgerId: L, fromId: 'acc_wechat', toId: '', amount: 100, date: '2026-10-01' }), null)
  assert.ok(db.addTransfer({ ledgerId: L, fromId: 'acc_wechat', toId: 'acc_bank', amount: 100, date: '2026-10-01' }))
})

/* ---------------- 预算 ---------------- */

test('saveBudget / budgetOf：限额裁剪、零值清理', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  db.saveBudget(L, { monthlyTotal: 300000, categoryBudgets: { food: 100000, transport: -5 } })
  var b = db.budgetOf(L)
  assert.strictEqual(b.monthlyTotal, 300000)
  assert.strictEqual(b.categoryBudgets.food, 100000)
  assert.strictEqual(b.categoryBudgets.transport, undefined)
})

/* ---------------- 周期记账 ---------------- */

test('周期规则：创建、暂停、删除', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var r = db.addRecurring(L, { name: '房租', amount: 250000, type: 'expense', category: 'home', cycle: 'monthly', nextDate: '2026-11-01' })
  assert.strictEqual(r.name, '房租')
  assert.strictEqual(db.recurringList(L).length, 1)
  assert.strictEqual(db.toggleRecurring(L, r.id), true) // 暂停
  assert.strictEqual(db.recurringList(L)[0].paused, true)
  assert.strictEqual(db.toggleRecurring(L, r.id), false) // 恢复
  assert.strictEqual(db.removeRecurring(L, r.id), true)
  assert.strictEqual(db.recurringList(L).length, 0)
})

test('runDueRecurring：到期执行、幂等、nextDate 推进、暂停跳过', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  db.addRecurring(L, { name: '工资', amount: 1500000, type: 'income', category: 'salary', cycle: 'monthly', nextDate: '2026-10-01' })
  var first = db.runDueRecurring(L, '2026-10-18')
  assert.strictEqual(first.length, 1)
  var rec = db.getRecord(first[0])
  assert.strictEqual(rec.amount, 1500000)
  assert.strictEqual(rec.date, '2026-10-01')
  assert.strictEqual(rec.note.indexOf('工资'), 0)
  var again = db.runDueRecurring(L, '2026-10-18')
  assert.strictEqual(again.length, 0, '重复执行不应产生新记录（幂等）')
  assert.strictEqual(db.recurringList(L)[0].nextDate, '2026-11-01')
  assert.strictEqual(db.recordsOf(L).length, 1)
  // 错过多个周期：补记并连续推进
  db.addRecurring(L, { name: '水电', amount: 20000, type: 'expense', category: 'home', cycle: 'monthly', nextDate: '2026-08-01' })
  var many = db.runDueRecurring(L, '2026-10-18')
  assert.strictEqual(many.length, 3) // 8月、9月、10月
  assert.strictEqual(db.recurringList(L)[1].nextDate, '2026-11-01')
})

/* ---------------- 自定义分类 ---------------- */

test('自定义分类：优先、回退、保留另一类型', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  assert.strictEqual(db.categoriesOf(L, 'expense').length, 15, '无自定义时回退内置（含水电气物业话费）')
  db.saveCategories(L, 'expense', [
    { name: '房租', icon: '🏠' },
    { name: '干饭', icon: '🍚' }
  ])
  var cs = db.categoriesOf(L, 'expense')
  assert.strictEqual(cs.length, 2)
  assert.strictEqual(cs[0].name, '房租')
  assert.strictEqual(cs[0].custom, true)
  assert.ok(cs[0].key, '自定义分类应生成 key')
  assert.strictEqual(db.categoriesOf(L, 'income').length, 6, '收入类型不受影响')
  // 用自定义分类记账后，搜索能按名称命中
  db.addRecord({ ledgerId: L, type: 'expense', amount: 250000, category: cs[0].key, date: '2026-10-05', note: '10月房租' })
  assert.strictEqual(db.searchRecords(L, { q: '房租' }).length, 1)
  assert.strictEqual(db.searchRecords(L, { q: '干饭' }).length, 0)
})

/* ---------------- 搜索 ---------------- */

test('searchRecords：关键词/分类/成员/日期/金额区间', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  db.addRecord({ ledgerId: L, type: 'expense', amount: 3200, category: 'food', date: '2026-10-02', note: '午餐' })
  db.addRecord({ ledgerId: L, type: 'expense', amount: 250000, category: 'home', date: '2026-10-05', note: '房租' })
  db.addRecord({ ledgerId: L, type: 'income', amount: 1500000, category: 'salary', date: '2026-10-10', note: '' })
  assert.strictEqual(db.searchRecords(L, { q: '午餐' }).length, 1)
  assert.strictEqual(db.searchRecords(L, { q: '房租' }).length, 1)
  assert.strictEqual(db.searchRecords(L, { q: '不存在' }).length, 0)
  assert.strictEqual(db.searchRecords(L, { q: '餐饮' }).length, 1, '可按分类名搜索')
  assert.strictEqual(db.searchRecords(L, { type: 'income' }).length, 1)
  assert.strictEqual(db.searchRecords(L, { category: 'home' }).length, 1)
  assert.strictEqual(db.searchRecords(L, { minAmount: 100000, maxAmount: 300000 }).length, 1)
  assert.strictEqual(db.searchRecords(L, { start: '2026-10-04', end: '2026-10-06' }).length, 1)
  assert.strictEqual(db.searchRecords(L, { memberId: db.getMe().id }).length, 3)
  var sorted = db.searchRecords(L, {})
  assert.strictEqual(sorted[0].date, '2026-10-10', '结果按日期倒序')
})

/* ---------------- 导出 ---------------- */

test('exportCSV：含账户名、转账目标名、排除已删', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  db.addRecord({ ledgerId: L, type: 'expense', amount: 3200, category: 'food', date: '2026-10-02', note: '午餐', accountId: 'acc_wechat' })
  db.addTransfer({ ledgerId: L, fromId: 'acc_wechat', toId: 'acc_bank', toName: '储蓄卡', amount: 5000, date: '2026-10-03' })
  var r3 = db.addRecord({ ledgerId: L, type: 'expense', amount: 1000, category: 'food', date: '2026-10-04', note: '将被删除' })
  db.deleteRecord(r3.id)
  var csv = db.exportCSV(L)
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF)
  assert.strictEqual(csv.indexOf('微信钱包') >= 0, true)
  assert.strictEqual(csv.indexOf('转账,转账至 储蓄卡') >= 0, true)
  assert.strictEqual(csv.indexOf('将被删除'), -1, '已删除记录不进导出')
})

/* ---------------- 远端合并 ---------------- */

test('applyRemoteLedger：按 cfgAt LWW 合并账本级配置', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  db.saveBudget(L, { monthlyTotal: 100000 })
  var before = db.budgetOf(L).monthlyTotal
  // 旧配置不覆盖本地
  db.applyRemoteLedger({
    id: L, name: 'x', ownerId: 'remote', ownerName: '远端', createdAt: '2020-01-01T00:00:00.000Z',
    members: [{ id: 'remote', name: '远端', joinedAt: '2020-01-01T00:00:00.000Z' }],
    budget: { monthlyTotal: 999 },
    accounts: [], recurring: [], categories: [],
    cfgAt: '2020-01-01T00:00:00.000Z'
  })
  assert.strictEqual(db.budgetOf(L).monthlyTotal, before, '旧 cfgAt 不得覆盖本地配置')
  // 新配置覆盖
  db.applyRemoteLedger({
    id: L, name: 'x', ownerId: 'remote', ownerName: '远端', createdAt: '2020-01-01T00:00:00.000Z',
    members: [{ id: 'remote', name: '远端', joinedAt: '2020-01-01T00:00:00.000Z' }],
    budget: { monthlyTotal: 500000, categoryBudgets: { food: 100000 } },
    accounts: [{ id: 'acc_cash', name: '现金', type: 'cash', initialBalance: 520000 }],
    recurring: [{ id: 'rr1', name: '房租', amount: 250000, cycle: 'monthly', nextDate: '2026-11-01' }],
    categories: [{ key: 'c1', name: '房租', icon: '🏠', type: 'expense' }],
    cfgAt: new Date(Date.now() + 60000).toISOString()
  })
  assert.strictEqual(db.budgetOf(L).monthlyTotal, 500000)
  assert.strictEqual(db.budgetOf(L).categoryBudgets.food, 100000)
  assert.strictEqual(db.accountsOf(L)[0].initialBalance, 520000)
  assert.strictEqual(db.recurringList(L)[0].name, '房租')
  assert.strictEqual(db.categoriesOf(L, 'expense')[0].name, '房租')
})

test('exportLedgersForSync 携带账本级配置与 cfgAt', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  db.saveBudget(L, { monthlyTotal: 200000 })
  var pushed = db.exportLedgersForSync()[0]
  assert.strictEqual(pushed.budget.monthlyTotal, 200000)
  assert.ok(Array.isArray(pushed.accounts))
  assert.ok(pushed.cfgAt)
})

/* ---------------- 账本封面 ---------------- */

test('新建账本可指定封面；listLedgers 返回归一化封面，旧账本兜底默认', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var old = db.currentLedger().id
  var created = db.createLedger('旅行账本', { kind: 'preset', key: 'travel' })
  var L = created.id
  assert.strictEqual(db.getLedger(L).cover.key, 'travel')
  var list = db.listLedgers()
  var hit = list.filter(function (l) { return l.id === L })[0]
  assert.strictEqual(hit.cover.emoji, '✈️')
  assert.ok(hit.cover.gradient)
  // init 创建的老账本没有 cover 字段，兜底为默认预设
  var oldHit = list.filter(function (l) { return l.id === old })[0]
  assert.strictEqual(oldHit.cover.kind, 'preset')
  assert.strictEqual(oldHit.cover.key, 'default')
  assert.strictEqual(oldHit.cover.emoji, '📒')
})

test('setLedgerCover：切换自定义图片封面并刷新 cfgAt', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  var before = db.getLedger(L).cfgAt
  var img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg'
  db.setLedgerCover(L, { kind: 'image', image: img })
  var cover = db.getLedger(L).cover
  assert.strictEqual(cover.kind, 'image')
  assert.strictEqual(cover.image, img)
  assert.ok(db.getLedger(L).cfgAt >= before)
  // 不存在的账本静默返回，不抛异常
  assert.strictEqual(db.setLedgerCover('L_nope', { kind: 'preset', key: 'piggy' }), null)
})

test('分享包导入携带封面（预设与自定义图片）', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var created = db.createLedger('家庭账本', { kind: 'preset', key: 'home' })
  var L = created.id
  db.setLedgerCover(L, { kind: 'image', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' })
  var pkg = db.sharePackage(L)
  db.deleteLedger(L)
  var r = db.importSharePackage(pkg)
  assert.ok(r.ok)
  var cover = db.getLedger(L).cover
  assert.strictEqual(cover.kind, 'image')
  assert.ok(/^data:image\//.test(cover.image))
})

test('applyRemoteLedger：封面按 cfgAt LWW 合并，旧的远端配置不覆盖本地新封面', function () {
  var db = freshDbModule()
  store = {}
  db.init()
  var L = db.currentLedger().id
  db.setLedgerCover(L, { kind: 'preset', key: 'star' })
  // 远端 cfgAt 更旧：不覆盖
  db.applyRemoteLedger({
    id: L, name: '远端账本', ownerId: 'remote', ownerName: '远端',
    createdAt: '2020-01-01T00:00:00.000Z',
    cover: { kind: 'preset', key: 'piggy' },
    members: [],
    cfgAt: '2020-01-01T00:00:00.000Z'
  })
  assert.strictEqual(db.getLedger(L).cover.key, 'star')
  // 远端 cfgAt 更新：采用远端封面
  db.applyRemoteLedger({
    id: L, name: '远端账本', ownerId: 'remote', ownerName: '远端',
    createdAt: '2020-01-01T00:00:00.000Z',
    cover: { kind: 'image', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' },
    members: [],
    cfgAt: new Date(Date.now() + 60000).toISOString()
  })
  assert.strictEqual(db.getLedger(L).cover.kind, 'image')
})

console.log('\n' + passed + ' tests passed')
