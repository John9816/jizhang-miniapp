const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

var ICON_POOL = ['🍜', '🚌', '🛍️', '🏠', '🎮', '💊', '📚', '📱', '🧧', '✨', '☕', '🍺', '🚕', '⛽', '🐱', '👕', '💄', '🎁', '💰', '📈', '💼', '🧾', '🏥', '✈️', '🚿', '🔧', '📦', '🧴']

Page({
  data: {
    type: 'expense',
    categories: [],
    showAdd: false,
    newName: '',
    newIcon: '✨',
    iconPool: ICON_POOL,
    editingKey: '',
    editText: ''
  },

  onLoad() {
    this.setData({ iconPool: ICON_POOL })
    this.refresh()
  },

  onShow() {
    this.refresh()
  },

  setType(e) {
    var type = e.currentTarget.dataset.type
    if (type === this.data.type) return
    this.setData({ type: type })
    this.refresh()
  },

  refresh() {
    var ledger = db.currentLedger()
    if (!ledger) return
    this.setData({ categories: db.categoriesOf(ledger.id, this.data.type) })
  },

  openAdd() {
    this.setData({ showAdd: true, newName: '', newIcon: '✨' })
  },

  closeAdd() {
    this.setData({ showAdd: false })
  },

  onNewName(e) { this.setData({ newName: e.detail.value }) },

  pickIcon(e) { this.setData({ newIcon: e.currentTarget.dataset.icon }) },

  saveNew() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var name = String(this.data.newName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入分类名称', icon: 'none' })
      return
    }
    var list = this.data.categories.map(function (c) { return { key: c.key, name: c.name, icon: c.icon } })
    list.push({ name: name.slice(0, 8), icon: this.data.newIcon })
    db.saveCategories(ledger.id, this.data.type, list)
    this.setData({ showAdd: false, newName: '' })
    this.refresh()
    wx.showToast({ title: '已添加', icon: 'success' })
  },

  onEditFocus(e) {
    this.setData({ editingKey: e.currentTarget.dataset.key })
  },

  onEditBlur(e) {
    var key = e.currentTarget.dataset.key
    if (key !== this.data.editingKey) return
    var name = String(e.detail.value || '').trim().slice(0, 8)
    this.setData({ editingKey: '' })
    if (!name) {
      this.refresh()
      return
    }
    var ledger = db.currentLedger()
    if (!ledger) return
    var list = this.data.categories.map(function (c) {
      return { key: c.key, name: c.key === key ? name : c.name, icon: c.icon }
    })
    db.saveCategories(ledger.id, this.data.type, list)
    this.refresh()
  },

  moveUp(e) {
    var key = e.currentTarget.dataset.key
    var ledger = db.currentLedger()
    if (!ledger) return
    var list = this.data.categories.map(function (c) { return { key: c.key, name: c.name, icon: c.icon } })
    for (var i = 1; i < list.length; i++) {
      if (list[i].key === key) {
        var tmp = list[i - 1]
        list[i - 1] = list[i]
        list[i] = tmp
        break
      }
    }
    db.saveCategories(ledger.id, this.data.type, list)
    this.refresh()
  },

  removeCat(e) {
    var key = e.currentTarget.dataset.key
    var name = e.currentTarget.dataset.name
    var self = this
    wx.showModal({
      title: '停用分类',
      content: '「' + name + '」将从记账选择器中移除，历史记录不受影响。确定吗？',
      confirmColor: '#F04646',
      success(r) {
        if (!r.confirm) return
        var ledger = db.currentLedger()
        if (!ledger) return
        var list = self.data.categories
          .filter(function (c) { return c.key !== key })
          .map(function (c) { return { key: c.key, name: c.name, icon: c.icon } })
        db.saveCategories(ledger.id, self.data.type, list)
        self.refresh()
      }
    })
  },

  restoreDefaults() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var self = this
    wx.showModal({
      title: '恢复内置分类',
      content: '将清空自定义分类，恢复内置的' + (this.data.type === 'expense' ? 10 : 6) + '个分类。历史记录仍按原 key 显示。',
      confirmText: '恢复',
      success(r) {
        if (!r.confirm) return
        db.saveCategories(ledger.id, self.data.type, [])
        self.refresh()
      }
    })
  }
})
