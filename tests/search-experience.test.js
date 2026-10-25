var assert = require('assert')
var store = {}
global.wx = {
  getStorageSync: function (k) { return store[k] || '' },
  setStorageSync: function (k, v) { store[k] = v }
}
var db = require('../utils/db.js')
var definition
global.Page = function (p) { definition = p }
require('../pages/search/search.js')
delete global.Page
var failures = 0
function page() {
  store = {}
  db.init()
  var p = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData: function (patch) { Object.assign(this.data, patch) }
  })
  p.onLoad()
  p.onShow()
  return p
}
function add(fields) {
  return db.addRecord(Object.assign({ ledgerId: db.currentLedger().id, amount: 1200, type: 'expense', category: 'food', date: '2026-10-24', note: '午饭' }, fields))
}
function test(name, fn) {
  try { fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
test('反向日期和反向金额区间显示错误，不覆盖已查到的结果', function () {
  var p = page()
  add()
  p.doSearch()
  p.setData({ start: '2026-10-24', end: '2026-10-01' })
  p.doSearch()
  assert.ok(p.data.filterError)
  assert.strictEqual(p.data.results.length, 1)
  p.setData({ start: '', end: '', minAmount: '100', maxAmount: '20' })
  p.doSearch()
  assert.ok(p.data.filterError)
  assert.strictEqual(p.data.results.length, 1)
})
test('金额上限明确填零时不显示正金额记录，非法小数不能偷偷放宽条件', function () {
  var p = page()
  add()
  p.setData({ maxAmount: '0' })
  p.doSearch()
  assert.strictEqual(p.data.results.length, 0)
  p.setData({ minAmount: '1.2.3', maxAmount: '' })
  p.doSearch()
  assert.ok(p.data.filterError)
})
test('快捷日期筛选即时查询，近三个月正确跨年', function () {
  var p = page()
  p.applyDatePreset('quarter', new Date(2026, 0, 15))
  assert.strictEqual(p.data.start, '2025-11-01')
  assert.strictEqual(p.data.end, '2026-01-15')
  assert.strictEqual(p.data.searched, true)
  p.onStartChange({ detail: { value: '2025-12-01' } })
  assert.strictEqual(p.data.datePreset, '')
})
test('省略整数位的小额筛选按实际金额匹配', function () {
  var p = page()
  add({ amount: 49 })
  add({ amount: 50 })
  p.setData({ minAmount: '.5', maxAmount: '.50' })
  p.doSearch()
  assert.strictEqual(p.data.filterError, '')
  assert.deepStrictEqual(p.data.results.map(function (r) { return r.amount }), [50])
})
test('编辑账单返回后保留筛选条件并刷新结果', function () {
  var p = page()
  var rec = add()
  p.setData({ q: '午饭' })
  p.doSearch()
  assert.strictEqual(p.data.results.length, 1)
  db.updateRecord(rec.id, { amount: 2500, type: 'expense', category: 'food', date: rec.date, note: '晚饭' })
  p.onShow()
  assert.strictEqual(p.data.q, '午饭')
  assert.strictEqual(p.data.results.length, 0)
})
test('自定义分类可以按名称查询，结果展示自定义名称与图标', function () {
  var p = page()
  db.saveCategories(db.currentLedger().id, 'expense', [{ key: 'custom_pet', name: '猫咪', icon: '🐱' }])
  add({ category: 'custom_pet', note: '' })
  p.setData({ q: '猫咪' })
  p.doSearch()
  assert.strictEqual(p.data.results.length, 1)
  assert.strictEqual(p.data.groups[0].records[0].categoryName, '猫咪')
  assert.strictEqual(p.data.groups[0].records[0].icon, '🐱')
})
if (failures) process.exitCode = 1
