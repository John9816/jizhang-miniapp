var assert = require('assert')
var fs = require('fs')
var os = require('os')
var path = require('path')
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jizhang-export-'))
var failures = 0
async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
function setup(choice, writeError) {
  var state = { deliveries: [], toasts: [], clipboard: '' }
  global.wx = {
    env: { USER_DATA_PATH: dir },
    showActionSheet: function (o) { o.success({ tapIndex: choice }) },
    showToast: function (o) { state.toasts.push(o.title) },
    showLoading: function () {}, hideLoading: function () {},
    getFileSystemManager: function () { return { writeFile: function (o) {
      if (writeError) return o.fail({ errMsg: 'writeFile:fail quota exceeded' })
      fs.writeFileSync(o.filePath, o.data, o.encoding)
      o.success()
    } } },
    shareFileMessage: function (o) {
      state.deliveries.push({ name: o.fileName, contents: fs.readFileSync(o.filePath, 'utf8') })
      o.success()
    },
    setClipboardData: function (o) { state.clipboard = o.data; o.success() }
  }
  return state
}
async function main() {
  await test('账本导出保留自定义分类名称', async function () {
    var state = setup(1)
    var store = {}
    wx.getStorageSync = function (k) { return store[k] || '' }
    wx.setStorageSync = function (k, v) { store[k] = v }
    var db = require('../utils/db.js')
    db.init()
    var ledger = db.currentLedger()
    db.saveCategories(ledger.id, 'expense', [{ key: 'custom_pet', name: '猫咪用品', icon: '🐱' }])
    db.addRecord({ ledgerId: ledger.id, type: 'expense', category: 'custom_pet', amount: 50, date: '2026-10-24', note: '' })
    var csv = db.exportCSV(ledger.id)
    assert.ok(csv.includes('猫咪用品'))
    await require('../utils/csvExport.js').show({ csv: csv, name: ledger.name, count: 1 })
    assert.ok(state.clipboard.includes('猫咪用品'))
  })
  await test('对账页只有一笔记录也可导出，记录数不受备注换行影响', async function () {
    var state = setup(1)
    var store = {}
    wx.getStorageSync = function (k) { return store[k] || '' }
    wx.setStorageSync = function (k, v) { store[k] = v }
    var db = require('../utils/db.js')
    db.init()
    var ledger = db.currentLedger()
    db.addRecord({ ledgerId: ledger.id, type: 'expense', category: 'food', amount: 50, date: '2026-10-24', note: '一\n二' })
    var definition
    global.Page = function (p) { definition = p }
    require('../pages/reconcile/reconcile.js')
    delete global.Page
    var page = Object.assign({}, definition, { data: { ledger: ledger } })
    await page.exportCSV()
    assert.ok(state.clipboard.includes('一\n二'))
    assert.ok(state.toasts.includes('已复制 1 笔'))
  })
  await test('导出中文 CSV 文件保留 BOM 和多行备注，文件名不可包含路径', async function () {
    var state = setup(0)
    var exporter = require('../utils/csvExport.js')
    var csv = '\ufeff日期,备注\n2026-10-24,"午饭\n聚餐"'
    var result = await exporter.show({ csv: csv, name: '../家庭/账本', count: 1 })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(state.deliveries.length, 1)
    assert.strictEqual(state.deliveries[0].contents, csv)
    assert.ok(state.deliveries[0].name.endsWith('.csv'))
    assert.ok(!/[\\/]/.test(state.deliveries[0].name))
  })
  await test('文件写入失败给出反馈且不会打开分享窗口', async function () {
    var state = setup(0, true)
    var result = await require('../utils/csvExport.js').show({ csv: '\ufeff日期\n2026-10-24', name: '测试', count: 1 })
    assert.strictEqual(result.ok, false)
    assert.strictEqual(state.deliveries.length, 0)
    assert.ok(state.toasts.length)
  })
  await test('复制模式保留完整 CSV，多行备注不会被当作多笔记录', async function () {
    var state = setup(1)
    var csv = '\ufeff日期,备注\n2026-10-24,"一\n二"'
    var result = await require('../utils/csvExport.js').show({ csv: csv, name: '账本', count: 1 })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(state.clipboard, csv)
    assert.ok(state.toasts.some(function (t) { return t.indexOf('1 笔') >= 0 }))
    assert.strictEqual(state.deliveries.length, 0)
  })
  await test('只有表头的账本不生成空文件，取消分享不报错', async function () {
    var state = setup(0)
    var exporter = require('../utils/csvExport.js')
    var empty = await exporter.show({ csv: '\ufeff日期', name: '账本', count: 0 })
    assert.strictEqual(empty.ok, false)
    assert.strictEqual(state.deliveries.length, 0)
    state.toasts = []
    wx.shareFileMessage = function (o) { o.fail({ errMsg: 'shareFileMessage:fail cancel' }) }
    var cancelled = await exporter.show({ csv: '\ufeff日期\n2026-10-24', name: '账本', count: 1 })
    assert.strictEqual(cancelled.cancelled, true)
    assert.strictEqual(state.toasts.length, 0)
  })
  fs.rmSync(dir, { recursive: true, force: true })
  if (failures) process.exitCode = 1
}
main()
