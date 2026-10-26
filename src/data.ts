// 科技数据加载：data/ 下的 JSON 是唯一事实源。
//
// 本模块同时是"数据集注册表"：人类科技树与《群星》科技树共用同一套渲染管线，
// 差别只在数据本身。下面这批导出全是 let，setActiveDataset() 会整体重新赋值；
// ESM 是活绑定，所以 layout / tour / edges / labels / scene / community 里
// import 这些名字的地方无需改动就跟着切到新数据。
import humanTechsRaw from '../data/techs.json'
import humanErasRaw from '../data/eras.json'
import humanCategoriesRaw from '../data/categories.json'
import stTechsRaw from '../data/stellaris/nomads-4.4/techs.json'
import stErasRaw from '../data/stellaris/nomads-4.4/eras.json'
import stCategoriesRaw from '../data/stellaris/nomads-4.4/categories.json'

// ───── 原始 JSON 结构（人类树是调研产物的 schema，群星树由
//       scripts/build_stellaris_dataset.mjs 按同一 schema 生成） ─────
interface RawTech {
  id: string
  name: string
  nameEn: string
  wikiEn?: string
  aliases?: string[]
  year: number
  year_basis: string | null
  year_note: string
  kind: string
  era: string
  category: string
  importance: number
  prereqs: string[]
  related: string[]
  desc: string
  // ── 以下为群星树专有（人类树没有），只用于悬停卡片 ──
  tier?: number
  cost?: number
  area?: string
  weight?: number
  unlocks?: string
  rare?: boolean
  dangerous?: boolean
  start?: boolean
}

interface RawEra {
  id: string
  name: string
  nameEn: string
  yearStart: number
  yearEnd: number
  order: number
}

interface RawCategory {
  id: string
  name: string
  nameEn: string
  color: string
  group: string            // 顶层域群 A 形式与符号 / B 认识自然 / C 改造世界 / D 人与社会
  subcategories: string[]
}

const GROUP_NAMES_ALL: Record<string, string> = {
  A: '形式与符号', B: '认识自然', C: '改造世界', D: '人与社会',
}

/** 渲染管线使用的节点结构（era/category 已转为索引，name 已做缺失回退） */
export interface TechNode {
  id: string
  name: string          // 中文名，缺失时回退英文（不向玩家暴露内部 id）
  nameEn: string
  wikiEn: string        // 英文维基条目标题：desc 派生文字的署名对象（见 LICENSE-data.md §2）
  aliases: string[]     // 常用别名，供搜索命中
  year: number
  yearBasis: string     // 年代依据（规范 §6），exact 表示"批次给了确切年份"而非已逐条核对
  yearNote: string
  kind: string          // §3 副轴：原理/工艺/器物/制度/媒介
  era: number           // 时代层索引
  category: number      // 领域索引
  importance: number
  prereqs: string[]
  related: string[]
  desc: string
  // 自定义颜色（#rrggbb）。缺省 = 跟随所属领域的颜色；由 edit.ts 的叠加层写入
  color?: string
  // 群星树专有：层级 / 花费 / 所属领域 / 权重 / 解锁文本 / 稀有度标记
  tier?: number
  cost?: number
  area?: string
  weight?: number
  unlocks?: string
  rare?: boolean
  dangerous?: boolean
  start?: boolean
}

export type DatasetId = 'human' | 'stellaris'

export interface DatasetEra { id: string; name: string; range: string }
export interface DatasetCategory { id: string; name: string; nameEn: string; hex: string; group: string }
export interface DatasetGroup { key: string; name: string }

/** 一套可被渲染管线直接消费的数据集 */
export interface Dataset {
  id: DatasetId
  label: string          // 切换控件上的名字
  title: string          // 页面主标题
  attribution: string    // 页脚来源说明（HTML）
  eraNoun: string        // "时代" / "层级"，用于统计行等文案
  showWiki: boolean      // 是否显示英文维基署名块（群星数据没有）
  kindOrder: string[]
  eras: DatasetEra[]
  categories: DatasetCategory[]
  groups: DatasetGroup[]
  techs: TechNode[]
  eraIds: string[]
  categoryIds: string[]
  eraIdToIndex: Map<string, number>
  categoryIdToIndex: Map<string, number>
  /** 悬停卡片里的"年代"文案：人类树是年份 + 精度，群星树是层级 */
  formatYear(n: TechNode): string
  /** 悬停卡片追加的专有行（人类树返回空串） */
  extraTooltip(n: TechNode): string
}

// ───── 年代依据标签（规范 §6：让"精确数值"与"真实精度"同时可见） ─────
const YEAR_BASIS_LABEL: Record<string, { mark: string; approx: boolean }> = {
  exact: { mark: '', approx: false },
  // 默认档，几乎每条都带 → 长标注不进取悬停卡，依据仍留在 techs.json 的 year_basis 字段里
  batch_asserted: { mark: '', approx: false },
  circa: { mark: '约数', approx: true },
  decade: { mark: '十年代取值', approx: true },
  century: { mark: '世纪中值', approx: true },
  range_midpoint: { mark: '文献区间中点', approx: true },
  scholarly_disputed: { mark: '学界有分歧，取主流值', approx: true },
  convention_floor: { mark: '仅知时代归属，取起点', approx: true },
}

function yearLabel(y: number): string {
  if (y < 0) {
    const abs = Math.abs(y)
    return abs >= 10000 ? `前 ${(abs / 10000).toFixed(abs % 10000 === 0 ? 0 : 1)} 万` : `前 ${abs}`
  }
  return `${y}`
}

/** 人类树的"年代"文案：年份 + 真实精度标注 */
function humanYearText(n: TechNode): string {
  const b = YEAR_BASIS_LABEL[n.yearBasis] ?? { mark: '', approx: false }
  const abs = Math.abs(n.year)
  const core = n.year >= 0
    ? `${n.year} 年`
    : abs >= 10000 ? `前 ${(abs / 10000).toFixed(abs % 10000 === 0 ? 0 : 1)} 万年` : `公元前 ${abs} 年`
  return `${b.approx ? '约' : ''}${core}${b.mark ? `（${b.mark}）` : ''}`
}

/** 群星树的"年代"位显示层级，不冒充年份 */
function stellarisYearText(n: TechNode): string {
  return `T${n.tier ?? '?'} 层级`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 群星树专有的悬停追加行：花费 / 权重 / 解锁 / 稀有度 */
function stellarisExtra(n: TechNode): string {
  const rows: string[] = []
  if (n.cost) rows.push(`研究花费 ${n.cost}`)
  if (n.weight) rows.push(`权重 ${n.weight}`)
  const flags = [n.start ? '初始科技' : '', n.rare ? '稀有' : '', n.dangerous ? '危险' : ''].filter(Boolean)
  if (flags.length) rows.push(flags.join(' · '))
  let html = rows.length ? `<div class="tt-dim">${esc(rows.join('　'))}</div>` : ''
  if (n.unlocks) {
    let list: string[] = []
    try {
      const parsed = JSON.parse(n.unlocks)
      list = Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : []
    } catch { /* 非 JSON 就整条当文本 */ }
    const text = (list.length ? list : [n.unlocks]).join('、')
    html += `<div class="tt-desc">解锁：${esc(text)}</div>`
  }
  return html
}

// ───── 通用装配：把 raw JSON 变成渲染管线要的形状 ─────
function buildDataset(cfg: {
  id: DatasetId
  label: string
  title: string
  attribution: string
  eraNoun: string
  showWiki: boolean
  kindOrder: string[]
  techsRaw: RawTech[]
  erasRaw: RawEra[]
  categoriesRaw: RawCategory[]
  groups: DatasetGroup[]
  eraRange?: (era: RawEra) => string
  formatYear: (n: TechNode) => string
  extraTooltip: (n: TechNode) => string
}): Dataset {
  const eras = [...cfg.erasRaw].sort((a, b) => a.order - b.order)
  const categories = cfg.categoriesRaw

  const eraIdToIndex = new Map(eras.map((e, i) => [e.id, i]))
  const categoryIdToIndex = new Map(categories.map((c, i) => [c.id, i]))

  const techs: TechNode[] = cfg.techsRaw.map(t => ({
    id: t.id,
    name: t.name || t.nameEn, // 中文缺失回退英文
    nameEn: t.nameEn,
    wikiEn: t.wikiEn ?? '',
    aliases: t.aliases ?? [],
    year: t.year,
    yearBasis: t.year_basis ?? 'exact',
    yearNote: t.year_note ?? '',
    kind: t.kind ?? '',
    era: eraIdToIndex.get(t.era) ?? 0,
    category: categoryIdToIndex.get(t.category) ?? 0,
    importance: t.importance,
    prereqs: t.prereqs ?? [],
    related: t.related ?? [],
    desc: t.desc,
    ...(t.tier !== undefined ? { tier: t.tier } : {}),
    ...(t.cost !== undefined ? { cost: t.cost } : {}),
    ...(t.area !== undefined ? { area: t.area } : {}),
    ...(t.weight !== undefined ? { weight: t.weight } : {}),
    ...(t.unlocks !== undefined ? { unlocks: t.unlocks } : {}),
    ...(t.rare !== undefined ? { rare: t.rare } : {}),
    ...(t.dangerous !== undefined ? { dangerous: t.dangerous } : {}),
    ...(t.start !== undefined ? { start: t.start } : {}),
  }))

  return {
    id: cfg.id,
    label: cfg.label,
    title: cfg.title,
    attribution: cfg.attribution,
    eraNoun: cfg.eraNoun,
    showWiki: cfg.showWiki,
    kindOrder: cfg.kindOrder,
    eras: eras.map(e => ({
      id: e.id,
      name: e.name,
      range: cfg.eraRange ? cfg.eraRange(e) : `${yearLabel(e.yearStart)} – ${e.yearEnd >= 2025 ? '今' : yearLabel(e.yearEnd)}`,
    })),
    categories: categories.map(c => ({ id: c.id, name: c.name, nameEn: c.nameEn, hex: c.color, group: c.group })),
    groups: cfg.groups,
    techs,
    eraIds: eras.map(e => e.id),
    categoryIds: categories.map(c => c.id),
    eraIdToIndex,
    categoryIdToIndex,
    formatYear: cfg.formatYear,
    extraTooltip: cfg.extraTooltip,
  }
}

// ───── 人类科技树 ─────
const HUMAN_DATASET = buildDataset({
  id: 'human',
  label: '人类科技树',
  title: '人类科技树',
  eraNoun: '时代',
  showWiki: true,
  kindOrder: ['原理', '工艺', '器物', '制度', '媒介'],
  groups: ['A', 'B', 'C', 'D'].map(k => ({ key: k, name: GROUP_NAMES_ALL[k] })),
  techsRaw: humanTechsRaw as RawTech[],
  erasRaw: humanErasRaw as RawEra[],
  categoriesRaw: humanCategoriesRaw as RawCategory[],
  formatYear: humanYearText,
  extraTooltip: () => '',
  attribution:
    `来源：<a href="https://github.com/secwind7/polytech-tree" target="_blank" rel="noopener">Polytech Tree</a>
     · 数据 <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>
     · 代码 <a href="https://github.com/secwind7/polytech-tree/blob/main/LICENSE" target="_blank" rel="noopener">MIT</a>
     · 部分中文摘要参考英文维基百科对应条目（见节点悬停卡），按
       <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a> 提供`,
})

// ───── 《群星》科技树（数据由 scripts/build_stellaris_dataset.mjs 生成） ─────
// 时代层 = 科技层级 T0–T5；领域 = 研究类别；副轴 kind = 研究领域（物理/社会/工程）
const STELLARIS_DATASET = buildDataset({
  id: 'stellaris',
  label: '群星科技树',
  title: '群星科技树',
  eraNoun: '层级',
  showWiki: false,
  kindOrder: ['原理', '制度', '器物'],
  groups: ['B', 'C', 'D'].map(k => ({ key: k, name: GROUP_NAMES_ALL[k] })),
  // 层级本身已经写在时代名里（T3 · 高级），再补一段"年代区间"只会重复
  eraRange: () => '',
  techsRaw: stTechsRaw as unknown as RawTech[],
  erasRaw: stErasRaw as unknown as RawEra[],
  categoriesRaw: stCategoriesRaw as unknown as RawCategory[],
  formatYear: stellarisYearText,
  extraTooltip: stellarisExtra,
  attribution:
    `数据来源：<a href="https://www.wensn.cn/stellaris/" target="_blank" rel="noopener">wensn.cn 群星科技树</a>（nomads-4.4）
     · 游戏内容版权归 <a href="https://www.paradoxinteractive.com/" target="_blank" rel="noopener">Paradox Interactive</a> 所有
     · 本站为非官方学习用途展示 · 渲染代码
       <a href="https://github.com/secwind7/polytech-tree/blob/main/LICENSE" target="_blank" rel="noopener">MIT</a>`,
})

export const DATASETS: Dataset[] = [HUMAN_DATASET, STELLARIS_DATASET]
export const DEFAULT_DATASET_ID: DatasetId = 'human'

let active: Dataset = HUMAN_DATASET

// ───── 对外的活绑定：setActiveDataset() 在这里整体换血 ─────
export let ACTIVE_DATASET: Dataset = active
export let TECHS: TechNode[] = active.techs
export let ERA_INFO: DatasetEra[] = active.eras
export let ERA_COUNT = active.eras.length
export let CATEGORY_NAMES = active.categories.map(c => c.name)
export let CATEGORY_HEX = active.categories.map(c => c.hex)
export let CATEGORY_GROUPS = active.categories.map(c => c.group)
export let CATEGORY_COUNT = active.categories.length
export let GROUPS: DatasetGroup[] = active.groups
export let GROUP_NAMES: Record<string, string> = Object.fromEntries(active.groups.map(g => [g.key, g.name]))
export let KIND_ORDER: string[] = active.kindOrder
// 反向：数字索引 → 字符串 id（社区层与 data/*.json 之间序列化时要还原成 id）
export let ERA_ID_TO_INDEX: Map<string, number> = active.eraIdToIndex
export let CATEGORY_ID_TO_INDEX: Map<string, number> = active.categoryIdToIndex
export let ERA_IDS: string[] = active.eraIds
export let CATEGORY_IDS: string[] = active.categoryIds

export function getDataset(id: DatasetId): Dataset {
  return DATASETS.find(d => d.id === id) ?? HUMAN_DATASET
}

/** 切换数据集：重新绑定上面那批 let 导出（调用方随后必须重建世界） */
export function setActiveDataset(id: DatasetId) {
  active = getDataset(id)
  ACTIVE_DATASET = active
  TECHS = active.techs
  ERA_INFO = active.eras
  ERA_COUNT = active.eras.length
  CATEGORY_NAMES = active.categories.map(c => c.name)
  CATEGORY_HEX = active.categories.map(c => c.hex)
  CATEGORY_GROUPS = active.categories.map(c => c.group)
  CATEGORY_COUNT = active.categories.length
  GROUPS = active.groups
  GROUP_NAMES = Object.fromEntries(active.groups.map(g => [g.key, g.name]))
  KIND_ORDER = active.kindOrder
  ERA_ID_TO_INDEX = active.eraIdToIndex
  CATEGORY_ID_TO_INDEX = active.categoryIdToIndex
  ERA_IDS = active.eraIds
  CATEGORY_IDS = active.categoryIds
}
