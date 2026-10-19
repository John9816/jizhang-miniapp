const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

Page({
  data: {
    type: 'expense',        // expense | income
    mode: 'normal',         // normal | transfer
    categories: [],
    category: 'food',
    amountInput: '',
    date: '',
    note: '',
    editingId: '',
    ledgerId: '',
    accounts: [],
    accountId: '',
    transferTo: '',
    transferToName: ''
  },

  normalizeAccounts(accounts) {
    return (accounts || []).map(function (a) {
      var info = u.accountTypeInfo(a.type)
      return { id: a.id, name: a.name, type: a.type, icon: info.icon, initialBalance: a.initialBalance }
    })
  },

  onLoad(options) {
    var ledger = db.currentLedger()
    var ledgerId = ledger ? ledger.id : ''
    this.setData({ ledgerId: ledgerId, accounts: this.normalizeAccounts(db.accountsOf(ledgerId)) })
    if (options.id) {
      var rec = db.getRecord(options.id)
      if (rec) {
        var d = {
          editingId: rec.id,
          ledgerId: rec.ledgerId,
          date: rec.date,
          note: rec.note,
          amountInput: u.formatCents(rec.amount),
          accounts: this.normalizeAccounts(db.accountsOf(rec.ledgerId))
        }
        if (rec.type === 'transfer') {
          d.mode = 'transfer'
          d.accountId = rec.accountId
          d.transferTo = rec.transferTo
          d.transferToName = rec.transferToName
        } else {
          d.type = rec.type
          d.category = rec.category
          d.accountId = rec.accountId || ''
        }
        this.setData(d)
      }
    } else if (options.mode === 'transfer') {
      this.setData({ mode: 'transfer' })
    }
    this.syncCategories()
  },

  syncCategories() {
    if (this.data.mode === 'transfer') return
    var list = db.categoriesOf(this.data.ledgerId, this.data.type)
    var valid = list.some(function (c) { return c.key === this.data.category }, this)
    this.setData({
      categories: list,
      category: valid ? this.data.category : list[0].key
    })
  },

  setType(e) {
    var type = e.currentTarget.dataset.type
    if (type === this.data.type) return
    var list = db.categoriesOf(this.data.ledgerId, type)
    this.setData({
      type: type,
      categories: list,
      category: list[0].key
    })
  },

  setMode(e) {
    var mode = e.currentTarget.dataset.mode
    var type = e.currentTarget.dataset.type
    var patch = { mode: mode }
    if (type && type !== this.data.type) patch.type = type
    this.setData(patch, function () { this.syncCategories() })
  },

  setCategory(e) {
    this.setData({ category: e.currentTarget.dataset.key })
  },

  setAccount(e) {
    var id = e.currentTarget.dataset.id
    var field = e.currentTarget.dataset.field
    var target = {}
    if (field === 'from') {
      target.accountId = id
      // 转回同一账户时清掉目标，避免保存校验误导
      if (this.data.transferTo === id) target.transferTo = ''
    } else {
      target.transferTo = id
    }
    var accounts = this.data.accounts
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].id === id) {
        target[field === 'from' ? 'accountId' : 'transferToName'] = accounts[i].name
        break
      }
    }
    this.setData(target)
  },

  onAmountInput(e) {
    var v = String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '')
    var parts = v.split('.')
    var intPart = parts[0].slice(0, 7)
    var out = intPart
    if (parts.length > 1) {
      out += '.' + parts.slice(1).join('').slice(0, 2)
    }
    this.setData({ amountInput: out })
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  onSave() {
    var cents = u.yuanToCents(this.data.amountInput)
    if (cents <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' })
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
      fields.accountId = this.data.accountId
      fields.transferTo = this.data.transferTo
      fields.transferToName = this.data.transferToName
      if (!fields.accountId || !fields.transferTo || fields.accountId === fields.transferTo) {
        wx.showToast({ title: '请选择转出和转入账户', icon: 'none' })
        return
      }
    }
    if (this.data.editingId) {
      var updated = db.updateRecord(this.data.editingId, fields)
      if (!updated) {
        wx.showToast({ title: '保存失败，请检查表单', icon: 'none' })
        return
      }
      wx.showToast({ title: '已保存', icon: 'success' })
    } else {
      db.addRecord(fields)
      wx.showToast({ title: this.data.mode === 'transfer' ? '已转账' : '已记下', icon: 'success' })
    }
    setTimeout(function () { wx.navigateBack() }, 300)
  },

  onDelete() {
    var self = this
    wx.showModal({
      title: '删除记录',
      content: '删除后不可恢复，确定删除这条记录吗？',
      confirmColor: '#F04646',
      success(r) {
        if (r.confirm) {
          db.deleteRecord(self.data.editingId)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(function () { wx.navigateBack() }, 300)
        }
      }
    })
  }
})
