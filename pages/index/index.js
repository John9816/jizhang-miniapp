const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')

Page({
  data: {
    me: { id: '', name: '' },
    ledger: null,
    monthKey: '',
    monthLabel: '',
    memberFilter: 'all',
    members: [],
    groups: [],
    summary: { income: 0, expense: 0, balance: 0, incomeText: '0.00', expenseText: '0.00', balanceText: '0.00' },
    loading: true,
    showNickname: false,
    nicknameInput: '',
    cloudOn: false,
    syncText: '',
    emptyText: '本月还没有记账记录',
    viewMode: 'list',          // list | calendar
    calendar: { days: [], weekdays: [] },
    selectedDay: '',
    dayGroups: [],
    budget: { monthlyTotal: 0, categoryBudgets: {} },
    budgetStatus: null,
    budgetAlert: ''
  },

  onLoad() {
    var me = db.getMe()
    this.setData({
      me: me,
      showNickname: !me.name,
      nicknameInput: me.name || '',
      selectedDay: u.dateStr(new Date())
    })
    var key = u.currentMonthKey()
    this.setData({ monthKey: key, monthLabel: u.formatMonth(key) })
    this.refresh()
    var self = this
    this._offChange = db.onChange(function () { self.refresh() })
  },

  onUnload() {
    if (this._offChange) this._offChange()
  },

  onShow() {
    // 到期周期记账自动执行（幂等，两端各自跑也不重复）
    var ledger = db.currentLedger()
    if (ledger) {
      var generated = db.runDueRecurring(ledger.id)
      if (generated.length > 0) {
        wx.showToast({ title: '周期记账 +' + generated.length, icon: 'none' })
      }
    }
    if (this.data.loading) return
    this.refresh()
  },

  toggleView() {
    this.setData({ viewMode: this.data.viewMode === 'list' ? 'calendar' : 'list' })
    this.refresh()
  },

  selectDay(e) {
    var day = e.currentTarget.dataset.day
    this.setData({ selectedDay: day })
    this.refresh()
  },

  refresh() {
    var me = db.getMe()
    var ledger = db.currentLedger()
    this.setData({ cloudOn: cloud.enabled(), syncText: cloud.statusText() })
    if (!ledger) {
      this.setData({
        me: me,
        ledger: null,
        members: [],
        groups: [],
        loading: false,
        emptyText: '还没有账本，去创建一个吧',
        budgetStatus: null,
        budgetAlert: '',
        dayGroups: [],
        calendar: { days: [], weekdays: [] },
        summary: { income: 0, expense: 0, balance: 0, incomeText: '0.00', expenseText: '0.00', balanceText: '0.00' }
      })
      return
    }
    var self = this
    var all = db.recordsOf(ledger.id).filter(function (r) {
      return String(r.date).slice(0, 7) === self.data.monthKey
    })
    var members = u.memberStats(all, ledger.members)
    var filtered = this.data.memberFilter === 'all'
      ? all
      : all.filter(function (r) { return r.memberId === self.data.memberFilter })
    var decorated = filtered.map(function (r) {
      var isTransfer = r.type === 'transfer'
      var accName = ''
      if (isTransfer) {
        var accs = db.accountsOf(ledger.id)
        for (var i = 0; i < accs.length; i++) {
          if (accs[i].id === r.transferTo) accName = accs[i].name || ''
        }
      }
      return {
        id: r.id,
        date: r.date,
        note: r.note,
        createdAt: r.createdAt,
        type: r.type,
        amount: r.amount,
        icon: isTransfer ? '🔀' : u.categoryIcon(r.type, r.category),
        categoryName: isTransfer ? ('转账至' + (accName || '其他账户')) : u.categoryName(r.type, r.category),
        amountText: u.signedText(r.amount, r.type),
        memberName: r.memberName,
        isOther: r.memberId !== me.id
      }
    })
    var groups = u.groupByDate(decorated)
    var s = u.calcSummary(all)
    // 日历视图数据
    var calendar = u.calendarMonth(this.data.monthKey, all)
    var dayGroups = groups.filter(function (g) { return g.date === self.data.selectedDay })
    // 预算状态与首页提醒（只看当前月、不受成员筛选影响）
    var budgetStatus = null
    var budgetAlert = ''
    if (this.data.monthKey === u.currentMonthKey()) {
      var budget = db.budgetOf(ledger.id)
      budgetStatus = u.budgetStatus(budget, all, null)
      if (budgetStatus.total && budgetStatus.total.pct >= 80) {
        budgetAlert = budgetStatus.total.over
          ? '本月支出已超出预算 ' + u.formatCents(budgetStatus.total.used - budgetStatus.total.limit) + ' 元'
          : '本月支出已达预算的 ' + budgetStatus.total.pct + '%，注意控制'
      }
    }
    var emptyText = this.data.memberFilter === 'all'
      ? (this.data.monthKey === u.currentMonthKey() ? '本月还没有记账记录' : '这个月还没有记录')
      : '该成员本月还没有记录'
    this.setData({
      me: me,
      ledger: ledger,
      members: members,
      groups: groups,
      calendar: calendar,
      dayGroups: dayGroups,
      loading: false,
      emptyText: emptyText,
      budget: db.budgetOf(ledger.id),
      budgetStatus: budgetStatus,
      budgetAlert: budgetAlert,
      summary: {
        income: s.income,
        expense: s.expense,
        balance: s.balance,
        incomeText: u.formatCents(s.income),
        expenseText: u.formatCents(s.expense),
        balanceText: u.formatCents(s.balance)
      }
    })
  },

  prevMonth() {
    var key = u.shiftMonth(this.data.monthKey, -1)
    this.setData({ monthKey: key, monthLabel: u.formatMonth(key), memberFilter: 'all' })
    this.refresh()
  },

  nextMonth() {
    var key = u.shiftMonth(this.data.monthKey, 1)
    this.setData({ monthKey: key, monthLabel: u.formatMonth(key), memberFilter: 'all' })
    this.refresh()
  },

  setMemberFilter(e) {
    var id = e.currentTarget.dataset.id
    this.setData({ memberFilter: id })
    this.refresh()
  },

  onRecordTap(e) {
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showActionSheet({
      itemList: ['编辑这条记录', '删除这条记录'],
      success(res) {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: '/pages/edit/edit?id=' + id })
        } else if (res.tapIndex === 1) {
          wx.showModal({
            title: '删除记录',
            content: '删除后不可恢复，确定删除这条记录吗？',
            confirmColor: '#F04646',
            success(r) {
              if (r.confirm) {
                db.deleteRecord(id)
                wx.showToast({ title: '已删除', icon: 'success' })
                self.refresh()
              }
            }
          })
        }
      }
    })
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  goTransfer() {
    wx.navigateTo({ url: '/pages/edit/edit?mode=transfer' })
  },

  goLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' })
  },

  goMembers() {
    wx.navigateTo({ url: '/pages/members/members' })
  },

  goStats() {
    wx.navigateTo({ url: '/pages/stats/stats' })
  },

  goBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' })
  },

  goAssets() {
    wx.navigateTo({ url: '/pages/assets/assets' })
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  goCategories() {
    wx.navigateTo({ url: '/pages/categories/categories' })
  },

  goRecurring() {
    wx.navigateTo({ url: '/pages/recurring/recurring' })
  },

  onNicknameInput(e) {
    this.setData({ nicknameInput: e.detail.value })
  },

  confirmNickname() {
    var name = this.data.nicknameInput.trim()
    db.setMyName(name)
    this.setData({ showNickname: false })
    this.refresh()
    wx.showToast({ title: '你好，' + (name || '我'), icon: 'none' })
  }
})
