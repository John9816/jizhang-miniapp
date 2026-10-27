const db = require('../../utils/db.js')
const u = require('../../utils/util.js')
const insight = require('../../utils/budget-insight.js')

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
    insight: null,
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
    var categories = db.categoriesOf(ledger.id, 'expense')
    var categoryMap = {}
    categories.forEach(function (c) { categoryMap[c.key] = c })
    var recs = db.recordsOf(ledger.id).filter(function (r) {
      return String(r.date).slice(0, 7) === u.currentMonthKey()
    })
    var status = u.budgetStatus(budget, recs, function (key) { return categoryMap[key] })
    var catBudgets = status.items.map(function (it) {
      return Object.assign({}, it, {
        usedText: u.formatCents(it.used),
        limitText: u.formatCents(it.limit),
        remainText: ((it.limit - it.used) / 100).toFixed(2)
      })
    })
    var forecast = insight.calculate(budget.monthlyTotal, recs)
    forecast.remainingText = u.formatCents(Math.abs(forecast.remaining))
    forecast.dailyText = u.formatCents(forecast.dailyAvailable)
    forecast.projectedText = u.formatCents(forecast.projected)
    forecast.futureText = u.formatCents(forecast.futureExpense)
    forecast.projectedOver = forecast.projected > budget.monthlyTotal
    this.setData({
      monthKey: u.currentMonthKey(), monthLabel: u.formatMonth(u.currentMonthKey()),
      insight: forecast,
      monthlyInput: budget.monthlyTotal > 0 ? (budget.monthlyTotal / 100).toFixed(2) : '',
      usedText: status.total ? u.formatCents(status.total.used) : u.formatCents(u.calcSummary(recs).expense),
      limitText: status.total ? u.formatCents(status.total.limit) : '',
      totalPct: status.total ? status.total.pct : 0,
      totalOver: status.total ? status.total.over : false,
      categoryBudgets: catBudgets,
      expCategories: categories
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
    if (this.data.monthlyInput && !/^\d+(\.\d{0,2})?$/.test(this.data.monthlyInput)) {
      wx.showToast({ title: '请输入有效预算，最多两位小数', icon: 'none' })
      return
    }
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
    var cats = this.data.expCategories
    if (!cats.length) {
      wx.showToast({ title: '暂无可设置的分类', icon: 'none' })
      return
    }
    this.pickCategory(cats[0].key)
    this.setData({ showCatPicker: true })
  },

  pickCategory(key) {
    var cat = this.data.expCategories.filter(function (c) { return c.key === key })[0]
    if (!cat) return
    var exist = db.budgetOf(this.ledgerIdOf()).categoryBudgets[key]
    this.setData({ pickedCat: key, pickedCatName: cat.name, editLimit: exist ? (exist / 100).toFixed(2) : '' })
  },

  onPickCategory(e) { this.pickCategory(e.currentTarget.dataset.key) },

  editCategory(e) {
    this.pickCategory(e.currentTarget.dataset.key)
    if (this.data.pickedCat === e.currentTarget.dataset.key) this.setData({ showCatPicker: true })
  },

  onCatLimitInput(e) {
    this.setData({ editLimit: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') })
  },

  saveCatLimit() {
    var ledger = db.currentLedger()
    if (!ledger || !this.data.pickedCat) return
    var cents = u.yuanToCents(this.data.editLimit)
    if (cents <= 0 || !/^\d+(\.\d{0,2})?$/.test(this.data.editLimit)) {
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
    if (!ledger || !key) return
    var item = this.data.categoryBudgets.filter(function (c) { return c.key === key })[0]
    var name = item ? item.name : '该分类'
    var self = this
    wx.showModal({
      title: '删除分类预算？',
      content: '仅删除「' + name + '」的预算额度，不会删除该分类的记账记录。',
      confirmText: '删除',
      confirmColor: '#D65A45',
      success: function (res) {
        if (!res.confirm) return
        // 使用打开弹窗时的账本，避免异步确认期间误删其他账本的预算。
        var budget = db.budgetOf(ledger.id)
        var cats = Object.assign({}, budget.categoryBudgets)
        delete cats[key]
        db.saveBudget(ledger.id, { monthlyTotal: budget.monthlyTotal, categoryBudgets: cats })
        self.refresh()
        wx.showToast({ title: '分类预算已删除', icon: 'none' })
      }
    })
  },

  closePicker() {
    this.setData({ showCatPicker: false })
  }
})
