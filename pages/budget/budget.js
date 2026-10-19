const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

Page({
  data: {
    monthKey: '',
    monthLabel: '',
    monthlyInput: '',
    categoryBudgets: [],     // [{ key, name, icon, used, limit, pct, over }]
    expCategories: [],       // 支出分类（用于选择要设预算的分类）
    totalInput: '',
    usedText: '0.00',
    limitText: '',
    totalPct: 0,
    totalOver: false,
    showCatPicker: false,
    pickedCat: '',
    pickedLimit: '',
    editingCat: '',
    editLimit: ''
  },

  onLoad() {
    this.setData({ monthKey: u.currentMonthKey(), monthLabel: u.formatMonth(u.currentMonthKey()) })
    this.refresh()
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var budget = db.budgetOf(ledger.id)
    var recs = db.recordsOf(ledger.id).filter(function (r) {
      return String(r.date).slice(0, 7) === u.currentMonthKey()
    })
    var status = u.budgetStatus(budget, recs, null)
    var cats = u.categoryStats(recs, 'expense')
    var catBudgets = status.items.map(function (it) {
      return Object.assign({}, it, {
        usedText: u.formatCents(it.used),
        limitText: u.formatCents(it.limit),
        remainText: ((it.limit - it.used) / 100).toFixed(2)
      })
    })
    var available = u.categoryStats(recs, 'expense').length
      ? cats.map(function (c) { return { key: c.key, name: c.name, icon: c.icon, amountText: c.amountText, pct: c.pct } })
      : db.categoriesOf(ledger.id, 'expense')
    this.setData({
      monthlyInput: budget.monthlyTotal > 0 ? (budget.monthlyTotal / 100).toFixed(2) : '',
      usedText: status.total ? u.formatCents(status.total.used) : u.formatCents(u.calcSummary(recs).expense),
      limitText: status.total ? u.formatCents(status.total.limit) : '',
      totalPct: status.total ? status.total.pct : 0,
      totalOver: status.total ? status.total.over : false,
      categoryBudgets: catBudgets,
      expCategories: available
    })
  },

  ledgerIdOf() {
    var l = db.currentLedger()
    return l ? l.id : ''
  },

  onTotalInput(e) {
    this.setData({ monthlyInput: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') })
  },

  saveTotal() {
    var cents = u.yuanToCents(this.data.monthlyInput)
    var ledger = db.currentLedger()
    if (!ledger) return
    db.saveBudget(ledger.id, {
      monthlyTotal: cents,
      categoryBudgets: db.budgetOf(ledger.id).categoryBudgets
    })
    wx.showToast({ title: '总预算已保存', icon: 'success' })
    this.refresh()
  },

  openCatPicker() {
    var self = this
    var cats = this.data.expCategories
    if (!cats.length) {
      wx.showToast({ title: '暂无可设置的分类', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: cats.map(function (c) { return c.icon + ' ' + c.name }),
      success(res) {
        var cat = cats[res.tapIndex]
        var budget = db.budgetOf(self.ledgerIdOf())
        var exist = budget.categoryBudgets[cat.key]
        self.setData({
          showCatPicker: true,
          pickedCat: cat.key,
          pickedCatName: cat.name,
          editLimit: exist ? (exist / 100).toFixed(2) : ''
        })
      }
    })
  },

  ledgerIdOf() {
    var l = db.currentLedger()
    return l ? l.id : ''
  },

  onCatLimitInput(e) {
    this.setData({ editLimit: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') })
  },

  saveCatLimit() {
    var ledger = db.currentLedger()
    if (!ledger || !this.data.pickedCat) return
    var cents = u.yuanToCents(this.data.editLimit)
    if (cents <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    var budget = db.budgetOf(ledger.id)
    var cats = Object.assign({}, budget.categoryBudgets)
    cats[this.data.pickedCat] = cents
    db.saveBudget(ledger.id, { monthlyTotal: budget.monthlyTotal, categoryBudgets: cats })
    this.setData({ showCatPicker: false })
    wx.showToast({ title: '分类预算已保存', icon: 'success' })
    this.refresh()
  },

  removeCatLimit(e) {
    var key = e.currentTarget.dataset.key
    var ledger = db.currentLedger()
    if (!ledger) return
    var budget = db.budgetOf(ledger.id)
    var cats = Object.assign({}, budget.categoryBudgets)
    delete cats[key]
    db.saveBudget(ledger.id, { monthlyTotal: budget.monthlyTotal, categoryBudgets: cats })
    this.refresh()
  },

  closePicker() {
    this.setData({ showCatPicker: false })
  }
})
