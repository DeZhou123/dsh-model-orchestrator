/**
 * Model Orchestrator — browser half.
 *
 * A strip under the composer that answers, at a glance, the three questions a
 * user actually has about an auto-router: which model is in use right now, is
 * its lane healthy, and what has it been spending. Expanding it exposes the
 * model groups, the channels inside the current model, and every automatic
 * switch, because an auto-router that cannot be audited is an auto-router
 * nobody should trust.
 *
 * Preference mode is controlled from here: pick a model, and the router stays on
 * that model while switching channels underneath it.
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
      noPreference: '未设置',
      effort: '推理档',
      bestLane: '最佳渠道',
      availableLanes: '可用渠道',
      allGroups: '全部模型组',
      currentGroup: '当前模型',
      open: '展开',
      close: '收起',
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
      noPreference: 'not set',
      effort: 'Effort',
      bestLane: 'Best channel',
      availableLanes: 'Available',
      allGroups: 'All model groups',
      currentGroup: 'Current model',
      open: 'Show',
      close: 'Hide',
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

    /** The strip's "what is happening" line. */
    function Summary(props) {
      const { t, current, config, preference, data } = props
      if (current === null || current === undefined) {
        return h('span', { className: 'mo-muted' }, t('noModel'))
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

    /** The expanded panel. */
    function Panel(props) {
      const { t, data, busy, onConfig, onRefresh, error, onPreferChange } = props
      const config = data?.config ?? {}
      const current = data?.current ?? null
      const groups = data?.groups ?? []
      const lanes = data?.lanes ?? []
      const decisions = data?.decisions ?? []
      const catalog = data?.catalog ?? {}
      const dataset = data?.dataset ?? {}
      const preference = data?.preference ?? { configured: { model: '', provider: '', fallback: 'auto' }, active: false, suspended: false, group: null, exhausted: null, effectiveMode: 'auto' }
      const channelData = data?.channelData ?? { available: false }

      const modeButton = (mode) => h('button', {
        key: mode,
        type: 'button',
        'data-active': config.mode === mode ? '1' : '0',
        onClick: () => {
          if (mode === 'prefer' && (config.preferModel ?? '') === '') {
            // Opening preference mode with nothing configured adopts the model
            // that is running right now — the least surprising default.
            const model = current?.family ?? current?.model ?? ''
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

      const groupOptions = []
      const seen = new Set()
      for (const group of groups) {
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
        const found = groups.find(group => group.key === raw || group.family === raw
          || String(group.key ?? '').toLowerCase() === folded)
        if (found !== undefined) return found.family ?? found.key
        return raw
      })()
      if (preferValue !== '' && !seen.has(preferValue)) {
        groupOptions.unshift(h('option', { key: 'current-pref', value: preferValue }, preferValue + ' · ⚠'))
      }

      return h('div', { className: 'mo-panel' }, [
        error === '' ? null : h('div', { key: 'err', className: 'mo-err' }, t('loadFailed') + ': ' + error),
        h('div', { key: 'controls', className: 'mo-row' }, [
          h('span', { key: 'ml' }, t('title')),
          h('span', { key: 'seg', className: 'mo-seg' }, ['auto', 'prefer', 'manual', 'off'].map(modeButton)),
          h('span', { key: 'sl' }, t('strategy')),
          h('span', { key: 'sseg', className: 'mo-seg' }, ['quality', 'balanced', 'economy', 'speed'].map(strategyButton)),
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
          h('button', { key: 'refresh', type: 'button', className: 'mo-btn', onClick: onRefresh, disabled: busy }, t('refresh')),
          busy ? h('span', { key: 'busy', className: 'mo-note' }, t('saving')) : null,
        ]),
        config.mode === 'prefer' ? h('div', { key: 'prefrow', className: 'mo-row' }, [
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
          h('span', { key: 'fl' }, t('preferFallback')),
          h('select', {
            key: 'fsel',
            className: 'mo-select',
            value: config.preferFallback ?? 'auto',
            disabled: busy,
            onChange: (event) => onConfig({ preferFallback: String(event.target.value ?? 'auto') }),
          }, [
            h('option', { key: 'auto', value: 'auto' }, t('fallbackAuto')),
            h('option', { key: 'manual', value: 'manual' }, t('fallbackManual')),
            h('option', { key: 'off', value: 'off' }, t('fallbackOff')),
          ]),
          h('span', { key: 'el' }, t('budget')),
          h('input', {
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
          }),
          config.turnTokenBudget === 0 ? h('span', { key: 'boff', className: 'mo-note' }, t('budgetOff')) : null,
        ]) : h('div', { key: 'budgetrow', className: 'mo-row' }, [
          h('span', { key: 'el' }, t('budget')),
          h('input', {
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
          }),
          config.turnTokenBudget === 0 ? h('span', { key: 'boff', className: 'mo-note' }, t('budgetOff')) : null,
          h('span', { key: 'ch' }, t('channelData') + '：' + (channelData.available ? t('channelDataOn') : t('channelDataOff'))),
        ]),
        h(PreferenceBanner, { key: 'banner', t, preference, onConfig, busy }),
        h('div', { key: 'grid', className: 'mo-grid' }, [
          h('div', { key: 'catalog', className: 'mo-card' }, [
            h('div', { key: 'a', className: 'mo-strong' }, (catalog.total ?? 0) + ' / ' + (catalog.providers?.length ?? 0) + ' ' + t('lane')),
            h('div', { key: 'b', className: 'mo-note' }, (catalog.groups ?? 0) + ' ' + t('family') + ' · ' + (dataset.families ?? 0) + ' report'),
            h('div', { key: 'c', className: 'mo-note' }, dataset.imported === null || dataset.imported === undefined
              ? 'report v' + (dataset.shipped?.reportVersion ?? '—')
              : 'imported v' + (dataset.imported.reportVersion ?? '—')),
            (catalog.failures ?? []).length === 0 ? null : h('div', { key: 'd', className: 'mo-warn' }, catalog.failures.length + ' lanes failed to list'),
          ]),
          h('div', { key: 'model', className: 'mo-card' }, [
            h('div', { key: 'a', className: 'mo-strong mo-ellipsis', title: current === null ? '' : current.provider + '/' + current.model }, current === null ? t('noModel') : (current.family ?? current.model)),
            h('div', { key: 'b', className: 'mo-note mo-ellipsis' }, current === null ? '' : current.provider + '/' + current.model),
            current === null ? null : h('div', { key: 'c', className: 'mo-note' }, (current.effort === null || current.effort === undefined ? '' : t('effort') + ' ' + current.effort + ' · ')
              + t('requests') + ' ' + current.requests + ' · ' + t('switches') + ' ' + current.switches),
            current === null ? null : h('div', { key: 'd', className: (current.health ?? {}).available === false ? 'mo-err' : 'mo-note' },
              (current.health ?? {}).available === false
                ? statusLabel(t, current.health.status) + ' · ' + (current.health.reason ?? '') + (fmtCooldown(current.health.cooldownMs) === '' ? '' : ' · ' + fmtCooldown(current.health.cooldownMs) + t('retryIn'))
                : t('healthy')),
          ]),
          h('div', { key: 'prefcard', className: 'mo-card' }, [
            h('div', { key: 'a', className: 'mo-strong' }, t('preferModel')),
            h('div', { key: 'b', className: 'mo-note' }, preference.configured.model === '' ? t('preferNone') : preference.configured.model + (preference.configured.provider === '' ? '' : '@' + preference.configured.provider)),
            preference.group === null ? null : h('div', { key: 'c', className: preference.group.available > 0 ? 'mo-ok' : 'mo-err' },
              preference.group.available + '/' + preference.group.total + ' ' + t('availableLanes')),
            current === null ? null : h('div', { key: 'd', className: 'mo-row' }, h('button', {
              type: 'button',
              className: 'mo-btn',
              disabled: busy,
              onClick: () => onConfig({ mode: 'prefer', preferModel: current.family ?? current.model, preferProvider: '' }),
            }, t('preferSet'))),
          ]),
        ]),
        h('div', { key: 'groups', className: 'mo-section' }, [
          h('div', { key: 'h', className: 'mo-strong' }, t('models')),
          h('div', { key: 's', className: 'mo-scroll' }, h('table', { className: 'mo-table' }, [
            h('thead', { key: 'thead' }, h('tr', { key: 'r' }, [
              h('th', { key: 'p' }, ''),
              h('th', { key: 'm' }, t('family')),
              h('th', { key: 'l' }, t('availableLanes')),
              h('th', { key: 'b' }, t('bestLane')),
              h('th', { key: 'i' }, t('intel')),
              h('th', { key: 'u' }, t('utility')),
            ])),
            h('tbody', { key: 'tbody' }, groups.slice(0, 16).map((group, index) => h(GroupRow, {
              key: (group.key ?? group.family ?? '') + '/' + index + '/' + group.utility,
              group,
              current,
              preference,
              t,
              busy,
              onPrefer: (entry) => onPreferChange(entry),
            }))),
          ])),
        ]),
        h('div', { key: 'lanes', className: 'mo-section' }, [
          h('div', { key: 'h', className: 'mo-strong' }, t('lanes') + (current === null ? '' : ' · ' + (current.family ?? current.model))),
          h('div', { key: 's', className: 'mo-scroll' }, lanes.length === 0
            ? h('div', { key: 'none', className: 'mo-note' }, '—')
            : h('table', { className: 'mo-table' }, [
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
        ]),
        h('div', { key: 'dec', className: 'mo-section' }, [
          h('div', { key: 'h', className: 'mo-strong' }, t('decisions')),
          h('div', { key: 'l', className: 'mo-list' }, decisions.length === 0
            ? h('div', { key: 'none', className: 'mo-note' }, '—')
            : decisions.map((entry, index) => h('div', { key: entry.at + '-' + index }, [
              h('span', { key: 't', className: 'mo-muted' }, new Date(entry.at).toLocaleTimeString() + ' '),
              h('span', { key: 'f' }, (entry.from ?? '—') + ' → '),
              h('span', { key: 'to', className: 'mo-strong' }, entry.to ?? '—'),
              h('span', { key: 'r', className: 'mo-note' }, ' · ' + (entry.reason ?? '')),
            ]))),
        ]),
      ])
    }

    /** The dock entry. */
    function ModelOrchestratorDock(props) {
      const t = props.t
      const sessionId = props.sessionId
      const [expanded, setExpanded] = React.useState(false)
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
          }, t('title') + ' · ' + t(config.mode ?? 'auto') + (config.mode === 'prefer' && preference.suspended ? '!' : '')),
          h(Summary, { key: 'sum', t, current, config, preference, data }),
          data === null && error === '' ? h('span', { key: 'load', className: 'mo-muted' }, t('noData')) : null,
          error !== '' && data === null ? h('span', { key: 'err', className: 'mo-err' }, t('unreachable')) : null,
          h('span', { key: 'chev', className: 'mo-chevron', 'data-open': expanded ? '1' : '0' }, '▾'),
        ]),
        expanded ? h(Panel, {
          key: 'panel',
          t,
          data,
          busy,
          error,
          onConfig,
          onRefresh,
          onPreferChange,
        }) : null,
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
      },
    }
  },
})
