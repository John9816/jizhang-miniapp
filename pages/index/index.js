const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')

Page({
  data: {
    statusBar: 20,
    me: { id: '', name: '' },
    ledger: null,
    ledgerCover: null,
    monthKey: '',
    monthLabel: '',
    monthShort: '',
    isCurrentMonth: true,
    memberFilter: 'all',
    members: [],
    groups: [],
    recordCount: 0,
    summary: { income: 0, expense: 0, balance: 0, incomeText: '0.00', expenseText: '0.00', balanceText: '0.00' },
    today: { expenseText: '0.00', incomeText: '0.00', has: false },
    streak: 0,
    heroBudget: null,
    topCats: [],
    recurringHint: null,
    recurringCount: 0,
    challenge: null,
    challengeCount: 0,
    loading: true,
    showMore: false,
    cloudOn: false,
    syncText: '',
    account: { phase: 'off', tone: 'idle', text: '本地模式', tip: '本地模式', logged: false, error: '' },
    // 首屏合并资料卡：未完善资料且未手动关闭时展示，关闭/完成后自动消失
    showOnboard: false,
    ledgerSheet: false,
    ledgerOptions: [],
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
      selectedDay: u.dateStr(new Date()),
      greeting: u.greeting(),
      monthKey: key,
      monthLabel: u.formatMonth(key),
      monthShort: parseInt(key.slice(5, 7), 10) + '月'
    })
    this.refresh()
    var self = this
    this._offChange = db.onChange(function () { self.refresh() })
    // 注册/登录状态变化即时反馈（首次进入时尤其重要：不能让用户在黑盒里等）
    this._offCloud = cloud.onChange(function (st) { self.onAccountChange(st) })
    this.setData({ account: cloud.accountState() })
    this.updateOnboard()
  },

  onUnload() {
    if (this._offChange) this._offChange()
    if (this._offCloud) this._offCloud()
  },

  onAccountChange(st) {
    this.setData({ account: st, syncText: st.text })
    if (st.phase === 'ready') db.markRegistered()
  },

  /* ---------------- 首屏合并资料卡（非阻断） ---------------- */

  /**
   * 先记账，后补资料：
   *  - 静默注册由 cloud.init() 在 App.onLaunch 完成（wx.login → 服务端自动开户），全程无弹窗；
   *  - 头像/昵称不做强制引导：只在首页顶部放一张可关闭的资料卡（profile-fill 组件），
   *    头像按钮 + 昵称输入框并排，补齐或关闭后自动消失；
   *  - 手机号与首启流程解耦，个人主体拿不到微信手机号，首启放按钮必失败，故本版起彻底移除手机号功能。
   */
  updateOnboard() {
    var p = db.getProfile()
    var hasAvatar = !!p.avatar
    var hasName = !!p.name && p.name !== '我'
    this.setData({ showOnboard: !p.guideDone && (!hasAvatar || !hasName) })
  },

  /** 资料卡关闭/完成：隐藏并标记已读 */
  onOnboardDone() {
    this.setData({ showOnboard: false })
  },

  /** 首页同步状态条：正常时点按立即同步，失败时点按重试登录 */
  onSyncTap() {
    var self = this
    if (this.data.account.phase === 'failed') {
      wx.showLoading({ title: '重试中', mask: true })
      cloud.retry().then(function (res) {
        wx.hideLoading()
        self.setData({ account: cloud.accountState() })
        if (!res.ok) wx.showToast({ title: (res.error || '仍失败').slice(0, 16), icon: 'none' })
      })
      return
    }
    cloud.sync()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    this.updateOnboard()
    var ledger = db.currentLedger()
    if (ledger) {
      var generated = db.runDueRecurring(ledger.id)
      if (generated.length > 0) {
        wx.showToast({ title: '周期记账：已自动入账 ' + generated.length + ' 笔', icon: 'none' })
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
        ledgerCover: null,
        members: [],
        groups: [],
        recordCount: 0,
        challenge: null,
        challengeCount: 0,
      loading: false,
      emptyText: '还没有账本，去创建一个吧',
      dayGroups: [],
      calendar: { days: [], weekdays: [] },
        today: { expenseText: '0.00', incomeText: '0.00', has: false },
        streak: 0,
        heroBudget: null,
        topCats: [],
        recurringHint: null,
        recurringCount: 0,
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
        timeText: u.hmText(r.createdAt),
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

    // 今日卡片 / 连续记账天数 / 常用分类：基于账本全部记录（翻看历史月份时今日卡自动隐藏）
    var allLedger = db.recordsOf(ledger.id)
    var todayKey = u.dateStr(new Date())
    var todayRecs = allLedger.filter(function (r) { return r.date === todayKey })
    var todaySum = u.calcSummary(todayRecs)
    var today = {
      expenseText: u.formatCents(todaySum.expense),
      incomeText: u.formatCents(todaySum.income),
      has: todayRecs.length > 0
    }
    var isCurMonth = this.data.monthKey === u.currentMonthKey()
    // 预算进度内嵌主卡（有预算时）：进度条 + 剩余/超支文案，点击进预算管理
    var heroBudget = null
    if (isCurMonth) {
      var status = u.budgetStatus(db.budgetOf(ledger.id), all, null)
      if (status.total) {
        var t = status.total
        heroBudget = {
          pct: Math.min(100, t.pct),
          pctText: t.pct + '%',
          usedText: u.formatCents(t.used),
          limitText: u.formatCents(t.limit),
          leftText: u.formatCents(Math.max(0, t.limit - t.used)),
          overText: u.formatCents(Math.max(0, t.used - t.limit)),
          over: t.over
        }
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

    // 周期记账提示条：有启用中规则时常驻首页（入口不再只藏在更多面板），展示待执行条数与最近一次扣款
    var recurRules = db.recurringList(ledger.id)
    var recurActive = 0
    var recurNext = null
    for (var ri = 0; ri < recurRules.length; ri++) {
      var rr = recurRules[ri]
      if (rr.paused) continue
      recurActive++
      if (!recurNext || String(rr.nextDate) < String(recurNext.nextDate)) recurNext = rr
    }
    var recurringHint = null
    if (recurActive > 0 && recurNext) {
      var todayStr = u.dateStr(new Date())
      var tomorrowStr = u.dateStr(new Date(Date.now() + 86400000))
      var nextPrefix = ''
      if (recurNext.nextDate === todayStr) nextPrefix = '今天 '
      else if (recurNext.nextDate === tomorrowStr) nextPrefix = '明天 '
      recurringHint = {
        count: recurActive,
        name: recurNext.name || u.categoryName(recurNext.type, recurNext.category),
        nextText: nextPrefix + u.cnDate(recurNext.nextDate)
      }
    }

    this.setData({
      me: me,
      ledger: ledger,
      ledgerCover: u.ledgerCoverInfo(ledger.cover),
      members: members,
      groups: groups,
      recordCount: filtered.length,
      calendar: calendar,
      dayGroups: dayGroups,
      loading: false,
      emptyText: emptyText,
      challenge: active,
      challengeCount: running,
      heroBudget: heroBudget,
      today: today,
      streak: u.calcStreak(allLedger),
      topCats: u.topCategories(allLedger, 'expense', 5),
      recurringHint: recurringHint,
      recurringCount: recurActive,
      isCurrentMonth: isCurMonth,
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

  /* ---------------- 账本切换（点顶部账本名） ---------------- */

  openLedgerSheet() {
    var options = db.listLedgers().map(function (l) {
      return {
        id: l.id,
        name: l.name,
        cover: l.cover,
        memberCount: l.memberCount || 1,
        isCurrent: l.isCurrent
      }
    })
    if (!options.length) return
    this.setData({ ledgerOptions: options, ledgerSheet: true, showMore: false })
  },

  closeLedgerSheet() {
    this.setData({ ledgerSheet: false })
  },

  switchLedger(e) {
    var id = e.currentTarget.dataset.id
    if (!id || id === db.currentLedger().id) {
      this.closeLedgerSheet()
      return
    }
    db.setCurrentLedger(id)
    // 切账本后重置到当前月与全部成员，避免带着上一個账本的月份/筛选看新账本
    var key = u.currentMonthKey()
    this.setData({
      monthKey: key,
      monthLabel: u.formatMonth(key),
      monthShort: parseInt(key.slice(5, 7), 10) + '月',
      memberFilter: 'all',
      ledgerSheet: false
    })
    this.refresh()
    var name = db.currentLedger().name
    wx.showToast({ title: '已切换到「' + name + '」', icon: 'none' })
  },

  goLedgerFromSheet() {
    this.setData({ ledgerSheet: false })
    wx.navigateTo({ url: '/pages/ledger/ledger' })
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

  /** 常用分类快捷记账：带上分类直接进记一笔 */
  goEditWithCategory(e) {
    var key = e.currentTarget.dataset.key
    wx.navigateTo({ url: '/pages/edit/edit?category=' + encodeURIComponent(key) })
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

  /** 周期记账提示条 / 更多面板入口：进入周期记账管理页 */
  goRecurring() {
    this.setData({ showMore: false })
    wx.navigateTo({ url: '/pages/recurring/recurring' })
  },

  goAssets() {
    wx.navigateTo({ url: '/pages/assets/assets' })
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
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
})
