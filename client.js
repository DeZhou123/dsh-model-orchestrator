/**
 * Model Orchestrator — browser half.
 *
 * Two entries, one panel, and the model seat's own label.
 *
 * In a conversation: a strip under the composer that answers, at a glance, the
 * three questions a user actually has about an auto-router — which model is in
 * use right now, is its lane healthy, and what has it been spending.
 *
 * On the New Session screen the composer is a different variant, so that strip
 * is not rendered at all; the same status is offered as a compact chip in the
 * hero options row, showing which model the first message is about to use.
 *
 * Expanding either one opens the same panel, split into tabs and bounded in
 * height: model groups, the channels inside the current model, and every
 * automatic switch, because an auto-router that cannot be audited is an
 * auto-router nobody should trust.
 *
 * Preference mode is controlled from here: pick a model, and the router stays on
 * that model while switching channels underneath it.
 *
 * The composer's bottom-right seat belongs to the official picker, and it paints
 * whatever that picker holds. With the switch on, that model is no longer the one
 * being called, so the label is taken over too and reads "自动选择" for as long as
 * the router owns the choice.
 *
 * Written as a hand-authored ModuleLoader bundle: no build step, no Harness
 * Client package imports (their APIs move between releases and a throwing
 * component blanks the slot), only theme tokens for colour.
 *
 * @module client
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-orchestrator',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'model-orchestrator'
    const API = '/api/model-orchestrator'
    const STYLE_ID = 'dsh-model-orchestrator-css'

    const zh = {
      title: '模型调度',
      auto: '自动',
      prefer: '偏好',
      manual: '手动',
      off: '关闭',
      strategy: '策略',
      quality: '质量优先',
      balanced: '均衡',
      economy: '省 token',
      speed: '速度优先',
      expand: '展开详情',
      collapse: '收起',
      refresh: '刷新模型清单',
      healthy: '可用',
      cooling: '冷却中',
      quota: '额度耗尽',
      rate: '速率受限',
      region: '地区封锁',
      auth: '凭据/授权',
      unavailable: '不可用',
      context: '上下文不足',
      transient: '瞬时故障',
      slow: '响应过慢',
      request: '请求本身有问题',
      safety: '渠道安全审核',
      unknown: '未知',
      noModel: '尚未选择模型',
      tokensToday: '今日 token',
      observedTtft: '实测首字',
      reportTtft: '报告首字',
      switches: '自动切换',
      requests: '请求数',
      models: '模型组（按当前策略排序）',
      lanes: '当前模型的渠道',
      decisions: '最近切换',
      lane: '渠道',
      family: '模型',
      intel: '智力',
      utility: '得分',
      vision: '视觉',
      contextWindow: '上下文',
      retryIn: '秒后重试',
      denyHint: '已屏蔽',
      noData: '正在读取调度状态…',
      unreachable: '无法读取调度状态（Host 未响应）',
      budget: '单轮 token 预算',
      budgetOff: '关闭',
      preferModel: '偏好模型',
      preserve: '保留会话档位',
      preferAll: '所有渠道',
      preferFallback: '偏好不可用时',
      preferActive: '偏好模式生效中',
      preferSuspended: '偏好模式已暂停',
      preferResume: '重试偏好',
      preferSet: '设为偏好',
      preferNone: '选择一个模型后，只调用该模型并在渠道间自动切换。',
      preferExhausted: '该模型的全部渠道都不可用',
      fallbackAuto: '自动',
      fallbackManual: '手动',
      fallbackOff: '关闭',
      saving: '保存中…',
      loadFailed: '读取失败',
      errors: '失败',
      cooldown: '冷却',
      rateLimited: '渠道限流',
      accounts: '账号',
      channelData: '渠道数据',
      channelDataOn: '已接入',
      channelDataOff: '未接入',
      peerShare: '渠道互借',
      peerShareHint: '打开后本机可把空闲车道借给对侧实例，也可借用对侧的额度（两端需同一个 token）',
      peerShareOn: '已开启',
      peerShareOff: '已关闭',
      peerRole: '角色',
      peerRoleBoth: '既借又出',
      peerRoleLend: '只出借',
      peerRoleBorrow: '只借用',
      peerRoleOff: '不参与',
      peerBorrowWhen: '借用时机',
      peerBorrowExhausted: '本机车道全不可用时',
      peerBorrowAlways: '一直参与打分',
      peerServer: '出借端点',
      peerServerOff: '未监听',
      peerLendable: '可借车道',
      peerBorrow: '借用方',
      peerToken: '互借 token',
      noPreference: '未设置',
      effort: '推理档',
      bestLane: '最佳渠道',
      availableLanes: '可用渠道',
      allGroups: '全部模型组',
      currentGroup: '当前模型',
      open: '展开',
      close: '收起',
      nextUp: '预计',
      tabOverview: '概览',
      tabModels: '模型',
      tabLanes: '渠道',
      tabLog: '记录',
      tabSettings: '设置',
      topModels: '策略排名前 4',
      preferHint: '点 ★ 设为偏好',
      firstTurn: '首轮接管',
      firstTurnHint: '新会话第一条消息就按调度结果调用模型',
      pickerDecides: '由选择器决定',
      closePop: '关闭',
      autoSelect: '自动选择',
      autoOn: '已接管',
      autoOff: '未接管',
      autoSelectHint: '模型全部由调度决定，官方选择器只作展示',
      autoSelectOnHint: '自动选择已开启：在这里选模型不会影响实际调用，点一下关闭',
      browseModels: '浏览全部模型…',
      pickerTitle: '选择偏好模型',
      pickerSearch: '搜索模型 / 渠道 / 标签',
      pickerNone: '不锁定偏好（回到自动调度）',
      pickerEmpty: '没有匹配的模型',
      pickerLoading: '正在读取模型清单…',
      pickerFoot: '点一行即设为偏好；模型组表里的 ★ 也能设。',
      channels: '渠道',
      visionYes: '视觉',
    }

    const en = {
      title: 'Model routing',
      auto: 'Auto',
      prefer: 'Preferred',
      manual: 'Manual',
      off: 'Off',
      strategy: 'Strategy',
      quality: 'Quality',
      balanced: 'Balanced',
      economy: 'Token saver',
      speed: 'Speed',
      expand: 'Show details',
      collapse: 'Hide',
      refresh: 'Refresh model catalog',
      healthy: 'available',
      cooling: 'cooling down',
      quota: 'quota exhausted',
      rate: 'rate limited',
      region: 'region blocked',
      auth: 'credential/auth',
      unavailable: 'unavailable',
      context: 'context too small',
      transient: 'transient fault',
      slow: 'too slow',
      request: 'request itself was rejected',
      safety: 'blocked by channel safety review',
      unknown: 'unknown',
      noModel: 'no model selected yet',
      tokensToday: 'tokens today',
      observedTtft: 'measured TTFT',
      reportTtft: 'report TTFT',
      switches: 'auto switches',
      requests: 'requests',
      models: 'Model groups (ranked by the active strategy)',
      lanes: 'Channels of the current model',
      decisions: 'Recent switches',
      lane: 'Channel',
      family: 'Model',
      intel: 'Intel',
      utility: 'Utility',
      vision: 'Vision',
      contextWindow: 'Context',
      retryIn: 's to retry',
      denyHint: 'blocked',
      noData: 'Reading routing state…',
      unreachable: 'Cannot read routing state (no Host response)',
      budget: 'Turn token budget',
      budgetOff: 'off',
      preferModel: 'Preferred model',
      preserve: 'Preserve session',
      preferAll: 'All channels',
      preferFallback: 'When unavailable',
      preferActive: 'Preference mode active',
      preferSuspended: 'Preference mode paused',
      preferResume: 'Retry preference',
      preferSet: 'Prefer this',
      preferNone: 'Pick a model to call only that model and switch channels under it.',
      preferExhausted: 'every channel of this model is unavailable',
      fallbackAuto: 'Auto',
      fallbackManual: 'Manual',
      fallbackOff: 'Off',
      saving: 'Saving…',
      loadFailed: 'read failed',
      errors: 'failures',
      cooldown: 'cooling',
      rateLimited: 'channel rate limit',
      accounts: 'accounts',
      channelData: 'Channel data',
      channelDataOn: 'connected',
      channelDataOff: 'not connected',
      peerShare: 'Channel sharing',
      peerShareHint: 'Lend idle lanes to the peer instance and borrow its quota (both sides need the same token)',
      peerShareOn: 'on',
      peerShareOff: 'off',
      peerRole: 'Role',
      peerRoleBoth: 'lend + borrow',
      peerRoleLend: 'lend only',
      peerRoleBorrow: 'borrow only',
      peerRoleOff: 'not involved',
      peerBorrowWhen: 'Borrow when',
      peerBorrowExhausted: 'local lanes are exhausted',
      peerBorrowAlways: 'always scored',
      peerServer: 'Lend endpoint',
      peerServerOff: 'not listening',
      peerLendable: 'Lendable lanes',
      peerBorrow: 'Borrower',
      peerToken: 'Share token',
      noPreference: 'not set',
      effort: 'Effort',
      bestLane: 'Best channel',
      availableLanes: 'Available',
      allGroups: 'All model groups',
      currentGroup: 'Current model',
      open: 'Show',
      close: 'Hide',
      nextUp: 'likely',
      tabOverview: 'Overview',
      tabModels: 'Models',
      tabLanes: 'Channels',
      tabLog: 'Log',
      tabSettings: 'Settings',
      topModels: 'Top 4 by strategy',
      preferHint: 'Click ★ to prefer',
      firstTurn: 'Take over turn 1',
      firstTurnHint: 'The first message of a new session already runs the routed model',
      pickerDecides: 'picker decides',
      closePop: 'Close',
      autoSelect: 'Auto select',
      autoOn: 'on',
      autoOff: 'off',
      autoSelectHint: 'The router picks the model; the picker only displays it',
      autoSelectOnHint: 'Auto select is on: choosing a model here will not change the call. Click to turn it off',
      browseModels: 'Browse all models…',
      pickerTitle: 'Choose the preferred model',
      pickerSearch: 'Search model / channel / tag',
      pickerNone: 'No preference (back to auto routing)',
      pickerEmpty: 'no matching model',
      pickerLoading: 'Reading the model catalog…',
      pickerFoot: 'Click a row to prefer it; ★ in the model table does the same.',
      channels: 'channels',
      visionYes: 'vision',
    }

    /** Status key -> translation key. */
    const STATUS_KEY = {
      ok: 'healthy',
      rate: 'rate',
      quota: 'quota',
      region: 'region',
      auth: 'auth',
      unavailable: 'unavailable',
      context: 'context',
      transient: 'transient',
      slow: 'slow',
      request: 'request',
      safety: 'safety',
    }

    /** Status key -> theme token used for its dot. */
    const STATUS_TOKEN = {
      ok: 'var(--dsw-alias-state-success-primary)',
      rate: 'var(--dsw-alias-state-warn-primary)',
      slow: 'var(--dsw-alias-state-warn-primary)',
      transient: 'var(--dsw-alias-state-warn-primary)',
      quota: 'var(--dsw-alias-state-error-primary)',
      auth: 'var(--dsw-alias-state-error-primary)',
      region: 'var(--dsw-alias-state-error-primary)',
      unavailable: 'var(--dsw-alias-state-error-primary)',
      context: 'var(--dsw-alias-state-warn-primary)',
      request: 'var(--dsw-alias-state-warn-primary)',
      safety: 'var(--dsw-alias-state-error-primary)',
    }

    const CSS = `
.mo-root{display:flex;flex-direction:column;gap:0;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mo-strip{display:flex;align-items:center;gap:8px;min-width:0;padding:2px 4px;background:none;border:none;cursor:pointer;color:inherit;font:inherit;text-align:left;border-radius:6px}
.mo-strip:hover{background:var(--dsw-alias-bg-layer-2)}
.mo-strip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mo-chip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;height:18px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mo-chip[data-mode="auto"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mo-chip[data-mode="prefer"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.mo-chip[data-mode="prefer"][data-suspended="1"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.mo-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.mo-strong{color:var(--dsw-alias-label-primary);font-weight:500}
.mo-muted{color:var(--dsw-alias-state-idle-primary)}
.mo-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:280px}
.mo-chevron{transition:transform .12s;color:var(--dsw-alias-state-idle-primary)}
.mo-chevron[data-open="1"]{transform:rotate(180deg)}
.mo-panel{margin-top:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px;display:flex;flex-direction:column;gap:10px}
.mo-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mo-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.mo-seg button{border:none;background:transparent;color:inherit;font:inherit;padding:2px 10px;cursor:pointer}
.mo-seg button[data-active="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mo-seg button:not(:last-child){border-right:1px solid var(--dsw-alias-border-l1)}
.mo-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;padding:2px 8px;border-radius:6px;cursor:pointer}
.mo-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.mo-btn:disabled{opacity:.5;cursor:default}
.mo-input{width:90px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;padding:2px 6px;border-radius:6px}
.mo-select{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;padding:2px 6px;border-radius:6px;max-width:260px}
.mo-table{width:100%;border-collapse:collapse}
.mo-table th{text-align:left;font-weight:500;color:var(--dsw-alias-state-idle-primary);padding:2px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.mo-table td{padding:2px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.mo-table tr[data-current="1"] td{color:var(--dsw-alias-label-primary)}
.mo-table tr[data-prefer="1"] td{background:var(--dsw-alias-bg-layer-2)}
.mo-num{text-align:right;font-variant-numeric:tabular-nums}
.mo-list{display:flex;flex-direction:column;gap:2px;max-height:170px;overflow:auto}
.mo-note{color:var(--dsw-alias-state-idle-primary)}
.mo-warn{color:var(--dsw-alias-state-warn-primary)}
.mo-err{color:var(--dsw-alias-state-error-primary)}
.mo-ok{color:var(--dsw-alias-state-success-primary)}
.mo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px}
.mo-card{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.mo-scroll{overflow-x:auto}
.mo-banner{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:6px;padding:6px 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-2)}
.mo-banner[data-kind="ok"]{border-color:var(--dsw-alias-state-success-primary)}
.mo-section{display:flex;flex-direction:column;gap:4px;min-width:0}
.mo-star{border:none;background:transparent;color:var(--dsw-alias-state-idle-primary);cursor:pointer;font:inherit;padding:0 2px}
.mo-star[data-on="1"]{color:var(--dsw-alias-state-success-primary)}
/* The row injected at the top of the official model list, matched to that list's rows. */
.mo-list-group{display:flex;flex-direction:column}
.mo-list-row{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:5px 7px;border:none;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.mo-list-row:hover,.mo-list-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.mo-list-copy{display:flex;flex-direction:column;flex:1;min-width:0}
.mo-list-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:18px}
.mo-list-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px}
.mo-list-check{flex:0 0 14px;display:grid;place-items:center;color:var(--dsw-alias-label-primary);font-size:13px;line-height:14px}
.mo-list-group[data-on="1"] .mo-list-name{color:var(--dsw-alias-brand-primary)}
/* Preference picker: a fixed overlay so a 100-row list is never clipped by the panel. */
.mo-modal{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}
.mo-dialog{display:flex;flex-direction:column;gap:8px;width:min(640px,94vw);max-height:min(78vh,560px);padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 16px 48px rgba(0,0,0,.28)}
.mo-dialog-head{display:flex;align-items:center;gap:8px}
.mo-dialog-title{flex:1 1 auto;color:var(--dsw-alias-label-primary);font-weight:500}
.mo-search{flex:1 1 auto;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.mo-dialog-list{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:2px;overflow:auto}
.mo-pick{display:flex;align-items:center;gap:8px;width:100%;padding:4px 6px;border:1px solid transparent;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.mo-pick:hover{background:var(--dsw-alias-bg-layer-2)}
.mo-pick[data-selected="1"]{border-color:var(--dsw-alias-brand-primary)}
.mo-pick-star{flex:none;width:16px;color:var(--dsw-alias-state-idle-primary);text-align:center}
.mo-pick[data-selected="1"] .mo-pick-star{color:var(--dsw-alias-state-success-primary)}
.mo-pick-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.mo-pick-meta{flex:none;color:var(--dsw-alias-state-idle-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
.mo-dialog-foot{color:var(--dsw-alias-state-idle-primary)}
/* Header keeps only the controls people actually use; everything else is a tab. */
.mo-head{justify-content:space-between}
.mo-spacer{flex:1 1 auto}
.mo-tabs{display:flex;gap:2px;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mo-tab{border:none;background:none;color:inherit;font:inherit;padding:3px 8px;cursor:pointer;border-radius:6px 6px 0 0}
.mo-tab:hover{background:var(--dsw-alias-bg-layer-2)}
.mo-tab[data-active="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mo-tabbody{display:flex;flex-direction:column;gap:8px;max-height:216px;overflow:auto;padding-right:2px}
.mo-panel{max-height:min(56vh,360px);overflow:auto}
.mo-anchor{position:relative;display:inline-flex;min-width:0}
.mo-chipbtn{cursor:pointer;background:var(--dsw-alias-bg-layer-1);font:inherit;height:20px;max-width:340px}
.mo-chipbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.mo-chipbtn .mo-chevron{margin-left:2px}
.mo-pop{position:absolute;right:0;bottom:calc(100% + 6px);z-index:40;width:min(560px,92vw);max-height:min(72vh,480px);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.18));padding:8px}
.mo-pop .mo-panel{border:none;background:none;padding:0;max-height:none}
.mo-check{display:inline-flex;align-items:center;gap:6px;min-width:0}
`

    /** Insert the stylesheet once for the lifetime of the client run. */
    function ensureStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-model-orchestrator'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /** Format a token count compactly. */
    function fmtTokens(value) {
      const number = Number(value ?? 0)
      if (!Number.isFinite(number) || number <= 0) return '0'
      if (number >= 1_000_000) return (number / 1_000_000).toFixed(2) + 'M'
      if (number >= 1_000) return (number / 1_000).toFixed(1) + 'k'
      return String(Math.round(number))
    }

    /** Format a cooldown as a compact countdown. */
    function fmtCooldown(ms) {
      const seconds = Math.max(0, Math.round(Number(ms ?? 0) / 1000))
      if (seconds === 0) return ''
      if (seconds < 60) return seconds + 's'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + 'm'
      return Math.round(minutes / 60) + 'h'
    }

    /** Human status label for one health verdict. */
    function statusLabel(t, status) {
      return t(STATUS_KEY[status] ?? 'unknown')
    }

    /** The mode shown on both entries: auto-select replaces the plain mode name. */
    function modeLabel(t, config) {
      if (config?.autoSelect === true) return t('autoSelect')
      return t(config?.mode ?? 'auto')
    }

    /** The strip's "what is happening" line. */
    function Summary(props) {
      const { t, current, config, preference, data } = props
      const next = data?.next ?? null
      if (current === null || current === undefined) {
        // A session that has not dispatched anything has no current route; the
        // useful line there is the route the first message will use (the server
        // computes it with the same selection the router would make).
        if (next === null) return h('span', { className: 'mo-muted' }, t('noModel'))
        return h('span', { className: 'mo-row' }, [
          h('span', { key: 'dot', className: 'mo-dot' }),
          h('span', { key: 'n', className: 'mo-muted' }, t('nextUp') + ' '),
          h('span', { key: 'f', className: 'mo-strong' }, next.family ?? next.model),
          h('span', { key: 'p', className: 'mo-muted' },
            (next.provider ?? '') + (next.model === null || next.model === undefined ? '' : '/' + next.model)),
          h('span', { key: 'l', className: 'mo-muted' }, next.lanes + '/' + next.total + ' ' + t('availableLanes')),
        ])
      }
      const health = current.health ?? { status: 'ok', available: true, cooldownMs: 0 }
      const bits = []
      bits.push(h('span', { key: 'dot', className: 'mo-dot', style: { background: STATUS_TOKEN[health.status] ?? STATUS_TOKEN.ok } }))
      bits.push(h('span', { key: 'family', className: 'mo-strong' }, current.family ?? current.model))
      if (config.mode === 'prefer' && preference.configured.model !== '') {
        const group = preference.group
        bits.push(h('span', { key: 'pref', className: preference.suspended ? 'mo-warn' : 'mo-ok' },
          (preference.suspended ? t('preferSuspended') : t('preferActive'))
          + (group === null ? '' : ' · ' + group.available + '/' + group.total)))
      } else {
        bits.push(h('span', { key: 'lane', className: 'mo-muted' }, current.provider))
      }
      bits.push(h('span', { key: 'state' }, health.available
        ? t('healthy')
        : statusLabel(t, health.status) + (fmtCooldown(health.cooldownMs) === '' ? '' : ' · ' + fmtCooldown(health.cooldownMs) + t('retryIn'))))
      bits.push(h('span', { key: 'tok' }, t('tokensToday') + ' ' + fmtTokens(current.tokensToday)))
      if (current.switches > 0) bits.push(h('span', { key: 'sw', className: 'mo-muted' }, t('switches') + ' ' + current.switches))
      if (data?.catalog?.error) bits.push(h('span', { key: 'err', className: 'mo-warn' }, 'catalog: ' + data.catalog.error))
      return h('span', { className: 'mo-row' }, bits)
    }

    /** The preference banner. */
    function PreferenceBanner(props) {
      const { t, preference, onConfig, busy } = props
      if (preference.configured.model === '') return null
      if (preference.suspended) {
        return h('div', { className: 'mo-banner' }, [
          h('span', { key: 'i', className: 'mo-warn' }, t('preferSuspended') + '：' + preference.configured.model),
          h('span', { key: 'r', className: 'mo-note' }, preference.exhausted?.reason ?? ''),
          h('span', { key: 'm', className: 'mo-note' }, '→ ' + t(preference.effectiveMode ?? 'auto')),
          h('button', {
            key: 'retry',
            type: 'button',
            className: 'mo-btn',
            disabled: busy,
            onClick: () => onConfig({ mode: 'prefer', preferModel: preference.configured.model, preferProvider: preference.configured.provider }),
          }, t('preferResume')),
        ])
      }
      if (preference.active) {
        return h('div', { className: 'mo-banner', 'data-kind': 'ok' }, [
          h('span', { key: 'i', className: 'mo-ok' }, t('preferActive') + '：' + (preference.group?.family ?? preference.configured.model)),
          h('span', { key: 'c', className: 'mo-note' }, preference.group === null ? '' : preference.group.available + '/' + preference.group.total + ' ' + t('availableLanes')),
          h('span', { key: 'f', className: 'mo-note' }, t('preferFallback') + '：' + t(preference.configured.fallback === 'auto' ? 'auto' : preference.configured.fallback === 'manual' ? 'manual' : 'off')),
        ])
      }
      return null
    }

    /** One model-group row. */
    function GroupRow(props) {
      const { group, current, preference, t, busy, onPrefer } = props
      const isCurrent = current !== null && current !== undefined && current.family === group.family
      const isPrefer = preference.configured.model !== ''
        && (preference.configured.model === group.family || preference.configured.model === group.key)
      const best = group.bestProvider === null ? '—' : group.bestProvider + '/' + group.bestModel
      return h('tr', { 'data-current': isCurrent ? '1' : '0', 'data-prefer': isPrefer ? '1' : '0' }, [
        h('td', { key: 'p' }, h('button', {
          type: 'button',
          className: 'mo-star',
          'data-on': isPrefer ? '1' : '0',
          title: t('preferSet'),
          disabled: busy,
          onClick: () => onPrefer(group),
        }, '★')),
        h('td', { key: 'm' }, [
          h('span', { key: 'f', className: 'mo-strong' }, group.family ?? group.key),
          (group.tags ?? []).length === 0 ? null : h('span', { key: 't', className: 'mo-note' }, ' · ' + group.tags.slice(0, 2).join(', ')),
        ]),
        h('td', { key: 'l', className: 'mo-num' }, group.lanes + '/' + group.total),
        h('td', { key: 'b', className: 'mo-ellipsis', title: best }, best),
        h('td', { key: 'i', className: 'mo-num' }, group.intel ?? '—'),
        h('td', { key: 'u', className: 'mo-num' }, typeof group.utility === 'number' ? group.utility.toFixed(3) : '—'),
      ])
    }

    /** One channel row of the current model. */
    function LaneRow(props) {
      const { lane, t } = props
      const status = lane.available ? 'ok' : (lane.cooling ? 'rate' : 'unavailable')
      return h('tr', { 'data-current': lane.provider === props.currentProvider ? '1' : '0' }, [
        h('td', { key: 'p', className: 'mo-ellipsis', title: lane.provider + '/' + lane.model }, lane.provider),
        h('td', { key: 's' }, h('span', { key: 'd', className: 'mo-dot', style: { background: STATUS_TOKEN[status] ?? STATUS_TOKEN.ok, display: 'inline-block', marginRight: 4 } }),
          lane.available ? t('healthy') : (lane.reason || t('unavailable')) + (lane.cooldownMs > 0 ? ' · ' + fmtCooldown(lane.cooldownMs) : '')),
        h('td', { key: 'u', className: 'mo-num' }, typeof lane.utility === 'number' ? lane.utility.toFixed(3) : '—'),
        h('td', { key: 't', className: 'mo-num' }, lane.ttftMs === null || lane.ttftMs === undefined ? '—' : lane.ttftMs + 'ms'),
        h('td', { key: 'k', className: 'mo-num' }, lane.todayTokens === null || lane.todayTokens === undefined ? '—' : fmtTokens(lane.todayTokens)),
      ])
    }

    /** One model-group table, shared by the overview and the models tab. */
    function GroupTable(props) {
      const { t, groups, current, preference, busy, onPreferChange } = props
      if (groups.length === 0) return h('div', { className: 'mo-note' }, '—')
      return h('div', { className: 'mo-scroll' }, h('table', { className: 'mo-table' }, [
        h('thead', { key: 'thead' }, h('tr', { key: 'r' }, [
          h('th', { key: 'p' }, ''),
          h('th', { key: 'm' }, t('family')),
          h('th', { key: 'l' }, t('availableLanes')),
          h('th', { key: 'b' }, t('bestLane')),
          h('th', { key: 'i' }, t('intel')),
          h('th', { key: 'u' }, t('utility')),
        ])),
        h('tbody', { key: 'tbody' }, groups.map((group, index) => h(GroupRow, {
          key: (group.key ?? group.family ?? '') + '/' + index + '/' + group.utility,
          group,
          current,
          preference,
          t,
          busy,
          onPrefer: onPreferChange,
        }))),
      ]))
    }

    /**
     * The expanded panel.
     *
     * It used to be one long column: controls, preference row, budget row, three
     * cards, a sixteen-row table, the channel table and the switch log, all at
     * once — several screens tall on a laptop, which pushed the composer around
     * and made the thing unreadable exactly when a decision needed checking. Now
     * the header keeps the two controls people actually use (mode, refresh), the
     * body is one tab at a time inside a bounded scroll region, and the overview
     * answers "what is running and what runs next" without scrolling at all.
     */
    function Panel(props) {
      const { t, data, busy, onConfig, onRefresh, error, onPreferChange, onClose, sessionId } = props
      const [tab, setTab] = React.useState('overview')
      const [pickerOpen, setPickerOpen] = React.useState(false)
      // The preference list has to cover every family, which `summary.groups` does
      // not (capped at 30); load the uncapped list only while a surface shows it.
      const families = useFamilies(sessionId, tab === 'settings' || pickerOpen)
      const config = data?.config ?? {}
      const current = data?.current ?? null
      const next = data?.next ?? null
      const groups = data?.groups ?? []
      const lanes = data?.lanes ?? []
      const decisions = data?.decisions ?? []
      const catalog = data?.catalog ?? {}
      const dataset = data?.dataset ?? {}
      const preference = data?.preference ?? { configured: { model: '', provider: '', fallback: 'auto' }, active: false, suspended: false, group: null, exhausted: null, effectiveMode: 'auto' }
      const channelData = data?.channelData ?? { available: false }
      // 渠道互借状态（出借端点 / 可借车道 / 借用方）。Host 没给就当未启用。
      const peer = data?.peer ?? null
      // Before the uncapped list arrives (or against an older Host that has no
      // /families route) the dialog can still show the summary's groups — strictly
      // better than an empty screen.
      const pickerFamilies = families.groups.length > 0
        ? families
        : { ...families, groups, total: groups.length }

      const modeButton = (mode) => h('button', {
        key: mode,
        type: 'button',
        'data-active': config.mode === mode ? '1' : '0',
        onClick: () => {
          if (mode === 'prefer' && (config.preferModel ?? '') === '') {
            // Opening preference mode with nothing configured adopts the model
            // that is running right now — the least surprising default.
            const model = current?.family ?? current?.model ?? next?.family ?? ''
            if (model !== '') onConfig({ mode: 'prefer', preferModel: model })
            return
          }
          onConfig({ mode })
        },
        disabled: busy,
      }, t(mode))

      const strategyButton = (strategy) => h('button', {
        key: strategy,
        type: 'button',
        'data-active': config.strategy === strategy ? '1' : '0',
        onClick: () => onConfig({ strategy }),
        disabled: busy,
      }, t(strategy))

      // Options come from the uncapped list once it has arrived; `groups` is the
      // fallback for the first paint.
      const optionSource = families.groups.length > 0 ? families.groups : groups
      const groupOptions = []
      const seen = new Set()
      for (const group of optionSource) {
        const value = group.family ?? group.key
        if (value === undefined || seen.has(value)) continue
        seen.add(value)
        groupOptions.push(h('option', { key: value, value }, value + ' · ' + group.lanes + '/' + group.total + ' ' + t('availableLanes')))
      }
      // The stored preference may be a fold key ("glm-5-3") while the option
      // values are family ids ("glm-5.3"); resolve it so the select actually
      // shows the configured model instead of silently falling back to empty.
      const preferValue = (() => {
        const raw = config.preferModel ?? ''
        if (raw === '') return ''
        const folded = String(raw).toLowerCase().replace(/[._\s]+/g, '-')
        const found = optionSource.find(group => group.key === raw || group.family === raw
          || String(group.key ?? '').toLowerCase() === folded)
        if (found !== undefined) return found.family ?? found.key
        return raw
      })()
      if (preferValue !== '' && !seen.has(preferValue)) {
        groupOptions.unshift(h('option', { key: 'current-pref', value: preferValue }, preferValue + ' · ⚠'))
      }

      const currentCard = current === null
        ? h('div', { key: 'current', className: 'mo-card' }, next === null
          ? [h('div', { key: 'a', className: 'mo-strong' }, t('noModel'))]
          : [
            h('div', { key: 'a', className: 'mo-strong mo-ellipsis' }, t('nextUp') + ' · ' + (next.family ?? next.model)),
            h('div', { key: 'b', className: 'mo-note mo-ellipsis' }, (next.provider ?? '') + '/' + (next.model ?? '')),
            h('div', { key: 'c', className: 'mo-note' }, next.lanes + '/' + next.total + ' ' + t('availableLanes')),
          ])
        : h('div', { key: 'current', className: 'mo-card' }, [
          h('div', { key: 'a', className: 'mo-strong mo-ellipsis' }, current.family ?? current.model),
          h('div', { key: 'b', className: 'mo-note mo-ellipsis' }, current.provider + '/' + current.model),
          h('div', { key: 'c', className: 'mo-note' },
            (current.effort === null || current.effort === undefined ? '' : t('effort') + ' ' + current.effort + ' · ')
            + t('requests') + ' ' + current.requests + ' · ' + t('switches') + ' ' + current.switches),
          h('div', { key: 'd', className: (current.health ?? {}).available === false ? 'mo-err' : 'mo-ok' },
            (current.health ?? {}).available === false
              ? statusLabel(t, current.health.status) + ' · ' + (current.health.reason ?? '')
                + (fmtCooldown(current.health.cooldownMs) === '' ? '' : ' · ' + fmtCooldown(current.health.cooldownMs) + t('retryIn'))
              : t('healthy')),
        ])

      const preferenceCard = h('div', { key: 'prefcard', className: 'mo-card' }, [
        h('div', { key: 'a', className: 'mo-strong' }, t('preferModel')),
        h('div', { key: 'b', className: 'mo-note mo-ellipsis' }, preference.configured.model === ''
          ? t('preferNone')
          : preference.configured.model + (preference.configured.provider === '' ? '' : '@' + preference.configured.provider)),
        preference.group === null ? null : h('div', { key: 'c', className: preference.group.available > 0 ? 'mo-ok' : 'mo-err' },
          preference.group.available + '/' + preference.group.total + ' ' + t('availableLanes')),
        h('div', { key: 'd', className: 'mo-row' }, [
          current === null ? null : h('button', {
            key: 'set',
            type: 'button',
            className: 'mo-btn',
            disabled: busy,
            onClick: () => onConfig({ mode: 'prefer', preferModel: current.family ?? current.model, preferProvider: '' }),
          }, t('preferSet')),
          h('button', {
            key: 'browse',
            type: 'button',
            className: 'mo-btn',
            disabled: busy,
            onClick: () => setPickerOpen(true),
          }, t('browseModels')),
        ]),
      ])

      const catalogCard = h('div', { key: 'catalog', className: 'mo-card' }, [
        h('div', { key: 'a', className: 'mo-strong' }, (catalog.total ?? 0) + ' / ' + (catalog.providers?.length ?? 0) + ' ' + t('lane')),
        h('div', { key: 'b', className: 'mo-note' }, (catalog.groups ?? 0) + ' ' + t('family') + ' · ' + (dataset.families ?? 0) + ' report'),
        h('div', { key: 'c', className: 'mo-note' }, dataset.imported === null || dataset.imported === undefined
          ? 'report v' + (dataset.shipped?.reportVersion ?? '—')
          : 'imported v' + (dataset.imported.reportVersion ?? '—')),
        (catalog.failures ?? []).length === 0 ? null : h('div', { key: 'd', className: 'mo-warn' }, catalog.failures.length + ' lanes failed to list'),
      ])

      const overview = h('div', { key: 'overview', className: 'mo-tabbody' }, [
        h('div', { key: 'cards', className: 'mo-grid' }, [currentCard, preferenceCard, catalogCard]),
        h(PreferenceBanner, { key: 'banner', t, preference, onConfig, busy }),
        h('div', { key: 'top', className: 'mo-section' }, [
          h('div', { key: 'h', className: 'mo-note' }, t('topModels') + ' · ' + t('preferHint')),
          h(GroupTable, { key: 'table', t, groups: groups.slice(0, 4), current, preference, busy, onPreferChange }),
        ]),
      ])

      const modelsTab = h('div', { key: 'models', className: 'mo-tabbody' }, [
        h('div', { key: 'h', className: 'mo-note' }, t('models') + ' · ' + groups.length),
        h(GroupTable, { key: 'table', t, groups: groups.slice(0, 18), current, preference, busy, onPreferChange }),
      ])

      const lanesTab = h('div', { key: 'lanes', className: 'mo-tabbody' }, [
        h('div', { key: 'h', className: 'mo-note' }, t('lanes') + (current === null ? '' : ' · ' + (current.family ?? current.model))),
        lanes.length === 0
          ? h('div', { key: 'none', className: 'mo-note' }, '—')
          : h('div', { key: 's', className: 'mo-scroll' }, h('table', { className: 'mo-table' }, [
            h('thead', { key: 'thead' }, h('tr', { key: 'r' }, [
              h('th', { key: 'p' }, t('lane')),
              h('th', { key: 's' }, t('healthy')),
              h('th', { key: 'u' }, t('utility')),
              h('th', { key: 't' }, t('observedTtft')),
              h('th', { key: 'k' }, t('tokensToday')),
            ])),
            h('tbody', { key: 'tbody' }, lanes.map((lane, index) => h(LaneRow, {
              key: lane.provider + '/' + lane.model + '/' + index,
              lane,
              t,
              currentProvider: current?.provider,
            }))),
          ])),
      ])

      const logTab = h('div', { key: 'log', className: 'mo-tabbody' }, (decisions.length === 0
        ? [h('div', { key: 'none', className: 'mo-note' }, '—')]
        : decisions.slice(0, 14).map((entry, index) => h('div', { key: entry.at + '-' + index, className: 'mo-note' }, [
          h('span', { key: 't', className: 'mo-muted' }, new Date(entry.at).toLocaleTimeString() + ' '),
          h('span', { key: 'f' }, (entry.from ?? '—') + ' → '),
          h('span', { key: 'to', className: 'mo-strong' }, entry.to ?? '—'),
          h('span', { key: 'r' }, ' · ' + (entry.reason ?? '')),
        ]))))

      const budgetInput = h('input', {
        key: 'budget',
        className: 'mo-input',
        type: 'number',
        min: 0,
        step: 1000,
        defaultValue: String(config.turnTokenBudget ?? 0),
        disabled: busy,
        onBlur: (event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value) && value !== config.turnTokenBudget) onConfig({ turnTokenBudget: Math.max(0, value) })
        },
      })

      const settingsTab = h('div', { key: 'settings', className: 'mo-tabbody' }, [
        h('div', { key: 'strategy', className: 'mo-row' }, [
          h('span', { key: 'l' }, t('strategy')),
          h('span', { key: 'seg', className: 'mo-seg' }, ['quality', 'balanced', 'economy', 'speed'].map(strategyButton)),
        ]),
        // Always visible: the preference used to appear only after switching to
        // prefer mode, which is part of why it felt hard to reach.
        h('div', { key: 'prefrow', className: 'mo-row' }, [
          h('span', { key: 'pl' }, t('preferModel')),
          h('select', {
            key: 'psel',
            className: 'mo-select',
            value: preferValue,
            disabled: busy,
            onChange: (event) => {
              const value = String(event.target.value ?? '')
              if (value === '') onConfig({ mode: 'auto', preferModel: '' })
              else onConfig({ mode: 'prefer', preferModel: value, preferProvider: '' })
            },
          }, [
            h('option', { key: 'none', value: '' }, '— ' + t('noPreference') + ' —'),
            ...groupOptions,
          ]),
          h('button', {
            key: 'browse',
            type: 'button',
            className: 'mo-btn',
            disabled: busy,
            onClick: () => setPickerOpen(true),
          }, t('browseModels')),
          config.mode === 'prefer' ? h('span', { key: 'fl' }, t('preferFallback')) : null,
          config.mode === 'prefer' ? h('select', {
            key: 'fsel',
            className: 'mo-select',
            value: config.preferFallback ?? 'auto',
            disabled: busy,
            onChange: (event) => onConfig({ preferFallback: String(event.target.value ?? 'auto') }),
          }, [
            h('option', { key: 'auto', value: 'auto' }, t('fallbackAuto')),
            h('option', { key: 'manual', value: 'manual' }, t('fallbackManual')),
            h('option', { key: 'off', value: 'off' }, t('fallbackOff')),
          ]) : null,
        ]),
        h('div', { key: 'effortrow', className: 'mo-row' }, [
          h('span', { key: 'rl' }, t('effort')),
          h('select', {
            key: 'rsel',
            className: 'mo-select',
            value: config.reasoningEffort ?? 'auto',
            disabled: busy,
            onChange: (event) => onConfig({ reasoningEffort: String(event.target.value ?? 'auto') }),
          }, [
            h('option', { key: 'auto', value: 'auto' }, t('auto')),
            h('option', { key: 'preserve', value: 'preserve' }, t('preserve')),
            ...['low', 'medium', 'high', 'max'].map(id => h('option', { key: id, value: id }, id)),
          ]),
          h('span', { key: 'bl' }, t('budget')),
          budgetInput,
          config.turnTokenBudget === 0 ? h('span', { key: 'boff', className: 'mo-note' }, t('budgetOff')) : null,
        ]),
        h('div', { key: 'first', className: 'mo-row' }, [
          h('label', { key: 'l', className: 'mo-check' }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: config.routeFirstTurn !== false,
              disabled: busy,
              onChange: (event) => onConfig({ routeFirstTurn: event.target.checked === true }),
            }),
            h('span', { key: 't' }, t('firstTurn')),
          ]),
          h('span', { key: 'h', className: 'mo-note' }, t('firstTurnHint')),
        ]),
        // Same switch as the one in the session header: the model is decided by the
        // router and the official picker only displays it.
        h('div', { key: 'auto', className: 'mo-row' }, [
          h('label', { key: 'l', className: 'mo-check' }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: config.autoSelect === true,
              disabled: busy,
              onChange: (event) => onConfig({ autoSelect: event.target.checked === true }),
            }),
            h('span', { key: 't' }, t('autoSelect')),
          ]),
          h('span', { key: 'h', className: 'mo-note' }, t('autoSelectHint')),
        ]),
        // ── 渠道互借（2026-10-29）───────────────────────────────────────────
        // 一个开关 + 角色 + 借用时机。开关先落盘，端点重绑与借用车道注册由 Host 侧
        // applyConfig 里同步完成 —— 面板不需要知道端口重绑这回事。
        h('div', { key: 'peer', className: 'mo-row' }, [
          h('label', { key: 'l', className: 'mo-check' }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: peer?.enabled === true,
              disabled: busy,
              onChange: (event) => onConfig({ peerShare: { enabled: event.target.checked === true } }),
            }),
            h('span', { key: 't' }, t('peerShare')),
          ]),
          peer?.enabled === true ? h('span', { key: 'rl' }, t('peerRole')) : null,
          peer?.enabled === true ? h('select', {
            key: 'rsel',
            className: 'mo-select',
            value: peer?.role ?? 'both',
            disabled: busy,
            onChange: (event) => onConfig({ peerShare: { role: String(event.target.value ?? 'both') } }),
          }, [
            h('option', { key: 'both', value: 'both' }, t('peerRoleBoth')),
            h('option', { key: 'lend', value: 'lend' }, t('peerRoleLend')),
            h('option', { key: 'borrow', value: 'borrow' }, t('peerRoleBorrow')),
            h('option', { key: 'off', value: 'off' }, t('peerRoleOff')),
          ]) : null,
          peer?.enabled === true && (peer?.role === 'both' || peer?.role === 'borrow') ? h('span', { key: 'bl' }, t('peerBorrowWhen')) : null,
          peer?.enabled === true && (peer?.role === 'both' || peer?.role === 'borrow') ? h('select', {
            key: 'bsel',
            className: 'mo-select',
            value: peer?.borrowWhen ?? 'exhausted',
            disabled: busy,
            onChange: (event) => onConfig({ peerShare: { borrowWhen: String(event.target.value ?? 'exhausted') } }),
          }, [
            h('option', { key: 'exhausted', value: 'exhausted' }, t('peerBorrowExhausted')),
            h('option', { key: 'always', value: 'always' }, t('peerBorrowAlways')),
          ]) : null,
        ]),
        h('div', { key: 'peerhint', className: 'mo-note' }, t('peerShareHint')),
        peer?.enabled === true ? h('div', { key: 'peerst', className: 'mo-note' },
          t('peerServer') + '：' + (peer.server === null
            ? t('peerServerOff') + (peer.serverError ? '（' + peer.serverError + '）' : '')
            : peer.server.host + ':' + peer.server.port)
          + ' · ' + t('peerLendable') + ' ' + (peer.lendable?.count ?? 0)
          + ' · ' + t('peerBorrow') + ' ' + (peer.borrow?.peerUrl === '' ? '—' : (peer.borrow.models?.length ?? 0) + ' 条')) : null,
        peer?.enabled === true ? h('div', { key: 'peertok', className: 'mo-note' },
          t('peerToken') + '：' + (peer.token === null ? '—' : peer.token.path)) : null,
        h('div', { key: 'chan', className: 'mo-note' }, t('channelData') + '：' + (channelData.available ? t('channelDataOn') : t('channelDataOff'))),
      ])

      const tabButton = (id, label) => h('button', {
        key: id,
        type: 'button',
        className: 'mo-tab',
        'data-active': tab === id ? '1' : '0',
        onClick: () => setTab(id),
      }, label)

      return h('div', { className: 'mo-panel' }, [
        error === '' ? null : h('div', { key: 'err', className: 'mo-err' }, t('loadFailed') + ': ' + error),
        h('div', { key: 'controls', className: 'mo-row mo-head' }, [
          h('span', { key: 'seg', className: 'mo-seg' }, ['auto', 'prefer', 'manual', 'off'].map(modeButton)),
          h('span', { key: 'strat', className: 'mo-note' }, t('strategy') + ' · ' + t(config.strategy ?? 'balanced')),
          h('span', { key: 'spacer', className: 'mo-spacer' }),
          busy ? h('span', { key: 'busy', className: 'mo-note' }, t('saving')) : null,
          h('button', { key: 'refresh', type: 'button', className: 'mo-btn', onClick: onRefresh, disabled: busy }, t('refresh')),
          onClose === undefined || onClose === null
            ? null
            : h('button', { key: 'close', type: 'button', className: 'mo-btn', onClick: onClose, title: t('closePop') }, '×'),
        ]),
        h('div', { key: 'tabs', className: 'mo-tabs' }, [
          tabButton('overview', t('tabOverview')),
          tabButton('models', t('tabModels')),
          tabButton('lanes', t('tabLanes')),
          tabButton('log', t('tabLog')),
          tabButton('settings', t('tabSettings')),
        ]),
        tab === 'overview' ? overview
          : tab === 'models' ? modelsTab
            : tab === 'lanes' ? lanesTab
              : tab === 'log' ? logTab : settingsTab,
        pickerOpen ? h(PreferencePicker, {
          key: 'picker',
          t,
          families: pickerFamilies,
          preference,
          busy,
          onConfig,
          onClose: () => setPickerOpen(false),
        }) : null,
      ])
    }
    /**
     * Shared data and command plumbing for both entries.
     *
     * The composer strip and the New Session chip read the same summary and post
     * the same patches; keeping two copies of that logic is how the two surfaces
     * start disagreeing about what the router is doing.
     */
    function useOrchestrator(sessionId) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const query = sessionId === undefined || sessionId === null ? '' : '?sessionId=' + encodeURIComponent(String(sessionId))
          const response = await fetch(API + '/summary' + query, { headers: { Accept: 'application/json' } })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const value = await response.json()
          setData(value)
          setError('')
          // The injected row and the seat label are both outside this component;
          // keep them in step with every read.
          if (typeof value?.config?.autoSelect === 'boolean') {
            publishAutoSelect(value.config.autoSelect === true)
            ensureListRow()
          }
          return value
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return null
        }
      }, [sessionId])

      React.useEffect(() => {
        let cancelled = false
        let timer = null
        const tick = async () => {
          if (cancelled) return
          if (typeof document === 'undefined' || document.visibilityState === 'visible') await load()
        }
        tick()
        timer = setInterval(tick, 10_000)
        const onVisible = () => {
          if (document.visibilityState === 'visible') tick()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          cancelled = true
          if (timer !== null) clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      const onConfig = React.useCallback(async (patch) => {
        setBusy(true)
        try {
          const response = await fetch(API + '/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (response.ok) await load()
          else setError('HTTP ' + response.status)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [load])

      const onRefresh = React.useCallback(async () => {
        setBusy(true)
        try {
          await fetch(API + '/refresh', { method: 'POST' })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [load])

      const onPreferChange = React.useCallback((group) => {
        const model = group.family ?? group.key
        if (model !== undefined && model !== '') onConfig({ mode: 'prefer', preferModel: model, preferProvider: '' })
      }, [onConfig])

      return { data, error, busy, load, onConfig, onRefresh, onPreferChange }
    }

    /**
     * One uncapped list of model groups, loaded on demand.
     *
     * `summary.groups` is capped (30) because it rides along with the 10 s poll; the
     * preference UI needs every family, and only while it is open. That cap is why
     * the old dropdown only offered a handful of models to lock onto.
     */
    function useFamilies(sessionId, enabled) {
      const [state, setState] = React.useState({ loading: false, error: '', total: 0, groups: [] })
      React.useEffect(() => {
        if (!enabled) return undefined
        let cancelled = false
        setState(previous => ({ ...previous, loading: true }))
        const query = sessionId === undefined || sessionId === null ? '' : '?sessionId=' + encodeURIComponent(String(sessionId))
        fetch(API + '/families' + query, { headers: { Accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then((value) => {
            if (cancelled) return
            setState({
              loading: false,
              error: '',
              total: Number(value.total ?? 0),
              groups: Array.isArray(value.groups) ? value.groups : [],
            })
          })
          .catch((failure) => {
            if (cancelled) return
            setState(previous => ({ ...previous, loading: false, error: failure instanceof Error ? failure.message : String(failure) }))
          })
        return () => {
          cancelled = true
        }
      }, [sessionId, enabled])
      return state
    }

    /** Context window as "128k" / "1M". */
    function fmtContext(value) {
      const window = Number(value ?? 0)
      if (!Number.isFinite(window) || window <= 0) return ''
      if (window >= 1_000_000) return Math.round(window / 1_000_000) + 'M'
      return Math.round(window / 1000) + 'k'
    }

    /** One row of the preference picker. */
    function PickRow(props) {
      const { t, group, selected, onPick } = props
      const family = group.family ?? group.key
      const best = group.bestProvider === null || group.bestProvider === undefined
        ? '—'
        : group.bestProvider + '/' + group.bestModel
      const meta = [
        group.intel === null || group.intel === undefined ? null : t('intel') + ' ' + group.intel,
        group.vision === true ? t('visionYes') : null,
        fmtContext(group.contextWindow),
      ].filter(Boolean).join(' · ')
      return h('button', {
        type: 'button',
        className: 'mo-pick',
        'data-selected': selected ? '1' : '0',
        onClick: () => onPick(group),
      }, [
        h('span', { key: 's', className: 'mo-pick-star' }, selected ? '★' : '☆'),
        h('span', { key: 'm', className: 'mo-pick-main' }, [
          h('span', { key: 'n' }, [
            h('span', { key: 'f', className: 'mo-strong' }, family),
            (group.tags ?? []).length === 0 ? null : h('span', { key: 't', className: 'mo-note' }, ' · ' + group.tags.slice(0, 2).join(', ')),
          ]),
          h('span', { key: 'l', className: 'mo-note mo-ellipsis' },
            group.lanes + '/' + group.total + ' ' + t('channels') + ' · ' + best),
        ]),
        h('span', { key: 'x', className: 'mo-pick-meta' }, meta),
      ])
    }

    /**
     * The dedicated preference screen: every model, searchable, with the facts
     * that make locking one a decision (channels, best lane, intelligence, vision,
     * window). Rendering it as a fixed overlay keeps it usable from a dock entry
     * whose own panel scrolls.
     */
    function PreferencePicker(props) {
      const { t, families, preference, busy, onConfig, onClose } = props
      const [query, setQuery] = React.useState('')
      const groups = families?.groups ?? []
      const needle = query.trim().toLowerCase()
      const rows = needle === ''
        ? groups
        : groups.filter(group => [group.family, group.key, group.bestProvider, group.bestModel, ...(group.models ?? []), ...(group.tags ?? [])]
          .filter(value => typeof value === 'string')
          .join(' ')
          .toLowerCase()
          .includes(needle))
      const selected = preference?.configured?.model ?? ''

      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const pick = (group) => {
        const family = group === null ? '' : (group.family ?? group.key ?? '')
        if (family === '') onConfig({ mode: 'auto', preferModel: '', preferProvider: '' })
        else onConfig({ mode: 'prefer', preferModel: family, preferProvider: '' })
        onClose()
      }

      return h('div', {
        className: 'mo-modal',
        role: 'dialog',
        'aria-modal': 'true',
        onClick: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      }, h('div', { className: 'mo-dialog' }, [
        h('div', { key: 'head', className: 'mo-dialog-head' }, [
          h('span', { key: 't', className: 'mo-dialog-title' }, t('pickerTitle')),
          h('span', { key: 'c', className: 'mo-note' }, rows.length + ' / ' + (families?.total ?? groups.length)),
          h('button', { key: 'x', type: 'button', className: 'mo-btn', onClick: onClose, title: t('closePop') }, '×'),
        ]),
        h('div', { key: 'search', className: 'mo-row' }, h('input', {
          className: 'mo-search',
          type: 'search',
          value: query,
          placeholder: t('pickerSearch'),
          autoFocus: true,
          onChange: (event) => setQuery(String(event.target.value ?? '')),
        })),
        h('div', { key: 'list', className: 'mo-dialog-list' }, [
          h('button', {
            key: 'none',
            type: 'button',
            className: 'mo-pick',
            'data-selected': selected === '' ? '1' : '0',
            disabled: busy,
            onClick: () => pick(null),
          }, [
            h('span', { key: 's', className: 'mo-pick-star' }, selected === '' ? '★' : '☆'),
            h('span', { key: 'm', className: 'mo-pick-main' },
              h('span', { key: 'n', className: 'mo-strong' }, t('pickerNone'))),
          ]),
          ...(families?.loading === true && groups.length === 0
            ? [h('div', { key: 'loading', className: 'mo-note' }, t('pickerLoading'))]
            : rows.length === 0
              ? [h('div', { key: 'empty', className: 'mo-note' }, t('pickerEmpty'))]
              : rows.map((group, index) => h(PickRow, {
                key: (group.key ?? group.family ?? '') + '/' + index,
                t,
                group,
                selected: selected !== '' && (selected === group.family || selected === group.key),
                onPick: pick,
              }))),
        ]),
        h('div', { key: 'foot', className: 'mo-dialog-foot mo-note' }, t('pickerFoot')),
      ]))
    }

    // ── 官方模型列表首行的「自动选择」 ───────────────────────────────────────────
    //
    // The shipped seat (`client-ui-model-selection`) owns both the trigger and its
    // menu, exposes only a label slot, and builds the list from its own catalog — so
    // there is no registration point for one more row. Replacing the seat instead
    // would shadow the whole official picker (search, effort pane, subagent gating,
    // keyboard navigation). The row is therefore added to the rendered list: one
    // `menuitemradio` above the first provider group, kept in sync by a childList
    // observer that follows the pane opening and closing.
    const LIST_ROW_ID = 'dsh-model-orchestrator-auto-row'
    const LIST_CONTAINER_SELECTOR = 'div[role="menu"][id$="-models"]'

    /** Locale + state the injected row paints from; written by the entries' pollers. */
    const listBridge = { t: null, autoSelect: false, scheduled: false }
    let listObserver = null

    // ── the switch, as React state ─────────────────────────────────────────────
    //
    // `listBridge` is a plain object because the injected row is plain DOM. The
    // official seat's label (below) is a React slot, so the same value also needs a
    // subscribable face: the composer trigger must repaint the moment the switch
    // flips, not at the next 10 s poll.
    const seatState = { autoSelect: false, listeners: new Set() }

    /** Read the switch: the injected row reads it through `listBridge`, React through the hook. */
    function readAutoSelect() {
      return seatState.autoSelect
    }

    /**
     * Publish the switch to every surface that paints it.
     *
     * One writer, so the DOM row and the React label cannot disagree; only a real
     * change notifies, which is what keeps a repaint from looping back into a write.
     */
    function publishAutoSelect(on) {
      const next = on === true
      listBridge.autoSelect = next
      if (seatState.autoSelect === next) return
      seatState.autoSelect = next
      for (const listener of Array.from(seatState.listeners)) {
        try {
          listener()
        } catch (failure) {
          // One broken subscriber must not cost the other surfaces their repaint.
        }
      }
    }

    function subscribeAutoSelect(listener) {
      seatState.listeners.add(listener)
      return () => {
        seatState.listeners.delete(listener)
      }
    }

    /**
     * The switch as React state.
     *
     * `useSyncExternalStore` is the tear-free read on the React 18 shell DSH ships;
     * the `useState` branch only covers an older shell, where one label per placement
     * is still not worth a hard dependency.
     */
    const useAutoSelect = typeof React.useSyncExternalStore === 'function'
      ? () => React.useSyncExternalStore(subscribeAutoSelect, readAutoSelect, readAutoSelect)
      : () => {
        const [value, setValue] = React.useState(() => readAutoSelect())
        React.useEffect(() => subscribeAutoSelect(() => setValue(readAutoSelect())), [])
        return value
      }

    /** The official model pane, when it is open. */
    function findListContainer() {
      if (typeof document === 'undefined') return null
      return document.querySelector(LIST_CONTAINER_SELECTOR)
    }

    /** Close the official menu through its own trigger (we are inside the menu). */
    function closeModelMenu() {
      if (typeof document === 'undefined') return
      const trigger = document.querySelector('button[aria-haspopup="menu"][aria-controls$="-menu"]')
      if (trigger !== null && typeof trigger.click === 'function') trigger.click()
    }

    /** Write the switch from the injected row (no React tree owns that node). */
    function writeAutoSelect(on) {
      return fetch(API + '/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSelect: on === true }),
      }).catch(() => {})
    }

    /** Build the row once; `set` compares before writing so the observer cannot loop. */
    function buildListRow(t) {
      const row = document.createElement('div')
      row.id = LIST_ROW_ID
      row.className = 'mo-list-group'
      row.setAttribute('data-on', '0')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mo-list-row'
      button.setAttribute('role', 'menuitemradio')
      button.setAttribute('aria-checked', 'false')
      const copy = document.createElement('span')
      copy.className = 'mo-list-copy'
      const name = document.createElement('span')
      name.className = 'mo-list-name'
      name.setAttribute('data-mo-name', '')
      const hint = document.createElement('span')
      hint.className = 'mo-list-hint'
      hint.setAttribute('data-mo-hint', '')
      copy.appendChild(name)
      copy.appendChild(hint)
      const check = document.createElement('span')
      check.className = 'mo-list-check'
      check.setAttribute('data-mo-check', '')
      button.appendChild(copy)
      button.appendChild(check)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const next = row.getAttribute('data-on') !== '1'
        publishAutoSelect(next)
        paintListRow(row, listBridge.t, next)
        writeAutoSelect(next)
        closeModelMenu()
      })
      row.appendChild(button)
      return row
    }

    /** Paint label, hint and checked state, writing only what changed. */
    function paintListRow(row, t, on) {
      const want = on ? '1' : '0'
      if (row.getAttribute('data-on') !== want) row.setAttribute('data-on', want)
      const button = row.querySelector('button')
      const checked = on ? 'true' : 'false'
      if (button !== null && button.getAttribute('aria-checked') !== checked) button.setAttribute('aria-checked', checked)
      const name = row.querySelector('[data-mo-name]')
      const label = t === null ? '' : t('autoSelect')
      if (name !== null && name.textContent !== label) name.textContent = label
      const hint = row.querySelector('[data-mo-hint]')
      const hintText = t === null ? '' : (on ? t('autoOn') : t('autoSelectHint'))
      if (hint !== null && hint.textContent !== hintText) hint.textContent = hintText
      const check = row.querySelector('[data-mo-check]')
      const glyph = on ? '✓' : ''
      if (check !== null && check.textContent !== glyph) check.textContent = glyph
      const title = t === null ? '' : (on ? t('autoSelectOnHint') : t('autoSelectHint'))
      if (button !== null && button.title !== title) button.title = title
    }

    /** Insert the row at the top of the model pane, or repaint the existing one. */
    function ensureListRow() {
      if (listBridge.t === null) return
      const container = findListContainer()
      if (container === null) return
      let row = container.querySelector('#' + LIST_ROW_ID)
      if (row === null || row === undefined) {
        row = buildListRow(listBridge.t)
        container.insertBefore(row, container.firstChild)
      }
      paintListRow(row, listBridge.t, listBridge.autoSelect)
    }

    function scheduleListRow() {
      if (listBridge.scheduled) return
      listBridge.scheduled = true
      const run = () => {
        listBridge.scheduled = false
        ensureListRow()
      }
      if (typeof Promise === 'undefined') run()
      else Promise.resolve().then(run)
    }

    /**
     * Watch for the model pane appearing (and for React dropping our row) and keep
     * the first row present. Called from every entry that has a locale, so the row
     * exists in a conversation and on the New Session screen alike.
     */
    function installListRow(t) {
      listBridge.t = t
      if (listObserver === null) {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
        listObserver = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes ?? []) {
              if (node.nodeType !== 1) continue
              const matches = node.matches?.(LIST_CONTAINER_SELECTOR) === true
              const contains = typeof node.querySelector === 'function' && node.querySelector(LIST_CONTAINER_SELECTOR) !== null
              if (matches || contains) {
                scheduleListRow()
                return
              }
            }
            for (const node of record.removedNodes ?? []) {
              if (node.nodeType !== 1) continue
              const isRow = node.id === LIST_ROW_ID
              const holdsRow = typeof node.querySelector === 'function' && node.querySelector('#' + LIST_ROW_ID) !== null
              if (isRow || holdsRow) {
                scheduleListRow()
                return
              }
            }
          }
        })
        listObserver.observe(document.body, { childList: true, subtree: true })
      }
      ensureListRow()
      return () => {}
    }

    // ── the official seat's label ──────────────────────────────────────────────
    //
    // The seat (`conversation.input.model`) paints its trigger — the composer's
    // bottom-right — from the picker's own selection. Once the switch is on, that
    // selection is no longer what answers, so the trigger keeps naming the last
    // hand-picked model while every call goes somewhere else. The seat declares this
    // child slot for exactly this kind of decoration, and the switch is read through
    // the store the injected row writes, so both surfaces flip together.
    //
    // Only the `trigger` placement is rewritten: `menu` and `option` are the list
    // the user is picking from, and those must keep naming models.
    //
    // The slot is declared `single` and the shipped 1017 release-label plugin already
    // occupies it at the default priority, so this entry shadows it (priority -1
    // renders first — the framework's own shadowing rule). What is displaced is a
    // badge on DeepSeek official Flash entries; a seat label that names a model the
    // router is not going to call is the bigger problem.
    const SEAT_LABEL_PLACEMENT = 'trigger'

    /**
     * The effort chip the seat paints beside the label, located from the label node.
     *
     * The label renders inside the seat's own `<span data-provider-id data-model-id>`
     * holder, which is the trigger's label row; the effort chip is that row's next
     * element sibling. Any other shape returns null and the caller leaves the DOM
     * alone, so a seat that reorganises its trigger costs the hiding and nothing else.
     */
    function seatEffortChip(node) {
      if (node === null || node === undefined || typeof node.closest !== 'function') return null
      const holder = node.closest('[data-model-id]')
      const row = holder === null || holder === undefined ? null : holder.parentElement
      const chip = row === null || row === undefined ? null : row.nextElementSibling
      if (chip === null || chip === undefined || chip.tagName !== 'SPAN') return null
      return chip
    }

    let seatPrimed = false

    /**
     * One-shot read of the switch for the seat label.
     *
     * The seat is painted before the dock's first poll lands, and showing the
     * hand-picked model name for those first frames is the exact confusion this
     * takeover removes. The first label instance primes the store; the pollers keep
     * it fresh from then on.
     */
    function primeAutoSelect() {
      if (seatPrimed) return
      seatPrimed = true
      fetch(API + '/summary', { headers: { Accept: 'application/json' } })
        .then((response) => response.ok ? response.json() : null)
        .then((value) => {
          if (typeof value?.config?.autoSelect === 'boolean') publishAutoSelect(value.config.autoSelect === true)
        })
        .catch(() => {})
    }

    /**
     * The label inside the seat's trigger, and inside its list rows.
     *
     * Props are the seat's own render call: `provider`, `model`, `placement` and
     * `selected`, plus `t` from the registered locale namespace. Anything unexpected
     * falls back to the model name the seat would have painted.
     */
    function ModelSeatLabel(props) {
      const t = props.t
      const on = useAutoSelect()
      const nodeRef = React.useRef(null)
      const model = props.model ?? {}
      const name = typeof model.name === 'string' ? model.name : String(model.id ?? '')
      const auto = props.placement === SEAT_LABEL_PLACEMENT && on === true

      React.useEffect(() => {
        primeAutoSelect()
      }, [])

      // The seat also paints its own reasoning-effort chip here, from its own
      // selection. With the router in charge that value is display-only too, and
      // "自动选择 · high" reads as if the effort had been picked here; the chip is
      // hidden through the seat's own row and restored when the switch goes off.
      React.useEffect(() => {
        if (!auto) return undefined
        const chip = seatEffortChip(nodeRef.current)
        if (chip === null) return undefined
        const previous = chip.style.display
        chip.style.display = 'none'
        return () => {
          chip.style.display = previous
        }
      }, [auto, props.model])

      const label = auto ? (typeof t === 'function' ? t('autoSelect') : '自动选择') : name
      return h('span', { ref: nodeRef, 'data-mo-auto': auto ? '1' : undefined }, label)
    }

    /** The composer strip: one line, expandable into the panel. */
    function ModelOrchestratorDock(props) {
      const t = props.t
      const [expanded, setExpanded] = React.useState(false)
      React.useEffect(() => installListRow(t), [t])
      const { data, error, busy, onConfig, onRefresh, onPreferChange } = useOrchestrator(props.sessionId)
      const config = data?.config ?? { mode: 'auto' }
      const current = data?.current ?? null
      const preference = data?.preference ?? { configured: { model: '' }, active: false, suspended: false, group: null }

      return h('div', { className: 'mo-root' }, [
        h('button', {
          key: 'strip',
          type: 'button',
          className: 'mo-strip',
          title: expanded ? t('collapse') : t('expand'),
          'aria-expanded': expanded ? 'true' : 'false',
          onClick: () => setExpanded(value => !value),
        }, [
          h('span', {
            key: 'mode',
            className: 'mo-chip',
            'data-mode': config.mode,
            'data-suspended': config.mode === 'prefer' && preference.suspended ? '1' : '0',
          }, t('title') + ' · ' + modeLabel(t, config) + (config.mode === 'prefer' && preference.suspended ? '!' : '')),
          h(Summary, { key: 'sum', t, current, config, preference, data }),
          data === null && error === '' ? h('span', { key: 'load', className: 'mo-muted' }, t('noData')) : null,
          error !== '' && data === null ? h('span', { key: 'err', className: 'mo-err' }, t('unreachable')) : null,
          h('span', { key: 'chev', className: 'mo-chevron', 'data-open': expanded ? '1' : '0' }, '▾'),
        ]),
        expanded ? h(Panel, {
          key: 'panel',
          t,
          sessionId: props.sessionId,
          data,
          busy,
          error,
          onConfig,
          onRefresh,
          onPreferChange,
        }) : null,
      ])
    }

    /**
     * The New Session chip.
     *
     * The blank-session screen renders its composer with `variant="hero"`, and
     * `conversation.composer.dock` is only rendered for `variant="composer"` — so
     * the router was invisible on exactly the screen where the first model decision
     * is made. The hero options row is a real list slot in that screen, so the same
     * status is shown there before the first message, and expanding it opens the
     * same panel in a popover instead of reflowing the hero.
     */
    function HeroChip(props) {
      const t = props.t
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => installListRow(t), [t])
      const { data, error, busy, onConfig, onRefresh, onPreferChange } = useOrchestrator(props.sessionId)
      const config = data?.config ?? { mode: 'auto' }
      const current = data?.current ?? null
      const next = data?.next ?? null
      const preference = data?.preference ?? { configured: { model: '' }, active: false, suspended: false, group: null }
      // Before the first message there is no `current` route, so the chip answers the
      // only question that matters there: which model is about to answer. In manual
      // mode that is the picker's business, and with routing off it is nobody's.
      const label = current !== null
        ? (current.family ?? current.model)
        : config.mode === 'off' ? t('off')
          : config.mode === 'manual' && config.autoSelect !== true ? t('pickerDecides')
            : next === null ? t('noModel') : (next.family ?? next.model)
      const dot = current === null && next === null
        ? null
        : current !== null && (current.health ?? {}).available === false
          ? STATUS_TOKEN[current.health.status] ?? STATUS_TOKEN.unavailable
          : STATUS_TOKEN.ok

      return h('div', { className: 'mo-anchor' }, [
        h('button', {
          key: 'chip',
          type: 'button',
          className: 'mo-chip mo-chipbtn',
          'data-mode': config.mode,
          'data-suspended': config.mode === 'prefer' && preference.suspended ? '1' : '0',
          'aria-expanded': open ? 'true' : 'false',
          title: t('expand') + ' · ' + t('title'),
          onClick: () => setOpen(value => !value),
        }, [
          dot === null ? null : h('span', { key: 'dot', className: 'mo-dot', style: { background: dot } }),
          h('span', { key: 'm' }, t('title') + ' · ' + modeLabel(t, config)),
          h('span', { key: 's', className: 'mo-ellipsis' }, label),
          h('span', { key: 'c', className: 'mo-chevron', 'data-open': open ? '1' : '0' }, '▾'),
        ]),
        open ? h('div', { key: 'pop', className: 'mo-pop' }, h(Panel, {
          t,
          sessionId: props.sessionId,
          data,
          busy,
          error,
          onConfig,
          onRefresh,
          onPreferChange,
          onClose: () => setOpen(false),
        })) : null,
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-orchestrator: dictionaries')
        ctx.effect(() => ensureStyles(), 'model-orchestrator: styles')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'model-orchestrator',
          order: 6,
          locale: NS,
        }, ModelOrchestratorDock))
        // 新会话首屏是另一个 composer 变体（hero），composer.dock 在那一屏不渲染；
        // hero.options 是那一行真实存在的列表槽，首条消息之前的调度可见性靠它。
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'model-orchestrator-hero',
          order: 12,
          locale: NS,
        }, HeroChip))
        // 官方模型列表首行的「自动选择」不是 slot（那一格没有扩展点）：它由
        // installListRow 注入到渲染出来的列表里，入口的 effect 负责挂上观察器。
        // 官方 seat 触发的标签（composer 右下角那个模型名）是它声明的 single 子槽：
        // 打开自动选择后，那里显示的模型已经不是实际调用的模型，由这个条目接管显示。
        // 该槽默认被 @deepseek-ai/dsh-client-ui-deepseek-model-label-1017 占着，所以按
        // 框架的 shadow 规则用更低的 priority 取胜（越低越先渲染）。
        ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
          name: 'conversation.input.model.label',
          id: 'model-orchestrator-seat-label',
          priority: -1,
          locale: NS,
        }, ModelSeatLabel))
      },
    }
  },
})
