var db = require('../../utils/db')
var u = require('../../utils/util')
var recordView = require('../../utils/record-view')
var motion = require('../../utils/motion')

Page({
  data: { templates: [], count: 0, ledgerId: '', ledgerName: '', filter: 'all', unavailable: false },
  onLoad(options) {
    var ledger = options && options.ledgerId ? db.getLedger(options.ledgerId) : db.currentLedger()
    this._ledgerId = ledger ? ledger.id : ''
    this.refresh()
  },
  onShow() {
    this.refresh()
    if (!this._offDb) this._offDb = db.onChange(() => this.refresh())
    motion.reveal(this)
  },
  onHide() { if (this._offDb) this._offDb(); this._offDb = null },
  onUnload() { this.onHide() },
  refresh() {
    var ledger = db.getLedger(this._ledgerId)
    if (!ledger) { this.setData({ unavailable: true, templates: [], count: 0 }); return }
    var accounts = db.accountsOf(ledger.id)
    var all = db.templatesOf(ledger.id)
    var filter = this.data.filter
    this.setData({
      ledgerId: ledger.id, ledgerName: ledger.name, unavailable: false, count: all.length,
      templates: all.filter(t => filter === 'all' || t.type === filter).map(function (t) {
        var transfer = t.type === 'transfer'
        var category = transfer ? { name: '账户转账', icon: '↔' } : recordView.categoryInfo(ledger.id, t.type, t.category)
        function accountName(id) {
          if (!id) return '不指定账户'
          return (accounts.find(a => a.id === id) || {}).name || '账户已失效'
        }
        var validIds = accounts.filter(a => !u.accountIsFixed(a.type)).map(a => a.id)
        var missing = (t.accountId && validIds.indexOf(t.accountId) < 0) || (transfer && (!t.accountId || !t.transferTo || validIds.indexOf(t.transferTo) < 0 || t.transferTo === t.accountId))
        var missingCategory = !transfer && !db.categoriesOf(ledger.id, t.type).some(c => c.key === t.category)
        return Object.assign({}, t, {
          amountText: u.formatCents(t.amount), typeLabel: transfer ? '转账' : (t.type === 'income' ? '收入' : '支出'),
          icon: category.icon, categoryName: category.name,
          accountText: transfer ? accountName(t.accountId) + ' → ' + accountName(t.transferTo) : accountName(t.accountId),
          warning: missingCategory ? '分类已变更，使用时需重新选择' : (missing ? '账户已变更，使用时请重新确认' : '')
        })
      })
    })
  },
  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.type }); this.refresh() },
  openEditor(query) {
    if (this._navigating || !db.getLedger(this._ledgerId)) return
    this._navigating = true
    wx.navigateTo({ url: '/pages/edit/edit?ledgerId=' + encodeURIComponent(this._ledgerId) + '&' + query, complete: () => { this._navigating = false } })
  },
  createTemplate() { this.openEditor('asTemplate=1') },
  useTemplate(e) { this.openEditor('templateId=' + encodeURIComponent(e.currentTarget.dataset.id)) },
  editTemplate(e) { this.openEditor('editTemplateId=' + encodeURIComponent(e.currentTarget.dataset.id)) },
  openTemplateMenu(e) {
    if (this._menuOpen) return
    var id = e.currentTarget.dataset.id
    if (!db.getTemplate(this._ledgerId, id)) return this.refresh()
    this._menuOpen = true
    wx.showActionSheet({
      itemList: ['编辑模板', '删除模板'],
      success: (res) => {
        if (res.tapIndex === 0) this.editTemplate(e)
        if (res.tapIndex === 1) this.removeTemplate(e)
      },
      fail: function () {},
      complete: () => { this._menuOpen = false }
    })
  },
  removeTemplate(e) {
    if (this._confirming) return
    var id = e.currentTarget.dataset.id
    var template = db.getTemplate(this._ledgerId, id)
    if (!template) { this.refresh(); return }
    this._confirming = true
    wx.showModal({
      title: '删除这个模板？', content: '删除「' + template.name + '」只移除快捷预填，已经记下的账单会保留。',
      confirmText: '删除模板', confirmColor: '#B25A32',
      success: (res) => {
        if (!res.confirm) return
        var removed = db.removeTemplate(this._ledgerId, id)
        wx.showToast({ title: removed ? '模板已删除' : '模板已不可用', icon: removed ? 'success' : 'none' })
        this.refresh()
      },
      complete: () => { this._confirming = false }
    })
  }
})
