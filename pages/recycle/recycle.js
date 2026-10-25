var db = require('../../utils/db')
var u = require('../../utils/util')
var recordView = require('../../utils/record-view')
var motion = require('../../utils/motion')
var PAGE_SIZE = 30

Page({
  data: { records: [], ledgers: [], ledgerIndex: 0, keyword: '', totalCount: 0, matchedCount: 0, hasMore: false },
  onLoad() { this._limit = PAGE_SIZE; this.refresh() },
  onShow() {
    this.refresh()
    if (!this._offDb) this._offDb = db.onChange(() => this.refresh())
    motion.reveal(this)
  },
  onHide() { if (this._offDb) this._offDb(); this._offDb = null },
  onUnload() { this.onHide() },
  refresh() {
    var selected = this._ledgerId || ''
    var ledgers = [{ id: '', name: '全部账本' }].concat(db.listLedgers().map(l => ({ id: l.id, name: l.name })))
    var index = ledgers.findIndex(l => l.id === selected)
    if (index < 0) { selected = ''; index = 0; this._ledgerId = '' }
    var keyword = this.data.keyword.trim().toLowerCase()
    var all = db.deletedRecordsOf()
    var records = all.filter(r => !selected || r.ledgerId === selected).map(function (r) {
      var ledger = db.getLedger(r.ledgerId)
      var category = r.type === 'transfer' ? { name: '账户转账', icon: '↔' } : recordView.categoryInfo(r.ledgerId, r.type, r.category)
      return {
        id: r.id, ledgerName: ledger.name, categoryName: category.name, icon: category.icon,
        type: r.type, typeLabel: r.type === 'transfer' ? '转账' : (r.type === 'income' ? '收入' : '支出'),
        sign: r.type === 'transfer' ? '' : (r.type === 'income' ? '+' : '−'),
        amountText: u.formatCents(r.amount), date: r.date, note: r.note || '', memberName: r.memberName || '我',
        updatedAt: r.updatedAt
      }
    }).filter(r => !keyword || [r.note, r.categoryName, r.ledgerName, r.memberName, r.date, r.amountText].join(' ').toLowerCase().indexOf(keyword) >= 0)
    var limit = this._limit || PAGE_SIZE
    // 先筛选分页，再校验可见行，避免大量删除记录让每次输入触发全量交叉查找。
    var visible = records.slice(0, limit).map(function (r) {
      var state = db.recordRestoreState(r.id)
      return Object.assign(r, {
        deletedText: u.dateStr(new Date(r.updatedAt)) + ' ' + u.hmText(r.updatedAt),
        canRestore: state.ok, reason: state.reason || '', missingAccount: !!state.missingAccount
      })
    })
    this.setData({ ledgers: ledgers, ledgerIndex: index, totalCount: all.length, matchedCount: records.length, records: visible, hasMore: records.length > limit })
  },
  onKeyword(e) { this._limit = PAGE_SIZE; this.setData({ keyword: e.detail.value }); this.refresh() },
  clearKeyword() { this.onKeyword({ detail: { value: '' } }) },
  onLedgerChange(e) {
    var ledger = this.data.ledgers[Number(e.detail.value)]
    if (!ledger) return
    this._ledgerId = ledger.id; this._limit = PAGE_SIZE; this.refresh()
  },
  loadMore() { this._limit = (this._limit || PAGE_SIZE) + PAGE_SIZE; this.refresh() },
  onReachBottom() { if (this.data.hasMore) this.loadMore() },
  onRestore(e) {
    if (this._confirming) return
    var id = e.currentTarget.dataset.id
    var state = db.recordRestoreState(id)
    if (!state.ok) { wx.showToast({ title: state.reason, icon: 'none' }); this.refresh(); return }
    var record = db.getRecord(id)
    var ledger = db.getLedger(record.ledgerId)
    this._confirming = true
    wx.showModal({
      title: '恢复这笔账单？',
      content: record.date + ' · ¥' + u.formatCents(record.amount) + '\n恢复到「' + ledger.name + '」，收支和账户余额会重新计算。' + (state.missingAccount ? '\n原记账账户已删除，恢复后保留历史关联，不影响现有账户；可在编辑账单中重新选择账户。' : ''),
      confirmText: '恢复账单', confirmColor: '#91651D',
      success: (res) => {
        if (!res.confirm) return
        var result = db.restoreRecord(id)
        wx.showToast({ title: result.ok ? '账单已恢复' : result.reason, icon: result.ok ? 'success' : 'none' })
        this.refresh()
      },
      complete: () => { this._confirming = false }
    })
  }
})
