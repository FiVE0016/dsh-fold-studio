/**
 * Lessons — 跨会话记录"自己犯过的错"，并在系统提示里回放。
 *
 * 宿主端模块，不进入客户端构建（scripts/build.mjs 的 LOCAL_MODULES 只收
 * 客户端模块）。由 index.js 在 apply() 里调用 installLessons(ctx)。
 *
 * 设计约束：
 * - 本模块整体由调用方 try/catch 包裹；它自己抛错不能影响 fold 的界面功能。
 * - 两个可选服务 systemPrompt / tools 各自独立注入，缺一个不影响另一个。
 * - 数据文件是唯一事实源，读写失败只降级，不让插件挂掉。
 *
 * 数据文件：$DSH_HOME/dsh-lessons/lessons.json（沿用合并前的路径，避免迁移丢数据）
 * 目录覆盖：DSH_LESSONS_DATA_DIR
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** 注入段标识与顺序。越小越靠前，-200 是 dsh-session-prompt 占的位置。 */
const SECTION_NAME = 'dsh-lessons:head'
const SECTION_ORDER = -150

/** 单次注入的字符预算与条数上限，防止清单变长后撑爆上下文。 */
const MAX_CHARS = 4000
const MAX_ENTRIES = 40
/** 文件里最多保留多少条（含已失效的），超出按时间淘汰最旧的。 */
const MAX_STORED = 400

const KIND_USER = 'user-correction'
const KIND_SELF = 'self-admitted'

function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

function dataDir() {
  const override = process.env.DSH_LESSONS_DATA_DIR?.trim()
  return override ? override : join(dshHome(), 'dsh-lessons')
}

function dataFile() {
  return join(dataDir(), 'lessons.json')
}

function emptyState() {
  return { version: 1, entries: [] }
}

function isEntry(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.id === 'string'
    && typeof value.symptom === 'string'
    && typeof value.fix === 'string'
}

/** 读状态。文件坏了不能让插件挂掉：挪开留证，重新开始，并向日志告警。 */
function readState(logger) {
  const path = dataFile()
  if (!existsSync(path)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return emptyState()
    return { version: 1, entries: parsed.entries.filter(isEntry) }
  } catch (error) {
    try { renameSync(path, path + '.corrupt-' + Date.now()) } catch {}
    logger?.warn?.('fold-studio/lessons: lessons.json 读取失败，已挪开并新建', error)
    return emptyState()
  }
}

/** 原子写：先写临时文件再 rename，避免并发读看到半截 JSON。 */
function writeStateAtomic(state) {
  const path = dataFile()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

function newId() {
  return 'l_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
}

/** 启动诊断：只追加，不轮转。用于定位"注入成功但工具没注册"这类只在宿主里出现的差异。 */
export function writeTrace(line) {
  try {
    const path = join(dataDir(), 'startup.log')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, new Date().toISOString() + ' ' + line + '\n', { encoding: 'utf8', flag: 'a' })
  } catch {}
}

/** 合并用的归一化键：去空白、小写，避免同一现象写成两条。 */
function normKey(symptom) {
  return symptom.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)
}

function projectLabel(project) {
  if (!project || project === 'global') return '全局'
  return basename(project) || project
}

function kindLabel(kind) {
  return kind === KIND_SELF ? '自我承认' : '用户纠正'
}

function liveEntries(entries) {
  return entries
    .filter((entry) => !entry.retiredAt)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/** 把清单渲染成注入文本；没有可用条目时返回空串，避免往提示里塞空标题。 */
export function renderSection(entries) {
  const live = liveEntries(entries).slice(0, MAX_ENTRIES)
  if (live.length === 0) return ''

  const head = [
    '## 历史教训（dsh-lessons）',
    '',
    '以下是你在过往会话中犯过的错误，来自用户的明确纠正或你自己的承认。',
    '在给出结论、修改文件或声称"完成"之前，先对照本清单自查；命中任何一条，先纠正做法再继续。',
    '',
  ]
  const blocks = head.slice(0, 4)
  let budget = MAX_CHARS - head.join('\n').length
  let shown = 0

  for (const entry of live) {
    const block = [
      '### ' + (shown + 1) + '. [' + kindLabel(entry.kind) + ' · ' + projectLabel(entry.project) + '] ' + entry.symptom,
      entry.cause ? '- 原因：' + entry.cause : '',
      '- 做法：' + entry.fix,
      '',
    ].filter(Boolean).join('\n')
    if (block.length + 1 > budget) break
    blocks.push(block)
    budget -= block.length + 1
    shown += 1
  }

  if (shown === 0) return ''
  if (shown < live.length) {
    blocks.push('（另有 ' + (live.length - shown) + ' 条未展开，可用 list_lessons 查看）')
  }
  return blocks.filter(Boolean).join('\n')
}

export function formatEntry(entry) {
  const state = entry.retiredAt ? '已失效' : '生效'
  return '- ' + entry.id + ' [' + kindLabel(entry.kind) + ' · ' + state + ' · ' + projectLabel(entry.project) + '] ' + entry.symptom
    + '\n  做法：' + entry.fix
}

/**
 * 取得 defineTool。官方工具包由宿主在运行时提供，普通 Node 解析不到，
 * 所以按运行时动态取；取不到就退化成原样注册，让注入功能继续可用。
 */
/**
 * 工具定义直接写成宿主期望的最终形态：`parameters` 与 `output.schema` 都是标准
 * JSON Schema。不使用 `@deepseek-ai/dsh-tools` 的 `defineTool`——该包由宿主在运行时
 * 提供，动态 import 在本机时灵时不灵；兜底成 identity 时，作者 DSL 会被原样注册，
 * 模型侧参数就退化成 unknown（2026-11-24 实测：factory=anonymous / probe=schema-missing）。
 */

/**
 * 安装教训记忆：一个系统提示段 + 三个工具。
 * @param {object} ctx - fold-studio 的插件上下文。
 */
export function installLessons(ctx) {
  let state = readState(ctx?.logger)
  let rendered = ''

  const refresh = () => {
    rendered = renderSection(state.entries)
  }
  refresh()

  const countLive = () => state.entries.filter((entry) => !entry.retiredAt).length

  const save = (next) => {
    if (next.entries.length > MAX_STORED) {
      next = {
        ...next,
        entries: next.entries
          .slice()
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .slice(0, MAX_STORED),
      }
    }
    writeStateAtomic(next)
    state = next
    refresh()
  }

  const record = (fields) => {
    const key = normKey(fields.symptom)
    const existing = state.entries.find((entry) => normKey(entry.symptom) === key)
    const now = Date.now()

    if (existing) {
      const merged = {
        ...existing,
        cause: fields.cause ? String(fields.cause).trim() : existing.cause,
        fix: String(fields.fix).trim(),
        kind: fields.kind === KIND_SELF ? KIND_SELF : (existing.kind ?? KIND_USER),
        project: fields.project ? String(fields.project).trim() : existing.project,
        updatedAt: now,
        retiredAt: null,
      }
      const next = { ...state, entries: state.entries.map((entry) => (entry.id === existing.id ? merged : entry)) }
      save(next)
      return { id: existing.id, total: countLive(), merged: true }
    }

    const entry = {
      id: newId(),
      symptom: String(fields.symptom).trim(),
      cause: fields.cause ? String(fields.cause).trim() : '',
      fix: String(fields.fix).trim(),
      kind: fields.kind === KIND_SELF ? KIND_SELF : KIND_USER,
      project: fields.project ? String(fields.project).trim() : 'global',
      createdAt: now,
      retiredAt: null,
    }
    const next = { ...state, entries: [...state.entries, entry] }
    save(next)
    return { id: entry.id, total: countLive(), merged: false }
  }

  const listBy = (filter, limit) => {
    const rows = state.entries
      .filter((entry) => (filter === 'all' ? true : filter === 'retired' ? Boolean(entry.retiredAt) : !entry.retiredAt))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, limit)
    return {
      total: rows.length,
      text: rows.length === 0 ? '（没有符合条件的条目）' : rows.map(formatEntry).join('\n'),
    }
  }

  const retire = (id) => {
    const hit = state.entries.find((entry) => entry.id === id)
    if (!hit || hit.retiredAt) return { ok: false, total: countLive() }
    const next = {
      ...state,
      entries: state.entries.map((entry) => (entry.id === id ? { ...entry, retiredAt: Date.now() } : entry)),
    }
    save(next)
    return { ok: true, total: countLive() }
  }

  let sectionAdded = false
  const addSection = (promptService) => {
    if (!promptService || sectionAdded) return
    sectionAdded = true
    promptService.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => rendered,
    })
    writeTrace('section registered, text=' + rendered.length)
  }

  let readyPrompt
  try {
    readyPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  } catch {}
  if (readyPrompt) addSection(readyPrompt)
  ctx.inject(['systemPrompt'], (scope) => addSection(scope.systemPrompt))

  let toolsInstalled = false

  /**
   * 安装三个工具。两条触发路径共用这个函数：
   * 服务已就绪时同步安装，未就绪时由 ctx.inject 事后补上，用标志去重。
   */
  const installTools = (toolsService, logger) => {
    if (toolsInstalled || !toolsService) return
    toolsInstalled = true
    try {
      toolsService.register({
        name: 'record_lesson',
        description: '记录一条"自己犯过的错"，供未来会话规避。'
          + '当用户明确指出你的错误，或你自己发现刚才的判断/操作是错的，就调用它。'
          + '同一现象重复记录会合并到已有条目，而不是新增一条。',
        parameters: {
          type: 'object',
          properties: {
            symptom: { type: 'string', description: '错误的可辨识现象，一句话。写成"做了什么/说了什么"，不要写情绪评价。' },
            fix: { type: 'string', description: '正确做法，一句话，下次遇到同类情形可直接照做。' },
            cause: { type: 'string', description: '为什么会犯这个错：漏了哪一步检查、误用了哪个前提。' },
            kind: { type: 'string', description: '来源：user-correction 表示用户指出的纠正，self-admitted 表示你自己承认的失误。默认 user-correction。' },
            project: { type: 'string', description: '适用的工作区绝对路径；跨项目通用时省略。' },
          },
          required: ['symptom', 'fix'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              total: { type: 'number' },
              merged: { type: 'boolean' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.merged
              ? '已合并到已有条目 ' + value.id + '（现有 ' + value.total + ' 条）'
              : '已记录 ' + value.id + '（现有 ' + value.total + ' 条）',
          }],
        },
        async execute(args) {
          const symptom = String(args?.symptom ?? '').trim()
          const fix = String(args?.fix ?? '').trim()
          if (!symptom) throw new Error('symptom 不能为空')
          if (!fix) throw new Error('fix 不能为空')
          return record({ symptom, fix, cause: args?.cause, kind: args?.kind, project: args?.project })
        },
      })

      toolsService.register({
        name: 'list_lessons',
        description: '列出已记录的历史教训。开始一个任务前复习，或怀疑清单被污染时检查。',
        parameters: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: '取值 live（未失效）、retired（已失效）或 all。默认 live。' },
            limit: { type: 'number', description: '最多返回条数，默认 30。' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'number' },
              text: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args) {
          const filter = args?.filter === 'retired' || args?.filter === 'all' ? args.filter : 'live'
          const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 30
          return listBy(filter, limit)
        },
      })

      toolsService.register({
        name: 'retire_lesson',
        description: '把一条教训标记为失效（保留记录，不再注入）。当某条教训已不再适用，或它本身是误记时使用。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'list_lessons 返回的条目 id。' },
          },
          required: ['id'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              total: { type: 'number' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok ? '已标记失效，剩余生效条目 ' + value.total + ' 条' : '没有找到该 id，或它已经失效',
          }],
        },
        async execute(args) {
          return retire(String(args?.id ?? '').trim())
        },
      })
      const probe = toolsService.get?.('record_lesson')
      writeTrace(
        'tools registered: record_lesson, list_lessons, retire_lesson'
        + '; probe=' + (probe?.parameters?.properties ? 'schema-ok' : 'schema-missing'),
      )
    } catch (error) {
      toolsInstalled = false
      ctx.logger?.warn?.('fold-studio/lessons: 工具注册失败，注入功能不受影响', error)
      writeTrace('tools register failed: ' + String(error?.message ?? error))
    }
  }

  const visible = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  const readyTools = visible('tools')
  writeTrace(
    'apply: tools=' + (readyTools ? 'visible' : 'absent')
    + ' systemPrompt=' + (visible('systemPrompt') ? 'visible' : 'absent'),
  )
  if (readyTools) installTools(readyTools, ctx.logger)
  ctx.inject(['tools'], (scope) => installTools(scope.tools, scope.logger ?? ctx.logger))
}
