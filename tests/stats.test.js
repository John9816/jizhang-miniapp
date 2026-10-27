/**
 * 统计/预算/资产/周期记账/CSV 单元测试（纯函数，Node 直跑）
 * 运行：node tests/stats.test.js
 */
var assert = require('assert')
var u = require('../utils/util.js')

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

function rec(over) {
  return Object.assign({
    id: 'R', ledgerId: 'L', memberId: 'm1', memberName: '我',
    type: 'expense', amount: 100, category: 'food', date: '2026-10-15', note: ''
  }, over || {})
}

console.log('stats.test:')

/* ---------- 周期 ---------- */

test('periodOf 月：起止与前后月', function () {
  var p = u.periodOf('month', '2026-10-18')
  assert.strictEqual(p.start, '2026-10-01')
  assert.strictEqual(p.end, '2026-10-31')
  assert.strictEqual(p.label, '2026年10月')
  assert.strictEqual(p.prevKey, '2026-09')
  assert.strictEqual(p.nextKey, '2026-11')
  var feb = u.periodOf('month', '2026-02-10')
  assert.strictEqual(feb.end, '2026-02-28')
  var febLeap = u.periodOf('month', '2028-02-10')
  assert.strictEqual(febLeap.end, '2028-02-29')
})

test('weekStart 周一为起点、跨月跨年正确', function () {
  assert.strictEqual(u.weekStart('2026-10-18'), '2026-10-12') // 周日 → 上周一
  assert.strictEqual(u.weekStart('2026-10-12'), '2026-10-12') // 周一
  assert.strictEqual(u.weekStart('2026-01-01'), '2025-12-29') // 周四 → 去年周一
  assert.strictEqual(u.shiftWeek('2026-01-01', -1), '2025-12-22')
})

test('periodOf 年 / custom / week', function () {
  var y = u.periodOf('year', '2026-10-18')
  assert.strictEqual(y.start, '2026-01-01')
  assert.strictEqual(y.end, '2026-12-31')
  var w = u.periodOf('week', '2026-10-18')
  assert.strictEqual(w.start, '2026-10-12')
  assert.strictEqual(w.end, '2026-10-18')
  var c = u.periodOf('custom', '2026-10-18', { start: '2026-10-01', end: '2026-10-07' })
  assert.strictEqual(c.start, '2026-10-01')
  assert.strictEqual(c.label, '10/01 ~ 10/07')
})

/* ---------- 分类统计 ---------- */

test('categoryStats：占比按类型内计算、排序、排除转账', function () {
  var recs = [
    rec({ amount: 3000, category: 'food' }),
    rec({ amount: 1000, category: 'food' }),
    rec({ amount: 2000, category: 'transport' }),
    rec({ amount: 5000, category: 'salary', type: 'income' }),
    rec({ amount: 9999, type: 'transfer', category: 'transfer' })
  ]
  var list = u.categoryStats(recs, 'expense')
  assert.strictEqual(list.length, 2)
  assert.strictEqual(list[0].key, 'food')
  assert.strictEqual(list[0].amount, 4000)
  assert.strictEqual(list[0].count, 2)
  assert.strictEqual(list[0].pct, 66.7) // 4000/6000，保留一位小数
  assert.strictEqual(list[1].key, 'transport')
  assert.strictEqual(list[1].pct, 33.3)
  assert.strictEqual(u.categoryStats(recs, 'expense')[0].name, '餐饮')
})

/* ---------- 趋势序列 ---------- */

test('trendSeries 按日补齐空缺、按周聚合', function () {
  var recs = [
    rec({ amount: 1000, date: '2026-10-12' }),
    rec({ amount: 2000, date: '2026-10-12' }),
    rec({ amount: 1500, date: '2026-10-15', type: 'income', category: 'salary' })
  ]
  var day = u.trendSeries(recs, '2026-10-12', '2026-10-14', 'day')
  assert.strictEqual(day.length, 3)
  assert.strictEqual(day[0].expense, 3000)
  assert.strictEqual(day[2].expense, 0)
  var week = u.trendSeries(recs, '2026-10-12', '2026-10-18', 'week')
  assert.strictEqual(week.length, 1)
  assert.strictEqual(week[0].expense, 3000)
  assert.strictEqual(week[0].income, 1500)
})

/* ---------- 日历 ---------- */

test('calendarMonth：天数、星期占位、今日标记', function () {
  var recs = [rec({ amount: 800, date: '2026-10-18', type: 'expense' })]
  var cal = u.calendarMonth('2026-10', recs)
  assert.strictEqual(cal.days.length, 35)
  assert.strictEqual(cal.days[0].date, '2026-09-27')
  assert.strictEqual(cal.days[0].inMonth, false)
  assert.strictEqual(cal.days[4].date, '2026-10-01')
  assert.strictEqual(cal.days[4].weekday, 4)
  assert.strictEqual(cal.days[4].inMonth, true)
  assert.strictEqual(cal.days[21].date, '2026-10-18')
  assert.strictEqual(cal.days[21].expense, 800)
  assert.strictEqual(cal.days[21].income, 0)
  assert.strictEqual(cal.days[34].date, '2026-10-31')
  var feb = u.calendarMonth('2026-02', [])
  assert.strictEqual(feb.days.length, 28, '月初恰好周日且当月恰好四周时无需额外占位')
  assert.strictEqual(feb.days.filter(function (d) { return d.inMonth }).length, 28)
  var leap = u.calendarMonth('2028-02', [])
  assert.strictEqual(leap.days.filter(function (d) { return d.inMonth }).length, 29)
  assert.strictEqual(leap.days.length % 7, 0)
  assert.strictEqual(new Set(leap.days.map(function (d) { return d.date })).size, leap.days.length)
})

/* ---------- 预算 ---------- */

test('budgetStatus：总预算、分类预算、超支、排序', function () {
  var recs = [
    rec({ amount: 80000, category: 'food' }),  // 餐饮 800
    rec({ amount: 30000, category: 'transport' }), // 交通 300
    rec({ amount: 50000, category: 'salary', type: 'income' })
  ]
  var budget = {
    monthlyTotal: 100000,
    categoryBudgets: { food: 100000, transport: 200000 }
  }
  var st = u.budgetStatus(budget, recs, function (k) { return { name: 'X' } })
  assert.strictEqual(st.total.used, 110000)
  assert.strictEqual(st.total.limit, 100000)
  assert.strictEqual(st.total.over, true)
  assert.strictEqual(st.items.length, 2)
  assert.strictEqual(st.items[0].key, 'food') // 80% > 15%，排第一
  assert.strictEqual(st.items[0].pct, 80)
  assert.strictEqual(st.items[1].key, 'transport')
  assert.strictEqual(st.items[1].pct, 15)
  var none = u.budgetStatus({}, recs)
  assert.strictEqual(none.total, null)
  assert.strictEqual(none.items.length, 0)
})

/* ---------- 资产 ---------- */

test('accountBalance：收入/支出/转入/转出', function () {
  var recs = [
    rec({ amount: 10000, type: 'income', accountId: 'a1' }),
    rec({ amount: 3000, type: 'expense', accountId: 'a1' }),
    rec({ amount: 2000, type: 'expense', accountId: 'a2' }),
    rec({ amount: 5000, type: 'transfer', accountId: 'a1', transferTo: 'a2' })
  ]
  assert.strictEqual(u.accountBalance({ id: 'a1', initialBalance: 100000 }, recs), 102000) // 1000+100-30-50
  assert.strictEqual(u.accountBalance({ id: 'a2', initialBalance: 0 }, recs), 3000) // +50-20
  assert.strictEqual(u.accountBalance({ id: 'a1', initialBalance: 0 }, []), 0)
})

/* ---------- 周期记账 ---------- */

test('nextRunDate：周/月/季/年', function () {
  assert.strictEqual(u.nextRunDate({ cycle: 'weekly', lastRunAt: '2026-10-18T10:00:00.000Z' }), '2026-10-25')
  assert.strictEqual(u.nextRunDate({ cycle: 'monthly', nextDate: '2026-01-31' }), '2026-02-28')
  assert.strictEqual(u.nextRunDate({ cycle: 'quarterly', nextDate: '2026-11-30' }), '2027-02-28')
  assert.strictEqual(u.nextRunDate({ cycle: 'yearly', nextDate: '2026-10-18' }), '2027-10-18')
  assert.strictEqual(u.nextRunDate({ cycle: 'monthly', nextDate: '2028-01-31' }), '2028-02-29')
})

test('dueRecurring：到期与暂停', function () {
  var today = '2026-10-18'
  var rules = [
    { id: 'r1', nextDate: '2026-10-18', paused: false },
    { id: 'r2', nextDate: '2026-10-20', paused: false },
    { id: 'r3', nextDate: '2026-10-01', paused: true },
    { id: 'r4', nextDate: '2026-10-17', paused: false }
  ]
  var due = u.dueRecurring(rules, today)
  assert.strictEqual(due.length, 2)
  assert.strictEqual(due[0].id, 'r1') // 保持规则数组顺序
  assert.strictEqual(due[1].id, 'r4')
})

/* ---------- CSV ---------- */

test('recordsToCSV：BOM、表头、转义、转账行', function () {
  var recs = [
    rec({ amount: 3200, note: '午餐,"公司"食堂' }),
    rec({ amount: 5000, type: 'income', category: 'salary', note: '' })
  ]
  var csv = u.recordsToCSV(recs, '家庭账本')
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF)
  var lines = csv.split('\n')
  assert.strictEqual(lines[0], '\ufeff账本,家庭账本')
  assert.strictEqual(lines[1], '日期,类型,分类,金额(元),账户,备注,记录人')
  assert.strictEqual(lines[2], '2026-10-15,支出,餐饮,-32.00,,"午餐,""公司""食堂",我')
  assert.strictEqual(lines[3], '2026-10-15,收入,工资,+50.00,,,我')
})

console.log('\n' + passed + ' tests passed')
