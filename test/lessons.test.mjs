import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installLessons } from '../src/lessons.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lessons-test-'))
  const root = await fs.realpath(temp)
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const previous = process.env.DSH_LESSONS_DATA_DIR
  process.env.DSH_LESSONS_DATA_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_LESSONS_DATA_DIR
    else process.env.DSH_LESSONS_DATA_DIR = previous
  })

  const sections = []
  const tools = []
  const warnings = []
  const logger = { warn: (...args) => warnings.push(args) }
  const ctx = {
    logger,
    inject: (_names, callback) => {
      callback({
        logger,
        systemPrompt: { section: (section) => sections.push(section) },
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
      })
    },
  }

  installLessons(ctx)
  await settle()

  const byName = (name) => tools.find((tool) => tool.name === name)
  return { root, sections, tools, warnings, byName, file: path.join(root, 'lessons.json') }
}

test('空清单不产生注入内容', async (t) => {
  const f = await fixture(t)
  assert.equal(f.sections.length, 1)
  assert.equal(f.sections[0].text(), '')
  // 测试环境解析不到宿主提供的 @deepseek-ai/dsh-tools，只允许这条降级警告。
  assert.equal(f.warnings.filter((args) => !String(args[0]).includes('dsh-tools')).length, 0)
})

test('注册三个工具', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(f.tools.map((tool) => tool.name).sort(), ['list_lessons', 'record_lesson', 'retire_lesson'])
})

test('记录后注入文本包含条目并落盘', async (t) => {
  const f = await fixture(t)
  const result = await f.byName('record_lesson').execute({
    symptom: '把 asar 当目录 ls',
    fix: '先 stat 判断类型',
    cause: '没确认路径形态',
  })
  assert.equal(result.merged, false)
  assert.equal(result.total, 1)

  const parsed = JSON.parse(await fs.readFile(f.file, 'utf8'))
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].symptom, '把 asar 当目录 ls')

  const text = f.sections[0].text()
  assert.match(text, /历史教训/)
  assert.match(text, /把 asar 当目录 ls/)
  assert.match(text, /先 stat 判断类型/)
})

test('同一现象归一化后合并，不新增', async (t) => {
  const f = await fixture(t)
  const record = f.byName('record_lesson')
  await record.execute({ symptom: '把 asar 当目录 ls', fix: '先 stat' })
  const second = await record.execute({ symptom: '把  ASAR  当目录 LS', fix: '先 stat 判断类型' })
  assert.equal(second.merged, true)
  assert.equal(second.total, 1)
})

test('空 symptom 或 fix 被拒绝', async (t) => {
  const f = await fixture(t)
  const record = f.byName('record_lesson')
  await assert.rejects(() => record.execute({ symptom: '   ', fix: 'x' }), /symptom/)
  await assert.rejects(() => record.execute({ symptom: 'x', fix: '  ' }), /fix/)
})

test('失效条目不再注入，但 filter=all 仍可见', async (t) => {
  const f = await fixture(t)
  const record = f.byName('record_lesson')
  const list = f.byName('list_lessons')
  const retire = f.byName('retire_lesson')

  const first = await record.execute({ symptom: '甲', fix: '避免甲' })
  await record.execute({ symptom: '乙', fix: '避免乙' })

  const retired = await retire.execute({ id: first.id })
  assert.equal(retired.ok, true)
  assert.equal(retired.total, 1)
  assert.doesNotMatch(f.sections[0].text(), /甲/)

  assert.equal((await retire.execute({ id: first.id })).ok, false)
  assert.equal((await list.execute({})).total, 1)
  assert.equal((await list.execute({ filter: 'all' })).total, 2)
})

test('文件损坏时挪开并重建，不抛错', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.file, '{ 坏掉的 json', 'utf8')

  const fresh = { sections: [], tools: [], warnings: [] }
  const logger = { warn: (...args) => fresh.warnings.push(args) }
  installLessons({
    logger,
    inject: (_names, callback) => callback({
      logger,
      systemPrompt: { section: (section) => fresh.sections.push(section) },
      tools: { register: (definition) => { fresh.tools.push(definition); return () => {} } },
    }),
  })
  await settle()

  assert.equal(fresh.sections[0].text(), '')
  assert.ok(fresh.warnings.some((args) => String(args[0]).includes('读取失败')))
  const names = await fs.readdir(f.root)
  assert.ok(names.some((name) => name.startsWith('lessons.json.corrupt-')))
})

test('systemPrompt 缺失时不影响工具注册', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lessons-test-'))
  const root = await fs.realpath(temp)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const previous = process.env.DSH_LESSONS_DATA_DIR
  process.env.DSH_LESSONS_DATA_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_LESSONS_DATA_DIR
    else process.env.DSH_LESSONS_DATA_DIR = previous
  })

  const tools = []
  const logger = { warn: () => {} }
  installLessons({
    logger,
    inject: (names, callback) => {
      if (names.includes('systemPrompt')) return
      callback({ logger, tools: { register: (definition) => { tools.push(definition); return () => {} } } })
    },
  })
  await settle()
  assert.equal(tools.length, 3)
})

test('输出 schema 用顶层 required 数组，而不是属性上的 required', async (t) => {
  const f = await fixture(t)
  for (const tool of f.tools) {
    const schema = tool.output?.schema
    assert.ok(schema, tool.name + ' 缺少 output.schema')
    // 值 schema DSL 的 object 节点只接受 type / properties / additionalProperties。
    assert.equal(schema.required, undefined, tool.name + ' 的 output.schema 不能写 required')
    const params = tool.parameters
    assert.equal(params.type, 'object', tool.name + ' 的 parameters 必须是 object 根')
    assert.ok(params.properties, tool.name + ' 的 parameters 必须有 properties')
    for (const [key, spec] of Object.entries(schema.properties ?? {})) {
      assert.equal(spec.required, undefined, tool.name + '.' + key + ' 不应在属性上写 required')
    }
  }
})
