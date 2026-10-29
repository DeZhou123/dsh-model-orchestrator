/**
 * The agent-facing face of the orchestrator: one tool with an `action`
 * parameter, plus the `/route` human command.
 *
 * Both call the same Host operations the panel calls, so there is exactly one
 * implementation of every operation and the agent and the user cannot disagree
 * about what "switch to economy" did.
 *
 * @module src/tools
 */

/** Render a JSON value as one text block, which is all a tool result needs. */
function asText(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** Compact one-line summary of a model group. */
function formatGroup(group) {
  return {
    model: group.family ?? group.key,
    intel: group.intel,
    utility: group.utility,
    lanes: group.lanes + '/' + group.total,
    best: group.bestProvider === null ? null : group.bestProvider + '/' + group.bestModel,
    excluded: group.excluded,
  }
}

/**
 * Register the tool and the command.
 *
 * @param {object} options
 * @param {object} options.ctx - host context carrying `tools` and/or `commands`.
 * @param {object} options.api - orchestrator operations.
 */
export function registerAgentSurface(options) {
  const { ctx, api } = options

  ctx.inject(['tools'], (scoped) => {
    const dispose = scoped.tools.register({
      name: 'model_orchestrator',
      description: [
        '查看和控制当前的模型自动调度。',
        'action 取值：',
        'status —— 当前实际使用的模型、其渠道健康、按优先级排好的模型组与最近切换记录；',
        'explain —— 上一次为什么选了这个模型/渠道（含各项打分）；',
        'lanes —— 列出当前可用的模型组及其渠道覆盖（多模型多渠道对比）；',
        'set —— 改调度设置（mode/strategy/preferModel/preferProvider/preferFallback/turnTokenBudget/deny/allow/denyProviders/reasoningEffort/routeFirstTurn/autoSelect）；',
        'prefer —— 打开偏好模式：只调用指定模型，用尽时自动换渠道，所有渠道都不可用时暂停并提醒；',
        'unprefer —— 退出偏好模式，回到自动调度；',
        'refresh —— 重新拉取实时模型清单与渠道数据；',
        'import_report —— 从磁盘上的测速报告 markdown 重新导入智力/速度优先级数据；',
        'clear_import —— 丢弃导入的优先级数据，回到插件自带的那份；',
        'peer —— 渠道互借状态：出借端点、可借车道、借用方已注册的对侧模型（用 set 的 peerShare 字段改设置）。',
        '额度耗尽、限流或渠道不可用时，会先在同一个模型的其它渠道间切换；只有整个模型都不可用才换模型。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'explain', 'lanes', 'set', 'prefer', 'unprefer', 'refresh', 'import_report', 'clear_import', 'peer'],
            description: '要执行的操作。',
          },
          sessionId: { type: 'string', description: 'status/explain 时可指定会话；省略则用最近活跃的会话。' },
          mode: { type: 'string', enum: ['auto', 'prefer', 'manual', 'off'], description: 'set：auto 自动调度；prefer 偏好模式；manual 只在当前模型不可用时换；off 完全不介入。' },
          strategy: { type: 'string', enum: ['quality', 'balanced', 'economy', 'speed'], description: 'set：调度策略。' },
          preferModel: { type: 'string', description: 'set/prefer：偏好模型（家族 id，如 glm-5.3，或 provider/model）。' },
          preferProvider: { type: 'string', description: 'prefer：把偏好模型限制在某个渠道（空字符串表示所有渠道）。' },
          preferFallback: { type: 'string', enum: ['auto', 'manual', 'off'], description: 'set：偏好模型所有渠道都不可用时改用什么模式。' },
          reasoningEffort: { type: 'string', description: 'set：auto | preserve | 具体 effort id（max/high/...）。' },
          routeFirstTurn: { type: 'boolean', description: 'set：新会话第一条消息是否直接按调度结果调用模型（true，默认）；false 时首轮先用选择器里的模型。' },
          autoSelect: { type: 'boolean', description: 'set：自动选择——模型全部由调度决定，官方模型选择器只作展示（true）；false 时选择器的改动会被尊重一段时间。' },
          turnTokenBudget: { type: 'number', description: 'set：单轮输出 token 预算，超出后自动切到省 token 档；0 关闭。' },
          deny: { type: 'array', items: { type: 'string' }, description: 'set：永不动用的模型（id 或 provider/model）。' },
          allow: { type: 'array', items: { type: 'string' }, description: 'set：即使在内置黑名单里也允许动用。' },
          denyProviders: { type: 'array', items: { type: 'string' }, description: 'set：排除整个车道。' },
          path: { type: 'string', description: 'import_report：测速报告 markdown 的绝对路径。' },
          peerShare: {
            type: 'object',
            description: 'set：渠道互借设置（enabled/role/host/port/token/peerUrl/peerToken/peerProvider/borrowWhen/allowProviders/denyProviders）。'
              + 'role 取值 off|both|lend|borrow；borrowWhen 取值 exhausted|always。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => asText(value),
      },
      async execute(args) {
        const action = String(args?.action ?? 'status')
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
        switch (action) {
          case 'status':
            return api.status(sessionId)
          case 'explain':
            return api.explain(sessionId)
          case 'lanes': {
            const status = api.status(sessionId)
            return { ok: true, current: status.current, preference: status.preference, groups: status.groups }
          }
          case 'set': {
            const patch = {}
            for (const key of ['mode', 'strategy', 'preferModel', 'preferProvider', 'preferFallback',
              'turnTokenBudget', 'deny', 'allow', 'denyProviders', 'reasoningEffort', 'routeFirstTurn', 'autoSelect',
              'peerShare']) {
              if (args?.[key] !== undefined) patch[key] = args[key]
            }
            if (Object.keys(patch).length === 0) return { ok: false, error: 'set 需要至少一个要修改的字段' }
            return { ok: true, config: api.applyConfig(patch) }
          }
          case 'prefer': {
            const model = String(args?.preferModel ?? '').trim()
            if (model === '') return { ok: false, error: 'prefer 需要 preferModel' }
            return {
              ok: true,
              config: api.applyConfig({
                mode: 'prefer',
                preferModel: model,
                preferProvider: String(args?.preferProvider ?? '').trim(),
              }),
            }
          }
          case 'unprefer':
            return { ok: true, config: api.applyConfig({ mode: 'auto' }) }
          case 'refresh': {
            const catalog = await api.refresh()
            return { ok: true, catalog }
          }
          case 'import_report':
            return api.importReport(String(args?.path ?? ''))
          case 'clear_import':
            return api.clearImport()
          case 'peer':
            return api.peer()
          default:
            return { ok: false, error: 'unknown action "' + action + '"' }
        }
      },
    })
    return () => dispose()
  })

  ctx.inject(['commands'], (scoped) => {
    const dispose = scoped.commands.register({
      name: 'route',
      description: '查看/切换模型自动调度：/route [status|explain|lanes|auto|manual|off|prefer <模型>|unprefer|quality|balanced|economy|speed|reasoning <auto|preserve|effort>|firstturn <on|off>|autoselect <on|off>|refresh|peer [on|off|lend|borrow|both]]',
      handler: async (invocation) => {
        const input = String(invocation?.rawInput ?? '').trim()
        const [verbRaw, ...rest] = input.split(/\s+/).filter(Boolean)
        const verb = (verbRaw ?? 'status').toLowerCase()
        const sessionId = invocation?.agent?.id
        let value
        switch (verb) {
          case 'status':
            value = api.status(sessionId)
            break
          case 'explain':
            value = api.explain(sessionId)
            break
          case 'lanes': {
            const status = api.status(sessionId)
            value = { ok: true, current: status.current, preference: status.preference, groups: status.groups }
            break
          }
          case 'refresh': {
            const catalog = await api.refresh()
            value = { ok: true, catalog }
            break
          }
          case 'peer': {
            const next = (rest[0] ?? '').toLowerCase()
            if (next === '') {
              value = api.peer()
              break
            }
            if (next === 'on') value = { ok: true, config: api.applyConfig({ peerShare: { enabled: true } }) }
            else if (next === 'off') value = { ok: true, config: api.applyConfig({ peerShare: { enabled: false } }) }
            else if (['lend', 'borrow', 'both', 'off'].includes(next)) value = { ok: true, config: api.applyConfig({ peerShare: { role: next } }) }
            else value = { ok: false, error: '用法：/route peer [on|off|lend|borrow|both]' }
            break
          }
          case 'auto':
          case 'manual':
          case 'off':
            value = { ok: true, config: api.applyConfig({ mode: verb }) }
            break
          case 'prefer': {
            if (rest.length === 0) {
              value = { ok: false, error: '用法：/route prefer <模型家族|provider/model> [渠道]' }
            } else {
              value = {
                ok: true,
                config: api.applyConfig({ mode: 'prefer', preferModel: rest[0], preferProvider: rest[1] ?? '' }),
              }
            }
            break
          }
          case 'unprefer':
            value = { ok: true, config: api.applyConfig({ mode: 'auto' }) }
            break
          case 'quality':
          case 'balanced':
          case 'economy':
          case 'speed':
            value = { ok: true, config: api.applyConfig({ strategy: verb }) }
            break
          case 'reasoning':
            value = { ok: true, config: api.applyConfig({ reasoningEffort: rest[0] ?? 'auto' }) }
            break
          case 'firstturn':
            value = { ok: true, config: api.applyConfig({ routeFirstTurn: (rest[0] ?? 'on').toLowerCase() !== 'off' }) }
            break
          case 'autoselect':
            value = { ok: true, config: api.applyConfig({ autoSelect: (rest[0] ?? 'on').toLowerCase() !== 'off' }) }
            break
          case 'pin':
            value = { ok: true, config: api.applyConfig(rest.length >= 2
              ? { mode: 'prefer', preferModel: rest[1], preferProvider: rest[0] }
              : { mode: 'auto', preferModel: '' }) }
            break
          default:
            value = { ok: false, error: 'unknown subcommand "' + verb + '"' }
        }
        return { kind: 'text', text: renderCommand(value) }
      },
    })
    return () => dispose()
  })
}

/** Human-readable rendering for the `/route` command. */
export function renderCommand(value) {
  if (value?.ok === false) return '调度命令失败：' + value.error
  if (value?.lastDecision !== undefined) {
    const decision = value.lastDecision
    if (decision === null) return '还没有路由决策记录。'
    const lines = [
      '上次决策：' + (decision.from ?? '—') + ' → ' + decision.provider + '/' + decision.model,
      '模式：' + decision.mode + ' · 策略：' + decision.strategy + ' · 得分：' + decision.utility,
      '原因：' + decision.reason,
    ]
    if (decision.parts !== null && decision.parts !== undefined) {
      lines.push('打分：质量 ' + decision.parts.quality + ' · 速度 ' + decision.parts.speed
        + ' · 健康 ' + decision.parts.health + ' · 成本 ' + decision.parts.cost
        + ' · 用量 ' + decision.parts.usage + ' · 首字 ' + (decision.parts.ttftMs ?? '?') + 'ms(' + decision.parts.latencySource + ')')
      // Live load is the only non-historical reading; show it only when it
      // actually influenced the score, so an idle machine stays quiet.
      if (Number(decision.parts.concurrent ?? 0) > 0) {
        lines.push('并发：本路由 ' + (decision.parts.inFlight ?? 0) + ' 个在飞 · 同渠道 '
          + (decision.parts.laneInFlight ?? 0) + ' 个在飞 · 扣 ' + decision.parts.concurrent)
      }
    }
    if ((decision.alternatives ?? []).length > 0) {
      lines.push('', '备选模型组：')
      for (const group of decision.alternatives) {
        lines.push('  ' + (group.utility ?? '?') + '  ' + (group.family ?? group.key) + '  ' + group.lanes + '/' + group.total + ' 渠道')
      }
    }
    if (value.preference !== undefined && value.preference.configured.model !== '') {
      lines.push('', '偏好：' + value.preference.configured.model
        + ' · ' + (value.preference.active ? '生效中' : '已暂停')
        + (value.preference.group === null ? '' : ' · ' + value.preference.group.available + '/' + value.preference.group.total + ' 渠道可用'))
    }
    return lines.join('\n')
  }
  if (value?.current !== undefined || value?.groups !== undefined) {
    const lines = []
    const current = value.current
    if (current === null || current === undefined) {
      lines.push('当前没有在用的模型记录。')
    } else {
      lines.push('当前模型：' + current.provider + '/' + current.model + '（' + (current.family ?? '未知家族') + '）')
      if (current.effort) lines.push('推理档位：' + current.effort)
      if (current.health !== undefined && current.health !== null) {
        if (current.health.available) lines.push('状态：可用')
        else {
          const cooldown = Math.ceil((current.health.cooldownMs ?? 0) / 1000)
          lines.push('状态：不可用（' + current.health.reason + '，' + cooldown + 's 后重试）')
        }
      }
      if (current.tokensToday !== undefined) lines.push('今日 token：' + current.tokensToday)
      if (Number(current.inFlight ?? 0) > 0) lines.push('正在飞：' + current.inFlight + ' 个调用')
      if (current.reason !== undefined) lines.push('选择原因：' + current.reason)
      if (current.switches !== undefined) lines.push('本会话已自动切换：' + current.switches + ' 次')
    }
    if (value.preference !== undefined && value.preference.configured.model !== '') {
      const pref = value.preference
      lines.push('', '偏好模式：' + pref.configured.model + ' · ' + (pref.active ? '生效中' : pref.suspended ? '已暂停（' + (pref.exhausted?.reason ?? '') + '）' : '未生效')
        + (pref.group === null ? '' : ' · ' + pref.group.available + '/' + pref.group.total + ' 渠道可用'))
    }
    const groups = value.groups ?? []
    if (groups.length > 0) {
      lines.push('', '模型组（前 12）：')
      for (const group of groups.slice(0, 12).map(formatGroup)) {
        lines.push('  ' + group.utility + '  ' + group.model + '  智力 ' + (group.intel ?? '?')
          + '  渠道 ' + group.lanes + '  ' + (group.best ?? ''))
      }
    }
    return lines.join('\n')
  }
  if (value?.peer !== undefined) {
    const peer = value.peer
    const lines = ['渠道互借：' + (peer.enabled ? '已开启' : '已关闭') + ' · 角色 ' + peer.role + ' · 借用时机 ' + peer.borrowWhen]
    lines.push(peer.server === null
      ? '出借端点：未监听' + (peer.server?.error === undefined || peer.server?.error === '' ? '' : '（' + peer.server.error + '）')
      : '出借端点：' + peer.server.host + ':' + peer.server.port + '（可借 ' + peer.lendable.count + ' 条车道）')
    if (peer.lendable.providers.length > 0) lines.push('可借 provider：' + peer.lendable.providers.join('，'))
    lines.push(peer.borrow.peerUrl === ''
      ? '借用方：未配置对侧地址'
      : '借用方：' + peer.borrow.peerUrl + ' · ' + (peer.borrow.registered ? '已注册' : '未注册')
        + ' · ' + peer.borrow.models.length + ' 条对侧模型'
        + (peer.borrow.error === '' ? '' : '（' + peer.borrow.error + '）'))
    return lines.join('\n')
  }
  if (value?.decisions !== undefined) {
    const lines = ['最近切换记录：']
    for (const entry of value.decisions.slice(0, 10)) {
      lines.push('  ' + new Date(entry.at).toLocaleTimeString() + '  ' + (entry.from ?? '-') + ' → ' + (entry.to ?? '-') + '  ' + (entry.reason ?? ''))
    }
    return lines.join('\n')
  }
  // `status` carries a `catalog` summary as well as the route, so this branch has
  // to come after the route one — otherwise `/route status` answered with the
  // refresh line instead of the model.
  if (value?.catalog !== undefined) {
    return '清单已刷新：' + value.catalog.total + ' 个模型 / ' + value.catalog.providers + ' 条车道'
      + ' / ' + (value.catalog.channelData ? '渠道数据可用' : '渠道数据不可用')
  }

  // A settings patch is the only reply that carries `config` together with no
  // route data, so this branch goes last: `/route status` returns a config too,
  // and matching on it first printed the settings line instead of the model the
  // user asked about.
  if (value?.config !== undefined) {
    const config = value.config
    const preference = config.mode === 'prefer'
      ? ' 偏好=' + (config.preferModel || '—') + (config.preferProvider === '' ? '' : '@' + config.preferProvider)
        + ' 备用=' + config.preferFallback
      : ''
    return '调度设置已更新：mode=' + config.mode + ' strategy=' + config.strategy + preference
      + ' 单轮预算=' + (config.turnTokenBudget === 0 ? '关闭' : config.turnTokenBudget)
      + ' effort=' + (config.reasoningEffort || 'auto')
      + ' 首轮接管=' + (config.routeFirstTurn === false ? '关闭' : '开启')
      + ' 自动选择=' + (config.autoSelect === true ? '开启' : '关闭')
  }
  return JSON.stringify(value, null, 2)
}

export default registerAgentSurface
