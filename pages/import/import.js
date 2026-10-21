const db = require('../../utils/db.js')
const bill = require('../../utils/billParser.js')
const u = require('../../utils/util.js')
const vip = require('../../utils/vip.js')

/** 解析结果 → 可展示的明细行 */
function decorateRows(result) {
  return result.rows.map(function (r) {
    var cat = u.categoryOf(r.type, r.category)
    return {
      line: r.line,
      dateText: r.date.slice(5),
      type: r.type,
      title: r.party || r.note || '未命名',
      sub: r.note || '',
      catName: cat.name,
      catIcon: cat.icon,
      channel: r.channel || '',
      amountText: (r.type === 'income' ? '+' : '-') + u.formatCents(r.amount),
      txn: r.txn
    }
  })
}

function skipText(skipped) {
  var parts = []
  if (skipped.refund) parts.push('退款 ' + skipped.refund)
  if (skipped.closed) parts.push('关闭/未完结 ' + skipped.closed)
  if (skipped.neutral) parts.push('不计收支 ' + skipped.neutral)
  if (skipped.dup) parts.push('文件内重复 ' + skipped.dup)
  if (skipped.badRow) parts.push('无法解析 ' + skipped.badRow)
  return parts.length ? parts.join(' · ') : '无'
}

Page({
  data: {
    mode: 'file',
    rawText: '',
    result: null,
    sourceLabel: '',
    viewRows: [],
    summary: { count: 0, incomeText: '0.00', expenseText: '0.00', range: '' },
    skipNote: '',
    extraNote: '',
    ledger: null,
    accounts: [],
    categoryOptions: [],
    categoryIndex: 0,
    accountOptions: [],
    accountIndex: 0,
    importResult: null
  },

  onLoad() {
    this.refresh()
    var self = this
    this._offChange = db.onChange(function () { self.refresh() })
  },

  onUnload() {
    if (this._offChange) this._offChange()
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    var ledger = db.currentLedger()
    var categoryOptions = [{ key: 'auto', name: '自动识别（按交易信息推荐）' }]
    u.categoriesFor('expense').forEach(function (c) { categoryOptions.push({ key: c.key, name: '支出｜' + c.icon + c.name }) })
    u.categoriesFor('income').forEach(function (c) { categoryOptions.push({ key: c.key, name: '收入｜' + c.icon + c.name }) })
    var accountOptions = [{ id: '', name: '不指定账户' }]
    if (ledger) {
      db.accountsOf(ledger.id).forEach(function (a) { accountOptions.push({ id: a.id, name: a.name }) })
    }
    this.setData({
      ledger: ledger,
      accounts: ledger ? db.accountsOf(ledger.id) : [],
      categoryOptions: categoryOptions,
      accountOptions: accountOptions
    })
  },

  /* ---------------- 输入 ---------------- */

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode, result: null, importResult: null })
  },

  onRawInput(e) {
    this.setData({ rawText: e.detail.value })
  },

  chooseFile() {
    var self = this
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success(res) {
        var file = res.tempFiles[0]
        wx.getFileSystemManager().readFile({
          filePath: file.path,
          success(data) {
            self.applyResult(bill.parseBytes(data.data), file.name || '')
          },
          fail() {
            wx.showToast({ title: '文件读取失败', icon: 'none' })
          }
        })
      },
      fail() { /* 用户取消 */ }
    })
  },

  parsePasted() {
    var text = this.data.rawText.trim()
    if (!text) {
      wx.showToast({ title: '请先粘贴账单内容', icon: 'none' })
      return
    }
    this.applyResult(bill.parseText(text), '粘贴内容')
  },

  applyResult(result, fromName) {
    var self = this
    if (!result.src) {
      this.setData({
        result: result,
        sourceLabel: '',
        viewRows: [],
        summary: { count: 0, incomeText: '0.00', expenseText: '0.00', range: '' },
        skipNote: '',
        importResult: null
      })
      wx.showToast({ title: '未能识别账单格式', icon: 'none' })
      return
    }
    this.setData({
      result: result,
      sourceLabel: bill.SOURCE_LABELS[result.src] || result.src,
      viewRows: decorateRows(result),
      summary: {
        count: result.rows.length,
        incomeText: u.formatCents(result.stats.incomeCents),
        expenseText: u.formatCents(result.stats.expenseCents),
        range: (result.stats.firstDate || '-') + ' ~ ' + (result.stats.lastDate || '-')
      },
      skipNote: skipText(result.stats.skipped),
      extraNote: fromName ? '来源：' + fromName : '',
      importResult: null
    })
    wx.showToast({ title: '识别到 ' + result.rows.length + ' 笔', icon: 'success' })
  },

  reInput() {
    this.setData({ result: null, importResult: null, rawText: '' })
  },

  /* ---------------- 导入 ---------------- */

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },

  onAccountChange(e) {
    this.setData({ accountIndex: Number(e.detail.value) })
  },

  doImport() {
    var result = this.data.result
    var ledger = this.data.ledger
    if (!result || !result.rows.length || !ledger) return
    var rows = result.rows
    // 免费版单次导入上限 50 笔；会员不限（会员功能关闭时也放行，避免无意义的截断）
    if (vip.featureEnabled() && !db.isVip() && rows.length > 50) {
      rows = rows.slice(0, 50)
      wx.showToast({ title: '免费版单次上限 50 笔，已截断', icon: 'none' })
    }
    var catOpt = this.data.categoryOptions[this.data.categoryIndex]
    var accOpt = this.data.accountOptions[this.data.accountIndex]
    var opts = { accountId: accOpt ? accOpt.id : '' }
    if (catOpt && catOpt.key !== 'auto') opts.category = catOpt.key
    var res = db.importRows(ledger.id, rows, opts)
    this.setData({
      importResult: {
        added: res.added.length,
        dupes: res.dupes,
        skipped: res.skipped - res.dupes
      }
    })
    wx.showToast({ title: '已导入 ' + res.added.length + ' 笔', icon: 'success' })
  },

  goReconcile() {
    wx.navigateTo({ url: '/pages/reconcile/reconcile' })
  },

  onShareAppMessage() {
    return { title: '导入微信/支付宝账单，自动对账', path: '/pages/import/import' }
  }
})
