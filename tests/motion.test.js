var assert = require('assert')
var fs = require('fs')
var vm = require('vm')
var path = require('path')
var timers = new Map()
var seq = 0
var ctx = {
  module: { exports: {} },
  setTimeout: function (fn) { var id = ++seq; timers.set(id, fn); return id },
  clearTimeout: function (id) { timers.delete(id) }
}
var file = path.join(__dirname, '../utils/motion.js')
if (fs.existsSync(file)) vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx)
var motion = ctx.module.exports
var failures = 0
function test(name, fn) {
  timers.clear()
  try { fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
function page() {
  return { data: { showPanel: false }, tabHidden: false,
    setData: function (p) { Object.assign(this.data, p) },
    updateTabBar: function () { this.tabHidden = motion.hasOverlay(this, ['showPanel']) }
  }
}
function flush() {
  var tasks = Array.from(timers.values()); timers.clear()
  tasks.forEach(function (fn) { fn() })
}
function realPage(name) {
  var definition, tab = {}
  var filename = path.join(__dirname, '../pages/' + name + '/' + name + '.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: function (p) { definition = p }, console: console,
    wx: global.wx,
    require: function (p) { return /motion\.js$/.test(p) ? motion : require(path.resolve(path.dirname(filename), p)) },
    setTimeout: ctx.setTimeout, clearTimeout: ctx.clearTimeout
  })
  var p = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData: function (patch, cb) { Object.assign(this.data, patch); if (cb) cb() },
    getTabBar: function () { return { setData: function (patch) { Object.assign(tab, patch) } } }
  })
  p.tab = tab
  return p
}
test('关闭动画期间保留遮罩，结束后再恢复底部导航', function () {
  assert.strictEqual(typeof motion.open, 'function', '尚未实现统一弹层动效')
  var p = page()
  motion.open(p, 'showPanel')
  assert.strictEqual(p.tabHidden, true)
  motion.close(p, 'showPanel')
  assert.strictEqual(p.data.showPanel, false)
  assert.strictEqual(p.data.showPanelLeaving, true)
  assert.strictEqual(p.tabHidden, true)
  flush()
  assert.strictEqual(p.data.showPanelLeaving, false)
  assert.strictEqual(p.tabHidden, false)
})
test('关闭中重新打开取消旧回调，弹层不会突然消失或跳转', function () {
  var p = page(), navigated = 0
  motion.open(p, 'showPanel')
  motion.close(p, 'showPanel', { after: function () { navigated++ } })
  motion.open(p, 'showPanel', { draft: '保留输入' })
  flush()
  assert.strictEqual(p.data.showPanel, true)
  assert.strictEqual(p.data.draft, '保留输入')
  assert.strictEqual(navigated, 0)
})
test('快速重复点击弹层入口只执行一次离开动作', function () {
  var p = page(), navigated = 0
  motion.open(p, 'showPanel')
  var options = { after: function () { navigated++ } }
  motion.close(p, 'showPanel', options)
  motion.close(p, 'showPanel', options)
  assert.strictEqual(navigated, 0)
  flush()
  assert.strictEqual(navigated, 1)
})
test('页面隐藏时清理计时器，不留下遮罩或触发延迟跳转', function () {
  var p = page(), navigated = 0
  motion.open(p, 'showPanel')
  motion.close(p, 'showPanel', { after: function () { navigated++ } })
  motion.cleanup(p)
  flush()
  assert.strictEqual(navigated, 0)
  assert.strictEqual(p.tabHidden, false)
  assert.strictEqual(p.data.showPanel, false)
  assert.strictEqual(p.data.showPanelLeaving, false)
})
test('内容动效只更新动画状态，连续触发不改动金额或输入', function () {
  var p = page()
  p.data.amount = '123.45'
  p.data.note = '编辑中的备注'
  motion.reveal(p)
  var first = p.data.pageMotion
  motion.reveal(p)
  assert.ok(first && first !== p.data.pageMotion)
  assert.strictEqual(p.data.amount, '123.45')
  assert.strictEqual(p.data.note, '编辑中的备注')
  assert.strictEqual(timers.size, 0)
})
test('首页更多面板退场后才跳转，连续点击不会重复打开页面', function () {
  var routes = []
  global.wx = { navigateTo: function (o) { routes.push(o.url) } }
  var p = realPage('index')
  p.toggleMore()
  var e = { currentTarget: { dataset: { key: 'search' } } }
  p.openSheetItem(e)
  p.openSheetItem(e)
  assert.strictEqual(p.tab.hidden, true)
  assert.strictEqual(routes.length, 0)
  flush()
  assert.strictEqual(p.tab.hidden, false)
  assert.deepStrictEqual(routes, ['/pages/search/search'])
})
test('首页功能管理退场后切到我的，连续点击只切换一次且恢复导航', function () {
  var routes = []
  global.wx = { switchTab: function (o) { routes.push(o.url) } }
  var p = realPage('index')
  p.toggleMore()
  var e = { currentTarget: { dataset: { key: 'manage' } } }
  p.openSheetItem(e); p.openSheetItem(e)
  assert.strictEqual(routes.length, 0)
  assert.strictEqual(p.tab.hidden, true)
  flush()
  assert.strictEqual(p.tab.hidden, false)
  assert.deepStrictEqual(routes, ['/pages/profile/profile'])
})
test('首页视图切换等菜单退场，连点不会切两次回到原视图', function () {
  var p = realPage('index'), refreshes = 0
  global.wx.showToast = function () {}
  p.refresh = function () { refreshes++ }
  p.toggleMore()
  var e = { currentTarget: { dataset: { key: 'calendar' } } }
  p.openSheetItem(e); p.openSheetItem(e)
  assert.strictEqual(p.data.viewMode, 'list')
  flush()
  assert.strictEqual(p.data.viewMode, 'calendar')
  assert.strictEqual(p.tab.hidden, false)
  assert.strictEqual(refreshes, 1)
})
test('统计日期弹层取消立即还原输入，退场期间仍隐藏导航', function () {
  var p = realPage('stats')
  p.setData({ customStart: '2026-10-01', customEnd: '2026-10-24' })
  p.setPeriod({ currentTarget: { dataset: { period: 'custom' } } })
  p.onCustomStart({ detail: { value: '2026-09-01' } })
  p.cancelCustom()
  assert.strictEqual(p.data.customStart, '2026-10-01')
  assert.strictEqual(p.tab.hidden, true)
  flush()
  assert.strictEqual(p.tab.hidden, false)
})
test('我的帮助关闭中重新打开后仍保持显示且导航保持隐藏', function () {
  var p = realPage('profile')
  p.openHelp(); p.closeHelp(); p.openHelp()
  flush()
  assert.strictEqual(p.data.showHelp, true)
  assert.strictEqual(p.tab.hidden, true)
  p.onHide()
  assert.strictEqual(p.data.showHelp, false)
})
test('底部导航重复点击当前页不跳转，切页请求完成前只发送一次', function () {
  var component, routes = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../custom-tab-bar/index.js'), 'utf8'), {
    Component: function (c) { component = c },
    wx: { switchTab: function (o) { routes.push(o) } }
  })
  var p = Object.assign({ data: { selected: 0 } }, component.methods)
  p.onTab({ currentTarget: { dataset: { path: '/pages/index/index' } } })
  assert.strictEqual(routes.length, 0)
  var e = { currentTarget: { dataset: { path: '/pages/stats/stats' } } }
  p.onTab(e); p.onTab(e)
  assert.strictEqual(routes.length, 1)
  routes[0].complete()
  p.onTab(e)
  assert.strictEqual(routes.length, 2)
})
test('记一笔入口快速连点只打开一个编辑页，失败后允许重试', function () {
  var component, routes = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../custom-tab-bar/index.js'), 'utf8'), {
    Component: function (c) { component = c },
    wx: { navigateTo: function (o) { routes.push(o) } }
  })
  var p = Object.assign({ data: {} }, component.methods)
  p.onAdd(); p.onAdd()
  assert.strictEqual(routes.length, 1)
  routes[0].complete({ errMsg: 'navigateTo:fail' })
  p.onAdd()
  assert.strictEqual(routes.length, 2)
})
test('统计连续切换只绘制最后一次数据，页面隐藏后取消绘制', function () {
  var store = {}
  global.wx = {
    getStorageSync: function (k) { return store[k] || '' },
    setStorageSync: function (k, v) { store[k] = v }
  }
  require('../utils/db.js').init()
  var p = realPage('stats'), draws = 0
  p.drawCharts = function () { draws++ }
  p.loadData(); p.loadData()
  flush()
  assert.strictEqual(draws, 1)
  p.loadData()
  p.onHide()
  flush()
  assert.strictEqual(draws, 1)
})
if (failures) process.exitCode = 1
