const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

Page({
  data: {
    q: '',
    type: '',              // '' | expense | income | transfer
    memberId: '',
    category: '',
    start: '',
    end: '',
    minAmount: '',
    maxAmount: '',
    members: [],
    categories: [],        // 当前类型可选分类
    results: [],
    groups: [],
    summary: { count: 0, income: 0, expense: 0, incomeText: '0.00', expenseText: '0.00' },
    searched: false
  },

  onLoad() {
    var ledger = db.currentLedger()
    if (!ledger) return
    this.setData({
      members: u.memberStats(db.recordsOf(ledger.id), ledger.members).map(function (m) {
        return { id: m.id, name: m.name }
      })
    })
  },

  onShow() {
    var ledger = db.currentLedger()
    if (ledger) {
      this.setData({ categories: db.categoriesOf(ledger.id, 'expense') })
    }
  },

  onQInput(e) {
    this.setData({ q: e.detail.value })
  },

  setType(e) {
    var type = e.currentTarget.dataset.type
    var ledger = db.currentLedger()
    this.setData({
      type: this.data.type === type ? '' : type,
      category: ''
    })
    if (ledger) {
      var t = this.data.type === 'income' ? 'income' : 'expense'
      this.setData({ categories: db.categoriesOf(ledger.id, t) })
    }
  },

  setMember(e) {
    this.setData({ memberId: this.data.memberId === e.currentTarget.dataset.id ? '' : e.currentTarget.dataset.id })
  },

  setCategory(e) {
    this.setData({ category: this.data.category === e.currentTarget.dataset.key ? '' : e.currentTarget.dataset.key })
  },

  onStartChange(e) { this.setData({ start: e.detail.value }) },
  onEndChange(e) { this.setData({ end: e.detail.value }) },
  onMinInput(e) { this.setData({ minAmount: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') }) },
  onMaxInput(e) { this.setData({ maxAmount: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') }) },

  resetFilters() {
    this.setData({
      q: '', type: '', memberId: '', category: '', start: '', end: '', minAmount: '', maxAmount: '',
      results: [], groups: [], searched: false,
      summary: { count: 0, income: 0, expense: 0, incomeText: '0.00', expenseText: '0.00' }
    })
    var ledger = db.currentLedger()
    if (ledger) this.setData({ categories: db.categoriesOf(ledger.id, 'expense') })
  },

  doSearch() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var query = {
      q: this.data.q,
      type: this.data.type,
      memberId: this.data.memberId,
      category: this.data.category,
      start: this.data.start,
      end: this.data.end,
      minAmount: u.yuanToCents(this.data.minAmount) || 0,
      maxAmount: u.yuanToCents(this.data.maxAmount) || 0
    }
    var results = db.searchRecords(ledger.id, query)
    var me = db.getMe()
    var accounts = db.accountsOf(ledger.id)
    var decorated = results.map(function (r) {
      var isTransfer = r.type === 'transfer'
      var accName = ''
      if (isTransfer) {
        for (var i = 0; i < accounts.length; i++) {
          if (accounts[i].id === r.transferTo) accName = accounts[i].name || ''
        }
      }
      return {
        id: r.id,
        date: r.date,
        note: r.note,
        createdAt: r.createdAt,
        timeText: u.hmText(r.createdAt),
        type: r.type,
        amount: r.amount,
        icon: isTransfer ? '🔀' : u.categoryIcon(r.type, r.category),
        categoryName: isTransfer ? ('转账至' + (accName || '其他账户')) : u.categoryName(r.type, r.category),
        amountText: u.signedText(r.amount, r.type),
        memberName: r.memberName,
        isOther: r.memberId !== me.id
      }
    })
    var s = u.calcSummary(results)
    this.setData({
      results: results,
      groups: u.groupByDate(decorated),
      searched: true,
      summary: {
        count: results.length,
        income: s.income,
        expense: s.expense,
        incomeText: u.formatCents(s.income),
        expenseText: u.formatCents(s.expense)
      }
    })
  },

  onRecordTap(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/edit/edit?id=' + id })
  }
})
