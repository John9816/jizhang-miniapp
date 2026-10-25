const db = require('../../utils/db.js')
const u = require('../../utils/util.js')
const motion = require('../../utils/motion.js')

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
    datePreset: '',
    filterError: '',
    showFilters: false,
    filterCount: 0,
    filterSummary: '全部时间 · 全部类型',
    members: [],
    categories: [],        // 当前类型可选分类
    results: [],
    groups: [],
    summary: { count: 0, income: 0, expense: 0, incomeText: '0.00', expenseText: '0.00' },
    searched: false
  },

  onLoad(options) {
    var ledger = db.currentLedger()
    if (!ledger) return
    this.setData({
      members: u.memberStats(db.recordsOf(ledger.id), ledger.members).map(function (m) {
        return { id: m.id, name: m.name }
      })
    })
    options = options || {}
    if (/^\d{4}-\d{2}-\d{2}$/.test(options.start || '') && /^\d{4}-\d{2}-\d{2}$/.test(options.end || '')) {
      var type = ['income', 'expense', 'transfer'].indexOf(options.type) >= 0 ? options.type : ''
      this.setData({ type: type, start: options.start, end: options.end, category: options.category || '', memberId: options.memberId || '' })
    }
    this.doSearch()
  },

  onShow() {
    motion.reveal(this)
    var ledger = db.currentLedger()
    if (ledger) {
      var type = this.data.type
      this.setData({ categories: type === 'transfer' ? [] : type ? db.categoriesOf(ledger.id, type)
        : db.categoriesOf(ledger.id, 'expense').concat(db.categoriesOf(ledger.id, 'income')) })
    }
    if (this.data.searched) this.doSearch()
  },

  onQInput(e) {
    this.setData({ q: e.detail.value })
  },

  clearQuery() { this.setData({ q: '' }); this.doSearch() },
  toggleFilters() { this.setData({ showFilters: !this.data.showFilters }) },
  applyFilters() {
    this.doSearch()
    if (!this.data.filterError) {
      this.setData({ showFilters: false })
      if (wx.hideKeyboard) wx.hideKeyboard()
    }
  },

  setType(e) {
    var type = e.currentTarget.dataset.type
    this.setData({
      type: this.data.type === type ? '' : type,
      category: ''
    })
    this.onShow()
  },

  setMember(e) {
    this.setData({ memberId: this.data.memberId === e.currentTarget.dataset.id ? '' : e.currentTarget.dataset.id })
    if (this.data.searched) this.doSearch()
  },

  setCategory(e) {
    this.setData({ category: this.data.category === e.currentTarget.dataset.key ? '' : e.currentTarget.dataset.key })
    if (this.data.searched) this.doSearch()
  },

  onStartChange(e) { this.setData({ start: e.detail.value, datePreset: '' }); if (this.data.searched) this.doSearch() },
  onEndChange(e) { this.setData({ end: e.detail.value, datePreset: '' }); if (this.data.searched) this.doSearch() },
  onMinInput(e) { this.setData({ minAmount: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') }) },
  onMaxInput(e) { this.setData({ maxAmount: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') }) },

  setDatePreset(e) { this.applyDatePreset(e.currentTarget.dataset.preset) },

  applyDatePreset(preset, today) {
    today = today || new Date()
    var start = ''
    if (preset === 'month') start = u.dateStr(new Date(today.getFullYear(), today.getMonth(), 1))
    else if (preset === 'quarter') start = u.dateStr(new Date(today.getFullYear(), today.getMonth() - 2, 1))
    else if (preset === 'year') start = today.getFullYear() + '-01-01'
    this.setData({ datePreset: preset, start: start, end: preset === 'all' ? '' : u.dateStr(today) })
    this.doSearch()
  },

  resetFilters() {
    this.setData({
      q: '', type: '', memberId: '', category: '', start: '', end: '', minAmount: '', maxAmount: '', datePreset: '', filterError: '',
      results: [], groups: [], searched: true,
      summary: { count: 0, income: 0, expense: 0, incomeText: '0.00', expenseText: '0.00' }
    })
    this.onShow()
  },

  doSearch() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var min = String(this.data.minAmount).trim().replace(/^\./, '0.')
    var max = String(this.data.maxAmount).trim().replace(/^\./, '0.')
    var amountPattern = /^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/
    var error = ''
    if (this.data.start && this.data.end && this.data.start > this.data.end) error = '开始日期不能晚于结束日期'
    else if ((min && !amountPattern.test(min)) || (max && !amountPattern.test(max))) error = '金额请输入数字，最多保留两位小数'
    else if ((min && !Number.isSafeInteger(u.yuanToCents(min))) || (max && !Number.isSafeInteger(u.yuanToCents(max)))) error = '金额超出可查询范围'
    else if (min && max && u.yuanToCents(min) > u.yuanToCents(max)) error = '最低金额不能大于最高金额'
    this.setData({ filterError: error })
    if (error) { this.setData({ showFilters: true }); return }
    var d = this.data
    var count = [!!d.type, !!d.memberId, !!d.category, !!(d.start || d.end), !!(min || max)].filter(Boolean).length
    var dateText = d.start || d.end ? (d.start || '不限') + ' 至 ' + (d.end || '不限') : '全部时间'
    var typeText = { expense: '支出', income: '收入', transfer: '转账' }[d.type] || '全部类型'
    this.setData({ filterCount: count, filterSummary: dateText + ' · ' + typeText + (d.category ? ' · 已选分类' : '') + (d.memberId ? ' · 已选成员' : '') + (min || max ? ' · 已设金额' : '') })
    var query = {
      q: this.data.q,
      type: this.data.type,
      memberId: this.data.memberId,
      category: this.data.category,
      start: this.data.start,
      end: this.data.end,
      minAmount: min ? u.yuanToCents(min) : null,
      maxAmount: max ? u.yuanToCents(max) : null
    }
    var results = db.searchRecords(ledger.id, query)
    var me = db.getMe()
    var accounts = db.accountsOf(ledger.id)
    var categoryMap = {}
    ;(ledger.categories || []).forEach(function (c) { categoryMap[c.key] = c })
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
        icon: isTransfer ? '🔀' : ((categoryMap[r.category] || {}).icon || u.categoryIcon(r.type, r.category)),
        categoryName: isTransfer ? ('转账至' + (accName || '其他账户')) : ((categoryMap[r.category] || {}).name || u.categoryName(r.type, r.category)),
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
    motion.reveal(this, 'resultsMotion')
  },

  onRecordTap(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) })
  }
})
