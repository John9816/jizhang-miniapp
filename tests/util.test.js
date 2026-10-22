/**
 * 冒烟测试：用内存版 wx storage mock 直接测 utils/util.js 与 utils/db.js。
 * 运行：node tests/util.test.js
 */

var assert = require('assert')
var path = require('path')

var ROOT = path.join(__dirname, '..')
var store = {}

global.wx = {
  getStorageSync: function (key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''
  },
  setStorageSync: function (key, value) {
    store[key] = value
  }
}

var u = require(path.join(ROOT, 'utils/util.js'))

function freshDbModule() {
  var p = path.join(ROOT, 'utils/db.js')
  delete require.cache[require.resolve(p)]
  return require(p)
}

var passed = 0
var failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log('PASS  ' + name)
  } catch (e) {
    failed++
    console.log('FAIL  ' + name + '\n      ' + e.message)
  }
}

/* ---------------- util.js ---------------- */

test('金额：元字符串 ↔ 分 转换', function () {
  assert.strictEqual(u.yuanToCents('12.34'), 1234)
  assert.strictEqual(u.yuanToCents('0.05'), 5)
  assert.strictEqual(u.yuanToCents('100'), 10000)
  assert.strictEqual(u.yuanToCents('9.999'), 0, '超过两位小数应判非法')
  assert.strictEqual(u.yuanToCents('abc'), 0)
  assert.strictEqual(u.yuanToCents(''), 0)
  assert.strictEqual(u.formatCents(123456), '1,234.56')
  assert.strictEqual(u.formatCents(5), '0.05')
  assert.strictEqual(u.formatCents(-1234), '-12.34')
  assert.strictEqual(u.signedText(1234, 'income'), '+12.34')
  assert.strictEqual(u.signedText(1234, 'expense'), '-12.34')
})

test('月份：平移与跨年', function () {
  assert.strictEqual(u.shiftMonth('2026-10', -1), '2026-09')
  assert.strictEqual(u.shiftMonth('2026-01', -1), '2025-12')
  assert.strictEqual(u.shiftMonth('2026-12', 1), '2027-01')
  assert.strictEqual(u.formatMonth('2026-10'), '2026年10月')
})

test('汇总统计', function () {
  var s = u.calcSummary([
    { type: 'income', amount: 10000 },
    { type: 'expense', amount: 2345 },
    { type: 'expense', amount: 655 }
  ])
  assert.strictEqual(s.income, 10000)
  assert.strictEqual(s.expense, 3000)
  assert.strictEqual(s.balance, 7000)
})

test('按日期分组与组内小计', function () {
  var groups = u.groupByDate([
    { id: 'a', date: '2026-10-02', type: 'expense', amount: 1200, createdAt: 1 },
    { id: 'b', date: '2026-10-01', type: 'income', amount: 500000, createdAt: 2 },
    { id: 'c', date: '2026-10-01', type: 'expense', amount: 300, createdAt: 3 }
  ])
  assert.strictEqual(groups.length, 2)
  assert.strictEqual(groups[0].date, '2026-10-02', '分组应按日期倒序')
  assert.strictEqual(groups[1].incomeText, '5,000.00')
  assert.strictEqual(groups[1].expenseText, '3.00')
  assert.strictEqual(groups[1].records[0].id, 'c', '组内应按创建时间倒序')
  assert.strictEqual(groups[0].label.indexOf('10月2日'), 0)
})

test('成员统计', function () {
  var members = u.memberStats(
    [
      { memberId: 'u1', type: 'income', amount: 100 },
      { memberId: 'u1', type: 'expense', amount: 40 },
      { memberId: 'u2', type: 'expense', amount: 60 }
    ],
    { u1: { id: 'u1', name: '小明' }, u2: { id: 'u2', name: '小红' } }
  )
  assert.strictEqual(members.length, 2)
  var m1 = members.filter(function (m) { return m.id === 'u1' })[0]
  assert.strictEqual(m1.name, '小明')
  assert.strictEqual(m1.count, 2)
  assert.strictEqual(m1.income, 100)
  assert.strictEqual(m1.expense, 40)
  assert.strictEqual(members[0].id, 'u1', '应按记录数倒序')
})

test('Base64：中文与 Emoji 编解码（覆盖各种长度边界）', function () {
  var text = '家庭账本 🏠 餐饮 备注：和「小明」吃饭 ¥12.34'
  assert.strictEqual(u.b64decodeUtf8(u.b64encodeUtf8(text)), text)
  for (var len = 1; len <= 40; len++) {
    var s = ''
    for (var i = 0; i < len; i++) s += '中'
    assert.strictEqual(u.b64decodeUtf8(u.b64encodeUtf8(s)), s, '长度 ' + len + ' 编解码失败')
  }
})

test('分享包：编码 / 解码 / 容错', function () {
  var payload = { v: 1, app: 'jizhang', ledger: { id: 'L1', name: '家庭账本' }, records: [] }
  var code = u.encodeSharePayload(payload)
  assert.ok(code.indexOf('JZ1.') === 0)
  var decoded = u.decodeSharePayload(code)
  assert.strictEqual(decoded.ledger.name, '家庭账本')
  assert.strictEqual(u.decodeSharePayload('随便一段文字'), null)
  assert.strictEqual(u.decodeSharePayload('JZ1.###'), null)
  assert.strictEqual(u.decodeSharePayload(null), null)
})

/* ---------------- db.js（内存 wx storage） ---------------- */

test('数据层：初始化创建默认账本', function () {
  for (var k in store) delete store[k]
  var db = freshDbModule()
  db.init()
  var me = db.getMe()
  assert.ok(me.id && me.id.indexOf('u_') === 0)
  var ledgers = db.listLedgers()
  assert.strictEqual(ledgers.length, 1)
  assert.strictEqual(ledgers[0].name, '我的账本')
  assert.strictEqual(ledgers[0].isCurrent, true)
})

test('数据层：记录增删改与统计', function () {
  var db = freshDbModule()
  db.setMyName('小明')
  var ledger = db.currentLedger()
  var r1 = db.addRecord({ ledgerId: ledger.id, type: 'expense', amount: 1234, category: 'food', date: '2026-10-01', note: '午饭' })
  var r2 = db.addRecord({ ledgerId: ledger.id, type: 'income', amount: 500000, category: 'salary', date: '2026-10-01', note: '' })
  assert.strictEqual(db.recordsOf(ledger.id).length, 2)
  assert.strictEqual(r1.memberName, '小明', '记录应带记录人昵称快照')
  assert.strictEqual(db.addRecord({ ledgerId: ledger.id, type: 'expense', amount: 0, category: 'food', date: '2026-10-01' }), null, '金额为 0 应拒绝')
  var stats = db.statsOf(ledger.id)
  assert.strictEqual(stats.income, 500000)
  assert.strictEqual(stats.expense, 1234)
  assert.strictEqual(stats.balance, 498766)
  db.updateRecord(r1.id, { ledgerId: ledger.id, type: 'income', amount: 200, category: 'redpacket', date: '2026-10-02', note: '红包' })
  var updated = db.getRecord(r1.id)
  assert.strictEqual(updated.type, 'income')
  assert.strictEqual(updated.amount, 200)
  assert.strictEqual(updated.note, '红包')
  assert.strictEqual(db.deleteRecord(r2.id), true)
  assert.strictEqual(db.recordsOf(ledger.id).length, 1)
})

test('数据层：改昵称同步成员表与记录快照', function () {
  var db = freshDbModule()
  db.setMyName('小红')
  var ledger = db.currentLedger()
  db.addRecord({ ledgerId: ledger.id, type: 'expense', amount: 100, category: 'food', date: '2026-10-01' })
  db.setMyName('小红红')
  assert.strictEqual(db.currentLedger().members[db.getMe().id].name, '小红红')
  assert.strictEqual(db.recordsOf(ledger.id)[0].memberName, '小红红')
})

test('数据层：分享包双设备合并', function () {
  for (var k in store) delete store[k]
  var dbA = freshDbModule()
  dbA.init()
  dbA.setMyName('小明')
  var ledger = dbA.createLedger('家庭账本')
  dbA.addRecord({ ledgerId: ledger.id, type: 'expense', amount: 3500, category: 'food', date: '2026-10-01', note: '买菜' })
  dbA.addRecord({ ledgerId: ledger.id, type: 'income', amount: 1200000, category: 'salary', date: '2026-10-02', note: '十月工资' })
  var code = dbA.sharePackage(ledger.id)
  assert.ok(code.length > 20)

  // 设备 B：全新存储
  for (var k2 in store) delete store[k2]
  var dbB = freshDbModule()
  dbB.init()
  dbB.setMyName('小红')
  var res = dbB.importSharePackage(code)
  assert.strictEqual(res.ok, true, res.error || '')
  assert.strictEqual(res.added, 2)
  var ledgerB = dbB.currentLedger()
  assert.strictEqual(ledgerB.id, ledger.id, '导入后应切换到共享账本')
  assert.ok(ledgerB.members[dbA.getMe().id], '成员表应包含设备 A 的用户')
  assert.ok(ledgerB.members[dbB.getMe().id], '成员表应包含设备 B 的自己')
  var recs = dbB.recordsOf(ledger.id)
  assert.strictEqual(recs.length, 2)
  assert.strictEqual(recs[0].memberName, '小明', '记录来源成员名应保留')

  // B 记一笔，再分享回 A：A 只新增 B 的记录，不重复导入
  dbB.addRecord({ ledgerId: ledger.id, type: 'expense', amount: 880, category: 'transport', date: '2026-10-03', note: '打车' })
  var back = dbA.importSharePackage(dbB.sharePackage(ledger.id))
  assert.strictEqual(back.ok, true)
  assert.strictEqual(back.added, 1, '重复导入应去重')
  assert.strictEqual(dbA.recordsOf(ledger.id).length, 3)
  var statsB = dbA.statsOf(ledger.id)
  assert.strictEqual(statsB.expense, 4380)
})

test('数据层：非法分享包与删除账本兜底', function () {
  var db = freshDbModule()
  assert.strictEqual(db.importSharePackage('你好').ok, false)
  assert.strictEqual(db.importSharePackage('JZ1.not-base64-###').ok, false)
  assert.strictEqual(db.sharePackage('不存在的账本'), '')
  var l2 = db.createLedger('临时账本')
  assert.strictEqual(db.listLedgers().length >= 2, true)
  db.deleteLedger(l2.id)
  var cur = db.currentLedger()
  assert.ok(cur, '删除后应仍有可用账本')
})

test('首页增强：连续记账天数 / 常用分类 / 日历金额文本', function () {
  var u = require(path.join(ROOT, 'utils/util.js'))
  var today = u.dateStr(new Date())
  var yesterday = u.dateStr(new Date(Date.now() - 86400000))
  var dayBefore = u.dateStr(new Date(Date.now() - 2 * 86400000))

  // 连续天数：昨天+今天有记录 → 2；断开 → 1；都没有 → 0
  var recs = [
    { date: today, type: 'expense', category: 'food', amount: 1000 },
    { date: yesterday, type: 'expense', category: 'food', amount: 2000 },
    { date: dayBefore, type: 'income', category: 'salary', amount: 100 }
  ]
  assert.strictEqual(u.calcStreak(recs), 3, '三天连续')
  assert.strictEqual(u.calcStreak(recs.slice(0, 2)), 2, '昨天+今天')
  assert.strictEqual(u.calcStreak([recs[0]]), 1, '只有今天')
  assert.strictEqual(u.calcStreak([{ date: dayBefore, type: 'expense', category: 'food', amount: 100 }]), 0, '断了')
  assert.strictEqual(u.calcStreak([]), 0, '空')

  // 常用分类：按频次排序，取前 N
  var top = u.topCategories(recs.concat([
    { date: today, type: 'expense', category: 'food', amount: 100 },
    { date: today, type: 'expense', category: 'transport', amount: 100 },
    { date: today, type: 'income', category: 'salary', amount: 100 }
  ]), 'expense', 2)
  assert.strictEqual(top.length, 2)
  assert.strictEqual(top[0].key, 'food')
  assert.ok(top[0].name && top[0].icon && top[0].tint)

  // 紧凑金额：日历格用
  assert.strictEqual(u.compactAmount(3000), '30')
  assert.strictEqual(u.compactAmount(157150), '1571.5')
  assert.strictEqual(u.compactAmount(0), '0')
  assert.strictEqual(u.compactAmount(1000000), '1万')
  assert.strictEqual(u.compactAmount(12345600), '12.3万')
  assert.strictEqual(u.compactAmount(100000000), '100万')

  // 日历每天带收支文本
  var cal = u.calendarMonth(today.slice(0, 7), recs)
  var todayCell = cal.days.filter(function (d) { return d.date === today })[0]
  assert.strictEqual(todayCell.expenseText, '10')
  assert.strictEqual(todayCell.incomeText, '0')
  var yesterdayCell = cal.days.filter(function (d) { return d.date === yesterday })[0]
  assert.strictEqual(yesterdayCell.incomeText, '0')
  var dayBeforeCell = cal.days.filter(function (d) { return d.date === dayBefore })[0]
  assert.strictEqual(dayBeforeCell.incomeText, '1')
})

test('账本封面归一化：空值/坏 key 兜底默认，图片封面保留 dataURL', function () {
  var def = u.ledgerCoverInfo(null)
  assert.strictEqual(def.kind, 'preset')
  assert.strictEqual(def.key, 'default')
  assert.strictEqual(def.emoji, '📒')
  assert.ok(def.gradient)

  var bad = u.ledgerCoverInfo({ kind: 'preset', key: 'not_exist' })
  assert.strictEqual(bad.key, 'default')

  var img = u.ledgerCoverInfo({ kind: 'image', image: 'data:image/png;base64,iVBORw0KGgo' })
  assert.strictEqual(img.kind, 'image')
  assert.strictEqual(img.image, 'data:image/png;base64,iVBORw0KGgo')

  // 非 dataURL 的图片字段（脏数据）回退到默认预设，避免 image 组件渲染失败
  var dirty = u.ledgerCoverInfo({ kind: 'image', image: 'http://tmp/xxx.png' })
  assert.strictEqual(dirty.kind, 'preset')
  assert.strictEqual(dirty.key, 'default')

  // ledgerCoverOf 吃账本对象
  assert.strictEqual(u.ledgerCoverOf({ name: 'x' }).key, 'default')
  assert.strictEqual(u.ledgerCoverOf({ cover: { kind: 'preset', key: 'love' } }).emoji, '💕')
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
