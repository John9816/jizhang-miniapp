const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')
const avatar = require('../../utils/avatar.js')

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
    cloudOn: false,
    syncText: '',
    account: { phase: 'off', tone: 'idle', text: '本地模式', tip: '本地模式', logged: false, error: '' },
    // 首次进入的注册引导
    showGuide: false,
    guideTitle: '欢迎来到聿知记',
    guideSub: '正在为你创建专属账号…',
    guideAvatarSrc: '/images/avatar.png',
    guideName: '',
    guidePhone: '',
    guideManualPhone: false,
    guideSteps: { avatar: false, name: false, phone: false },
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
    this.startGuide()
  },

  onUnload() {
    if (this._offChange) this._offChange()
    if (this._offCloud) this._offCloud()
  },

  onAccountChange(st) {
    this.setData({ account: st, syncText: st.text })
    if (st.phase === 'ready') {
      db.markRegistered()
      this.setData({ guideSub: '账号已创建，ID ' + this.shortId(db.getProfile().id) })
    } else if (st.phase === 'failed') {
      this.setData({ guideSub: '账号未能创建成功，可以先用着，稍后重试' })
    }
  },

  shortId(id) {
    var h = 0
    var s = String(id || 'jizhang')
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000000
    return String(10000000 + h).slice(0, 8)
  },

  /* ---------------- 首次进入：自动注册 + 一键补齐 ---------------- */

  /**
   * 进入小程序后的处理：
   *  - 静默注册由 cloud.init() 在 App.onLaunch 已完成（wx.login → 服务端自动开户），这里只负责把状态呈现出来；
   *  - 资料还没补齐且没跳过过时，自动弹出引导卡，三步各点一次即可完成头像/昵称/手机号；
   *  - 微信不允许在无人点击的情况下拉起头像、手机号授权组件，所以「一键」是指一次点击完成一项，而不是全自动。
   */
  startGuide() {
    var p = db.getProfile()
    var steps = this.guideState(p)
    if (p.guideDone) return
    var patch = {
      showGuide: true,
      guideSteps: steps,
      guideName: p.name || '',
      guidePhone: p.phone || '',
      guideAvatarSrc: p.avatar || '/images/avatar.png',
      cloudOn: cloud.enabled()
    }
    if (!p.registeredAt) {
      patch.guideTitle = '欢迎来到聿知记'
      patch.guideSub = cloud.enabled() ? '正在为你创建专属账号…' : '本地模式，数据只存在这台手机'
    } else {
      patch.guideTitle = '完善你的资料'
      patch.guideSub = '账号已就绪，ID ' + this.shortId(p.id)
    }
    this.setData(patch)
  },

  guideState(p) {
    return {
      avatar: !!(p && p.avatar),
      name: !!(p && p.name) && p.name !== '我',
      phone: !!(p && p.phone)
    }
  },

  syncGuideSteps() {
    this.setData({ guideSteps: this.guideState(db.getProfile()) })
  },

  retryGuide() {
    var self = this
    wx.showLoading({ title: '重试中', mask: true })
    cloud.retry().then(function (res) {
      wx.hideLoading()
      self.setData({ account: cloud.accountState() })
      if (!res.ok) wx.showToast({ title: (res.error || '仍失败').slice(0, 16), icon: 'none' })
    })
  },

  onGuideAvatar(e) {
    var url = e.detail && e.detail.avatarUrl
    if (!url) return
    var self = this
    wx.showLoading({ title: '保存头像', mask: true })
    avatar.persist(url, function (err, dataUrl) {
      wx.hideLoading()
      if (err) {
        wx.showToast({ title: err.message || '头像保存失败', icon: 'none' })
        return
      }
      db.setProfile({ avatar: dataUrl })
      cloud.updateProfile({ avatar: dataUrl })
      self.setData({ guideAvatarSrc: dataUrl })
      self.syncGuideSteps()
    })
  },

  onGuideNameInput(e) {
    this.setData({ guideName: e.detail.value })
  },

  onGuideNameBlur(e) {
    var v = String((e.detail && e.detail.value) || '').trim()
    if (!v) return
    db.setMyName(v)
    cloud.updateProfile({ nickname: v })
    this.setData({ guideName: v })
    this.syncGuideSteps()
    this.refresh()
  },

  onGuidePhoneInput(e) {
    this.setData({ guidePhone: e.detail.value })
  },

  onGuidePhoneBlur(e) {
    var v = String((e.detail && e.detail.value) || '').trim()
    if (!/^1\d{10}$/.test(v)) return
    db.setProfile({ phone: v })
    cloud.bindPhone('', v)
    this.setData({ guidePhone: v })
    this.syncGuideSteps()
  },

  onGuidePhone(e) {
    var detail = e.detail || {}
    var self = this
    if (!detail.code) {
      // 个人主体拿不到手机号权限、或用户拒绝 → 自动切手动输入，不让用户卡在这里
      this.setData({ guideManualPhone: true })
      wx.showToast({ title: '请手动填写手机号', icon: 'none' })
      return
    }
    wx.showLoading({ title: '读取中', mask: true })
    cloud.bindPhone(detail.code).then(function (res) {
      wx.hideLoading()
      if (res.ok) {
        self.setData({ guidePhone: res.phone, guideManualPhone: false })
        self.syncGuideSteps()
      } else {
        self.setData({ guideManualPhone: true })
        wx.showToast({ title: res.needManual ? '请手动填写' : (res.error || '读取失败'), icon: 'none' })
      }
    })
  },

  closeGuide(mark) {
    this.setData({ showGuide: false })
    if (mark) db.setProfile({ guideDone: true })
    this.refresh()
  },

  skipGuide() {
    this.closeGuide(true)
    wx.showToast({ title: '已跳过，稍后可补', icon: 'none' })
  },

  finishGuide() {
    var s = this.guideState(db.getProfile())
    this.closeGuide(true)
    var done = (s.avatar ? 1 : 0) + (s.name ? 1 : 0) + (s.phone ? 1 : 0)
    if (done === 3) wx.showToast({ title: '资料已完善', icon: 'success' })
    else if (done > 0) wx.showToast({ title: '已补齐 ' + done + '/3', icon: 'success' })
    else wx.showToast({ title: '开始记账吧', icon: 'none' })
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
})
