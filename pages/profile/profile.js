const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')
const motion = require('../../utils/motion.js')
const profileFill = require('../../utils/profileFill.js')
const vip = require('../../utils/vip.js')

/** 由本地用户 id 生成一个稳定的展示编号 */
function shortId(id) {
  var h = 0
  var s = String(id || 'jizhang')
  for (var i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) % 100000000
  }
  return String(10000000 + h).slice(0, 8)
}

Page({
  data: {
    statusBar: 20,
    contentTop: 64,
    me: { id: '', name: '' },
    nicknameDraft: '',
    uid: '00000000',
    ledgerName: '我的账本',
    netWorthText: '0.00',
    assetsText: '0.00',
    debtsText: '0.00',
    challengeCount: 0,
    memberCount: 1,
    vipOn: false,
    syncText: '',
    cloudOn: false,
    account: { phase: 'off', tone: 'idle', text: '本地模式', tip: '本地模式', logged: false, error: '' },
    showRename: false,
    renameInput: '',
    showAbout: false,
    showHelp: false,
    metaTip: '本地模式',
    menuGroups: [
      { title: '记账管理', items: [
        { icon: '📒', text: '账本管理', action: 'goLedger' },
        { icon: '🏷️', text: '分类管理', action: 'goCategories' },
        { icon: '▤', text: '常用模板', action: 'goTemplates' },
        { icon: '🔁', text: '周期记账', action: 'goRecurring' }
      ] },
      { title: '财务计划', items: [
        { icon: '🎯', text: '预算管理', action: 'goBudget' },
        { icon: '🏆', text: '存钱挑战', action: 'goChallenge' }
      ] },
      { title: '数据工具', items: [
        { icon: '📥', text: '账单导入', extra: '微信 / 支付宝', action: 'goImport' },
        { icon: '🧮', text: '对账与导出', action: 'goReconcile' },
        { icon: '⚙', text: '同步与设置', action: 'goSettings' }
      ] }
    ]
  },

  onLoad() {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBar: (info && info.statusBarHeight) || 20, contentTop: u.navigationTop(info) })
    this.refresh()
    var self = this
    this._offChange = db.onChange(function () { self.refresh() })
    this._offCloud = cloud.onChange(function (st) { self.applyAccount(st) })
    this.setData({ account: cloud.accountState() })
  },

  onUnload() {
    motion.cleanup(this)
    if (this._offChange) this._offChange()
    if (this._offCloud) this._offCloud()
  },

  onShow() {
    this._navigating = false
    motion.reveal(this)
    this.updateTabBar()
    this.refresh()
  },

  onHide() { motion.cleanup(this) },

  updateTabBar() {
    var tab = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tab) tab.setData({ selected: 3, hidden: motion.hasOverlay(this, ['showRename', 'showHelp', 'showAbout']) })
  },

  refresh() {
    var me = db.getProfile()
    var ledger = db.currentLedger()
    var account = cloud.accountState()
    var patch = {
      me: me,
      vip: db.isVip(),
      vipOn: vip.featureEnabled(),
      uid: shortId(me.id),
      cloudOn: cloud.enabled(),
      syncText: cloud.statusText(),
      account: account,
      metaTip: account.phase === 'failed' ? '同步失败 · 查看设置' : account.tip
    }
    if (!this._nicknameEditing) patch.nicknameDraft = me.name || ''
    if (ledger) {
      var sum = db.assetSummary(ledger.id)
      var assets = 0
      var debts = 0
      for (var i = 0; i < sum.accounts.length; i++) {
        var b = sum.accounts[i].balance
        if (b >= 0) assets += b
        else debts += -b
      }
      var challenges = db.challengesOf(ledger.id)
      var running = 0
      for (var c = 0; c < challenges.length; c++) {
        if (!challenges[c].done) running++
      }
      patch.ledgerName = ledger.name
      patch.netWorthText = u.formatCents(sum.netWorth)
      patch.assetsText = u.formatCents(assets)
      patch.debtsText = u.formatCents(debts)
      patch.challengeCount = running
      patch.memberCount = Object.keys(ledger.members || {}).length
    }
    this.setData(patch)
  },

  /* ---------------- 跳转 ---------------- */

  navigate(url) {
    if (this._navigating) return
    this._navigating = true
    wx.navigateTo({ url: url, fail: () => { this._navigating = false } })
  },

  onMenuTap(e) {
    var action = e.currentTarget.dataset.action
    var allowed = this.data.menuGroups.some(group => group.items.some(item => item.action === action))
    if (allowed && typeof this[action] === 'function') this[action]()
  },

  goChallenge() {
    this.navigate('/pages/challenge/challenge')
  },

  goBudget() {
    this.navigate('/pages/budget/budget')
  },

  goLedger() {
    this.navigate('/pages/ledger/ledger')
  },

  goSettings() {
    this.navigate('/pages/settings/settings')
  },

  goCategories() {
    this.navigate('/pages/categories/categories')
  },
  goTemplates() { this.navigate('/pages/templates/templates') },
  goRecurring() { this.navigate('/pages/recurring/recurring') },

  goImport() {
    this.navigate('/pages/import/import')
  },

  goReconcile() {
    this.navigate('/pages/reconcile/reconcile')
  },

  goAssets() {
    this.navigate('/pages/assets/assets')
  },

  goStats() {
    wx.switchTab({ url: '/pages/stats/stats' })
  },

  /* ---------------- 弹层 ---------------- */

  openRename() {
    motion.open(this, 'showRename', { renameInput: this.data.me.name || '' })
  },

  closeRename() {
    motion.close(this, 'showRename')
  },

  onRenameInput(e) {
    this.setData({ renameInput: e.detail.value })
  },

  confirmRename() {
    var name = this.data.renameInput.trim()
    if (!name) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    db.setMyName(name)
    cloud.updateProfile({ nickname: name })
    this.closeRename()
    this.refresh()
    wx.showToast({ title: '已更新', icon: 'success' })
  },

  /* ---------------- 微信头像 / 昵称授权（逻辑统一走 utils/profileFill） ---------------- */

  onChooseAvatar(e) {
    var url = e.detail && e.detail.avatarUrl
    if (!url) return
    var self = this
    wx.showLoading({ title: '保存头像', mask: true })
    // 微信给的是临时路径，必须压成 base64 才能长期保留（否则冷启动即失效）
    profileFill.applyAvatar(url, function (err) {
      wx.hideLoading()
      if (err) {
        wx.showToast({ title: err.message || '头像保存失败', icon: 'none' })
        return
      }
      self.refresh()
      wx.showToast({ title: '头像已更新', icon: 'success' })
    })
  },

  onAvatarError() {
    // dataURL 不会过期；走到这里说明存的是失效地址，清掉让用户重选
    var av = this.data.me && this.data.me.avatar
    if (profileFill.onAvatarError(av)) {
      this.refresh()
      wx.showToast({ title: '头像已过期，请重新选择', icon: 'none' })
    }
  },

  /** 微信昵称建议被选中（input type="nickname" 的 bindnickname，最可靠的获取方式） */
  onNicknamePick(e) {
    var v = (e.detail && e.detail.nickname) || ''
    if (profileFill.applyNickname(v)) {
      this.setData({ nicknameDraft: v })
      this.refresh()
    }
  },

  onNicknameBlur(e) {
    this._nicknameEditing = false
    var v = String((e.detail && e.detail.value) || '').trim()
    if (profileFill.applyNickname(v)) {
      this.refresh()
    } else this.setData({ nicknameDraft: db.getProfile().name || '' })
  },

  onNicknameFocus() { this._nicknameEditing = true },
  onNicknameInput(e) { this.setData({ nicknameDraft: e.detail.value }) },

  /** 昵称输入框长按 → 手动改名（微信昵称授权失败时的兜底） */
  onNicknameLongPress() {
    this.openRename()
  },

  /* ---------------- 顶部状态行：统一进入同步设置 ---------------- */

  /** 云端状态变化时同步刷新顶部状态行（文案 + 最近同步时间） */
  applyAccount(st) {
    this.setData({
      account: st,
      metaTip: st.phase === 'failed' ? '同步失败 · 查看设置' : st.tip,
      syncText: cloud.statusText()
    })
  },

  onStatusTap() {
    this.goSettings()
  },

  toast(e) {
    wx.showToast({ title: e.currentTarget.dataset.text || '暂未开放', icon: 'none' })
  },

  openHelp() { motion.open(this, 'showHelp') },
  closeHelp() { motion.close(this, 'showHelp') },
  openAbout() { motion.open(this, 'showAbout') },
  closeAbout() { motion.close(this, 'showAbout') },
  goVip() { this.navigate('/pages/vip/vip') },

  copyApi() {
    wx.setClipboardData({ data: 'https://jizhang-api.751152.xyz' })
  },

  /** 账号未就绪时点「重试」：重新走一遍注册/登录 */
  retryAccount() {
    var self = this
    if (!cloud.enabled()) {
      wx.showToast({ title: '云同步未开启', icon: 'none' })
      return
    }
    wx.showLoading({ title: '连接中', mask: true })
    cloud.retry().then(function (res) {
      wx.hideLoading()
      if (res.ok) {
        wx.showToast({ title: '账号已就绪', icon: 'success' })
      } else {
        wx.showModal({
          title: '连接服务器失败',
          content: (res.error || '请检查网络') + '\n\n若小程序后台未把服务器域名加入 request 合法域名，体验版/正式版会直接拦掉请求。',
          confirmText: '再试一次',
          cancelText: '知道了',
          success: function (r) { if (r.confirm) self.retryAccount() }
        })
      }
      self.refresh()
    })
  },

  syncNow() {
    var self = this
    if (!this.data.cloudOn) {
      wx.showToast({ title: '云同步未开启', icon: 'none' })
      return
    }
    if (this._syncing) {
      wx.showToast({ title: '正在同步', icon: 'none' })
      return
    }
    this._syncing = true
    wx.showLoading({ title: '同步中', mask: true })
    this.applyAccount(cloud.accountState())
    cloud.sync().then(function () {
      wx.hideLoading()
      self._syncing = false
      var st = cloud.accountState()
      self.applyAccount(st)
      if (st.error) wx.showToast({ title: st.error.slice(0, 18), icon: 'none' })
      else wx.showToast({ title: '同步完成', icon: 'success' })
    })
  },
})
