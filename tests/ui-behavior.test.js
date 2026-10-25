var assert = require('assert')
var u = require('../utils/util.js')
var motion = require('../utils/motion.js')
var failures = 0
function test(name, fn) {
  try { fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}

test('自定义导航内容在胶囊下方，缺失或无效胶囊数据时保留导航高度', function () {
  global.wx = { getMenuButtonBoundingClientRect: function () { return { top: 52, bottom: 84 } } }
  assert.strictEqual(typeof u.navigationTop, 'function')
  assert.ok(u.navigationTop({ statusBarHeight: 47 }) >= 92)
  wx.getMenuButtonBoundingClientRect = function () { return { top: 0, bottom: 0 } }
  assert.strictEqual(u.navigationTop({ statusBarHeight: 47 }), 91)
  wx.getMenuButtonBoundingClientRect = function () { throw Error('unsupported') }
  assert.strictEqual(u.navigationTop({ statusBarHeight: 20 }), 64)
})

test('图表纵轴保留分级精度，不会把不同金额标成重复的零或一', function () {
  assert.strictEqual(typeof u.chartAxis, 'function')
  ;[1, 80, 120, 10000, 1000000, 99999999].forEach(function (amount) {
    var axis = u.chartAxis(amount)
    assert.ok(axis.max >= amount)
    assert.strictEqual(new Set(axis.labels).size, 4)
    assert.strictEqual(axis.labels[3], '¥0')
  })
  assert.ok(u.chartAxis(1).labels.some(function (label) { return label === '¥0.01' }))
  assert.ok(u.chartAxis(10000).labels.indexOf('¥50') >= 0)
  assert.ok(u.chartAxis(1000000).labels.some(function (label) { return label.indexOf('万') >= 0 }))
})

var stats
global.Page = function (page) { stats = page }
require('../pages/stats/stats.js')
delete global.Page

test('取消自定义日期不改变原来的统计周期与图表', function () {
  var reloads = 0
  var page = Object.assign({}, stats, {
    data: { period: 'week', refKey: '2026-10-12', showCustom: false },
    setData: function (patch) { Object.assign(this.data, patch) },
    loadData: function () { reloads++ }
  })
  page.setPeriod({ currentTarget: { dataset: { period: 'custom' } } })
  assert.strictEqual(page.data.period, 'week')
  assert.strictEqual(page.data.showCustom, true)
  page.cancelCustom()
  assert.strictEqual(page.data.period, 'week')
  assert.strictEqual(page.data.refKey, '2026-10-12')
  assert.strictEqual(page.data.showCustom, false)
  assert.strictEqual(reloads, 0)
})

test('日期弹层打开时隐藏原生底部导航，取消后恢复导航', function () {
  var tab = {}
  var page = Object.assign({}, stats, {
    data: { period: 'week', showCustom: false, posterShow: false },
    setData: function (patch) { Object.assign(this.data, patch) },
    getTabBar: function () { return { setData: function (patch) { Object.assign(tab, patch) } } }
  })
  page.setPeriod({ currentTarget: { dataset: { period: 'custom' } } })
  assert.strictEqual(tab.hidden, true)
  page.cancelCustom()
  assert.strictEqual(tab.hidden, true, '退场期间仍保留遮罩')
  motion.cleanup(page)
  assert.strictEqual(tab.hidden, false)
  assert.strictEqual(tab.selected, 2)
})

test('取消日期编辑恢复已应用的区间，确认才使用新日期', function () {
  var reloads = 0
  var page = Object.assign({}, stats, {
    data: { period: 'custom', customStart: '2026-10-01', customEnd: '2026-10-24' },
    setData: function (patch) { Object.assign(this.data, patch) },
    loadData: function () { reloads++ }
  })
  var event = { currentTarget: { dataset: { period: 'custom' } } }
  page.setPeriod(event)
  page.onCustomStart({ detail: { value: '2026-09-01' } })
  page.cancelCustom()
  assert.strictEqual(page.data.customStart, '2026-10-01')
  assert.strictEqual(reloads, 0)
  page.setPeriod(event)
  page.onCustomStart({ detail: { value: '2026-09-01' } })
  page.applyCustom()
  assert.strictEqual(page.data.customStart, '2026-09-01')
  assert.strictEqual(reloads, 1)
})

test('首页更多菜单与我的帮助弹层关闭后恢复底部导航', function () {
  var definition
  global.Page = function (page) { definition = page }
  require('../pages/index/index.js')
  var home = definition
  require('../pages/profile/profile.js')
  var profile = definition
  delete global.Page
  ;[
    { definition: home, open: 'toggleMore', close: 'toggleMore', selected: 0 },
    { definition: profile, open: 'openHelp', close: 'closeHelp', selected: 3 }
  ].forEach(function (scenario) {
    var tab = {}
    var page = Object.assign({}, scenario.definition, {
      data: {},
      setData: function (patch) { Object.assign(this.data, patch) },
      getTabBar: function () { return { setData: function (patch) { Object.assign(tab, patch) } } }
    })
    page[scenario.open]()
    assert.strictEqual(tab.hidden, true)
    page[scenario.close]()
    assert.strictEqual(tab.hidden, true, '退场期间保持导航隐藏')
    motion.cleanup(page)
    assert.strictEqual(tab.hidden, false)
    assert.strictEqual(tab.selected, scenario.selected)
  })
})

test('昵称聚焦编辑时，同步刷新不会覆盖正在输入的草稿', function () {
  var definition
  global.Page = function (page) { definition = page }
  delete require.cache[require.resolve('../pages/profile/profile.js')]
  require('../pages/profile/profile.js')
  delete global.Page
  var db = require('../utils/db.js')
  var store = {}
  global.wx = { getStorageSync: function (k) { return store[k] || '' }, setStorageSync: function (k, v) { store[k] = v } }
  db.init()
  var page = Object.assign({}, definition, {
    data: Object.assign({}, definition.data),
    setData: function (patch) { Object.assign(this.data, patch) }
  })
  page.onNicknameFocus()
  page.onNicknameInput({ detail: { value: '正在写的名字' } })
  db.applyCloudMe({ name: '云端旧名' })
  page.refresh()
  assert.strictEqual(page.data.nicknameDraft, '正在写的名字')
  page.onNicknameBlur({ detail: { value: '正在写的名字' } })
  assert.strictEqual(db.getProfile().name, '正在写的名字')
})

if (failures) process.exitCode = 1
