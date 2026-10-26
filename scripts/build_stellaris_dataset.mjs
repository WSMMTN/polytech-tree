// 从 wensn.cn 抓取《群星》科技树（Treant 树的原始 JSON），展平为引擎 schema 落盘。
//
// 数据源：https://www.wensn.cn/stellaris/<version>/{physics,society,engineering}.json
// 结构：root.children = 3 个领域节点，其下是科技节点（key / name / tier / category /
//       cost / prerequisites / prerequisites_names / description），子节点即下游科技，
//       同一 key 会在树里重复出现，故按 key 去重。
//
// 产出 data/stellaris/<version>/{techs,eras,categories}.json —— 与人类树的
// data/techs.json 同构，供 src/datasets/stellaris.ts 用同一套规则加载。
//
// 映射约定（见方案）：
//   era        ← tier（T0 塔底 → T5 塔顶）
//   category   ← category（中文类别名，作为 id）
//   kind       ← area（物理=原理 / 社会=制度 / 工程=器物）
//   importance ← 5 - min(4, tier)（T0 最基石 → 5 面，T4/T5 → 1 面）
//   year       ← 前置 DAG 的深度序（保证先因后果，漫游动画才有意义）
//
// 用法：node scripts/build_stellaris_dataset.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 'nomads-4.4'
const ROOT = 'https://www.wensn.cn/stellaris'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'stellaris', VERSION)

// 领域：kind 与 group 都由它派生（group 沿用人类树 A 形式与符号 / B 认识自然 /
// C 改造世界 / D 人与社会 的字母体系，群星只用得到 B/C/D）
const AREAS = {
  physics: { label: '物理学', kind: '原理', group: 'B' },
  society: { label: '社会学', kind: '制度', group: 'D' },
  engineering: { label: '工程学', kind: '器物', group: 'C' },
}

const TIER_NAMES = ['T0 · 起始', 'T1 · 初级', 'T2 · 中级', 'T3 · 高级', 'T4 · 尖端', 'T5 · 终极']

// 群星的研究类别（中文 ↔ 英文），英文仅供搜索与展示回退
const CATEGORY_EN = {
  材料科学: 'Materials',
  工业技术: 'Industry',
  计算技术: 'Computing',
  军事理论: 'Military Theory',
  力场操控: 'Field Manipulation',
  粒子物理: 'Particle Physics',
  灵能理论: 'Psionics',
  生物学: 'Biology',
  推进力学: 'Propulsion',
  新世界理论: 'New Worlds',
  宇航技术: 'Voidcraft',
  远古学: 'Archaeology',
  治国术: 'Statecraft',
}

// 类别配色：与人类树各自的调色板互不干扰，只要求同类内可区分
const CATEGORY_HEX = {
  粒子物理: '#4b7bff',
  力场操控: '#7d6cf0',
  计算技术: '#3fa9d8',
  推进力学: '#39c6b0',
  宇航技术: '#6f93d8',
  工业技术: '#d9743f',
  材料科学: '#a9865b',
  生物学: '#4fbf74',
  军事理论: '#d1545a',
  新世界理论: '#7bbf4a',
  灵能理论: '#b46fd8',
  远古学: '#c09a52',
  治国术: '#e5b24a',
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'polytech-tree-build/1.0' } })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return JSON.parse(await res.text())
}

/**
 * 前置字段有三种形态：空数组、字符串数组、以及 `{logic:'and'|'or', items:[…]}` 逻辑树
 * （items 可再嵌套逻辑树）。引擎的 prereq 是一个平铺的 id 列表，没有 and/or 语义，
 * 故这里把所有叶子 id 摊平：and 组本来就要全满足，or 组则显示为"这几项都能解锁它"，
 * 与树形视图的读法一致。
 */
function collectPrereqIds(p) {
  if (Array.isArray(p)) return p.flatMap(collectPrereqIds).filter(Boolean)
  if (p && typeof p === 'object' && Array.isArray(p.items)) {
    return p.items.flatMap(collectPrereqIds).filter(Boolean)
  }
  return typeof p === 'string' && p ? [p] : []
}

/** 递归展平：只收带 key 的节点，按 key 去重（同一科技会在下游子树里重复出现） */
function flatten(root) {
  const out = new Map()
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()
    if (n.key && !out.has(n.key)) out.set(n.key, n)
    for (const c of n.children ?? []) if (c) stack.push(c)
  }
  return out
}

const raw = new Map()
for (const area of Object.keys(AREAS)) {
  const json = await fetchJson(`${ROOT}/${VERSION}/${area}.json`)
  for (const [key, node] of flatten(json)) {
    if (!raw.has(key)) raw.set(key, node)
  }
  console.log(`  ${area}.json 抓取完成，累计唯一科技 ${raw.size} 项`)
}

// ───── 校验：前置必须全部命中（有悬空引用说明抓取层数不足，必须暴露而不是静默丢掉） ─────
const dangling = []
for (const [key, n] of raw) {
  for (const p of collectPrereqIds(n.prerequisites)) if (!raw.has(p)) dangling.push(`${key} → ${p}`)
}
if (dangling.length) throw new Error(`前置悬空 ${dangling.length} 处：${dangling.slice(0, 5).join('; ')}`)

// ───── 深度序：prereq 的深度严格小于后继，故按深度排序即合法的拓扑序 ─────
const depth = new Map()
const depthOf = key => {
  if (depth.has(key)) return depth.get(key)
  const n = raw.get(key)
  let d = 0
  for (const p of collectPrereqIds(n.prerequisites)) d = Math.max(d, depthOf(p) + 1)
  depth.set(key, d)
  return d
}
for (const key of raw.keys()) depthOf(key)

// ───── 类别的所属领域（群星的类别可能横跨领域，取出现最多的那个） ─────
const catAreaVotes = new Map()
for (const n of raw.values()) {
  const cat = n.category || '未分类'
  if (!catAreaVotes.has(cat)) catAreaVotes.set(cat, new Map())
  const votes = catAreaVotes.get(cat)
  votes.set(n.area, (votes.get(n.area) ?? 0) + 1)
}
const catArea = new Map()
for (const [cat, votes] of catAreaVotes) {
  catArea.set(cat, [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0])
}

/** tech_planetary_government → Planetary Government（只在缺英文名时兜底展示） */
function nameEnFromKey(key) {
  return key
    .replace(/^tech_/, '')
    .split('_')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

const techs = [...raw.values()]
  .sort((a, b) => depth.get(a.key) - depth.get(b.key) || a.tier - b.tier || a.key.localeCompare(b.key))
  .map((n, i) => ({
    id: n.key,
    name: n.name || nameEnFromKey(n.key),
    nameEn: nameEnFromKey(n.key),
    aliases: collectPrereqIds(n.prerequisites_names),
    year: i,                                  // 深度序：只作层内呈现顺序，不是真实年份
    year_basis: 'order',
    year_note: `${TIER_NAMES[n.tier] ?? 'T?'} 层级`,
    kind: AREAS[n.area]?.kind ?? '',
    era: `t${n.tier}`,
    category: n.category || '未分类',
    importance: 5 - Math.min(4, n.tier),
    prereqs: [...new Set(collectPrereqIds(n.prerequisites))].filter(p => raw.has(p)),
    related: [],
    desc: n.description ?? '',
    // ── 星图专有字段：只用于悬停卡片，不参与布局 ──
    tier: n.tier,
    cost: n.cost ?? 0,
    area: AREAS[n.area]?.label ?? n.area,
    weight: n.base_weight ?? 0,
    unlocks: typeof n.feature_unlocks === 'string' ? n.feature_unlocks : n.feature_unlocks ? JSON.stringify(n.feature_unlocks) : '',
    rare: !!n.is_rare,
    dangerous: !!n.is_dangerous,
    start: !!n.is_start_tech,
  }))

const eras = TIER_NAMES.map((name, i) => ({
  id: `t${i}`,
  name,
  nameEn: `Tier ${i}`,
  yearStart: i,
  yearEnd: i,
  order: i,
}))

const categories = [...catArea.keys()].sort().map(cat => ({
  id: cat,
  name: cat,
  nameEn: CATEGORY_EN[cat] ?? cat,
  color: CATEGORY_HEX[cat] ?? '#8a8f98',
  group: AREAS[catArea.get(cat)]?.group ?? 'C',
  subcategories: [],
}))

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'techs.json'), JSON.stringify(techs), 'utf8')
writeFileSync(join(OUT_DIR, 'eras.json'), JSON.stringify(eras), 'utf8')
writeFileSync(join(OUT_DIR, 'categories.json'), JSON.stringify(categories), 'utf8')

// ───── 产出摘要：数量、层级分布、前置完整性 ─────
const byEra = eras.map(e => `${e.name}=${techs.filter(t => t.era === e.id).length}`).join(' ')
const byKind = [...new Set(techs.map(t => t.kind))].filter(Boolean)
  .map(k => `${k}=${techs.filter(t => t.kind === k).length}`).join(' ')
console.log(`\n产出 → ${OUT_DIR}`)
console.log(`  科技 ${techs.length} 项 · 时代 ${eras.length} 层 · 类别 ${categories.length} 个`)
console.log(`  层级分布：${byEra}`)
console.log(`  副轴 kind：${byKind}`)
console.log(`  有前置：${techs.filter(t => t.prereqs.length).length} 项 · 悬空 ${dangling.length} 处`)
