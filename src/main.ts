import './style.css'
import * as THREE from 'three'
import { TECHS, ERA_INFO, ERA_COUNT, CATEGORY_NAMES, CATEGORY_COUNT, CATEGORY_HEX, CATEGORY_GROUPS, GROUP_NAMES, YEAR_BASIS_LABEL } from './data'
import type { TechNode } from './data'
import { layoutTower, type PlacedNode } from './layout'
import { createScene } from './scene'
import { PolyhedraField, facesOf } from './polyhedra'
import { buildEdges, buildEraRings } from './edges'
import { buildNameLabels, buildEraLabels, updateLabelFocal, setLabelMinPxAll } from './labels'
import { CameraRig } from './controls'
import { TourPlan, BLEND } from './tour'
import { buildGraph, kHopDepth, type DepGraph } from './graph'
import { loadEdits, saveEdits, clearEdits, emptyEdits, applyEdits, hasEdits, newTechId, type UserEdits } from './edit'
import { COMMUNITY_ENABLED } from './community/config'

// 点击聚焦沿"画面上真实存在的弧线"走 1 跳：只留直接相连的上下游，配合相机取景把这一组放到画面里
const FOCUS_HOPS = 1

// ───── 世界状态：数据（基础 + 用户增删）→ 布局 → 场景内容。增删后由 rebuildWorld() 整体重建 ─────
let edits: UserEdits = loadEdits()
// 社区层（Supabase）。未配置后端时 COMMUNITY_ENABLED=false，相关调用全部短路，
// 行为与纯本地版本完全一致
let communityEdits: UserEdits = emptyEdits()
let communityIds: Set<string> = new Set()
// 社区贡献的节点 id（新增 / 被改过的条目），"一键隐藏社区层"隐藏的就是这一批
let communityNodeIds: Set<string> = new Set()
let hiddenCommunity = false
// 社区上报入口。未配置后端时恒为 null，所有 push* 调用都是空操作
let communityApi: typeof import('./community/client') | null = null
let techs!: TechNode[]
let placed!: PlacedNode[]
let graph!: DepGraph
let placedByIdx!: Map<string, number>
let techById!: Map<string, TechNode>
let eraRadii!: number[]
let eraY!: number[]
let towerHeight = 0
let plan!: TourPlan
let field!: PolyhedraField
let edges!: ReturnType<typeof buildEdges>
let rings: THREE.Object3D[] = []
let nameLabels!: ReturnType<typeof buildNameLabels>
let eraLabels!: ReturnType<typeof buildEraLabels>

// 每帧复用的缓冲与掩码：尺寸随节点数变化，故在 buildWorld 里按当前规模重分配
let nodeVis!: Uint8Array
let edgeActive!: Uint8Array
let focusBuf!: Int8Array
let nameIdx!: Int32Array
let nameAlpha!: Float32Array
let focusDepth: Int8Array | null = null
let selected: number | null = null
let hoverIdx: number | null = null

const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches
if (IS_TOUCH) {
  document.getElementById('hint')!.textContent =
    '单指旋转 · 双指缩放与平移 · 点按节点查看详情 · 漫游中点按画面退出'
}

// ───── 场景（只建一次；里面的世界内容由 buildWorld 负责换血） ─────
const { scene, camera, renderer } = createScene(0)

/** 释放上一套世界内容。注意多面体几何是模块级共享的，不能跟着一起销毁 */
function disposeObjects(objs: THREE.Object3D[], disposeGeometry = true) {
  for (const o of objs) {
    o.parent?.remove(o)
    o.traverse(c => {
      const m = c as THREE.Mesh
      if (disposeGeometry && m.geometry) m.geometry.dispose()
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []
      for (const mat of mats) {
        // 名称/时代名的贴图是每套世界现画的 canvas 纹理，必须一并释放
        const rec = mat as unknown as Record<string, { dispose?: () => void } | undefined>
        for (const key of ['map', 'alphaMap', 'normalMap']) rec[key]?.dispose?.()
        mat.dispose()
      }
    })
  }
}

/**
 * 本地叠加层 + 社区叠加层的合并规则：
 * - added 按 id 去重（社区优先，免得同一次新增被本地与远端各算一份）
 * - deleted / colors 取并集
 * 社区层为空时直接返回本地层，纯本地路径不额外付出任何代价
 */
function combineOverlay(local: UserEdits, remote: UserEdits): UserEdits {
  if (!hasEdits(remote)) return local
  if (!hasEdits(local)) return remote
  const remoteIds = new Set(remote.added.map(n => n.id))
  return {
    added: [...local.added.filter(n => !remoteIds.has(n.id)), ...remote.added],
    deleted: [...new Set([...local.deleted, ...remote.deleted])],
    colors: { ...local.colors, ...remote.colors },
  }
}

/**
 * 按当前 techs 重建全部世界内容：布局、依赖图、多面体、环、名称、时代名、连线、漫游排期。
 * 新增/删除节点后调用，是"数据变了画面就跟着变"的唯一入口。
 */
function buildWorld() {
  disposeObjects(field ? field.meshes : [], false)
  disposeObjects(rings)
  disposeObjects(nameLabels ? nameLabels.meshes : [])
  disposeObjects(eraLabels ? eraLabels.meshes : [])
  if (edges) disposeObjects([edges.lines])

  techs = applyEdits(TECHS, combineOverlay(edits, communityEdits))
  const layout = layoutTower(techs)
  placed = layout.placed
  eraRadii = layout.eraRadii
  eraY = layout.eraY
  towerHeight = layout.towerHeight
  graph = buildGraph(placed.map(p => p.node.id), placed.map(p => p.node.prereqs))
  placedByIdx = new Map(placed.map((p, i) => [p.node.id, i]))
  techById = new Map(placed.map(p => [p.node.id, p.node]))

  nodeVis = new Uint8Array(placed.length).fill(1)
  edgeActive = new Uint8Array(placed.length).fill(1)
  focusBuf = new Int8Array(placed.length)
  nameIdx = new Int32Array(placed.length)
  nameAlpha = new Float32Array(placed.length)

  field = new PolyhedraField(placed, CATEGORY_HEX.map(h => new THREE.Color(h)))
  field.meshes.forEach(m => scene.add(m))

  const built = buildEraRings(eraRadii, eraY)
  rings = built.rings
  rings.forEach(r => scene.add(r))

  nameLabels = buildNameLabels(placed)
  nameLabels.meshes.forEach(m => scene.add(m))

  eraLabels = buildEraLabels(eraRadii, eraY)
  eraLabels.meshes.forEach(m => scene.add(m))

  plan = new TourPlan(placed, eraRadii, eraY)

  // 连线要在漫游中按显现时刻生长，故依赖 plan 的 revealAt
  edges = buildEdges(placed, plan.revealAt)
  scene.add(edges.lines)
}

buildWorld()
const rig = new CameraRig(camera, renderer.domElement, eraRadii, towerHeight, plan)

// ───── UI：图例（领域可隐藏）+ 名称显示上限 ─────
const legend = document.getElementById('legend')!
let labelLimit = 100 // 名称显示上限；图例里的滑杆会改它
const IMPLbl = ['基石', '领域支柱', '领域内重要', '改良与细分', '长尾补充']
const KINDS = ['原理', '工艺', '器物', '制度', '媒介'] as const

/** 图例整块重建：领域与重要度的计数随增删变化，不能只写死一次 */
function buildLegend() {
  const catCount = CATEGORY_NAMES.map((_, i) => placed.filter(p => p.node.category === i).length)
  legend.innerHTML = `
  <div class="lg-head"><div class="lg-title">领域图例</div>
    <button class="lg-toggle" id="legendToggle" title="折叠/展开图例">${legend.classList.contains('collapsed') ? '▸' : '▾'}</button></div>
  <div class="lg-body">
  ${['A', 'B', 'C', 'D'].map(g => `
    <button class="lg-group" data-group="${g}" title="整组开关：组内有隐藏时全显，否则全隐">${GROUP_NAMES[g]}<i>▾</i></button>
    ${CATEGORY_NAMES.map((name, i) => CATEGORY_GROUPS[i] === g ? `
      <button class="lg-item lg-cat" data-cat="${i}" title="点击隐藏该领域（含其连线），再点恢复">
        <span class="lg-dot" style="background:${CATEGORY_HEX[i]};color:${CATEGORY_HEX[i]}"></span><span>${name}</span><b>${catCount[i]}</b>
      </button>` : '').join('')}`).join('')}
  <div class="lg-hint">点领域名隐藏该领域（含连线）· 点组名整组开关</div>
  <button class="lg-reset" id="catReset">全部显示</button>
  <div class="lg-sep"></div>
  <div class="lg-title">形状 = 重要度（面数）</div>
  ${[1, 2, 3, 4, 5].map(l => `
    <button class="lg-item lg-imp" data-level="${l}" title="点击只看该档（独显），再点恢复全部">
      <span>${facesOf(l)} 面 ${IMPLbl[l - 1]}</span><b>${placed.filter(p => p.node.importance === l).length}</b>
    </button>`).join('')}
  <div class="lg-hint">点一档 = 只看这一档；再点恢复</div>
  <div class="lg-sep"></div>
  <div class="lg-title">名称显示上限</div>
  <div class="lg-limit">
    <input type="range" id="labelLimitRange" min="0" max="${techs.length}" step="1" value="${labelLimit}">
    <span id="labelLimitValue">${labelLimit}</span>
  </div>
  <div class="lg-hint">按到相机距离显示最近的名称</div>
  <div class="lg-sep"></div>
  <div class="lg-title">副轴 kind（规范 §3：筛选与文案）</div>
  <div class="lg-kinds" id="kindFilter">
  ${KINDS.map(k => `<button class="lg-kind" data-kind="${k}">${k}<b>${placed.filter(p => p.node.kind === k).length}</b></button>`).join('')}
  </div>
  <div class="lg-hint">点选即筛选：隐去节点、连线与名称，不动位置</div>
  </div>
`
}
buildLegend()
// 小屏默认折叠图例：手机上展开态会盖住半个画面
if (window.matchMedia('(max-width: 720px)').matches) {
  legend.classList.add('collapsed')
  buildLegend()
}

// ───── 可见性状态：领域掩码 ∧ kind 掩码 ∧ 重要度独显 + 点击聚焦，三处渲染共用一次下发 ─────
const hiddenCats = new Set<number>()
const activeKinds = new Set<string>()
let soloImp: number | null = null // 独显某档重要度（null = 不限档）
const isVisible = (i: number) => nodeVis[i] > 0

// 域群 → 该组下的领域索引。键必须是 categories.json 的组字母（A/B/C/D），
// 图例的 data-group 用的就是这个字母
const CATS_BY_GROUP: Record<string, number[]> = Object.fromEntries(
  ['A', 'B', 'C', 'D'].map(g =>
    [g, CATEGORY_NAMES.map((_, i) => i).filter(i => CATEGORY_GROUPS[i] === g)]))

function syncPanelState() {
  legend.querySelectorAll('.lg-cat').forEach(el =>
    el.classList.toggle('off', hiddenCats.has(Number((el as HTMLElement).dataset.cat))))
  // 组头三态：全隐 / 部分隐 / 全显，免得整组灰着却看不出组里还剩几个领域
  legend.querySelectorAll('.lg-group').forEach(el => {
    const cats = CATS_BY_GROUP[(el as HTMLElement).dataset.group!] ?? []
    const hidden = cats.filter(c => hiddenCats.has(c)).length
    el.classList.toggle('off', hidden === cats.length)
    el.classList.toggle('part', hidden > 0 && hidden < cats.length)
  })
  document.getElementById('catReset')!.classList.toggle('idle', hiddenCats.size === 0 && soloImp === null)
  legend.querySelectorAll('.lg-imp').forEach(el =>
    el.classList.toggle('on', Number((el as HTMLElement).dataset.level) === soloImp))
  legend.querySelectorAll('.lg-kind').forEach(el =>
    el.classList.toggle('on', activeKinds.has((el as HTMLElement).dataset.kind!)))
}

// ───── URL hash 状态：#n=<id>&hide=<领域>&imp=<档>&k=<kind>，当前视图可直接分享 ─────
function syncHash() {
  const p = new URLSearchParams()
  if (selected !== null) p.set('n', placed[selected].node.id)
  if (hiddenCats.size) p.set('hide', [...hiddenCats].sort((a, b) => a - b).join(','))
  if (soloImp !== null) p.set('imp', String(soloImp))
  if (activeKinds.size) p.set('k', [...activeKinds].join(','))
  const s = p.toString()
  history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search)
}

/** 从 URL hash 恢复筛选与聚焦，返回 hash 指定的节点索引（无则 null） */
function restoreFromHash(): number | null {
  const h = new URLSearchParams(location.hash.slice(1))
  h.get('hide')?.split(',').forEach(s => {
    const n = Number(s)
    if (Number.isInteger(n) && n >= 0 && n < CATEGORY_COUNT) hiddenCats.add(n)
  })
  const imp = Number(h.get('imp'))
  if (imp >= 1 && imp <= 5) soloImp = imp
  h.get('k')?.split(',').forEach(k => {
    if ((KINDS as readonly string[]).includes(k)) activeKinds.add(k)
  })
  const nid = h.get('n')
  return nid ? placedByIdx.get(nid) ?? null : null
}

function applyVisualState() {
  const kindsOn = activeKinds.size > 0
  for (let i = 0; i < placed.length; i++) {
    const n = placed[i].node
    nodeVis[i] = !hiddenCats.has(n.category) &&
      (!kindsOn || activeKinds.has(n.kind)) &&
      (soloImp === null || n.importance === soloImp) &&
      !(hiddenCommunity && communityNodeIds.has(n.id)) ? 1 : 0
  }
  // 选中项所属领域被隐藏时聚焦自动失效
  if (selected !== null && !nodeVis[selected]) { selected = null; focusDepth = null }
  for (let i = 0; i < placed.length; i++)
    edgeActive[i] = nodeVis[i] && (!focusDepth || focusDepth[i] >= 0) ? 1 : 0
  syncPanelState()
  field.setVisible(isVisible, focusDepth)
  nameLabels.setFilter(isVisible)
  nameLabels.setFocus(focusDepth)
  edges.setActive(edgeActive)
  edges.setEmphasis(focusDepth !== null) // 聚焦时子图的线提亮
  syncHash()
}

legend.addEventListener('click', e => {
  const t = e.target as HTMLElement
  if (t.closest('#legendToggle')) {
    const collapsed = legend.classList.toggle('collapsed')
    ;(legend.querySelector('#legendToggle') as HTMLElement).textContent = collapsed ? '▸' : '▾'
    return
  }
  const kindEl = t.closest('.lg-kind') as HTMLElement | null
  if (kindEl) {
    const k = kindEl.dataset.kind!
    activeKinds.has(k) ? activeKinds.delete(k) : activeKinds.add(k)
    applyVisualState()
    return
  }
  const el = t.closest?.('.lg-cat, .lg-group, .lg-imp, .lg-reset') as HTMLElement | null
  if (!el) return
  if (el.classList.contains('lg-reset')) { hiddenCats.clear(); soloImp = null }
  else if (el.classList.contains('lg-imp')) {
    const l = Number(el.dataset.level)
    soloImp = soloImp === l ? null : l // 独显：再点同一档即恢复
  } else if (el.classList.contains('lg-group')) {
    const cats = CATS_BY_GROUP[el.dataset.group!] ?? []
    const anyHidden = cats.some(c => hiddenCats.has(c))
    for (const c of cats) anyHidden ? hiddenCats.delete(c) : hiddenCats.add(c)
  } else {
    const c = Number(el.dataset.cat)
    hiddenCats.has(c) ? hiddenCats.delete(c) : hiddenCats.add(c)
  }
  applyVisualState()
})

// 名称上限滑杆在每次重建图例时是新元素，故用委托监听
legend.addEventListener('input', e => {
  const t = e.target as HTMLInputElement
  if (t.id !== 'labelLimitRange') return
  labelLimit = Number(t.value)
  const out = legend.querySelector('#labelLimitValue')
  if (out) out.textContent = String(labelLimit)
})

// ───── UI：字幕 ─────
const caption = document.getElementById('eraCaption')!
let captionTimer = 0
rig.onEraChange = era => {
  const info = ERA_INFO[era]
  const win = plan.windows[era]
  caption.innerHTML = `${info.name}<span class="sub">${info.range} · ${win.count} 项</span>`
  caption.classList.add('show')
  clearTimeout(captionTimer)
  // 只停留到本时代窗口过半，把画面让给正在显现的科技名
  captionTimer = window.setTimeout(() => caption.classList.remove('show'), win.dur * 450)
}

// ───── UI：工具栏 ─────
const btnTour = document.getElementById('btnTour') as HTMLButtonElement
const btnReset = document.getElementById('btnReset') as HTMLButtonElement
const btnCommunity = document.getElementById('btnCommunity') as HTMLButtonElement

// ───── 社区层开关：一键隐藏 / 显示社区贡献的节点（连带其连线与名称） ─────
/** 没有社区节点时整颗按钮不出现，纯本地版本不会多出一个永远点不动的按钮 */
function syncCommunityButton() {
  const n = communityNodeIds.size
  if (n === 0 && hiddenCommunity) hiddenCommunity = false // 社区层空了，开关自动复位
  btnCommunity.classList.toggle('hidden', n === 0)
  btnCommunity.classList.toggle('active', hiddenCommunity)
  btnCommunity.textContent = hiddenCommunity ? `👥 社区层已隐藏 (${n})` : `👥 隐藏社区层 (${n})`
  btnCommunity.title = hiddenCommunity
    ? '重新显示社区贡献的节点'
    : '只显示调研基线，藏起社区新增 / 修改过的节点'
}
btnCommunity.addEventListener('click', () => {
  hiddenCommunity = !hiddenCommunity
  syncCommunityButton()
  applyVisualState()
})

// 漫游期间只保留时代名与科技名：其余界面与悬停让位，连线改为按显现时刻生长
const BASE_FOV = camera.fov
const fog = scene.fog as THREE.Fog
const FOG_BASE = { near: fog.near, far: fog.far }
let shownEra = -2
let shownFov = BASE_FOV

// 视场随"要看的圆盘"渐变；标签的像素换算依赖焦距，改 fov 必须同步
function applyFov(fov: number) {
  if (Math.abs(fov - shownFov) < 0.05) return
  shownFov = fov
  camera.fov = fov
  camera.updateProjectionMatrix()
  updateLabelFocal(innerHeight, fov)
}

// 未到达时代的圆盘与时代名不显示：俯视时它们是画面上方那片空白里唯一的杂物
function showEraStage(era: number) {
  if (era === shownEra) return
  shownEra = era
  rings.forEach((r, i) => (r.visible = i <= era))
  eraLabels.setVisibleThrough(era)
}

function setTouring(on: boolean) {
  document.body.classList.toggle('touring', on)
  if (!on) applyFov(BASE_FOV) // 环绕模式恢复默认视场；漫游中由主循环逐帧驱动
  setLabelMinPxAll(on ? 18 : 0) // 漫游中远处的名字也要读得清
  // 俯视会看到下方整棵已积累的树，把雾推远免得它糊成一片背景
  fog.near = on ? 420 : FOG_BASE.near
  fog.far = on ? 2200 : FOG_BASE.far
  if (on) {
    hoverIdx = null
    shownEra = -2
    // 漫游是纯观赏：聚焦先解除，领域/kind 的隐藏保留（连线遮罩与隐去一并带上）
    selected = null
    focusDepth = null
    applyVisualState()
    field.beginTour(plan.revealAt, 0)
    edges.beginTour()
  } else {
    tooltip.classList.remove('show')
    renderer.domElement.style.cursor = ''
    field.endTour()
    field.highlight(null)
    edges.fillAll()
    nameLabels.invalidate()
    showEraStage(ERA_COUNT - 1)
  }
}

btnTour.addEventListener('click', () => {
  if (rig.mode === 'tour') {
    rig.stopTour()
  } else {
    rig.startTour()
    setTouring(true)
    btnTour.textContent = '⏹ 停止漫游'
    btnTour.classList.add('active')
  }
})
btnReset.addEventListener('click', () => rig.resetView())
rig.onTourEnd = () => {
  clearTimeout(captionTimer)
  caption.classList.remove('show')
  setTouring(false)
  btnTour.textContent = '▶ 漫游动画'
  btnTour.classList.remove('active')
}

// ───── UI：搜索（名称 / 英文名 / 别名），选中即聚焦并飞往节点 ─────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const searchBox = document.getElementById('searchBox') as HTMLInputElement
const searchResults = document.getElementById('searchResults')!
let SEARCHABLE: { t: TechNode; name: string; en: string; hay: string }[] = []
let searchHits: TechNode[] = []
let searchActive = -1

/** 搜索索引随数据重建（增删后必须重算，否则新节点搜不到、已删的还搜得着） */
function buildSearchIndex() {
  SEARCHABLE = placed.map(p => ({
    t: p.node,
    name: p.node.name.toLowerCase(),
    en: p.node.nameEn.toLowerCase(),
    hay: `${p.node.name} ${p.node.nameEn} ${p.node.aliases.join(' ')}`.toLowerCase(),
  }))
}

function renderSearch() {
  searchResults.innerHTML = searchHits.map((t, k) =>
    `<button class="sr-item${k === searchActive ? ' on' : ''}" data-id="${esc(t.id)}"><span>${esc(t.name)}</span><i>${esc(t.nameEn)}</i><b>${'★'.repeat(6 - t.importance)}</b></button>`
  ).join('')
  searchResults.classList.toggle('show', searchHits.length > 0)
}

function doSearch() {
  const q = searchBox.value.trim().toLowerCase()
  searchActive = -1
  if (!q) { searchHits = []; renderSearch(); return }
  const hits: { t: TechNode; rank: number }[] = []
  for (const s of SEARCHABLE) {
    if (!s.hay.includes(q)) continue
    // 前缀命中 > 名称内含 > 仅别名/组合命中；同级按重要度排
    const rank = s.name.startsWith(q) || s.en.startsWith(q) ? 0
      : s.name.includes(q) || s.en.includes(q) ? 1 : 2
    hits.push({ t: s.t, rank })
  }
  hits.sort((a, b) => a.rank - b.rank || a.t.importance - b.t.importance || a.t.year - b.t.year)
  searchHits = hits.slice(0, 12).map(h => h.t)
  renderSearch()
}

function gotoTech(id: string) {
  const idx = placedByIdx.get(id)
  if (idx === undefined) return
  // 目标当前被领域/kind/重要度筛掉时，先放开筛选让它可见
  if (!nodeVis[idx]) { hiddenCats.clear(); activeKinds.clear(); soloImp = null }
  if (selected !== idx) selectNode(idx) // selectNode 内部会把相机取景到"它 + 一跳邻居"
  searchHits = []; renderSearch()
  searchBox.value = ''
  searchBox.blur()
}

searchBox.addEventListener('input', doSearch)
searchBox.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!searchHits.length) return
    searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length
    renderSearch()
  } else if (e.key === 'Enter') {
    const t = searchHits[searchActive >= 0 ? searchActive : 0]
    if (t) gotoTech(t.id)
  } else if (e.key === 'Escape') {
    searchHits = []; renderSearch()
    searchBox.blur()
  }
})
searchResults.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest('.sr-item') as HTMLElement | null
  if (el) gotoTech(el.dataset.id!)
})
// 点搜索框之外收起结果
document.addEventListener('pointerdown', e => {
  if (!(e.target as HTMLElement).closest?.('#search')) { searchHits = []; renderSearch() }
})

// ───── 拾取：悬停看信息，点击锁定关联 ─────
const tooltip = document.getElementById('tooltip')!
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()

// 规范 §6：tooltip 同时显示"精确数值"与"真实精度"，避免把约定值读成确证
function yearText(n: TechNode): string {
  const b = YEAR_BASIS_LABEL[n.yearBasis] ?? { mark: '', approx: false }
  const abs = Math.abs(n.year)
  const core = n.year >= 0
    ? `${n.year} 年`
    : abs >= 10000 ? `前 ${(abs / 10000).toFixed(abs % 10000 === 0 ? 0 : 1)} 万年` : `公元前 ${abs} 年`
  return `${b.approx ? '约' : ''}${core}${b.mark ? `（${b.mark}）` : ''}`
}

function pickAt(clientX: number, clientY: number): number | null {
  const rect = renderer.domElement.getBoundingClientRect()
  ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  )
  raycaster.setFromCamera(ndc, camera)
  // 隐去的节点由 field 挡回 null，但要继续试更靠后的命中，否则它们会挡住身后
  for (const h of raycaster.intersectObjects(field.meshes, false)) {
    const idx = field.nodeIndexAt(h.object, h.instanceId!)
    if (idx !== null) return idx
  }
  return null
}

/** 把相机取景到"选中节点 + 一跳邻居"这一组上（自动放大 / 自动退到能看全） */
function focusCamera(idx: number) {
  const pts: THREE.Vector3[] = [placed[idx].position]
  for (const nb of graph.adj[idx]) pts.push(placed[nb].position)
  rig.focusOnGroup(pts)
}

function selectNode(idx: number | null) {
  if (idx === null || idx === selected) {
    selected = null
    focusDepth = null
  } else {
    selected = idx
    focusDepth = kHopDepth(graph, idx, FOCUS_HOPS, focusBuf)
    focusCamera(idx)
  }
  applyVisualState()
}

// 悬停/点按共用的卡片渲染；数据字段一律转义（数据来自 PR 贡献，防注入）
function tooltipHTML(idx: number, pinned: boolean): string {
  const n = placed[idx].node
  // 前置科技：显示名称（最多 4 个，避免溢出）
  const prereqNames = n.prereqs
    .map(id => techById.get(id)?.name ?? '')
    .filter(Boolean)
    .slice(0, 4)
    .map(esc)
    .join('、')
  const link = pinned ? '' : selected === null ? '' : selected === idx
    ? `<div class="tt-dim">已聚焦：与其直接相连（一跳）的科技</div>`
    : focusDepth && focusDepth[idx] >= 0
      ? `<div class="tt-dim">在聚焦范围内（${focusDepth[idx]} 跳）</div>` : ''
  // 编辑模式下卡片上直接改这个节点的颜色（写进叠加层，不改仓库数据）
  const colorRow = editMode
    ? `<label class="tt-color"><input type="color" data-role="color" data-id="${esc(n.id)}" value="${esc(n.color ?? CATEGORY_HEX[n.category])}" title="改这个节点的颜色" /><span>改色</span></label>
       ${n.color ? `<button data-act="uncolor">↺ 恢复领域色</button>` : ''}`
    : ''
  return `
    <div class="tt-name">${esc(n.name)}${communityIds.has(n.id) ? '<span class="tt-comm">社区</span>' : ''}</div>
    <div class="tt-dim">${n.nameEn !== n.name ? esc(n.nameEn) + ' · ' : ''}${yearText(n)}</div>
    <div class="tt-dim">${ERA_INFO[n.era].name} · ${CATEGORY_NAMES[n.category]}${n.kind ? ' · ' + esc(n.kind) : ''}</div>
    <div class="tt-dim">重要度 ${'★'.repeat(6 - n.importance)}${'☆'.repeat(n.importance - 1)}　${facesOf(n.importance)} 面</div>
    ${prereqNames ? `<div class="tt-dim">前置：${prereqNames}</div>` : ''}
    ${n.desc ? `<div class="tt-desc">${esc(n.desc)}</div>` : ''}
    ${link}
    ${n.wikiEn
      ? `<div class="tt-src">摘要参考英文维基百科条目
          <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(n.wikiEn)}" target="_blank" rel="noopener">${esc(n.wikiEn)}</a>
          （CC BY-SA 4.0）</div>`
      : ''}
    ${pinned
      ? `<div class="tt-actions">${colorRow}${editMode ? `<button data-act="del">🗑 删除此节点</button>` : ''}<button data-act="focus">⌖ 聚焦关联</button><button data-act="close">✕ 关闭</button></div>`
      : ''}
  `
}

// 防止卡片溢出屏幕边缘（贴近右/下边缘时回收到可视区内）
function placeTooltip(x: number, y: number) {
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight
  tooltip.style.left = `${Math.max(8, Math.min(x + 16, innerWidth - w - 8))}px`
  tooltip.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - h - 8))}px`
}

// 触摸点按出的固定卡片：可交互（含聚焦/删除/关闭按钮），不随指针移动
function showPinnedTooltip(idx: number, x: number, y: number) {
  tooltip.dataset.node = placed[idx].node.id
  tooltip.innerHTML = tooltipHTML(idx, true)
  tooltip.classList.add('show', 'pinned')
  placeTooltip(x, y)
}

function hidePinnedTooltip() {
  tooltip.classList.remove('show', 'pinned')
  delete tooltip.dataset.node
}

/** 卡片内容随数据变了就地重画（位置不动，免得"改色"这种小操作把卡片弹走） */
function refreshPinnedCard() {
  const id = tooltip.dataset.node
  const idx = id ? placedByIdx.get(id) : undefined
  if (idx === undefined || !tooltip.classList.contains('pinned')) return
  tooltip.innerHTML = tooltipHTML(idx, true)
}

tooltip.addEventListener('click', e => {
  const act = (e.target as HTMLElement).dataset?.act
  if (!act) return
  const id = tooltip.dataset.node
  const idx = id ? placedByIdx.get(id) : undefined
  if (act === 'focus' && idx !== undefined) {
    if (selected !== idx) selectNode(idx)
    else focusCamera(idx)
  } else if (act === 'del' && id) {
    deleteNode(id)
    return
  } else if (act === 'uncolor' && id) {
    setNodeColor(id, null)
    refreshPinnedCard()
    return
  }
  hidePinnedTooltip()
})

// 卡片里的取色器：拖动即预览（input），松开后重画卡片（change）好让"恢复领域色"按钮跟着出现
tooltip.addEventListener('input', e => {
  const el = e.target as HTMLInputElement
  if (el.dataset?.role === 'color') setNodeColor(el.dataset.id!, el.value)
})
tooltip.addEventListener('change', e => {
  const el = e.target as HTMLInputElement
  if (el.dataset?.role === 'color') { setNodeColor(el.dataset.id!, el.value); refreshPinnedCard() }
})

renderer.domElement.addEventListener('pointermove', e => {
  if (rig.mode === 'tour') return // 漫游中相机在动，悬停无意义
  if (e.pointerType === 'touch') return // 触摸无悬停，点按走 pointerup 的固定卡片
  if (tooltip.classList.contains('pinned')) return // 固定卡片不被悬停覆盖
  const idx = pickAt(e.clientX, e.clientY)
  hoverIdx = editMode ? null : idx
  if (idx === null) {
    tooltip.classList.remove('show')
    renderer.domElement.style.cursor = ''
    return
  }
  tooltip.innerHTML = tooltipHTML(idx, false)
  tooltip.classList.add('show')
  placeTooltip(e.clientX, e.clientY)
  renderer.domElement.style.cursor = 'pointer'
})

// 点击：位移与时长都很小才算"点选"，否则那是拖动转视角
let downX = 0, downY = 0, downT = 0
renderer.domElement.addEventListener('pointerdown', e => {
  downX = e.clientX; downY = e.clientY; downT = performance.now()
})
renderer.domElement.addEventListener('pointerup', e => {
  if (rig.mode === 'tour') return
  if (e.pointerType !== 'touch' && e.button !== 0) return
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return
  if (performance.now() - downT > 400) return
  const idx = pickAt(e.clientX, e.clientY)
  // 触摸与编辑模式都出固定卡片：触摸无悬停；编辑模式要在卡片上拿到"删除"
  if (editMode || e.pointerType === 'touch') {
    if (idx !== null) showPinnedTooltip(idx, e.clientX, e.clientY)
    else { hidePinnedTooltip(); if (selected !== null) selectNode(null) }
    return
  }
  hidePinnedTooltip()
  selectNode(idx) // 点空白 = 取消聚焦
})
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (tooltip.classList.contains('pinned')) { hidePinnedTooltip(); return }
  if (selected !== null) selectNode(null)
})

// ───── UI：编辑模式（增删节点） ─────
// 增删只改 localStorage 里叠加层，基础 data/*.json 不动；改完整体重建场景
let editMode = false
const btnEdit = document.getElementById('btnEdit') as HTMLButtonElement
const editPanel = document.getElementById('editPanel')!
const edName = document.getElementById('edName') as HTMLInputElement
const edNameEn = document.getElementById('edNameEn') as HTMLInputElement
const edYear = document.getElementById('edYear') as HTMLInputElement
const edEra = document.getElementById('edEra') as HTMLSelectElement
const edCat = document.getElementById('edCat') as HTMLSelectElement
const edImp = document.getElementById('edImp') as HTMLSelectElement
const edKind = document.getElementById('edKind') as HTMLSelectElement
const edPrereq = document.getElementById('edPrereq') as HTMLInputElement
const edPrereqList = document.getElementById('edPrereqList')!
const edColor = document.getElementById('edColor') as HTMLInputElement
const edColorAuto = document.getElementById('edColorAuto') as HTMLInputElement
const edDesc = document.getElementById('edDesc') as HTMLTextAreaElement
const edCount = document.getElementById('edCount')!

edEra.innerHTML = ERA_INFO.map((e, i) => `<option value="${i}">${e.name}</option>`).join('')
edCat.innerHTML = CATEGORY_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')
edKind.innerHTML = `<option value="">（未指定）</option>` +
  KINDS.map(k => `<option value="${k}">${k}</option>`).join('')
edImp.innerHTML = [1, 2, 3, 4, 5].map(l =>
  `<option value="${l}"${l === 3 ? ' selected' : ''}>${l} · ${facesOf(l)} 面 ${IMPLbl[l - 1]}</option>`).join('')

// ───── 前置科技：近四千项不适合下拉框，改成"输入即过滤"的可搜索选择器 ─────
// 索引懒建（首次输入时才展开全量），数据重建后置空等下次再建
type PrereqEntry = { t: TechNode; name: string; en: string; hay: string }
let prereqIndex: PrereqEntry[] | null = null
let prereqHits: TechNode[] = []
let prereqActive = -1
let prereqId = '' // 已选中的前置 id，'' = 无前置

function buildPrereqIndex() {
  if (prereqIndex || !placed) return
  prereqIndex = placed.map(p => ({
    t: p.node,
    name: p.node.name.toLowerCase(),
    en: p.node.nameEn.toLowerCase(),
    hay: `${p.node.name} ${p.node.nameEn} ${p.node.aliases.join(' ')}`.toLowerCase(),
  }))
}

function renderPrereqList() {
  if (!prereqHits.length) {
    edPrereqList.innerHTML = ''
    edPrereqList.classList.remove('show')
    return
  }
  edPrereqList.innerHTML = prereqHits.map((t, k) =>
    `<button type="button" class="ed-combo-item${k === prereqActive ? ' on' : ''}" data-id="${esc(t.id)}"><span>${esc(t.name)}</span><i>${esc(t.nameEn)}</i></button>`
  ).join('')
  edPrereqList.classList.add('show')
}

function searchPrereq() {
  const q = edPrereq.value.trim().toLowerCase()
  prereqActive = -1
  if (!q) {
    prereqHits = []
    renderPrereqList()
    return
  }
  buildPrereqIndex()
  const hits: { t: TechNode; rank: number }[] = []
  for (const s of prereqIndex!) {
    if (!s.hay.includes(q)) continue
    const rank = s.name.startsWith(q) ? 0 : s.en.startsWith(q) ? 1
      : s.name.includes(q) || s.en.includes(q) ? 2 : 3
    hits.push({ t: s.t, rank })
  }
  hits.sort((a, b) => a.rank - b.rank || b.t.importance - a.t.importance)
  prereqHits = hits.slice(0, 10).map(h => h.t)
  renderPrereqList()
}

/** 选定一个前置（或传 null 清空），并回填输入框 */
function pickPrereq(t: TechNode | null) {
  prereqId = t ? t.id : ''
  edPrereq.value = t ? t.name : ''
  prereqHits = []
  renderPrereqList()
}

edPrereq.addEventListener('input', () => { prereqId = ''; searchPrereq() })
// 已选中的名字再次聚焦时全选，直接打字就是重新搜，不会被旧名字拖着走
edPrereq.addEventListener('focus', () => { if (prereqId) edPrereq.select() })
edPrereq.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!prereqHits.length) return
    prereqActive = (prereqActive + (e.key === 'ArrowDown' ? 1 : -1) + prereqHits.length) % prereqHits.length
    renderPrereqList()
  } else if (e.key === 'Enter') {
    if (!prereqHits.length) return
    e.preventDefault()
    pickPrereq(prereqHits[prereqActive >= 0 ? prereqActive : 0])
  } else if (e.key === 'Escape') {
    prereqHits = []
    renderPrereqList()
  }
})
edPrereqList.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest('.ed-combo-item') as HTMLElement | null
  if (el) pickPrereq(techById.get(el.dataset.id!) ?? null)
})
document.getElementById('edPrereqClear')!.addEventListener('click', () => pickPrereq(null))
// 点到组合框以外就收起候选（点候选本身属于框内，故 pointerdown 阶段收起不会打断选择）
document.addEventListener('pointerdown', e => {
  if (prereqHits.length && !(e.target as HTMLElement).closest?.('.ed-combo')) {
    prereqHits = []
    renderPrereqList()
  }
})

// ───── 颜色：新增节点可自选，缺省跟随领域色；已有节点在卡片上改 ─────
/** 勾选"跟随领域色"时，色块只作预览并禁用；领域变了就跟着变 */
function syncColorPreview() {
  edColor.disabled = edColorAuto.checked
  if (edColorAuto.checked) edColor.value = CATEGORY_HEX[Number(edCat.value)] ?? '#5a8cff'
}
edCat.addEventListener('change', syncColorPreview)
edColorAuto.addEventListener('change', syncColorPreview)
syncColorPreview()

/** 记一笔自定义色（写进叠加层），并把当前画面上这个节点立即重绘 */
function setNodeColor(id: string, hex: string | null) {
  if (hex) edits.colors[id] = hex
  else delete edits.colors[id]
  saveEdits(edits)
  if (communityApi) void communityApi.pushColor(id, hex) // 社区层同步记一笔
  const idx = placedByIdx.get(id)
  if (idx === undefined) return
  const node = placed[idx].node
  if (hex) node.color = hex
  else delete node.color
  field.setBaseColor(idx, hex) // 只重绘这一个节点，不重建世界
}

/** 数据重建后：前置索引置空重算，已选中的前置若被删掉则一并清掉 */
function markPrereqDirty() {
  prereqIndex = null
  if (prereqId && !techById.has(prereqId)) pickPrereq(null)
}

function setEditMode(on: boolean) {
  editMode = on
  btnEdit.classList.toggle('active', on)
  editPanel.classList.toggle('hidden', !on)
  document.body.classList.toggle('editing', on)
  if (on) {
    hidePinnedTooltip()
    // 先把当前聚焦的节点填进"前置"，新建的项多半就挂在它下面
    if (selected !== null && !prereqId) pickPrereq(placed[selected].node)
    // 编辑时不需要聚焦高亮干扰判断，先解除
    if (selected !== null) selectNode(null)
  }
  hoverIdx = null
  tooltip.classList.remove('show')
}
btnEdit.addEventListener('click', () => setEditMode(!editMode))
document.getElementById('edClose')!.addEventListener('click', () => setEditMode(false))

/** 删除一个节点：新增的从叠加层摘掉，基础数据的记进删除集 */
function deleteNode(id: string) {
  if (edits.added.some(n => n.id === id)) {
    edits.added = edits.added.filter(n => n.id !== id)
  } else if (!edits.deleted.includes(id)) {
    edits.deleted.push(id)
  }
  delete edits.colors[id] // 节点都没了，自定义色一并清掉
  if (prereqId === id) pickPrereq(null)
  saveEdits(edits)
  if (communityApi) void communityApi.pushDelete(id) // 社区层同步记一笔（核心节点会被服务端拒掉）
  hidePinnedTooltip()
  rebuildAfterDataChange(null)
}

document.getElementById('edAdd')!.addEventListener('click', () => {
  const name = edName.value.trim()
  const nameEn = edNameEn.value.trim()
  if (!name && !nameEn) { edName.focus(); return }
  const year = Number(edYear.value)
  const id = newTechId()
  const node: TechNode = {
    id,
    name: name || nameEn,
    nameEn: nameEn || name,
    wikiEn: '',
    aliases: [],
    year: Number.isFinite(year) ? year : 0,
    yearBasis: 'exact',
    yearNote: '应用内新增',
    kind: edKind.value,
    era: Number(edEra.value),
    category: Number(edCat.value),
    importance: Number(edImp.value),
    prereqs: prereqId && placedByIdx.has(prereqId) ? [prereqId] : [],
    related: [],
    desc: edDesc.value.trim(),
  }
  edits.added.push(node)
  // 自定义色与新增节点一样只记在叠加层：color 缺省即跟随领域
  if (!edColorAuto.checked) edits.colors[id] = edColor.value
  saveEdits(edits)
  if (communityApi) void communityApi.pushAdd(node) // 社区层同步记一笔
  edName.value = ''
  edNameEn.value = ''
  edDesc.value = ''
  edColorAuto.checked = true
  syncColorPreview()
  pickPrereq(null)
  rebuildAfterDataChange(id) // 重建后把相机飞到新节点，立刻看到它落在哪
})

document.getElementById('edRestore')!.addEventListener('click', () => {
  if (!hasEdits(edits)) return
  edits = emptyEdits()
  clearEdits()
  rebuildAfterDataChange(null)
})

/** 界面里随数据变化的那些计数与索引 */
function refreshInterface() {
  document.getElementById('statLine')!.textContent =
    `${techs.length} 项科技 · ${ERA_COUNT} 个时代 · ${CATEGORY_COUNT} 大领域`
  buildLegend()
  buildSearchIndex()
  markPrereqDirty()
  edCount.textContent = hasEdits(edits)
    ? `已添加 ${edits.added.length} 项 · 已删除 ${edits.deleted.length} 项 · 改色 ${Object.keys(edits.colors).length} 项`
    : '当前为调研原始数据'
  edCount.classList.toggle('dirty', hasEdits(edits))
  syncCommunityButton()
}

/** 增删之后：重建世界 → 让相机认新布局 → 清残留状态 → 重新下发掩码 */
function rebuildAfterDataChange(focusId: string | null) {
  if (rig.mode === 'tour') rig.stopTour() // 漫游中改数据会打架，先退出
  buildWorld()
  rig.setLayout(eraRadii, towerHeight, plan)
  hoverIdx = null
  selected = null
  focusDepth = null
  shownEra = -2
  searchHits = []
  hidePinnedTooltip()
  refreshInterface()
  applyVisualState()
  rig.resetView()
  showEraStage(ERA_COUNT - 1)
  nameLabels.invalidate()
  if (focusId !== null) {
    const idx = placedByIdx.get(focusId)
    if (idx !== undefined) selectNode(idx)
  }
}

// ───── 社区层接线（Supabase）─────
// 只有配好 src/community/config.ts 里的 URL + anon key 才会真正加载 src/community；
// 没配时 COMMUNITY_ENABLED=false，communityApi 恒为 null，所有上报/订阅都是空操作。

/** 重拉社区层并重建画面。网络异常时保留上一次的社区层，不把画面清空 */
async function refreshCommunity() {
  if (!communityApi) return
  const st = await communityApi.fetchCommunity()
  if (!st.ok) return
  communityEdits = st.edits
  communityIds = st.communityIds
  communityNodeIds = st.nodeIds
  rebuildAfterDataChange(null)
}

async function loadCommunity() {
  try {
    const m = await import('./community/client')
    communityApi = m
    // 订阅放在首次拉取之前：万一拉取与首帧之间有人写入，事件到了照样会再拉一次
    m.subscribe(() => { void refreshCommunity() })
  } catch (e) {
    console.warn('[community] 模块加载失败，退回纯本地', e)
    return
  }
  await refreshCommunity()
}
if (COMMUNITY_ENABLED) void loadCommunity()

// ───── 自适应窗口 ─────
function refreshView() {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  updateLabelFocal(innerHeight, camera.fov) // 标签屏幕最小像素换算依赖焦距
}
refreshView()
window.addEventListener('resize', refreshView)

// ───── 主循环 ─────
const clock = new THREE.Clock()

// 首帧前把掩码下发一遍：面板初始态（"全部显示"是否可点）也在这里对齐
// 先恢复 URL hash 里的分享状态（筛选 + 聚焦节点），再统一下发
refreshInterface()
const hashSelected = restoreFromHash()
if (hashSelected !== null) {
  selected = hashSelected
  focusDepth = kHopDepth(graph, hashSelected, FOCUS_HOPS, focusBuf)
}
applyVisualState() // 若 hash 所选节点被 hash 里的筛选隐去，会在这里自动解除聚焦
if (selected !== null) focusCamera(selected)

function loop() {
  requestAnimationFrame(loop)
  const dt = Math.min(clock.getDelta(), 0.1)
  const time = clock.elapsedTime

  rig.update(dt)
  if (rig.mode === 'tour') {
    const t = rig.tourT - BLEND
    applyFov(plan.fovAt(t))
    field.setTourTime(t)
    field.update(time)
    edges.update(t)
    showEraStage(plan.eraOf(t))
    nameLabels.setTourNames(Math.max(0, plan.collectNames(t, nameIdx, nameAlpha)), nameIdx, nameAlpha)
  } else {
    field.update(time)
    field.highlight(hoverIdx)
    // 名称：仅完整在屏内的，按距离保留最近 limit 个
    nameLabels.update(camera, labelLimit, innerWidth, innerHeight)
  }
  eraLabels.update() // 时代名位置固定，无需每帧更新（保留接口兼容）

  renderer.render(scene, camera)
}
loop()
