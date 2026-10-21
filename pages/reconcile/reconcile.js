const db = require('../../utils/db.js')
const bill = require('../../utils/billParser.js')
const u = require('../../utils/util.js')
const vip = require('../../utils/vip.js')

Page({
  data: {
    mode: 'file',
    rawText: '',
    result: null,
    sourceLabel: '',
    rec: null,
    localCount: 0,
    ledger: null,
    accounts: [],
    accountIndex: 0,
    importNote: ''
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
    if (this.data.rec) this.runReconcile() // 页面回到前台时按最新数据重算
  },

  refresh() {
    var ledger = db.currentLedger()
    var accountOptions = [{ id: '', name: '不指定账户' }]
    if (ledger) {
      db.accountsOf(ledger.id).forEach(function (a) { accountOptions.push({ id: a.id, name: a.name }) })
      var localCount = db.recordsOf(ledger.id).filter(function (r) {
        return !r.deleted && (r.type === 'expense' || r.type === 'income')
      }).length
      this.setData({ ledger: ledger, accounts: db.accountsOf(ledger.id), accountOptions: accountOptions, localCount: localCount })
    } else {
      this.setData({ ledger: null, accounts: [], accountOptions: accountOptions, localCount: 0 })
    }
  },

  /* ---------------- 输入账单 ---------------- */

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
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
            self.applyResult(bill.parseBytes(data.data))
          },
          fail() { wx.showToast({ title: '文件读取失败', icon: 'none' }) }
        })
      },
      fail() { /* 取消 */ }
    })
  },

  parsePasted() {
    var text = this.data.rawText.trim()
    if (!text) {
      wx.showToast({ title: '请先粘贴账单内容', icon: 'none' })
      return
    }
    this.applyResult(bill.parseText(text))
  },

  applyResult(result) {
    if (!result.src) {
      this.setData({ result: null, rec: null })
      wx.showToast({ title: '未能识别账单格式', icon: 'none' })
      return
    }
    this.setData({ result: result, sourceLabel: bill.SOURCE_LABELS[result.src] || result.src, importNote: '' })
    this.runReconcile()
  },

  /* ---------------- 对账 ---------------- */

  runReconcile() {
    var result = this.data.result
    var ledger = this.data.ledger
    if (!result || !result.rows.length || !ledger) return
    var rec = db.reconcile(ledger.id, result.rows)
    var matchedRows = []
    var missingRows = []
    var extraRows = []
    rec.rows.forEach(function (item) {
      var row = item.row
      var entry = {
        key: item.key,
        dateText: row.date,
        title: row.party || row.note || '未命名',
        sub: row.note || '',
        amountText: (row.type === 'income' ? '+' : '-') + u.formatCents(row.amount),
        type: row.type,
        localNote: item.localNote || ''
      }
      if (item.status === 'matched') matchedRows.push(entry)
      else missingRows.push(entry)
    })
    rec.extra.forEach(function (r) {
      var cat = u.categoryOf(r.type, r.category)
      extraRows.push({
        id: r.id,
        dateText: r.date,
        title: r.note || cat.name,
        sub: cat.name + (r.memberName ? ' · ' + r.memberName : ''),
        amountText: (r.type === 'income' ? '+' : '-') + u.formatCents(r.amount),
        type: r.type
      })
    })
    matchedRows.sort(function (a, b) { return a.dateText < b.dateText ? 1 : -1 })
    missingRows.sort(function (a, b) { return a.dateText < b.dateText ? 1 : -1 })
    extraRows.sort(function (a, b) { return a.dateText < b.dateText ? 1 : -1 })
    this.setData({
      rec: {
        matched: rec.matched,
        missing: rec.missing,
        extraCount: rec.extra.length,
        matchedRows: matchedRows,
        missingRows: missingRows,
        extraRows: extraRows
      }
    })
  },

  importMissing() {
    var rec = this.data.rec
    var ledger = this.data.ledger
    if (!rec || !rec.missingRows.length || !ledger) return
    var rows = this.data.result.rows.filter(function (row) {
      var key = bill.rowKey(row)
      return rec.missingRows.some(function (m) { return m.key === key })
    })
    var accOpt = this.data.accountOptions[this.data.accountIndex]
    var res = db.importRows(ledger.id, rows, { accountId: accOpt ? accOpt.id : '' })
    this.setData({ importNote: '已补记 ' + res.added.length + ' 笔缺失流水' })
    wx.showToast({ title: '已补记 ' + res.added.length + ' 笔', icon: 'success' })
    this.runReconcile()
  },

  onAccountChange(e) {
    this.setData({ accountIndex: Number(e.detail.value) })
  },

  /* ---------------- 导出 ---------------- */

  exportCSV() {
    var ledger = this.data.ledger
    if (!ledger) return
    if (vip.featureEnabled() && !db.isVip()) {
      wx.showModal({
        title: '导出为会员功能',
        content: '升级会员后可解锁对账 CSV 导出，方便备份与报税。',
        confirmText: '去开通',
        cancelText: '知道了',
        success: function (r) { if (r.confirm) wx.navigateTo({ url: '/pages/vip/vip' }) }
      })
      return
    }
    var csv = db.exportReconcileCSV(ledger.id)
    if (!csv || csv.split('\n').length < 3) {
      wx.showToast({ title: '没有可导出的记录', icon: 'none' })
      return
    }
    var count = csv.split('\n').length - 2
    wx.showActionSheet({
      itemList: ['复制对账 CSV（可粘贴到表格）', '复制备用（发到文件传输助手）'],
      success(res) {
        wx.setClipboardData({
          data: csv,
          success() {
            wx.showToast({ title: '已复制 ' + count + ' 条', icon: 'success' })
          }
        })
      }
    })
  },

  explain() {
    wx.showModal({
      title: '怎么对账',
      content: '导入同一段时间的微信/支付宝账单，本页按「日期 + 金额 + 收/支」逐笔比对账本记录：绿色为两边都有，黄色为账单有但账本没记（可一键补记），灰色为账本多出的记录。',
      showCancel: false
    })
  },

  onShareAppMessage() {
    return { title: '账单对账', path: '/pages/reconcile/reconcile' }
  }
})
