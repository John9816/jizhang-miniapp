var cal = require('../../utils/date-calendar')
Component({
  properties: { value: String, start: {type:String,value:'2020-01-01'}, end: {type:String,value:'2035-12-31'}, clearable: Boolean },
  data: { opened:false, draft:'', month:'', monthLabel:'', cells:[], monthMode:false, year:2026, months:[], weekdays:['一','二','三','四','五','六','日'], shortcuts:[] },
  methods: {
    open() {
      var p = this.properties, today = cal.format(new Date())
      var draft = cal.allowed(p.value,p.start,p.end) ? p.value : today
      if (p.start && draft < p.start) draft = p.start
      if (p.end && draft > p.end) draft = p.end
      if (typeof wx !== 'undefined' && wx.hideKeyboard) wx.hideKeyboard()
      var yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1)
      this.setData({opened:true,draft:draft,month:draft.slice(0,7),monthMode:false,shortcuts:[{name:'今天',date:today},{name:'昨天',date:cal.format(yesterday)},{name:'本月1日',date:today.slice(0,8)+'01'}].filter(function(s){return cal.allowed(s.date,p.start,p.end)})})
      this.renderMonth()
    },
    close() { this.setData({opened:false}) },
    noop() {},
    renderMonth() {
      var month = this.data.month, p = this.properties, year = Number(month.slice(0,4))
      this.setData({cells:cal.grid(month,this.data.draft,p.start,p.end),monthLabel:year+'年'+Number(month.slice(5))+'月',year:year})
      this.renderMonths(year)
    },
    renderMonths(year) {
      var p = this.properties, months=[]
      for (var i=1;i<=12;i++) { var key=year+'-'+(i<10?'0':'')+i; months.push({key:key,label:i+'月',disabled:!!((p.start && key<p.start.slice(0,7))||(p.end && key>p.end.slice(0,7)))}) }
      this.setData({year:year,months:months})
    },
    move(e) {
      var delta = Number(e.currentTarget.dataset.delta)
      if (this.data.monthMode) {
        var year=this.data.year+delta, p=this.properties
        if ((p.start && year<Number(p.start.slice(0,4))) || (p.end && year>Number(p.end.slice(0,4)))) return
        this.renderMonths(year); return
      }
      var month = cal.shiftMonth(this.data.month,delta), p=this.properties
      if ((p.start && month<p.start.slice(0,7)) || (p.end && month>p.end.slice(0,7))) return
      this.setData({month:month}); this.renderMonth()
    },
    toggleMonths() { if(this.data.monthMode){this.setData({monthMode:false});this.renderMonth()}else this.setData({monthMode:true}) },
    selectMonth(e) {
      var key=e.currentTarget.dataset.month,p=this.properties
      if ((p.start && key<p.start.slice(0,7)) || (p.end && key>p.end.slice(0,7))) return
      this.setData({month:key,monthMode:false});this.renderMonth()
    },
    selectDay(e) {
      var date=e.currentTarget.dataset.date,p=this.properties
      if (!cal.allowed(date,p.start,p.end)) return
      this.setData({draft:date,month:date.slice(0,7),monthMode:false});this.renderMonth()
    },
    confirm() {
      var p=this.properties
      if (!cal.allowed(this.data.draft,p.start,p.end)) return
      this.triggerEvent('change',{value:this.data.draft});this.close()
    },
    clear() { if(this.properties.clearable){this.triggerEvent('change',{value:''});this.close()} }
  }
})
