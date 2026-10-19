const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')

Page({
  data: {
    statusBar: 20,
    me: { id: '', name: '' },
    ledger: null,
    monthKey: '',
    monthLabel: '',
    monthShort: '',
    isCurrentMonth: true,
    memberFilter: 'all',
    members: [],
    groups: [],
    recordCount: 0,
    summary: { income: 0, expense: 0, balance: 0, incomeText: '0.00', expenseText: '0.00', balanceText: '0.00' },
    challenge: null,
    challengeCount: 0,
    budgetAlert: '',
    loading: true,
    showMore: false,
    showNickname: false,
    nicknameInput: '',
    cloudOn: false,
    syncText: '',
    emptyText: '本月还没有记账记录',
    viewMode: 'list',
    calendar: { days: [], weekdays: [] },
    selectedDay: '',
    dayGroups: [],
    greeting: '你好'
  },

  onLoad() {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var me = db.getMe()
    var key = u.currentMonthKey()
    this.setData({
      statusBar: (info && info.statusBarHeight) || 20,
      me: me,
      showNickname: !me.name,
      nicknameInput: me.name || '',
      selectedDay: u.dateStr(new Date()),
      greeting: u.greeting(),
      monthKey: key,
      monthLabel: u.formatMonth(key),
      monthShort: parseInt(key.slice(5, 7), 10) + '月'
    })
    this.refresh()
    var self = this
    this._offChange = db.onChange(function () { self.refresh() })
  },

  onUnload() {
    if (this._offChange) this._offChange()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    var ledger = db.currentLedger()
    if (ledger) {
      var generated = db.runDueRecurring(ledger.id)
      if (generated.length > 0) {
        wx.showToast({ title: '周期记账 +' + generated.length, icon: 'none' })
      }
    }
    this.setData({ greeting: u.greeting() })
    if (this.data.loading) return
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh()
    wx.stopPullDownRefresh()
  },

  /* ---------------- 数据 ---------------- */

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
        recordCount: 0,
        challenge: null,
        challengeCount: 0,
        loading: false,
        emptyText: '还没有账本，去创建一个吧',
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

    var accounts = db.accountsOf(ledger.id)
    var accMap = {}
    for (var i = 0; i < accounts.length; i++) accMap[accounts[i].id] = accounts[i].name

    var decorated = filtered.map(function (r) {
      var isTransfer = r.type === 'transfer'
      var catKey = isTransfer ? 'transfer' : r.category
      return {
        id: r.id,
        date: r.date,
        note: r.note,
        createdAt: r.createdAt,
        type: r.type,
        amount: r.amount,
        icon: isTransfer ? '🔁' : u.categoryIcon(r.type, r.category),
        tint: u.categoryTint(catKey),
        categoryName: isTransfer
          ? ('转账至 ' + (r.transferToName || accMap[r.transferTo] || '其他账户'))
          : u.categoryName(r.type, r.category),
        amountText: isTransfer
          ? u.formatCents(r.amount)
          : u.signedText(r.amount, r.type),
        memberName: r.memberName,
        isOther: r.memberId !== me.id
      }
    })

    var groups = u.groupByDate(decorated)
    // 首页只展示最近 4 天，完整记录去「账单」页
    this.setData({ groups: groups })

    var s = u.calcSummary(all)
    var calendar = u.calendarMonth(this.data.monthKey, all)
    var dayGroups = groups.filter(function (g) { return g.date === self.data.selectedDay })

    var budgetAlert = ''
    if (this.data.monthKey === u.currentMonthKey()) {
      var status = u.budgetStatus(db.budgetOf(ledger.id), all, null)
      if (status.total && status.total.pct >= 80) {
        budgetAlert = status.total.over
          ? '本月支出已超出预算 ' + u.formatCents(status.total.used - status.total.limit) + ' 元'
          : '本月支出已达预算的 ' + status.total.pct + '%，注意控制'
      }
    }

    var challenges = db.challengesOf(ledger.id)
    var active = null
    var running = 0
    for (var c = 0; c < challenges.length; c++) {
      if (!challenges[c].done) {
        running++
        if (!active) active = challenges[c]
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
      recordCount: filtered.length,
      calendar: calendar,
      dayGroups: dayGroups,
      loading: false,
      emptyText: emptyText,
      challenge: active,
      challengeCount: running,
      budgetAlert: budgetAlert,
      isCurrentMonth: this.data.monthKey === u.currentMonthKey(),
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

  /* ---------------- 月份 / 筛选 / 视图 ---------------- */

  prevMonth() {
    var key = u.shiftMonth(this.data.monthKey, -1)
    this.applyMonth(key)
  },

  nextMonth() {
    if (this.data.isCurrentMonth) return
    var key = u.shiftMonth(this.data.monthKey, 1)
    this.applyMonth(key)
  },

  applyMonth(key) {
    this.setData({
      monthKey: key,
      monthLabel: u.formatMonth(key),
      monthShort: parseInt(key.slice(5, 7), 10) + '月',
      memberFilter: 'all'
    })
    this.refresh()
  },

  setMemberFilter(e) {
    this.setData({ memberFilter: e.currentTarget.dataset.id })
    this.refresh()
  },

  selectDay(e) {
    this.setData({ selectedDay: e.currentTarget.dataset.day })
    this.refresh()
  },

  toggleMore() {
    this.setData({ showMore: !this.data.showMore })
  },

  toggleCalendar() {
    var next = this.data.viewMode === 'list' ? 'calendar' : 'list'
    this.setData({ viewMode: next, showMore: false })
    this.refresh()
    wx.showToast({ title: next === 'calendar' ? '日历视图' : '列表视图', icon: 'none' })
  },

  /* ---------------- 跳转 ---------------- */

  openSheetItem(e) {
    var key = e.currentTarget.dataset.key
    var map = {
      ledger: '/pages/ledger/ledger',
      members: '/pages/members/members',
      categories: '/pages/categories/categories',
      recurring: '/pages/recurring/recurring',
      search: '/pages/search/search',
      assets: '/pages/assets/assets',
      budget: '/pages/budget/budget',
      transfer: '/pages/edit/edit?mode=transfer'
    }
    this.setData({ showMore: false })
    if (key === 'calendar') return this.toggleCalendar()
    if (key === 'challenge') return this.goChallenge()
    if (map[key]) wx.navigateTo({ url: map[key] })
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  goStats() {
    wx.switchTab({ url: '/pages/stats/stats' })
  },

  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' })
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

  goLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' })
  },

  goChallenge() {
    wx.navigateTo({ url: '/pages/challenge/challenge' })
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
            confirmColor: '#E2543F',
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

  /* ---------------- 首次昵称 ---------------- */

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
