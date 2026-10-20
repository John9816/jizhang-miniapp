const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')

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
  },

  onUnload() {
    if (this._offChange) this._offChange()
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
      syncText: cloud.statusText()
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
    db.setProfile({ avatar: url })
    // 云端地址只存微信 CDN 临时链接，下次冷启动前重新授权即可刷新
    cloud.updateProfile({ avatar: url })
    this.refresh()
    wx.showToast({ title: '头像已更新', icon: 'success' })
  },

  onAvatarError() {
    // 微信 CDN 临时链接过期：清掉失效头像，提示重新授权
    if (this.data.me && this.data.me.avatar) {
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

  onGetPhoneNumber(e) {
    var detail = e.detail || {}
    var self = this
    if (!detail.code) {
      // 用户拒绝或基础库不支持 → 弹层里手动填写
      wx.showToast({ title: '请改用下方手动填写', icon: 'none' })
      return
    }
    if (!cloud.enabled()) {
      wx.showToast({ title: '未开启云同步，请手动填写', icon: 'none' })
      return
    }
    wx.showLoading({ title: '绑定中' })
    cloud.bindPhone(detail.code).then(function (res) {
      wx.hideLoading()
      if (res.ok) {
        self.setData({ showPhone: false })
        self.refresh()
        wx.showToast({ title: '手机号已绑定', icon: 'success' })
      } else {
        // 个人主体无 getPhoneNumber 权限服务端会回 needManual
        wx.showToast({ title: res.needManual ? '请在下方手动填写' : (res.error || '绑定失败'), icon: 'none' })
      }
    })
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

  syncNow() {
    if (!this.data.cloudOn) {
      wx.showToast({ title: '云同步未开启', icon: 'none' })
      return
    }
    if (cloud.kick) cloud.kick()
    wx.showToast({ title: '已发起同步', icon: 'none' })
  }
})
