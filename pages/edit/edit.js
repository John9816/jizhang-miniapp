const db = require('../../utils/db.js')
const u = require('../../utils/util.js')
const motion = require('../../utils/motion.js')

/** 分 → "12.34"，不带千分位（可被 parse 回分） */
function plainAmount(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2)
}

Page({
  data: {
    statusBar: 20,
    contentTop: 64,
    pageH: 667,             // 由 JS 按真实窗口高度设定，避免 100vh 与自定义导航叠加导致键盘被挤出屏幕
    type: 'expense',        // expense | income
    categories: [],
    recentCats: [],
    mode: 'normal',         // normal | transfer
    category: 'food',
    amountInput: '',
    calcBase: 0,
    calcOp: '',
    calcHint: '',
    date: '',
    dateLabel: '',
    note: '',
    editingId: '',
    ledgerId: '',
    ledgerName: '我的账本',
    accounts: [],
    accountId: '',
    accountName: '',
    transferTo: '',
    transferToName: '',
    canSave: false,
    saving: false,
    savedCount: 0,
    saveFeedback: '',
    continueEntry: false,
    noteFocused: false,
    keyboardHeight: 0,
    recordUnavailable: false,
    templateMode: false,
    templateEditingId: '',
    templateName: '',
    templateWarning: '',
    fromTemplate: false,
    showAccounts: false
  },

  onLoad(options) {
    options = options || {}
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var templateSourceId = options.templateId || options.editTemplateId || ''
    var templateMode = options.asTemplate === '1' || !!options.editTemplateId
    var ledger = (templateSourceId || templateMode) && options.ledgerId ? db.getLedger(options.ledgerId) : db.currentLedger()
    var ledgerId = ledger ? ledger.id : ''
    var today = u.dateStr(new Date())
    this.setData({
      statusBar: (info && info.statusBarHeight) || 20,
      contentTop: u.navigationTop(info),
      pageH: (info && info.windowHeight) || 667,
      templateMode: templateMode,
      templateEditingId: options.editTemplateId || '',
      fromTemplate: !!templateSourceId,
      ledgerId: ledgerId,
      ledgerName: ledger ? ledger.name : '我的账本',
      accounts: this.normalizeAccounts(db.accountsOf(ledgerId)),
      date: today,
      dateLabel: u.cnDate(today)
    })

    if (!ledger && (templateSourceId || templateMode)) {
      this.setData({ recordUnavailable: true })
      wx.showToast({ title: '账本已不可用', icon: 'none' }); return
    }
    var sourceId = options.id || options.copyId || templateSourceId
    var copying = !options.id && !!sourceId
    if (sourceId) {
      var savedTemplate = templateSourceId ? db.getTemplate(ledgerId, templateSourceId) : null
      var rec = templateSourceId ? (savedTemplate && Object.assign({}, savedTemplate, { ledgerId: ledgerId })) : db.getRecord(sourceId)
      if (rec && !rec.deleted && db.getLedger(rec.ledgerId)) {
        var d = {
          editingId: copying ? '' : rec.id,
          ledgerId: rec.ledgerId,
          ledgerName: (db.getLedger(rec.ledgerId) || {}).name || '我的账本',
          date: copying ? today : rec.date,
          dateLabel: u.cnDate(copying ? today : rec.date),
          note: rec.note,
          amountInput: plainAmount(rec.amount),
          accounts: this.normalizeAccounts(db.accountsOf(rec.ledgerId), copying ? '' : rec.accountId),
          accountId: rec.accountId || ''
        }
        if (savedTemplate) d.templateName = savedTemplate.name
        if (rec.type === 'transfer') {
          d.mode = 'transfer'
          d.transferTo = rec.transferTo
          d.transferToName = rec.transferToName
        } else {
          d.type = rec.type
          d.category = rec.category
        }
        if (copying) {
          var validIds = d.accounts.map(function (a) { return a.id })
          if (d.accountId && validIds.indexOf(d.accountId) < 0) {
            d.accountId = ''
            if (savedTemplate) d.templateWarning = '模板账户已变更，请确认记账账户。'
          }
          if (d.transferTo && validIds.indexOf(d.transferTo) < 0) {
            d.transferTo = ''; d.transferToName = ''
            if (savedTemplate) d.templateWarning = '模板转账账户已变更，请重新选择两个账户。'
          }
        }
        this.setData(d)
      } else {
        this.setData({ editingId: options.id || '', recordUnavailable: true })
        wx.showToast({ title: templateSourceId ? '模板已删除或不存在' : '这条记录已删除或不存在', icon: 'none' })
        return
      }
    } else {
      // 新记录：预选账本默认记账账户（在「我的资产」页维护）
      this.applyDefaultAccount()
      if (options.mode === 'transfer') {
        this.setData({ mode: 'transfer' })
      } else if (options.category) {
        // 首页常用分类快捷进入：预选分类（仅支出类型有快捷行）
        this.setData({ type: 'expense', category: decodeURIComponent(options.category) })
      }
    }

    this.syncCategories()
    if (savedTemplate && savedTemplate.type !== 'transfer' && !this.data.categories.some(c => c.key === savedTemplate.category)) {
      this.setData({ category: '', templateWarning: '模板分类已变更，请重新选择分类后保存。' })
    }
    if (copying && !options.editTemplateId) {
      // 预填属于尚未保存的新记录；离开时仍应提醒。
      var prefill = { amountInput: this.data.amountInput, note: this.data.note }
      this.setData({ amountInput: '', note: '' })
      this._initialForm = this.formFingerprint()
      this.setData(prefill)
    } else {
    this._initialForm = this.formFingerprint()
    }
    this.refreshAmount()
  },

  onShow() { motion.reveal(this) },
  onHide() { motion.cleanup(this) },
  onUnload() { clearTimeout(this._saveTimer); motion.cleanup(this); this.guardUnsaved(false) },

  formFingerprint() {
    return JSON.stringify({
      type: this.data.mode === 'transfer' ? 'transfer' : this.data.type,
      category: this.data.mode === 'transfer' ? '' : this.data.category,
      amount: this.evalAmount(), date: this.data.date, note: this.data.note.trim(),
      accountId: this.data.accountId,
      transferTo: this.data.mode === 'transfer' ? this.data.transferTo : ''
    })
  },

  hasUnsavedChanges() { return !!this._initialForm && this.formFingerprint() !== this._initialForm },

  /**
   * 账户列表归一化。固定资产（房产/车产）不参与日常记账与转账选择——
   * 它们的估值只在「我的资产」页维护，避免记一笔误改房价车价。
   * keepId：编辑历史记录时保留原账户（可能是固定资产）。
   */
  normalizeAccounts(accounts, keepId) {
    return (accounts || []).map(function (a) {
      var info = u.accountTypeInfo(a.type)
      return { id: a.id, name: a.name, type: a.type, icon: info.icon, initialBalance: a.initialBalance, isFixed: info.group === 'fixed' }
    }).filter(function (a) { return !a.isFixed || a.id === keepId })
  },

  /**
   * 预选账本默认记账账户（在「我的资产」页「设为默认」维护）。
   * 仅新建记录时调用；编辑历史记录保持原账户。
   * 默认账户若是固定资产或已被删除，则回退「不指定」。
   */
  applyDefaultAccount() {
    var defId = db.defaultAccountOf(this.data.ledgerId)
    if (!defId) return
    var accounts = this.data.accounts
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].id === defId) {
        this.setData({ accountId: defId, accountName: accounts[i].name })
        return
      }
    }
  },

  /* ---------------- 类型 / 分类 ---------------- */

  syncCategories() {
    if (this.data.mode === 'transfer') return
    var list = db.categoriesOf(this.data.ledgerId, this.data.type).map(function (c) {
      return { key: c.key, name: c.name, icon: c.icon, tint: u.categoryTint(c.key) }
    })
    // 最近使用：按最近 30 天出现频次取前 6 个，横滑条放在分类网格上方
    var since = u.dateStr(new Date(Date.now() - 30 * 86400000))
    var recent = u.topCategories(
      db.recordsOf(this.data.ledgerId).filter(function (r) { return r.date >= since }),
      this.data.type,
      6
    )
    recent = recent.filter(function (c) { return list.some(function (it) { return it.key === c.key }) }).map(function (c) {
      return list.filter(function (it) { return it.key === c.key })[0]
    })
    var valid = false
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === this.data.category) valid = true
    }
    this.setData({
      categories: list,
      recentCats: recent,
      category: valid ? this.data.category : (list[0] ? list[0].key : 'other_out')
    })
  },

  setType(e) {
    var type = e.currentTarget.dataset.type
    // 转账为独立记账类型：与支出/收入并列在顶部切换
    if (type === 'transfer') return this.toggleTransfer()
    var self = this
    // 从转账模式切回支出/收入：先退到 normal 再同步分类
    this.setData({ type: type, mode: 'normal' }, function () {
      self.syncCategories()
      self.refreshAmount()
    })
  },

  setCategory(e) {
    var key = e.currentTarget.dataset.key
    this.setData({ category: key })
    this.refreshAmount()
    wx.vibrateShort && wx.vibrateShort({ type: 'light' })
  },

  toggleTransfer() {
    // 已在转账模式时无操作：避免误触丢失已选账户；退出走支出/收入切换
    if (this.data.mode === 'transfer') return
    if (this.data.accounts.length < 2) {
      wx.showToast({ title: '请先到「资产」添加两个账户', icon: 'none' })
      return
    }
    var ids = this.data.accounts.map(function (a) { return a.id })
    var first = ids.indexOf(this.data.accountId) >= 0 ? this.data.accountId : ids[0]
    var second = ids.indexOf(this.data.transferTo) >= 0 && this.data.transferTo !== first
      ? this.data.transferTo : ids.find(function (id) { return id !== first })
    this.setData({
      mode: 'transfer',
      accountId: first,
      transferTo: second
    })
    this.refreshAmount()
  },

  setAccount(e) {
    var id = e.currentTarget.dataset.id
    var field = e.currentTarget.dataset.field
    if (field === 'to' && id === this.data.accountId) {
      wx.showToast({ title: '转入和转出请选择不同账户', icon: 'none' }); return
    }
    var target = {}
    if (field === 'from') {
      target.accountId = id
      if (this.data.transferTo === id) target.transferTo = ''
    } else {
      target.transferTo = id
    }
    var accounts = this.data.accounts
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].id === id) {
        target[field === 'from' ? 'accountName' : 'transferToName'] = accounts[i].name
        break
      }
    }
    if (id === '') target.accountName = ''
    this.setData(target)
    if (this.data.showAccounts) motion.close(this, 'showAccounts')
    this.refreshAmount()
  },

  openAccounts() {
    if (this.data.noteFocused) this.finishNote()
    motion.open(this, 'showAccounts')
  },

  closeAccounts() {
    motion.close(this, 'showAccounts')
  },

  /* ---------------- 金额键盘 ---------------- */

  pressKey(e) {
    var k = String(e.currentTarget.dataset.k)
    if (k === 'del') return this.backspace()
    if (k === '+' || k === '-') return this.setOperator(k)
    if (k === '.') return this.appendDot()
    return this.appendDigit(k)
  },

  appendDigit(d) {
    var cur = this.data.amountInput
    if (cur === '0') cur = ''
    var seg = cur.split('.')
    if (seg.length > 1 && seg[1].length >= 2) return
    if (seg.length === 1 && seg[0].length >= 7) return
    this.setData({ amountInput: cur + d })
    this.refreshAmount()
  },

  appendDot() {
    var cur = this.data.amountInput
    if (cur.indexOf('.') >= 0) return
    this.setData({ amountInput: (cur || '0') + '.' })
  },

  backspace() {
    var cur = this.data.amountInput
    if (cur) {
      this.setData({ amountInput: cur.slice(0, -1) })
    } else if (this.data.calcOp) {
      // 退回到上一步的计算基数
      this.setData({ amountInput: plainAmount(this.data.calcBase), calcBase: 0, calcOp: '', calcHint: '' })
    }
    this.refreshAmount()
  },

  clearAmount() {
    this.setData({ amountInput: '', calcBase: 0, calcOp: '', calcHint: '' })
    this.refreshAmount()
  },

  setOperator(op) {
    var cents = u.yuanToCents(this.data.amountInput)
    var base = this.data.calcBase
    if (base === 0 && cents === 0) return
    if (base === 0) {
      base = cents
    } else if (cents > 0) {
      base = this.data.calcOp === '-' ? Math.max(0, base - cents) : base + cents
    }
    this.setData({
      calcBase: base,
      calcOp: op,
      calcHint: plainAmount(base) + ' ' + op,
      amountInput: ''
    })
    this.refreshAmount()
  },

  /** 结算当前金额（分） */
  evalAmount() {
    var cur = u.yuanToCents(this.data.amountInput)
    if (!this.data.calcOp) return cur
    return this.data.calcOp === '-' ? Math.max(0, this.data.calcBase - cur) : this.data.calcBase + cur
  },

  refreshAmount() {
    var cents = this.evalAmount()
    var ok = cents > 0
    if (ok && this.data.mode === 'transfer') {
      ok = !!this.data.accountId && !!this.data.transferTo && this.data.accountId !== this.data.transferTo
    }
    if (ok && this.data.fromTemplate && this.data.mode !== 'transfer') ok = !!this.data.category
    var accountName = ''
    var transferToName = this.data.transferToName
    this.data.accounts.forEach((account) => {
      if (account.id === this.data.accountId) accountName = account.name
      if (account.id === this.data.transferTo) transferToName = account.name
    })
    this.setData({ canSave: ok && !this.data.recordUnavailable, accountName: accountName, transferToName: transferToName })
    this.guardUnsaved(this.hasUnsavedChanges())
  },

  /** 未保存内容提醒：必须在用户交互之后调用才生效 */
  guardUnsaved(on) {
    if (!wx.enableAlertBeforeUnload) return
    if (on && !this._guarding) {
      try {
        wx.enableAlertBeforeUnload({ message: '这条还没保存，确定离开吗？' })
        this._guarding = true
      } catch (e) {}
    } else if (!on && this._guarding) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
      this._guarding = false
    }
  },

  /* ---------------- 其它输入 ---------------- */

  onDateChange(e) {
    this.setData({ date: e.detail.value, dateLabel: u.cnDate(e.detail.value) })
    this.guardUnsaved(this.hasUnsavedChanges())
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
    this.guardUnsaved(this.hasUnsavedChanges())
  },

  onNoteFocus() { this.setData({ noteFocused: true }) },
  onNoteKeyboard(e) {
    if (!this.data.noteFocused) return
    var height = Number(e.detail.height)
    if (!isFinite(height) || height < 0) return
    // 高度只控制避让；旧键盘的关闭事件可能晚于下一次聚焦，不能用它取消焦点。
    this.setData({ keyboardHeight: Math.min(height, Math.max(0, this.data.pageH - this.data.contentTop - 160)) })
  },
  onNoteBlur() { this.setData({ noteFocused: false, keyboardHeight: 0 }) },
  finishNote() {
    this.onNoteBlur()
    if (wx.hideKeyboard) wx.hideKeyboard()
  },
  toggleContinue() {
    if (this.data.editingId || this.data.templateMode || this.data.recordUnavailable) return
    this.setData({ continueEntry: !this.data.continueEntry })
  },

  onCancel() {
    if (this.data.saving) return
    if (this.hasUnsavedChanges() && !this.data.recordUnavailable) {
      wx.showModal({
        title: '放弃未保存的修改？', content: '返回后，本次输入的内容不会保存。',
        confirmText: '放弃修改', cancelText: '继续编辑', confirmColor: '#9A6D21',
        success: (res) => { if (res.confirm) this.leavePage() }
      })
      return
    }
    this.leavePage()
  },

  leavePage() {
    this.guardUnsaved(false)
    var pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/index/index' })
  },

  /* ---------------- 保存 ---------------- */

  onSave() { this.saveRecord(!!this.data.continueEntry && !this.data.editingId && !this.data.templateMode) },

  onSaveContinue() {
    if (this.data.editingId || this.data.templateMode) return
    this.saveRecord(true)
  },

  saveRecord(keepOpen) {
    if (this.data.saving) return
    var original = this.data.editingId ? db.getRecord(this.data.editingId) : null
    if (this.data.recordUnavailable || (this.data.editingId && (!original || original.deleted))) {
      wx.showToast({ title: '这条记录已删除，请返回查看', icon: 'none' })
      return
    }
    var cents = this.evalAmount()
    if (cents <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    if (!this.data.ledgerId || !db.getLedger(this.data.ledgerId)) {
      wx.showToast({ title: '账本不存在', icon: 'none' })
      return
    }
    if (this.data.fromTemplate && this.data.mode !== 'transfer' && !db.categoriesOf(this.data.ledgerId, this.data.type).some(c => c.key === this.data.category)) {
      wx.showToast({ title: '请选择有效分类', icon: 'none' }); return
    }
    var fields = {
      ledgerId: this.data.ledgerId,
      type: this.data.type,
      amount: cents,
      category: this.data.category,
      date: this.data.date || u.dateStr(new Date()),
      note: this.data.note,
      accountId: this.data.accountId
    }
    if (this.data.mode === 'transfer') {
      fields.type = 'transfer'
      fields.transferTo = this.data.transferTo
      fields.transferToName = this.data.transferToName
      if (!fields.accountId || !fields.transferTo || fields.accountId === fields.transferTo) {
        wx.showToast({ title: '请选择转出和转入账户', icon: 'none' })
        return
      }
      var validIds = this.normalizeAccounts(db.accountsOf(fields.ledgerId)).map(function (a) { return a.id })
      if (validIds.indexOf(fields.accountId) < 0 || validIds.indexOf(fields.transferTo) < 0) {
        wx.showToast({ title: '账户已变更，请重新选择', icon: 'none' })
        return
      }
    }

    if (this.data.templateMode) { this.saveTemplateForm(fields); return }
    this.setData({ saving: true })
    var ok
    if (this.data.editingId) {
      ok = db.updateRecord(this.data.editingId, fields)
    } else {
      ok = db.addRecord(fields)
    }
    if (!ok) {
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败，请检查表单', icon: 'none' })
      return
    }
    wx.showToast({ title: this.data.editingId ? '已保存' : '已记下', icon: 'success' })
    this.guardUnsaved(false)
    if (keepOpen) {
      this.setData({
        saving: false, amountInput: '', calcBase: 0, calcOp: '', calcHint: '', note: '',
        savedCount: this.data.savedCount + 1,
        saveFeedback: '刚刚记下 ¥' + u.formatCents(cents) + ' · 已连续保存 ' + (this.data.savedCount + 1) + ' 笔'
      })
      this._initialForm = this.formFingerprint()
      this.refreshAmount()
      motion.reveal(this, 'savedMotion')
      return
    }
    this.leavePage()
  },

  saveTemplateForm(fields) {
    if (this._namingTemplate) return
    this._namingTemplate = true
    wx.showModal({
      title: this.data.templateEditingId ? '保存模板' : '给模板起个名字',
      editable: true, placeholderText: '例如：工作日早餐（最多20字）',
      content: this.data.templateName || this.data.note.slice(0, 20),
      confirmText: '保存模板', confirmColor: '#8C641E',
      success: (res) => {
        if (!res.confirm) return
        var result = db.saveTemplate(this.data.ledgerId, Object.assign({}, fields, { id: this.data.templateEditingId, name: res.content }))
        if (!result.ok) { wx.showToast({ title: result.reason, icon: 'none' }); return }
        this.guardUnsaved(false)
        this._initialForm = this.formFingerprint()
        wx.showToast({ title: '模板已保存', icon: 'success' })
        this.leavePage()
      },
      complete: () => { this._namingTemplate = false }
    })
  },

  onDelete() {
    if (!this.data.editingId || this._deleting) return
    this._deleting = true
    var self = this
    wx.showModal({
      title: '删除记录',
      content: '删除后暂不计入收支和账户余额，可在「我的 → 设置 → 账单回收站」恢复。',
      confirmColor: '#B25A32',
      success(r) {
        if (!r.confirm) return
        if (!db.deleteRecord(self.data.editingId)) {
          wx.showToast({ title: '这笔账单已不可用', icon: 'none' })
          return
        }
        self.guardUnsaved(false)
        wx.showToast({ title: '已移入回收站', icon: 'success' })
        setTimeout(function () {
          var pages = getCurrentPages()
          if (pages.length > 1) wx.navigateBack()
          else wx.switchTab({ url: '/pages/index/index' })
        }, 300)
      },
      complete() { self._deleting = false }
    })
  }
})
