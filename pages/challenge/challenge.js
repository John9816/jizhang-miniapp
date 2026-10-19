const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

Page({
  data: {
    list: [],
    running: 0,
    totalSavedText: '0.00',
    hasLedger: true,
    showCreate: false,
    formName: '',
    formTarget: '',
    formDeadline: '',
    formError: '',
    showDeposit: false,
    depositId: '',
    depositName: '',
    depositMode: 'in',
    depositAmount: ''
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    var ledger = db.currentLedger()
    if (!ledger) {
      this.setData({ hasLedger: false, list: [], running: 0 })
      return
    }
    var list = db.challengesOf(ledger.id)
    var running = 0
    var saved = 0
    for (var i = 0; i < list.length; i++) {
      if (!list[i].done) running++
      saved += list[i].saved
    }
    this.setData({
      hasLedger: true,
      list: list,
      running: running,
      totalSavedText: u.formatCents(saved)
    })
  },

  /* ---------------- 新建 ---------------- */

  openCreate() {
    this.setData({
      showCreate: true,
      formName: '',
      formTarget: '',
      formDeadline: '',
      formError: ''
    })
  },

  closeCreate() {
    this.setData({ showCreate: false })
  },

  onFormName(e) { this.setData({ formName: e.detail.value }) },
  onFormTarget(e) { this.setData({ formTarget: e.detail.value }) },

  onFormDeadline(e) {
    this.setData({ formDeadline: e.detail.value })
  },

  clearDeadline() {
    this.setData({ formDeadline: '' })
  },

  submitCreate() {
    var name = this.data.formName.trim()
    var cents = u.yuanToCents(this.data.formTarget)
    if (!name) {
      this.setData({ formError: '给挑战起个名字' })
      return
    }
    if (cents <= 0) {
      this.setData({ formError: '目标金额要大于 0' })
      return
    }
    var created = db.addChallenge(db.currentLedger().id, {
      name: name,
      target: cents,
      deadline: this.data.formDeadline
    })
    if (!created) {
      this.setData({ formError: '创建失败，请重试' })
      return
    }
    this.setData({ showCreate: false })
    this.refresh()
    wx.showToast({ title: '挑战已创建', icon: 'success' })
  },

  /* ---------------- 存入 / 取出 ---------------- */

  openIn(e) {
    this.openDeposit(e.currentTarget.dataset.id, 'in')
  },

  openOut(e) {
    this.openDeposit(e.currentTarget.dataset.id, 'out')
  },

  openDeposit(id, mode) {
    var list = this.data.list
    var target = null
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) target = list[i]
    }
    if (!target) return
    this.setData({
      showDeposit: true,
      depositId: id,
      depositName: target.name,
      depositMode: mode,
      depositAmount: ''
    })
  },

  closeDeposit() {
    this.setData({ showDeposit: false })
  },

  onDepositInput(e) {
    this.setData({ depositAmount: e.detail.value })
  },

  quickAmount(e) {
    this.setData({ depositAmount: String(e.currentTarget.dataset.value) })
  },

  submitDeposit() {
    var cents = u.yuanToCents(this.data.depositAmount)
    if (cents <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    var amount = this.data.depositMode === 'out' ? -cents : cents
    var res = db.depositChallenge(db.currentLedger().id, this.data.depositId, amount)
    if (!res) {
      wx.showToast({ title: '操作失败', icon: 'none' })
      return
    }
    this.setData({ showDeposit: false })
    this.refresh()
    wx.showToast({
      title: this.data.depositMode === 'out' ? '已取出' : '已存入',
      icon: 'success'
    })
  },

  /* ---------------- 删除 ---------------- */

  onLongPress(e) {
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showActionSheet({
      itemList: ['删除这个挑战'],
      itemColor: '#E2543F',
      success(res) {
        if (res.tapIndex !== 0) return
        wx.showModal({
          title: '删除挑战',
          content: '删除后已存金额记录也会消失，确定吗？',
          confirmColor: '#E2543F',
          success(r) {
            if (!r.confirm) return
            db.removeChallenge(db.currentLedger().id, id)
            self.refresh()
            wx.showToast({ title: '已删除', icon: 'success' })
          }
        })
      }
    })
  },

  goBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' })
  }
})
