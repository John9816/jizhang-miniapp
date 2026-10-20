/**
 * 外部账单解析 / 导入 / 对账 / 导出 单测。
 * 运行：node tests/billParser.test.js
 */
var assert = require('assert')
var fs = require('fs')
var path = require('path')

var store = {}
global.wx = {
  getStorageSync: function (k) { return store[k] || '' },
  setStorageSync: function (k, v) { store[k] = String(v) },
  removeStorageSync: function (k) { delete store[k] }
}

var P = path.resolve(__dirname, '../utils/billParser.js')
var fresh = function () { delete require.cache[require.resolve(P)]; return require(P) }
var p = fresh()

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

function readFix(name) {
  return fs.readFileSync(path.resolve(__dirname, 'fixtures', name))
}

console.log('账单解析单测（utils/billParser.js）')

/* ---------------- 单元级 ---------------- */

test('toCents：货币符号 / 千分位 / 负数', function () {
  assert.strictEqual(p.toCents('￥35.00'), 3500)
  assert.strictEqual(p.toCents('1,234.56'), 123456)
  assert.strictEqual(p.toCents('35'), 3500)
  assert.strictEqual(p.toCents('-12.30'), -1230)
  assert.strictEqual(p.toCents('CNY19.9'), 1990)
  assert.strictEqual(p.toCents('abc'), 0)
  assert.strictEqual(p.toCents(''), 0)
})

test('normDirection / isSkipStatus / pickDate', function () {
  assert.strictEqual(p.normDirection('支出'), 'expense')
  assert.strictEqual(p.normDirection('收入'), 'income')
  assert.strictEqual(p.normDirection('/'), '')
  assert.strictEqual(p.normDirection(''), '')
  assert.strictEqual(p.isSkipStatus('支付成功'), false)
  assert.strictEqual(p.isSkipStatus('交易成功'), false)
  assert.strictEqual(p.isSkipStatus('已退款'), true)
  assert.strictEqual(p.isSkipStatus('退款成功'), true)
  assert.strictEqual(p.isSkipStatus('交易关闭'), true)
  assert.strictEqual(p.isSkipStatus('等待对方确认收款'), true)
  assert.strictEqual(p.isSkipStatus(''), false)
  assert.strictEqual(p.pickDate('2026-09-01 08:12:33'), '2026-09-01')
  assert.strictEqual(p.pickDate('2026/9/1 08:12'), '2026-09-01')
  assert.strictEqual(p.pickDate('垃圾'), '')
})

test('mergeSplitNumbers：把拆开的千分位金额合回一格', function () {
  var out = p.mergeSplitNumbers(['a', '1', '234.56', 'b'], 3)
  assert.strictEqual(out.length, 3)
  assert.strictEqual(out[1], '1,234.56')
  var cur = p.mergeSplitNumbers(['a', '￥1', '234.56', 'b'], 3)
  assert.strictEqual(cur.length, 3)
  assert.strictEqual(cur[1], '￥1,234.56')
})

test('guessCategory：常见商家 / 工资', function () {
  assert.strictEqual(p.guessCategory('expense', '星巴克', '拿铁'), 'food')
  assert.strictEqual(p.guessCategory('expense', '滴滴出行', '快车'), 'transport')
  assert.strictEqual(p.guessCategory('expense', '海底捞', '聚餐'), 'food')
  assert.strictEqual(p.guessCategory('expense', '中国移动', '话费充值'), 'phone')
  assert.strictEqual(p.guessCategory('income', '某某公司', '9月工资'), 'salary')
  assert.strictEqual(p.guessCategory('expense', '完全陌生的店', '买了东西'), 'other_out')
  assert.strictEqual(p.guessCategory('income', '路人甲', '感谢'), 'other_in')
})

test('rowKey：有单号用单号，无单号走日期+金额+对方', function () {
  var a = { src: 'wechat', txn: '4200001', date: '2026-09-01', amount: 3500, party: '星巴克' }
  var b = { src: 'wechat', txn: '4200001', date: '2026-09-01', amount: 3500, party: '星巴克' }
  var c = { src: 'wechat', txn: '', date: '2026-09-01', amount: 3500, party: '星巴克' }
  assert.strictEqual(p.rowKey(a), 'wechat#4200001')
  assert.strictEqual(p.rowKey(a), p.rowKey(b))
  assert.strictEqual(p.rowKey(a) !== p.rowKey(c).indexOf('wechat#2026-09-01'), true)
  assert.strictEqual(p.rowKey(c), 'wechat#2026-09-01#3500#星巴克')
})

/* ---------------- 微信账单（GBK） ---------------- */

test('微信账单 GBK：识别 / 说明行跳过 / 过滤 / 千分位 / 引号逗号 / 重复单号', function () {
  var r = p.parseBytes(readFix('wechat-sample.csv'))
  assert.strictEqual(r.src, 'wechat')
  // 12 条原始行：1 退款 + 1 不计收支 + 1 文件内重复单号 → 应剩 9
  assert.strictEqual(r.rows.length, 9)
  assert.strictEqual(r.stats.kept, 9)
  assert.strictEqual(r.stats.skipped.refund, 1)
  assert.strictEqual(r.stats.skipped.neutral, 1)
  assert.strictEqual(r.stats.skipped.dup, 1)
  assert.strictEqual(r.stats.skipped.badRow, 0)
  assert.strictEqual(r.stats.firstDate, '2026-09-01')
  assert.strictEqual(r.stats.lastDate, '2026-09-30')

  var first = r.rows[0]
  assert.strictEqual(first.date, '2026-09-01')
  assert.strictEqual(first.type, 'expense')
  assert.strictEqual(first.amount, 3500)
  assert.strictEqual(first.txn, '420000269320260901112233001')
  assert.strictEqual(first.party, '星巴克商务楼店')
  assert.strictEqual(first.note, '大杯拿铁')
  assert.strictEqual(first.channel, '零钱')
  assert.strictEqual(first.category, 'food')

  var jingdong = r.rows.filter(function (x) { return x.party === '京东商城' })[0]
  assert.strictEqual(jingdong.amount, 123456) // ￥1,234.56 → 合并成功

  var meituan = r.rows.filter(function (x) { return x.party === '美团外卖' })[0]
  assert.strictEqual(meituan.note, '黄焖鸡米饭')
  assert.strictEqual(meituan.category, 'food')

  var income = r.rows.filter(function (x) { return x.type === 'income' })[0]
  assert.strictEqual(income.party, '李四')
  assert.strictEqual(income.amount, 20000)
  assert.strictEqual(income.status, '已收款')

  var zhuanzhang = r.rows.filter(function (x) { return x.party === '张三' })[0]
  assert.strictEqual(zhuanzhang.channel, '零钱')
})

/* ---------------- 支付宝账单（GBK） ---------------- */

test('支付宝账单 GBK：识别 / 列顺序无关 / 交易关闭与退款过滤', function () {
  var r = p.parseBytes(readFix('alipay-sample.csv'))
  assert.strictEqual(r.src, 'alipay')
  // 12 条原始行：1 交易关闭 + 1 退款成功 → 应剩 10
  assert.strictEqual(r.rows.length, 10)
  assert.strictEqual(r.stats.skipped.closed, 1)
  assert.strictEqual(r.stats.skipped.refund, 1)

  var rui = r.rows.filter(function (x) { return x.party === '瑞幸咖啡' })[0]
  assert.strictEqual(rui.amount, 1990)
  assert.strictEqual(rui.category, 'food')
  assert.strictEqual(rui.txn, '2026090822001000000000000005')

  var yonghui = r.rows.filter(function (x) { return x.party === '永辉超市' })[0]
  assert.strictEqual(yonghui.amount, 123456) // 千分位无引号

  var family = r.rows.filter(function (x) { return x.party === '外婆家' })[0]
  assert.strictEqual(family.note, '家庭聚餐, 6人') // 引号内逗号
  assert.strictEqual(family.amount, 38600)

  var income = r.rows.filter(function (x) { return x.type === 'income' })[0]
  assert.strictEqual(income.party, '天弘基金')
  assert.strictEqual(income.amount, 123)
  assert.strictEqual(income.category, 'invest')
})

test('支付宝账单 UTF-8 + BOM：同样可解析', function () {
  var text = '\ufeff交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注\n' +
    '2026-09-01 09:00:00,餐饮美食,麦当劳,门店,巨无霸套餐,支出,29.50,余额宝,交易成功,2026090122001000000000000001,1000011,\n'
  var bytes = new TextEncoder().encode(text)
  var r = p.parseBytes(bytes)
  assert.strictEqual(r.src, 'alipay')
  assert.strictEqual(r.rows.length, 1)
  assert.strictEqual(r.rows[0].amount, 2950)
})

test('支付宝账单改列顺序：按列名而非位置映射', function () {
  var text = '账号,[x]\n起始日期,[2026-09-01 00:00:00]\n' +
    '交易状态,交易订单号,商家订单号,交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,对方账号,备注\n' +
    '交易成功,2026090122001000000000000001,1000011,2026-09-01 09:00:00,餐饮美食,麦当劳,巨无霸套餐,支出,29.50,余额宝,门店,\n'
  var r = p.parseText(text)
  assert.strictEqual(r.src, 'alipay')
  assert.strictEqual(r.rows.length, 1)
  assert.strictEqual(r.rows[0].party, '麦当劳')
  assert.strictEqual(r.rows[0].amount, 2950)
  assert.strictEqual(r.rows[0].date, '2026-09-01')
})

/* ---------------- 异常输入 ---------------- */

test('非账单文本：src 为 null 且给出错误提示', function () {
  var r = p.parseText('hello,world\n1,2\n')
  assert.strictEqual(r.src, null)
  assert.strictEqual(r.rows.length, 0)
  assert.ok(r.errors.length >= 1)
})

test('空输入不炸', function () {
  var r = p.parseText('')
  assert.strictEqual(r.src, null)
  assert.strictEqual(r.stats.lines, 0)
})

/* ---------------- 集成：解析 → 入账 → 对账 → 导出 → 反解析 ---------------- */

test('集成：微信流水导入账本 → 对账 → 导出 → 反向解析', function () {
  var parsed = p.parseBytes(readFix('wechat-sample.csv'))
  assert.strictEqual(parsed.src, 'wechat')

  var dbp = path.resolve(__dirname, '../utils/db.js')
  delete require.cache[dbp]
  var db = require(dbp)
  var l = db.createLedger('对账测试')
  var res = db.importRows(l.id, parsed.rows)
  assert.strictEqual(res.added.length, 9, '9 条入账')
  assert.strictEqual(res.dupes, 0)

  // 重复导入同一批：应全部判重
  var res2 = db.importRows(l.id, parsed.rows)
  assert.strictEqual(res2.added.length, 0)
  assert.strictEqual(res2.dupes, 9)

  // 手工补记两条之后做对账：9 条流水全部能配上导入的记录（matched=9），
  // 本机多出的 2 条手工记录成为 extra
  db.addRecord({ ledgerId: l.id, type: 'expense', amount: 3500, date: '2026-09-01', category: 'food', note: '星巴克手工' })
  db.addRecord({ ledgerId: l.id, type: 'income', amount: 20000, date: '2026-09-12', category: 'salary', note: '李四还款' })
  var rc = db.reconcile(l.id, parsed.rows)
  assert.strictEqual(rc.rows.length, 9)
  assert.strictEqual(rc.matched, 9)
  assert.strictEqual(rc.missing, 0)
  var starbucksRow = rc.rows.filter(function (x) { return x.row.party === '星巴克商务楼店' && x.row.date === '2026-09-01' })[0]
  assert.strictEqual(starbucksRow.status, 'matched')
  assert.strictEqual(rc.extra.length, 2) // 本机未与任何本批流水配平的记录（两条手工）

  // 导出后再反向解析（self 格式）
  var csv = db.exportReconcileCSV(l.id)
  var back = p.parseText(csv)
  assert.strictEqual(back.src, 'self')
  assert.strictEqual(back.rows.length, 11, '9 导入 + 2 手工 = 11 条')
  // 支出：3500+20000+45678+123456+2550+3120+8890+3800（导入）+ 3500（手工星巴克）
  assert.strictEqual(back.stats.expenseCents, 3500 * 2 + 20000 + 45678 + 123456 + 2550 + 3120 + 8890 + 3800)
  // 收入：李四 20000（导入）+ 李四还款 20000（手工）
  assert.strictEqual(back.stats.incomeCents, 20000 * 2)
  var selfIncome = back.rows.filter(function (x) { return x.type === 'income' })[0]
  assert.strictEqual(selfIncome.amount, 20000)
  assert.strictEqual(selfIncome.date, '2026-09-12')
})

test('集成：同步到新设备后重复导入仍全部判重（含旧版冗余表兼容）', function () {
  var parsed = p.parseBytes(readFix('wechat-sample.csv'))
  var dbp = path.resolve(__dirname, '../utils/db.js')
  Object.keys(store).forEach(function (k) { delete store[k] }) // 清掉上一个用例的持久化数据
  delete require.cache[dbp]
  var db = require(dbp)
  var l = db.createLedger('第二设备')
  var r1 = db.importRows(l.id, parsed.rows)
  assert.strictEqual(r1.added.length, 9)

  // 模拟云端合并后的"换设备"：重置模块但保留存储（记录带着 external 标记同步过来）
  delete require.cache[dbp]
  db = require(dbp)
  var r2 = db.importRows(l.id, parsed.rows)
  assert.strictEqual(r2.added.length, 0)
  assert.strictEqual(r2.dupes, 9)

  // 旧版兼容：记录被清空、只剩 db.imported 冗余键表时，同样能判重
  var raw = JSON.parse(store['jizhang.db.v1'])
  raw.imported = {}
  parsed.rows.forEach(function (row) { raw.imported[p.rowKey(row)] = true })
  raw.records = []
  store['jizhang.db.v1'] = JSON.stringify(raw)
  delete require.cache[dbp]
  db = require(dbp)
  var r3 = db.importRows(l.id, parsed.rows)
  assert.strictEqual(r3.added.length, 0)
  assert.strictEqual(r3.dupes, 9)
})

console.log('\n通过 ' + passed + ' 项')
