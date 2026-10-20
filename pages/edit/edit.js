const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

/** 分 → "12.34"，不带千分位（可被 parse 回分） */
function plainAmount(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2)
}

Page({
  data: {
    statusBar: 20,
    pageH: 667,             // 由 JS 按真实窗口高度设定，避免 100vh 与自定义导航叠加导致键盘被挤出屏幕
    type: 'expense',        // expense | income
    mode: 'normal',         // normal | transfer
    categories: [],
    category: 'food',
    amountInput: '',
    calcBase: 0,
    calcOp: '',
    calcHint: '',
    date: '',
    dateLabel: '',
    note: '',
    editingId: '',
    ledgerId: '',
    ledgerName: '我的账本',
    accounts: [],
    accountId: '',
    accountName: '',
    transferTo: '',
    transferToName: '',
    canSave: false,
    showAccounts: false
  },

  onLoad(options) {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var ledger = db.currentLedger()
    var ledgerId = ledger ? ledger.id : ''
    var today = u.dateStr(new Date())
    this.setData({
      statusBar: (info && info.statusBarHeight) || 20,
      pageH: (info && info.windowHeight) || 667,
      ledgerId: ledgerId,
      ledgerName: ledger ? ledger.name : '我的账本',
      accounts: this.normalizeAccounts(db.accountsOf(ledgerId)),
      date: today,
      dateLabel: u.cnDate(today)
    })

    if (options.id) {
      var rec = db.getRecord(options.id)
      if (rec) {
        var d = {
          editingId: rec.id,
          ledgerId: rec.ledgerId,
          date: rec.date,
          dateLabel: u.cnDate(rec.date),
          note: rec.note,
          amountInput: plainAmount(rec.amount),
          accounts: this.normalizeAccounts(db.accountsOf(rec.ledgerId)),
          accountId: rec.accountId || ''
        }
        if (rec.type === 'transfer') {
          d.mode = 'transfer'
          d.transferTo = rec.transferTo
          d.transferToName = rec.transferToName
        } else {
          d.type = rec.type
          d.category = rec.category
        }
        this.setData(d)
      }
    } else if (options.mode === 'transfer') {
      this.setData({ mode: 'transfer' })
    }

    this.syncCategories()
    this.refreshAmount()
  },

  normalizeAccounts(accounts) {
    return (accounts || []).map(function (a) {
      var info = u.accountTypeInfo(a.type)
      return { id: a.id, name: a.name, type: a.type, icon: info.icon, initialBalance: a.initialBalance }
    })
  },

  /* ---------------- 类型 / 分类 ---------------- */

  syncCategories() {
    if (this.data.mode === 'transfer') return
    var list = db.categoriesOf(this.data.ledgerId, this.data.type).map(function (c) {
      return { key: c.key, name: c.name, icon: c.icon, tint: u.categoryTint(c.key) }
    })
    var valid = false
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === this.data.category) valid = true
    }
    this.setData({
      categories: list,
      category: valid ? this.data.category : (list[0] ? list[0].key : 'other_out')
    })
  },

  setType(e) {
    var type = e.currentTarget.dataset.type
    if (type === this.data.type && this.data.mode === 'normal') return
    var self = this
    this.setData({ type: type, mode: 'normal' }, function () {
      self.syncCategories()
      self.refreshAmount()
    })
  },

  setCategory(e) {
    var key = e.currentTarget.dataset.key
    this.setData({ category: key })
    wx.vibrateShort && wx.vibrateShort({ type: 'light' })
  },

  toggleTransfer() {
    if (this.data.mode === 'transfer') {
      this.setData({ mode: 'normal' }, function () { this.refreshAmount() }.bind(this))
      return
    }
    if (this.data.accounts.length < 2) {
      wx.showToast({ title: '请先到「资产」添加两个账户', icon: 'none' })
      return
    }
    var first = this.data.accounts[0].id
    var second = this.data.accounts[1].id
    this.setData({
      mode: 'transfer',
      accountId: this.data.accountId || first,
      transferTo: this.data.transferTo || second
    })
    this.refreshAmount()
  },

  setAccount(e) {
    var id = e.currentTarget.dataset.id
    var field = e.currentTarget.dataset.field
    var target = {}
    if (field === 'from') {
      target.accountId = id
      if (this.data.transferTo === id) target.transferTo = ''
    } else {
      target.transferTo = id
    }
    var accounts = this.data.accounts
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].id === id) {
        target[field === 'from' ? 'accountName' : 'transferToName'] = accounts[i].name
        break
      }
    }
    if (id === '') target.accountName = ''
    if (this.data.showAccounts) target.showAccounts = false
    this.setData(target)
    this.refreshAmount()
  },

  openAccounts() {
    this.setData({ showAccounts: true })
  },

  closeAccounts() {
    this.setData({ showAccounts: false })
  },

  /* ---------------- 金额键盘 ---------------- */

  pressKey(e) {
    var k = String(e.currentTarget.dataset.k)
    if (k === 'del') return this.backspace()
    if (k === '+' || k === '-') return this.setOperator(k)
    if (k === '.') return this.appendDot()
    return this.appendDigit(k)
  },

  appendDigit(d) {
    var cur = this.data.amountInput
    if (cur === '0') cur = ''
    var seg = cur.split('.')
    if (seg.length > 1 && seg[1].length >= 2) return
    if (seg.length === 1 && seg[0].length >= 7) return
    this.setData({ amountInput: cur + d })
    this.refreshAmount()
  },

  appendDot() {
    var cur = this.data.amountInput
    if (cur.indexOf('.') >= 0) return
    this.setData({ amountInput: (cur || '0') + '.' })
  },

  backspace() {
    var cur = this.data.amountInput
    if (cur) {
      this.setData({ amountInput: cur.slice(0, -1) })
    } else if (this.data.calcOp) {
      // 退回到上一步的计算基数
      this.setData({ amountInput: plainAmount(this.data.calcBase), calcBase: 0, calcOp: '', calcHint: '' })
    }
    this.refreshAmount()
  },

  setOperator(op) {
    var cents = u.yuanToCents(this.data.amountInput)
    var base = this.data.calcBase
    if (base === 0 && cents === 0) return
    if (base === 0) {
      base = cents
    } else if (cents > 0) {
      base = this.data.calcOp === '-' ? Math.max(0, base - cents) : base + cents
    }
    this.setData({
      calcBase: base,
      calcOp: op,
      calcHint: plainAmount(base) + ' ' + op,
      amountInput: ''
    })
    this.refreshAmount()
  },

  /** 结算当前金额（分） */
  evalAmount() {
    var cur = u.yuanToCents(this.data.amountInput)
    if (!this.data.calcOp) return cur
    return this.data.calcOp === '-' ? Math.max(0, this.data.calcBase - cur) : this.data.calcBase + cur
  },

  refreshAmount() {
    var cents = this.evalAmount()
    var ok = cents > 0
    if (ok && this.data.mode === 'transfer') {
      ok = !!this.data.accountId && !!this.data.transferTo && this.data.accountId !== this.data.transferTo
    }
    this.setData({ canSave: ok })
    // 已经有输入内容时，给返回按钮加二次确认，避免手滑丢掉刚敲的金额
    this.guardUnsaved(this.data.editingId ? false : cents > 0)
  },

  /** 未保存内容提醒：必须在用户交互之后调用才生效 */
  guardUnsaved(on) {
    if (!wx.enableAlertBeforeUnload) return
    if (on && !this._guarding) {
      try {
        wx.enableAlertBeforeUnload({ message: '这条还没保存，确定离开吗？' })
        this._guarding = true
      } catch (e) {}
    } else if (!on && this._guarding) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
      this._guarding = false
    }
  },

  /* ---------------- 其它输入 ---------------- */

  onDateChange(e) {
    this.setData({ date: e.detail.value, dateLabel: u.cnDate(e.detail.value) })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
    if (!this.data.editingId) this.guardUnsaved(this.evalAmount() > 0 || !!e.detail.value)
  },

  onCancel() {
    // 点了取消就等于主动放弃，撤掉系统级拦截
    this.guardUnsaved(false)
    var pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/index/index' })
  },

  /* ---------------- 保存 ---------------- */

  onSave() {
    if (this.data.saving) return
    var cents = this.evalAmount()
    if (cents <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    if (!this.data.ledgerId) {
      wx.showToast({ title: '账本不存在', icon: 'none' })
      return
    }
    var fields = {
      ledgerId: this.data.ledgerId,
      type: this.data.type,
      amount: cents,
      category: this.data.category,
      date: this.data.date || u.dateStr(new Date()),
      note: this.data.note,
      accountId: this.data.accountId
    }
    if (this.data.mode === 'transfer') {
      fields.type = 'transfer'
      fields.transferTo = this.data.transferTo
      fields.transferToName = this.data.transferToName
      if (!fields.accountId || !fields.transferTo || fields.accountId === fields.transferTo) {
        wx.showToast({ title: '请选择转出和转入账户', icon: 'none' })
        return
      }
    }

    this.setData({ saving: true })
    var ok
    if (this.data.editingId) {
      ok = db.updateRecord(this.data.editingId, fields)
    } else {
      ok = db.addRecord(fields)
    }
    if (!ok) {
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败，请检查表单', icon: 'none' })
      return
    }
    wx.showToast({ title: this.data.editingId ? '已保存' : '已记下', icon: 'success' })
    this.guardUnsaved(false)
    setTimeout(function () {
      var pages = getCurrentPages()
      if (pages.length > 1) wx.navigateBack()
      else wx.switchTab({ url: '/pages/index/index' })
    }, 320)
  },

  onDelete() {
    var self = this
    wx.showModal({
      title: '删除记录',
      content: '删除后不可恢复，确定删除这条记录吗？',
      confirmColor: '#E2543F',
      success(r) {
        if (!r.confirm) return
        db.deleteRecord(self.data.editingId)
        wx.showToast({ title: '已删除', icon: 'success' })
        setTimeout(function () {
          var pages = getCurrentPages()
          if (pages.length > 1) wx.navigateBack()
          else wx.switchTab({ url: '/pages/index/index' })
        }, 300)
      }
    })
  }
})
