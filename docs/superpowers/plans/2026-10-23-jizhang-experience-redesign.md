# 记账本体验重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变账务数据与同步协议的前提下，完成记账本核心页面的统一视觉与交互重构。

**Architecture:** 以 `app.wxss` 作为设计令牌和通用控件层，页面 WXSS 只保留页面布局；首页、记一笔、统计、我的按现有数据接口渐进式替换结构；所有新增状态反馈都复用微信原生 toast、弹层和已有事件函数。

**Tech Stack:** 微信原生小程序 WXML/WXSS/JavaScript、Node.js 现有测试脚本。

**Spec:** `docs/superpowers/specs/2026-10-23-jizhang-experience-redesign-design.md`

## Global Constraints

- 保持本地优先数据层、云同步和账务计算口径不变。
- 不新增第三方依赖。
- 收入使用松石绿，支出使用深墨蓝，风险使用赤陶红，主行动使用琥珀金。
- 关键操作维持现有事件处理函数或提供同名兼容入口。
- 每个阶段修改后运行对应测试或结构检查。

### Task 1: 建立全局视觉令牌和通用控件基线

**Files:**
- Modify: `app.wxss`
- Modify: `custom-tab-bar/index.wxss`

- [x] **Step 1: 写入颜色、圆角、阴影、文字和状态令牌**
- [x] **Step 2: 更新卡片、按钮、芯片、列表、弹层和空状态的公共样式**
- [x] **Step 3: 更新自定义 tabbar 的层级、主行动按钮和选中态**
- [x] **Step 4: 运行 `rg` 检查全局类名仍被页面引用**

### Task 2: 重构首页信息层级和交互反馈

**Files:**
- Modify: `pages/index/index.wxml`
- Modify: `pages/index/index.wxss`
- Modify: `pages/index/index.js`（只在需要时补充 toast/刷新状态）

- [x] **Step 1: 保留现有账本、汇总、预算、列表和日历数据绑定**
- [x] **Step 2: 调整首页主卡为结余优先，并强化收入/支出/预算层级**
- [x] **Step 3: 统一快捷分类、成员筛选、账单行和空状态的触控反馈**
- [x] **Step 4: 保留更多面板、账本切换和现有跳转事件**
- [x] **Step 5: 用 `rg` 校验 WXML 中的事件名都存在于 `index.js`**

### Task 3: 重构记一笔的主流程

**Files:**
- Modify: `pages/edit/edit.wxml`
- Modify: `pages/edit/edit.wxss`
- Modify: `pages/edit/edit.js`

- [x] **Step 1: 保留金额键盘、支出/收入/转账切换和分类数据**
- [x] **Step 2: 调整金额区、最近分类和完成按钮的视觉优先级**
- [x] **Step 3: 保留低频字段、账户弹层和现有编辑路径**
- [x] **Step 4: 保存成功后提供短时成功反馈并维持原返回路径**
- [x] **Step 5: 运行现有测试并检查编辑页事件引用**

### Task 4: 重构统计与我的页面

**Files:**
- Modify: `pages/stats/stats.wxml`
- Modify: `pages/stats/stats.wxss`
- Modify: `pages/profile/profile.wxml`
- Modify: `pages/profile/profile.wxss`

- [x] **Step 1: 统计页强化总览卡的视觉层级并保留现有 canvas**
- [x] **Step 2: 统一周期切换、收入/支出切换、图表卡和空状态**
- [x] **Step 3: 我的页面统一资料头部、资产卡、功能分组和同步状态**
- [x] **Step 4: 检查所有跳转、弹层和头像事件保持可用**

### Task 5: 迁移二级页面并完成验证

**Files:**
- Modify: `pages/budget/budget.wxss`
- Modify: `pages/assets/assets.wxss`
- Modify: `pages/ledger/ledger.wxss`
- Modify: `pages/members/members.wxss`
- Modify: `pages/categories/categories.wxss`
- Modify: `pages/recurring/recurring.wxss`
- Modify: `pages/search/search.wxss`
- Modify: `pages/import/import.wxss`
- Modify: `pages/reconcile/reconcile.wxss`
- Modify: `pages/challenge/challenge.wxss`
- Modify: `pages/vip/vip.wxss`

- [x] **Step 1: 将二级页面的背景、卡片、按钮、列表和状态色迁移到公共令牌**
- [x] **Step 2: 运行 `npm test`**
- [x] **Step 3: 运行 WXML 事件引用检查脚本**
- [x] **Step 4: 检查工作区文件，确认只涉及体验层文件和文档**
