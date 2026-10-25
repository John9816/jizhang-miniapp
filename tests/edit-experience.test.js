var assert = require('assert')
var db = require('../utils/db.js')
var definition
global.Page = function (p) { definition = p }
require('../pages/edit/edit.js')
delete global.Page
var failures = 0
function setup(editing) {
  var store = {}
  var state = { navigated: 0, modal: null }
  global.getCurrentPages = function () { return [{}, {}] }
  global.wx = {
    getStorageSync: function (k) { return store[k] || '' },
    setStorageSync: function (k, v) { store[k] = v },
    getWindowInfo: function () { return { statusBarHeight: 20, windowHeight: 800 } },
    getMenuButtonBoundingClientRect: function () { return { top: 24, bottom: 56 } },
    enableAlertBeforeUnload: function () {}, disableAlertBeforeUnload: function () {},
    showToast: function () {}, showModal: function (o) { state.modal = o },
    navigateBack: function () { state.navigated++ }
  }
  db.init()
  var rec = editing ? db.addRecord({ ledgerId: db.currentLedger().id, amount: 1200, type: 'expense', category: 'food', date: '2026-10-24', accountId: 'acc_wechat', note: '午饭' }) : null
  var p = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData: function (patch, cb) { Object.assign(this.data, patch); if (cb) cb() }
  })
  p.onLoad(rec ? { id: rec.id } : {})
  return { page: p, state: state, rec: rec }
}
function test(name, fn) {
  try { fn(); console.log('PASS ' + name) }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) }
}
test('编辑历史账单时显示原账户名称', function () {
  var p = setup(true).page
  assert.strictEqual(p.data.accountName, '微信钱包')
})
test('编辑后触发未保存提醒，还原原值后解除提醒', function () {
  var p = setup(true).page
  assert.ok(!p._guarding)
  p.onNoteInput({ detail: { value: '晚饭' } })
  assert.strictEqual(p._guarding, true)
  p.onNoteInput({ detail: { value: '午饭' } })
  assert.strictEqual(p._guarding, false)
})
test('取消有修改的账单需要确认，继续编辑保留输入', function () {
  var s = setup(true)
  s.page.onNoteInput({ detail: { value: '晚饭' } })
  s.page.onCancel()
  assert.ok(s.state.modal)
  assert.strictEqual(s.state.navigated, 0)
  s.state.modal.success({ confirm: false })
  assert.strictEqual(s.page.data.note, '晚饭')
  assert.strictEqual(s.state.navigated, 0)
  s.state.modal.success({ confirm: true })
  assert.strictEqual(s.state.navigated, 1)
  assert.strictEqual(db.getRecord(s.rec.id).note, '午饭')
})
test('新账单只填备注，金额清空后仍保留未保存提醒', function () {
  var p = setup(false).page
  p.onNoteInput({ detail: { value: '稍后补金额' } })
  p.appendDigit('1')
  p.backspace()
  assert.strictEqual(p._guarding, true)
})
test('找不到原记录时不能把编辑页意外保存为新账单', function () {
  var p = setup(false).page
  p.onLoad({ id: 'missing-record' })
  p.setData({ amountInput: '99' })
  p.onSave()
  assert.strictEqual(db.recordsOf(db.currentLedger().id).length, 0)
})
if (failures) process.exitCode = 1
