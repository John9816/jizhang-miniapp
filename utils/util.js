/**
 * 纯工具函数：分类、金额格式化、月份处理、分组统计、分享包编解码。
 * 不依赖 wx / document / window，可在 Node 下直接 require 做单元测试。
 */

var EXPENSE_CATEGORIES = [
  { key: 'food', name: '餐饮', icon: '🍜' },
  { key: 'shopping', name: '购物', icon: '🛍️' },
  { key: 'transport', name: '交通', icon: '🚌' },
  { key: 'home', name: '日用', icon: '🧴' },
  { key: 'water', name: '水费', icon: '💧' },
  { key: 'electric', name: '电费', icon: '⚡' },
  { key: 'gas', name: '燃气费', icon: '🔥' },
  { key: 'property', name: '物业费', icon: '🏢' },
  { key: 'phonebill', name: '话费', icon: '📞' },
  { key: 'fun', name: '娱乐', icon: '🎮' },
  { key: 'phone', name: '通讯', icon: '📱' },
  { key: 'social', name: '人情', icon: '🧧' },
  { key: 'study', name: '学习', icon: '📚' },
  { key: 'medical', name: '医疗', icon: '💊' },
  { key: 'other_out', name: '其他', icon: '✨' }
]

var INCOME_CATEGORIES = [
  { key: 'salary', name: '工资', icon: '💰' },
  { key: 'invest', name: '理财', icon: '📈' },
  { key: 'parttime', name: '兼职', icon: '💼' },
  { key: 'redpacket', name: '红包', icon: '🧧' },
  { key: 'reimburse', name: '报销', icon: '🧾' },
  { key: 'other_in', name: '其他', icon: '✨' }
]

/** 分类图标底色：浅色系，与奶油黄主题协调 */
var CATEGORY_TINTS = {
  food: '#FFEFD2', shopping: '#FDE6DC', transport: '#E3EEFF', home: '#EAF4E2',
  water: '#DDEFF6', electric: '#FFF0BE', gas: '#FFE1CC', property: '#E3E8F6',
  phonebill: '#E0F1E5',
  fun: '#FBE6F1', phone: '#E7F0FF', social: '#FFE6E2', study: '#EFE9FF',
  medical: '#FFE8E6', other_out: '#F0EDE3',
  salary: '#FFEFC8', invest: '#E4F6E9', parttime: '#E8EFFF', redpacket: '#FFE6E2',
  reimburse: '#E9F0FF', other_in: '#F0EDE3', transfer: '#EDEAE0'
}

function categoryTint(key) {
  return CATEGORY_TINTS[key] || '#F3EFE4'
}

/** 时段问候 */
function greeting(d) {
  var h = (d || new Date()).getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/** '2026-09-20' → '9月20日' */
function cnDate(dateStrValue) {
  var s = String(dateStrValue || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return parseInt(s.slice(5, 7), 10) + '月' + parseInt(s.slice(8, 10), 10) + '日'
}

function categoriesFor(type) {
  return type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES
}

function categoryOf(type, key) {
  var list = categoriesFor(type)
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === key) return list[i]
  }
  return list[0]
}

function categoryIcon(type, key) {
  return categoryOf(type, key).icon
}

function categoryName(type, key) {
  return categoryOf(type, key).name
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

/** 用户输入的元字符串 → 分为单位的整数；非法返回 0 */
function yuanToCents(input) {
  var s = String(input == null ? '' : input).trim().replace(/\.$/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 0
  var parts = s.split('.')
  var frac = parts[1] || ''
  frac = (frac + '00').slice(0, 2)
  return parseInt(parts[0], 10) * 100 + parseInt(frac, 10)
}

/** 分为单位整数 → "1,234.56" */
function formatCents(cents) {
  var n = Math.round(Number(cents) || 0)
  var sign = n < 0 ? '-' : ''
  var s = (Math.abs(n) / 100).toFixed(2)
  var seg = s.split('.')
  var intPart = seg[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return sign + intPart + '.' + seg[1]
}

/** 带正负号的金额文本，收入为 +，支出为 - */
function signedText(cents, type) {
  return (type === 'income' ? '+' : '-') + formatCents(cents)
}

function dateStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function currentMonthKey() {
  var d = new Date()
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1)
}

/** '2026-01' 前后平移 delta 个月 */
function shiftMonth(key, delta) {
  var y = parseInt(String(key).slice(0, 4), 10)
  var m = parseInt(String(key).slice(5, 7), 10) + delta
  y += Math.floor((m - 1) / 12)
  m = ((m - 1) % 12 + 12) % 12 + 1
  return y + '-' + pad2(m)
}

function formatMonth(key) {
  return parseInt(String(key).slice(0, 4), 10) + '年' + parseInt(String(key).slice(5, 7), 10) + '月'
}

var WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']

/** createdAt 兼容数字时间戳 / 数字字符串 / ISO 字符串 → 毫秒数（用于排序） */
function tsOf(v) {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return Number(v)
    var t = Date.parse(v)
    if (!isNaN(t)) return t
  }
  return 0
}

/** createdAt → 本地「HH:mm」；无法解析时返回空串（页面自行隐藏） */
function hmText(v) {
  var t = tsOf(v)
  if (!t) return ''
  var d = new Date(t)
  if (isNaN(d.getTime())) return ''
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** 按日期分组（倒序），并附组内小计与展示文本（转账不计收支） */
function groupByDate(records) {
  var map = {}
  var i
  for (i = 0; i < records.length; i++) {
    var r = records[i]
    if (!map[r.date]) {
      map[r.date] = { date: r.date, records: [], income: 0, expense: 0 }
    }
    var g = map[r.date]
    g.records.push(r)
    if (r.type === 'income') g.income += r.amount
    else if (r.type !== 'transfer') g.expense += r.amount
  }
  var today = dateStr(new Date())
  var yesterday = dateStr(new Date(Date.now() - 86400000))
  var keys = Object.keys(map).sort(function (a, b) { return a < b ? 1 : -1 })
  var groups = []
  for (i = 0; i < keys.length; i++) {
    var k = keys[i]
    var grp = map[k]
    // createdAt 可能是数字（本地新建）或 ISO 字符串（云同步回填），统一转毫秒再排序
    grp.records.sort(function (a, b) { return tsOf(b.createdAt) - tsOf(a.createdAt) })
    var mm = parseInt(k.slice(5, 7), 10)
    var dd = parseInt(k.slice(8, 10), 10)
    var wd = '周' + WEEKDAY_NAMES[new Date(parseInt(k.slice(0, 4), 10), mm - 1, dd).getDay()]
    // 组头始终带完整日期 + 星期；今天/昨天加前缀便于定位
    var label = mm + '月' + dd + '日 ' + wd
    if (k === today) label = '今天 ' + label
    else if (k === yesterday) label = '昨天 ' + label
    grp.label = label
    grp.incomeText = formatCents(grp.income)
    grp.expenseText = formatCents(grp.expense)
    groups.push(grp)
  }
  return groups
}

/**
 * 成员统计。membersMap: { memberId: { id, name } }
 * 返回 [{ id, name, count, income, expense }]
 */
function memberStats(records, membersMap) {
  var out = []
  var ids = Object.keys(membersMap || {})
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i]
    var recs = []
    for (var j = 0; j < records.length; j++) {
      if (records[j].memberId === id) recs.push(records[j])
    }
    var income = 0
    var expense = 0
    for (j = 0; j < recs.length; j++) {
      if (recs[j].type === 'income') income += recs[j].amount
      else if (recs[j].type !== 'transfer') expense += recs[j].amount
    }
    out.push({
      id: id,
      name: (membersMap[id] && membersMap[id].name) || '成员',
      count: recs.length,
      income: income,
      expense: expense
    })
  }
  out.sort(function (a, b) { return b.count - a.count })
  return out
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/* ---------------- 周期与统计（图表/预算/报表用） ---------------- */

/** '2026-10-18' → 本地 Date（避免 T 时区偏移） */
function parseDate(s) {
  var y = parseInt(String(s).slice(0, 4), 10)
  var m = parseInt(String(s).slice(5, 7), 10)
  var d = parseInt(String(s).slice(8, 10), 10)
  return new Date(y, m - 1, d)
}

function addDays(s, delta) {
  var d = parseDate(s)
  d.setDate(d.getDate() + delta)
  return dateStr(d)
}

/** 周一为一周起点 */
function weekStart(s) {
  var d = parseDate(s)
  var dow = (d.getDay() + 6) % 7
  return dateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow))
}

/** 周 key：'2026-W42'（ISO 周年 + 周数近似，展示够用） */
function weekKey(s) {
  var start = weekStart(s)
  var d = parseDate(start)
  var jan1 = new Date(d.getFullYear(), 0, 1)
  var days = Math.floor((d - jan1) / 86400000)
  var week = Math.floor((days + jan1.getDay() + 1) / 7) + 1
  return d.getFullYear() + '-W' + (week < 10 ? '0' : '') + week
}

function shiftWeek(s, delta) {
  return addDays(weekStart(s), delta * 7)
}

/** 周期定义：period: 'week' | 'month' | 'year' | 'custom'，返回 { key, start, end, label, prevKey, nextKey } */
function periodOf(period, refDate, custom) {
  var d = refDate ? parseDate(refDate) : new Date()
  if (period === 'week') {
    var start = weekStart(dateStr(d))
    var end = addDays(start, 6)
    return { key: start, start: start, end: end, label: start.slice(5).replace('-', '/') + ' ~ ' + end.slice(5).replace('-', '/'), prevKey: shiftWeek(start, -1), nextKey: shiftWeek(start, 1) }
  }
  if (period === 'year') {
    var y = d.getFullYear()
    return { key: String(y), start: y + '-01-01', end: y + '-12-31', label: y + '年', prevKey: String(y - 1), nextKey: String(y + 1) }
  }
  if (period === 'custom' && custom && custom.start && custom.end) {
    return { key: custom.start + '~' + custom.end, start: custom.start, end: custom.end, label: custom.start.slice(5).replace('-', '/') + ' ~ ' + custom.end.slice(5).replace('-', '/'), prevKey: '', nextKey: '' }
  }
  var mk = dateStr(d).slice(0, 7)
  var y2 = parseInt(mk.slice(0, 4), 10)
  var m2 = parseInt(mk.slice(5, 7), 10)
  var lastDay = new Date(y2, m2, 0).getDate()
  return { key: mk, start: mk + '-01', end: mk + '-' + (lastDay < 10 ? '0' : '') + lastDay, label: formatMonth(mk), prevKey: shiftMonth(mk, -1), nextKey: shiftMonth(mk, 1) }
}

function inRange(date, start, end) {
  return date >= start && date <= end
}

/** 汇总（排除转账记录） */
function calcSummary(records) {
  var income = 0
  var expense = 0
  for (var i = 0; i < records.length; i++) {
    var r = records[i]
    if (r.type === 'income') income += r.amount
    else if (r.type !== 'transfer') expense += r.amount
  }
  return { income: income, expense: expense, balance: income - expense }
}

/**
 * 分类统计排行。返回 [{ key, name, amount, count, pct, type }]，按金额降序。
 * meta 可选：{ type:'expense' } 只统计某一类；type:'all' 时分别返回（pct 类型内计算）。
 */
function categoryStats(records, type) {
  var map = {}
  var i
  for (i = 0; i < records.length; i++) {
    var r = records[i]
    if (r.type === 'transfer') continue
    if (type && r.type !== type) continue
    if (!map[r.category]) map[r.category] = { key: r.category, type: r.type, amount: 0, count: 0 }
    map[r.category].amount += r.amount
    map[r.category].count++
  }
  var list = []
  var keys = Object.keys(map)
  var total = 0
  for (i = 0; i < keys.length; i++) total += map[keys[i]].amount
  for (i = 0; i < keys.length; i++) {
    var it = map[keys[i]]
    list.push({
      key: it.key,
      type: it.type,
      name: categoryName(it.type, it.key),
      icon: categoryIcon(it.type, it.key),
      amount: it.amount,
      amountText: formatCents(it.amount),
      count: it.count,
      pct: total > 0 ? Math.round(it.amount * 1000 / total) / 10 : 0
    })
  }
  list.sort(function (a, b) { return b.amount - a.amount })
  return list
}

/** 按日/周聚合的时间序列（趋势图）。granularity: 'day' | 'week' */
function trendSeries(records, start, end, granularity) {
  var points = {}
  var keys = []
  var i
  var cur = granularity === 'week' ? weekStart(start) : start
  var stop = granularity === 'week' ? weekStart(end) : end
  while (cur <= stop) {
    keys.push(cur)
    points[cur] = { income: 0, expense: 0 }
    cur = granularity === 'week' ? addDays(cur, 7) : addDays(cur, 1)
    if (keys.length > 400) break
  }
  for (i = 0; i < records.length; i++) {
    var r = records[i]
    if (r.type === 'transfer') continue
    var k = granularity === 'week' ? weekStart(r.date) : r.date
    if (!points[k]) continue
    if (r.type === 'income') points[k].income += r.amount
    else points[k].expense += r.amount
  }
  return keys.map(function (k) {
    return { key: k, income: points[k].income, expense: points[k].expense, label: granularity === 'week' ? k.slice(5).replace('-', '/') : k.slice(5).replace('-', '/') }
  })
}

/** 环比：current vs previous（同长度周期），返回 { expensePct, incomePct } */
function momChange(current, previous) {
  function pct(a, b) {
    if (!b) return a > 0 ? 100 : 0
    return Math.round((a - b) * 100 / b)
  }
  return { expensePct: pct(current.expense, previous.expense), incomePct: pct(current.income, previous.income) }
}

/** 日历月网格：返回 { days: [{ date, income, expense, isCurrentMonth }], weekdays } */
function calendarMonth(monthKey, records) {
  var y = parseInt(String(monthKey).slice(0, 4), 10)
  var m = parseInt(String(monthKey).slice(5, 7), 10)
  var first = new Date(y, m - 1, 1)
  var daysInMonth = new Date(y, m, 0).getDate()
  var byDate = {}
  var i
  for (i = 0; i < records.length; i++) {
    var r = records[i]
    if (!byDate[r.date]) byDate[r.date] = { income: 0, expense: 0 }
    if (r.type === 'income') byDate[r.date].income += r.amount
    else if (r.type !== 'transfer') byDate[r.date].expense += r.amount
  }
  var days = []
  for (i = 0; i < daysInMonth; i++) {
    var ds = dateStr(new Date(y, m - 1, i + 1))
    var v = byDate[ds] || { income: 0, expense: 0 }
    days.push({
      date: ds,
      day: i + 1,
      weekday: (first.getDay() + i) % 7,
      income: v.income,
      expense: v.expense,
      incomeText: compactAmount(v.income),
      expenseText: compactAmount(v.expense),
      today: ds === dateStr(new Date()),
      inMonth: true
    })
  }
  return { days: days, weekdays: WEEKDAY_NAMES }
}

/* ---------------- 预算 ---------------- */

/**
 * 连续记账天数：从今天起向前数有记录的日子；
 * 今天还没记时从昨天起算（给了用户一整天的时间，不会一早醒来就断）。
 */
function calcStreak(records) {
  var set = {}
  for (var i = 0; i < records.length; i++) {
    if (records[i].type !== 'transfer') set[records[i].date] = true
  }
  var d = new Date()
  if (!set[dateStr(d)]) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
    if (!set[dateStr(d)]) return 0
  }
  var n = 0
  while (set[dateStr(d)]) {
    n++
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
  }
  return n
}

/** 常用分类：按出现频次取前 N 个（快捷记账行用） */
function topCategories(records, type, limit) {
  var count = {}
  for (var i = 0; i < records.length; i++) {
    var r = records[i]
    if (r.type !== type || !r.category) continue
    count[r.category] = (count[r.category] || 0) + 1
  }
  return Object.keys(count)
    .sort(function (a, b) { return count[b] - count[a] })
    .slice(0, limit || 5)
    .map(function (k) {
      return {
        key: k,
        name: categoryName(type, k),
        icon: categoryIcon(type, k),
        tint: categoryTint(k),
        count: count[k]
      }
    })
}

/** 紧凑金额文本：日历格子用。157150 → "1,571.5"；1000000 → "1万"；3000 → "30" */
function compactAmount(cents) {
  var v = Math.abs(Math.round(Number(cents) || 0))
  if (v >= 1000000) { // 满 1 万（100 万分）才折成「万」；100 万以上取整
    var wan = v / 1000000
    return (wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10) + '万'
  }
  var yuan = v / 100
  var t = (Math.round(yuan * 100) / 100).toString()
  return t
}

/**
 * 预算执行状态。budget: { monthlyTotal, categoryBudgets }，records 为当月记录。
 * 返回 { total: { used, limit, pct, over }, items: [{ key,name,used,limit,pct,over }] }（按使用比例降序）
 */
function budgetStatus(budget, records, categoryMeta) {
  budget = budget || {}
  var out = { total: null, items: [] }
  var expense = []
  var i
  for (i = 0; i < records.length; i++) {
    if (records[i].type === 'expense') expense.push(records[i])
  }
  var used = 0
  for (i = 0; i < expense.length; i++) used += expense[i].amount
  var limit = Number(budget.monthlyTotal) || 0
  if (limit > 0) {
    out.total = { used: used, limit: limit, pct: Math.round(used * 100 / limit), over: used > limit }
  }
  var cats = budget.categoryBudgets || {}
  var keys = Object.keys(cats)
  for (i = 0; i < keys.length; i++) {
    var cl = Number(cats[keys[i]]) || 0
    if (cl <= 0) continue
    var cu = 0
    var j
    for (j = 0; j < expense.length; j++) {
      if (expense[j].category === keys[i]) cu += expense[j].amount
    }
    var meta = categoryMeta ? categoryMeta(keys[i]) : null
    out.items.push({
      key: keys[i],
      name: (meta && meta.name) || categoryName('expense', keys[i]),
      icon: (meta && meta.icon) || categoryIcon('expense', keys[i]),
      used: cu,
      limit: cl,
      pct: Math.round(cu * 100 / cl),
      over: cu > cl
    })
  }
  out.items.sort(function (a, b) { return b.pct - a.pct })
  return out
}

/* ---------------- 资产账户 ---------------- */

var ACCOUNT_TYPES = [
  { key: 'cash', name: '现金', icon: '💵', group: 'fund' },
  { key: 'bank', name: '储蓄卡', icon: '🏦', group: 'fund' },
  { key: 'alipay', name: '支付宝', icon: '🅰️', group: 'fund' },
  { key: 'wechat', name: '微信钱包', icon: '💬', group: 'fund' },
  { key: 'house', name: '房产', icon: '🏠', group: 'fixed' },
  { key: 'car', name: '车产', icon: '🚗', group: 'fixed' },
  { key: 'credit', name: '信用卡', icon: '💳', group: 'debt' },
  { key: 'other', name: '其他', icon: '📦', group: 'fund' }
]

/** 账户分组：fund=资金 / fixed=固定资产（房产车产，按估值计） / debt=负债 */
var ACCOUNT_GROUPS = [
  { key: 'fund', name: '资金账户', hint: '现金、银行卡、微信、支付宝等随时可用的钱' },
  { key: 'fixed', name: '固定资产', hint: '房产、车产等，按当前估值计入总资产' },
  { key: 'debt', name: '负债', hint: '信用卡等待还款项，从总资产中扣除' }
]

function accountTypeInfo(key) {
  for (var i = 0; i < ACCOUNT_TYPES.length; i++) {
    if (ACCOUNT_TYPES[i].key === key) return ACCOUNT_TYPES[i]
  }
  return ACCOUNT_TYPES[ACCOUNT_TYPES.length - 1]
}

/** 账户所属分组 key：fund / fixed / debt */
function accountGroupOf(type) {
  return accountTypeInfo(type).group || 'fund'
}

/** 固定资产（房产/车产）的余额展示为「估值」而非流水余额 */
function accountIsFixed(type) {
  return accountGroupOf(type) === 'fixed'
}

/** 账户余额：初始 + 收入 - 支出 + 转入 - 转出；信用卡负债为负 */
function accountBalance(account, records) {
  var bal = Number(account.initialBalance) || 0
  var i
  for (i = 0; i < records.length; i++) {
    var r = records[i]
    if (r.type === 'income' && r.accountId === account.id) bal += r.amount
    else if (r.type === 'expense' && r.accountId === account.id) bal -= r.amount
    else if (r.type === 'transfer' && r.accountId === account.id) bal -= r.amount
    else if (r.type === 'transfer' && r.transferTo === account.id) bal += r.amount
  }
  return bal
}

function defaultAccounts() {
  return [
    { id: 'acc_cash', name: '现金', type: 'cash', initialBalance: 0, sortIndex: 0 },
    { id: 'acc_wechat', name: '微信钱包', type: 'wechat', initialBalance: 0, sortIndex: 1 },
    { id: 'acc_alipay', name: '支付宝', type: 'alipay', initialBalance: 0, sortIndex: 2 },
    { id: 'acc_bank', name: '储蓄卡', type: 'bank', initialBalance: 0, sortIndex: 3 }
  ]
}

/* ---------------- 周期记账 ---------------- */

var RECUR_CYCLES = [
  { key: 'weekly', name: '每周' },
  { key: 'monthly', name: '每月' },
  { key: 'quarterly', name: '每季' },
  { key: 'yearly', name: '每年' }
]

function recurCycleName(key) {
  for (var i = 0; i < RECUR_CYCLES.length; i++) {
    if (RECUR_CYCLES[i].key === key) return RECUR_CYCLES[i].name
  }
  return '每月'
}

/** 周期规则的下次执行日 */
function nextRunDate(rule) {
  var base = rule.lastRunAt ? String(rule.lastRunAt).slice(0, 10) : String(rule.startDate || rule.nextDate || dateStr(new Date()))
  if (rule.cycle === 'weekly') return addDays(base, 7)
  if (rule.cycle === 'monthly') return addMonths(base, 1)
  if (rule.cycle === 'quarterly') return addMonths(base, 3)
  return addMonths(base, 12)
}

function addMonths(s, delta) {
  var d = parseDate(s)
  var day = d.getDate()
  var y = d.getFullYear()
  var m = d.getMonth() + delta
  y += Math.floor(m / 12)
  m = ((m % 12) + 12) % 12
  var last = new Date(y, m + 1, 0).getDate()
  day = Math.min(day, last)
  return dateStr(new Date(y, m, day))
}

/** 到期（今天及以前未执行）的周期规则 */
function dueRecurring(rules, today) {
  today = today || dateStr(new Date())
  var out = []
  var i
  for (i = 0; i < rules.length; i++) {
    var r = rules[i]
    if (!r || r.paused) continue
    var nd = String(r.nextDate || '')
    if (nd && nd <= today) out.push(r)
  }
  return out
}

/* ---------------- 账本封面 ---------------- */

/**
 * 账本封面预设：渐变 + emoji，与奶油黄主题协调的浅色系。
 * key 会落库，新增预设只能往后加，别改已有 key（老用户的封面不能变）。
 */
var LEDGER_COVERS = [
  { key: 'default', name: '默认', emoji: '📒', gradient: 'linear-gradient(135deg, #F7E8C3, #EFD49B)' },
  { key: 'piggy', name: '存钱', emoji: '🐷', gradient: 'linear-gradient(135deg, #FFE3EC, #FFC4D8)' },
  { key: 'home', name: '家庭', emoji: '🏠', gradient: 'linear-gradient(135deg, #E3EEFF, #C4DAFF)' },
  { key: 'travel', name: '旅行', emoji: '✈️', gradient: 'linear-gradient(135deg, #DFF3F1, #B5E5DD)' },
  { key: 'business', name: '生意', emoji: '💼', gradient: 'linear-gradient(135deg, #EFE9FF, #D6C8FF)' },
  { key: 'love', name: '恋爱', emoji: '💕', gradient: 'linear-gradient(135deg, #FFE8E2, #FFC9B8)' },
  { key: 'coffee', name: '小确幸', emoji: '☕', gradient: 'linear-gradient(135deg, #F3E7D6, #E2C6A6)' },
  { key: 'star', name: '目标', emoji: '⭐', gradient: 'linear-gradient(135deg, #FFF3C4, #FFE083)' }
]

/**
 * 归一化封面字段（兼容没有 cover 的旧账本 / 旧分享包 / 旧同步数据）：
 *  - { kind: 'image', image: dataURL } 自定义图片
 *  - { kind: 'preset', key: 'xxx' }    预设（找不到 key 时回退默认）
 * 返回对象始终带全渲染所需字段，页面直接拿去用。
 */
function ledgerCoverInfo(cover) {
  if (!cover || typeof cover !== 'object') cover = { kind: 'preset', key: 'default' }
  if (cover.kind === 'image' && typeof cover.image === 'string' && /^data:image\//.test(cover.image)) {
    return { kind: 'image', key: 'image', name: '自定义', emoji: '', gradient: '', image: cover.image }
  }
  var key = String(cover.key || 'default')
  var hit = null
  for (var i = 0; i < LEDGER_COVERS.length; i++) {
    if (LEDGER_COVERS[i].key === key) { hit = LEDGER_COVERS[i]; break }
  }
  if (!hit) hit = LEDGER_COVERS[0]
  return {
    kind: 'preset',
    key: hit.key,
    name: hit.name,
    emoji: hit.emoji,
    gradient: hit.gradient,
    image: ''
  }
}

/** 取账本封面（账本对象或 cover 字段都吃） */
function ledgerCoverOf(ledger) {
  return ledgerCoverInfo(ledger && ledger.cover)
}

/* ---------------- 导出 CSV ---------------- */

function csvCell(v) {
  var s = String(v == null ? '' : v)
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

/** 记录数组 → CSV 文本（含 BOM，Excel 打开不乱码） */
function recordsToCSV(records, ledgerName) {
  var lines = ['\ufeff账本,' + csvCell(ledgerName || '')]
  lines.push('日期,类型,分类,金额(元),账户,备注,记录人')
  var i
  for (i = 0; i < records.length; i++) {
    var r = records[i]
    var typeName = r.type === 'income' ? '收入' : (r.type === 'transfer' ? '转账' : '支出')
    var sign = r.type === 'income' ? '+' : '-'
    lines.push([
      r.date,
      typeName,
      r.type === 'transfer' ? ('转账至 ' + (r.transferToName || r.transferTo || '')) : categoryName(r.type, r.category),
      sign + (r.amount / 100).toFixed(2),
      r.accountName || '',
      r.note || '',
      r.memberName || ''
    ].map(csvCell).join(','))
  }
  return lines.join('\n')
}

/* ---------- UTF-8 安全的 Base64（小程序无 btoa/atof/Buffer） ---------- */

var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function utf8Bytes(str) {
  var esc = encodeURIComponent(String(str))
  var bytes = []
  for (var i = 0; i < esc.length; i++) {
    if (esc.charAt(i) === '%') {
      bytes.push(parseInt(esc.substr(i + 1, 2), 16))
      i += 2
    } else {
      bytes.push(esc.charCodeAt(i))
    }
  }
  return bytes
}

function bytesToUtf8(bytes) {
  var esc = ''
  for (var i = 0; i < bytes.length; i++) {
    esc += '%' + ('0' + bytes[i].toString(16)).slice(-2)
  }
  return decodeURIComponent(esc)
}

function bytesToB64(bytes) {
  var out = ''
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i]
    var b1 = bytes[i + 1]
    var b2 = bytes[i + 2]
    out += B64_CHARS[b0 >> 2]
    out += B64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? '=' : B64_CHARS[b2 & 63]
  }
  return out
}

function b64ToBytes(str) {
  var clean = String(str).replace(/[^A-Za-z0-9+/]/g, '').replace(/=+$/, '')
  function idx(ch) {
    return ch === '' ? -1 : B64_CHARS.indexOf(ch)
  }
  var bytes = []
  for (var i = 0; i < clean.length; i += 4) {
    var c0 = idx(clean.charAt(i))
    var c1 = idx(clean.charAt(i + 1))
    var c2 = idx(clean.charAt(i + 2))
    var c3 = idx(clean.charAt(i + 3))
    if (c0 < 0 || c1 < 0) break
    bytes.push((c0 << 2) | (c1 >> 4))
    if (c2 < 0) break
    bytes.push(((c1 & 15) << 4) | (c2 >> 2))
    if (c3 < 0) break
    bytes.push(((c2 & 3) << 6) | c3)
  }
  return bytes
}

function b64encodeUtf8(str) {
  return bytesToB64(utf8Bytes(str))
}

function b64decodeUtf8(str) {
  return bytesToUtf8(b64ToBytes(str))
}

/** 从任意粘贴文本中提取分享包主体 */
var SHARE_PREFIX = 'JZ1.'
var SHARE_PATTERN = /JZ1\.[A-Za-z0-9+/=]+/

function encodeSharePayload(payload) {
  return SHARE_PREFIX + b64encodeUtf8(JSON.stringify(payload))
}

function decodeSharePayload(text) {
  var m = String(text == null ? '' : text).match(SHARE_PATTERN)
  if (!m) return null
  try {
    return JSON.parse(b64decodeUtf8(m[0].slice(SHARE_PREFIX.length)))
  } catch (e) {
    return null
  }
}

module.exports = {
  EXPENSE_CATEGORIES: EXPENSE_CATEGORIES,
  INCOME_CATEGORIES: INCOME_CATEGORIES,
  categoriesFor: categoriesFor,
  categoryOf: categoryOf,
  categoryIcon: categoryIcon,
  categoryName: categoryName,
  categoryTint: categoryTint,
  greeting: greeting,
  cnDate: cnDate,
  yuanToCents: yuanToCents,
  formatCents: formatCents,
  signedText: signedText,
  dateStr: dateStr,
  currentMonthKey: currentMonthKey,
  shiftMonth: shiftMonth,
  formatMonth: formatMonth,
  calcSummary: calcSummary,
  groupByDate: groupByDate,
  hmText: hmText,
  tsOf: tsOf,
  memberStats: memberStats,
  genId: genId,
  b64encodeUtf8: b64encodeUtf8,
  b64decodeUtf8: b64decodeUtf8,
  encodeSharePayload: encodeSharePayload,
  decodeSharePayload: decodeSharePayload,
  parseDate: parseDate,
  addDays: addDays,
  addMonths: addMonths,
  weekStart: weekStart,
  weekKey: weekKey,
  shiftWeek: shiftWeek,
  periodOf: periodOf,
  inRange: inRange,
  categoryStats: categoryStats,
  trendSeries: trendSeries,
  momChange: momChange,
  calendarMonth: calendarMonth,
  calcStreak: calcStreak,
  topCategories: topCategories,
  compactAmount: compactAmount,
  budgetStatus: budgetStatus,
  ACCOUNT_TYPES: ACCOUNT_TYPES,
  ACCOUNT_GROUPS: ACCOUNT_GROUPS,
  accountTypeInfo: accountTypeInfo,
  accountGroupOf: accountGroupOf,
  accountIsFixed: accountIsFixed,
  accountBalance: accountBalance,
  defaultAccounts: defaultAccounts,
  LEDGER_COVERS: LEDGER_COVERS,
  ledgerCoverInfo: ledgerCoverInfo,
  ledgerCoverOf: ledgerCoverOf,
  RECUR_CYCLES: RECUR_CYCLES,
  recurCycleName: recurCycleName,
  nextRunDate: nextRunDate,
  dueRecurring: dueRecurring,
  csvCell: csvCell,
  recordsToCSV: recordsToCSV
}
