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
    showVip: false
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
    var me = db.getMe()
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
    this.setData({ showRename: false })
    this.refresh()
    wx.showToast({ title: '已更新', icon: 'success' })
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
