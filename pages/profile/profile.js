const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')
const avatar = require('../../utils/avatar.js')

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
    me: { id: '', name: '' },
    uid: '00000000',
    ledgerName: '我的账本',
    netWorthText: '0.00',
    assetsText: '0.00',
    debtsText: '0.00',
    challengeCount: 0,
    memberCount: 1,
    syncText: '',
    cloudOn: false,
    account: { phase: 'off', tone: 'idle', text: '本地模式', tip: '本地模式', logged: false, error: '' },
    showRename: false,
    renameInput: '',
    showAbout: false,
    showHelp: false,
    showVip: false,
    showPhone: false,
    phoneInput: ''
  },

  onLoad() {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBar: (info && info.statusBarHeight) || 20 })
    this.refresh()
    var self = this
    this._offChange = db.onChange(function () { self.refresh() })
    this._offCloud = cloud.onChange(function (st) { self.setData({ account: st }) })
    this.setData({ account: cloud.accountState() })
  },

  onUnload() {
    if (this._offChange) this._offChange()
    if (this._offCloud) this._offCloud()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
    this.refresh()
  },

  refresh() {
    var me = db.getProfile()
    var ledger = db.currentLedger()
    var patch = {
      me: me,
      uid: shortId(me.id),
      cloudOn: cloud.enabled(),
      syncText: cloud.statusText(),
      account: cloud.accountState()
    }
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

  goChallenge() {
    wx.navigateTo({ url: '/pages/challenge/challenge' })
  },

  goBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' })
  },

  goLedger() {
    wx.navigateTo({ url: '/pages/ledger/ledger' })
  },

  goCategories() {
    wx.navigateTo({ url: '/pages/categories/categories' })
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  goReconcile() {
    wx.navigateTo({ url: '/pages/reconcile/reconcile' })
  },

  goAssets() {
    wx.navigateTo({ url: '/pages/assets/assets' })
  },

  goStats() {
    wx.switchTab({ url: '/pages/stats/stats' })
  },

  /* ---------------- 弹层 ---------------- */

  openRename() {
    this.setData({ showRename: true, renameInput: this.data.me.name || '' })
  },

  closeRename() {
    this.setData({ showRename: false })
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
    this.setData({ showRename: false })
    this.refresh()
    wx.showToast({ title: '已更新', icon: 'success' })
  },

  /* ---------------- 微信头像 / 昵称授权 ---------------- */

  onChooseAvatar(e) {
    var url = e.detail && e.detail.avatarUrl
    if (!url) return
    var self = this
    wx.showLoading({ title: '保存头像', mask: true })
    // 微信给的是临时路径，必须压成 base64 才能长期保留（否则冷启动即失效）
    avatar.persist(url, function (err, dataUrl) {
      wx.hideLoading()
      if (err) {
        wx.showToast({ title: err.message || '头像保存失败', icon: 'none' })
        return
      }
      db.setProfile({ avatar: dataUrl })
      cloud.updateProfile({ avatar: dataUrl })
      self.refresh()
      wx.showToast({ title: '头像已更新', icon: 'success' })
    })
  },

  onAvatarError() {
    // dataURL 不会过期；走到这里说明存的是失效地址，清掉让用户重选
    var av = this.data.me && this.data.me.avatar
    if (av && /^https?:\/\//.test(av)) {
      db.setProfile({ avatar: '' })
      this.refresh()
      wx.showToast({ title: '头像已过期，请重新选择', icon: 'none' })
    }
  },

  onNicknameBlur(e) {
    var v = String((e.detail && e.detail.value) || '').trim()
    if (!v || v === this.data.me.name) return
    db.setMyName(v)
    cloud.updateProfile({ nickname: v })
    this.refresh()
  },

  /** 昵称输入框长按 → 手动改名（微信昵称授权失败时的兜底） */
  onNicknameLongPress() {
    this.openRename()
  },

  /* ---------------- 手机号绑定 ---------------- */

  openPhone() {
    this.setData({ showPhone: true, phoneInput: this.data.me.phone || '' })
  },

  closePhone() {
    this.setData({ showPhone: false })
  },

  onPhoneInput(e) {
    this.setData({ phoneInput: e.detail.value })
  },

  confirmPhone() {
    var phone = this.data.phoneInput.trim()
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请填写 11 位手机号', icon: 'none' })
      return
    }
    var self = this
    if (!cloud.enabled()) {
      // 未接入云同步：号码只落本机
      db.setProfile({ phone: phone })
      this.setData({ showPhone: false })
      this.refresh()
      wx.showToast({ title: '已保存到本机', icon: 'success' })
      return
    }
    cloud.bindPhone('', phone).then(function (res) {
      if (res.ok) {
        self.setData({ showPhone: false })
        self.refresh()
        wx.showToast({ title: '手机号已绑定', icon: 'success' })
      } else {
        wx.showToast({ title: res.error || '保存失败', icon: 'none' })
      }
    })
  },

  toast(e) {
    wx.showToast({ title: e.currentTarget.dataset.text || '暂未开放', icon: 'none' })
  },

  openHelp() { this.setData({ showHelp: true }) },
  closeHelp() { this.setData({ showHelp: false }) },
  openAbout() { this.setData({ showAbout: true }) },
  closeAbout() { this.setData({ showAbout: false }) },
  openVip() { this.setData({ showVip: true }) },
  closeVip() { this.setData({ showVip: false }) },

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
    this.setData({ account: cloud.accountState() })
    cloud.sync().then(function () {
      wx.hideLoading()
      self._syncing = false
      var st = cloud.accountState()
      self.setData({ account: st })
      if (st.error) wx.showToast({ title: st.error.slice(0, 18), icon: 'none' })
      else wx.showToast({ title: '同步完成', icon: 'success' })
    })
  },
})
