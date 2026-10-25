var db = require('../../utils/db.js')
var view = require('../../utils/record-view.js')
var motion = require('../../utils/motion.js')

Page({
  data: { record: null, unavailable: false },
  onLoad(options) { this._id = (options || {}).id || ''; this.refresh() },
  onShow() {
    this.refresh()
    if (!this._offChange) this._offChange = db.onChange(() => this.refresh())
    motion.reveal(this)
  },
  onHide() {
    if (this._offChange) this._offChange()
    this._offChange = null
    motion.cleanup(this)
  },
  onUnload() { this.onHide() },
  refresh() {
    var record = view.describe(db.getRecord(this._id))
    this.setData({ record: record, unavailable: !record })
  },
  openEditor(copy) {
    this.refresh()
    if (this.data.unavailable || this._navigating) return
    this._navigating = true
    wx.navigateTo({
      url: '/pages/edit/edit?' + (copy ? 'copyId=' : 'id=') + encodeURIComponent(this._id),
      complete: () => { this._navigating = false }
    })
  },
  onEdit() { this.openEditor(false) },
  onRepeat() { this.openEditor(true) },
  openMore() {
    this.refresh()
    if (this.data.unavailable || this._menuOpen || this._navigating || this._confirming || this._namingTemplate) return
    this._menuOpen = true
    wx.showActionSheet({
      itemList: ['再记一笔', '存为常用模板', '删除账单'],
      success: (res) => {
        if (res.tapIndex === 0) this.onRepeat()
        if (res.tapIndex === 1) this.onSaveTemplate()
        if (res.tapIndex === 2) this.onDelete()
      },
      fail: function () {},
      complete: () => { this._menuOpen = false }
    })
  },
  onSaveTemplate() {
    this.refresh()
    if (this.data.unavailable || this._namingTemplate) return
    this._namingTemplate = true
    wx.showModal({
      title: '存为常用模板', editable: true,
      placeholderText: '例如：工作日早餐（最多20字）',
      content: this.data.record.categoryName,
      confirmText: '保存模板', confirmColor: '#8C641E',
      success: (res) => {
        if (!res.confirm) return
        var record = db.getRecord(this._id)
        if (!record || record.deleted) { this.refresh(); return }
        var result = db.saveTemplate(record.ledgerId, Object.assign({}, record, { id: '', name: res.content }))
        wx.showToast({ title: result.ok ? '模板已保存' : result.reason, icon: result.ok ? 'success' : 'none' })
      },
      complete: () => { this._namingTemplate = false }
    })
  },
  onDelete() {
    this.refresh()
    if (this.data.unavailable || this._confirming) return
    this._confirming = true
    wx.showModal({
      title: '删除这笔账单？', content: '删除后暂不计入收支和账户余额，可在「我的 → 设置 → 账单回收站」恢复。',
      confirmText: '删除账单', confirmColor: '#B25A32',
      success: (res) => {
        if (!res.confirm) return
        var record = db.getRecord(this._id)
        if (!record || record.deleted || !db.getLedger(record.ledgerId)) return this.refresh()
        if (db.deleteRecord(this._id)) {
          wx.showToast({ title: '已移入回收站', icon: 'success' })
          wx.navigateBack()
        }
      },
      complete: () => { this._confirming = false }
    })
  }
})
