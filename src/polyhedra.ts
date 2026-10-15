import * as THREE from 'three'
import { geomRadius, type PlacedNode } from './layout'
import { FLASH } from './tour'

// 形状 = 重要度（面数越多越重要），颜色 = 领域（见 categories.json）
// 5 档重要度正好对应 5 种柏拉图立体的面数：20 / 12 / 8 / 6 / 4
// importance 1 = 基石 → 二十面体；importance 5 = 长尾 → 四面体
// 外接球半径由 layout.ts 的 geomRadius 统一给出，低面数立体因体积小而自然显得更小
const R = geomRadius(2) // 除基石外各档共用的外接球半径
const BY_IMPORTANCE: THREE.BufferGeometry[] = [
  new THREE.IcosahedronGeometry(geomRadius(1)), // 20 面 —— importance 1
  new THREE.DodecahedronGeometry(R),     // 12 面 —— importance 2
  new THREE.OctahedronGeometry(R),       //  8 面 —— importance 3
  new THREE.BoxGeometry(R * 2 / Math.sqrt(3), R * 2 / Math.sqrt(3), R * 2 / Math.sqrt(3)), // 6 面 —— 4
  new THREE.TetrahedronGeometry(R),      //  4 面 —— importance 5
]
const LEVELS = BY_IMPORTANCE.length

export function facesOf(importance: number): number {
  return [20, 12, 8, 6, 4][Math.min(LEVELS, Math.max(1, Math.round(importance))) - 1]
}

interface InstanceMeta {
  nodeIdx: number
  placed: PlacedNode
}

/**
 * 显现弹入曲线：前 22% 时长冲到 ~2 倍再落回 1 倍。
 * 漫游中节点在屏幕上只有几像素，靠这个尺寸冲击"闪白"才看得见。
 */
function pop(k: number): number {
  const grow = Math.min(1, k / 0.22)
  return grow * (1 + 1.6 * Math.pow(1 - k, 1.6))
}

export class PolyhedraField {
  meshes: THREE.InstancedMesh[] = []
  private metas: InstanceMeta[][] = []
  private highlightIdx: number | null = null
  private domainColors: THREE.Color[]
  private nodeColors: THREE.Color[]
  private tmp = new THREE.Object3D()
  private white = new THREE.Color(0xffffff)
  // 隐去（领域/kind 掩码）：不改布局、不改尺寸，只把颜色压到背景上，并从射线拾取里剔除
  private keep: ((nodeIdx: number) => boolean) | null = null
  // 聚焦（点击某科技）：跳数表，0 = 选中自身、>0 = 连线可达、<0 = 不相干而淡出
  private focus: Int8Array | null = null
  private byIdx: PlacedNode[]
  private dim = new THREE.Color(0x070a14)
  // 三档混合系数：隐去要几乎不可见，聚焦时集外仍要看得出"那里还有东西"
  private static readonly HIDE_MIX = 0.995
  private static readonly OUT_MIX = 0.93
  private static readonly HOVER_MIX = 0.45
  // 漫游显现：revealAt[节点] = 出现时刻，tourTime < 0 表示不在漫游中（全部可见）
  private revealAt: Float32Array | null = null
  private tourTime = -1
  private flashFlags: Uint8Array[] = []
  private tmpColor = new THREE.Color()

  constructor(placed: PlacedNode[], colors: THREE.Color[]) {
    this.byIdx = placed
    this.domainColors = colors
    // 每个节点的实际底色：有自定义色就用它，否则回落到所属领域的颜色
    this.nodeColors = placed.map(p =>
      p.node.color ? new THREE.Color(p.node.color) : colors[p.node.category])
    const buckets: InstanceMeta[][] = Array.from({ length: LEVELS }, () => [])
    placed.forEach((p, globalIdx) => {
      const level = Math.min(LEVELS, Math.max(1, Math.round(p.node.importance))) - 1
      buckets[level].push({ nodeIdx: globalIdx, placed: p })
    })

    for (let lv = 0; lv < LEVELS; lv++) {
      const meta = buckets[lv]
      const mesh = new THREE.InstancedMesh(
        BY_IMPORTANCE[lv],
        new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.55 }),
        Math.max(1, meta.length)
      )
      mesh.count = meta.length
      mesh.frustumCulled = false // 实例分布全塔，禁用剔除避免误裁
      meta.forEach((m, i) => mesh.setColorAt(i, this.nodeColors[m.nodeIdx]))
      this.meshes.push(mesh)
      this.metas.push(meta)
    }
  }

  /** 每帧更新自转；漫游中还要处理"按年份逐个显现 + 闪亮" */
  update(time: number) {
    const reveal = this.revealAt
    for (let lv = 0; lv < this.meshes.length; lv++) {
      const mesh = this.meshes[lv]
      const meta = this.metas[lv]
      const flags = reveal ? this.flashFlags[lv] : null
      let repaint = false
      for (let i = 0; i < meta.length; i++) {
        const p = meta[i].placed
        let s = p.scale
        let flash = 0
        if (this.hidden(meta[i].nodeIdx)) s = 0 // 隐去：不在画面里占位，也不挡后面的节点
        else if (reveal) {
          const age = this.tourTime - reveal[meta[i].nodeIdx]
          if (age < 0) s = 0
          else if (age < FLASH) {
            const k = age / FLASH
            s = p.scale * pop(k)
            flash = 1 - k
          }
        }
        this.tmp.position.copy(p.position)
        this.tmp.quaternion.setFromAxisAngle(p.spinAxis, p.phase + time * p.spinSpeed)
        this.tmp.scale.setScalar(s)
        this.tmp.updateMatrix()
        mesh.setMatrixAt(i, this.tmp.matrix)

        if (flags) {
          const was = flags[i] > 0
          if (flash > 0) {
            // 显现瞬间冲亮（闪白是漫游里唯一能抓住眼的信号）
            mesh.setColorAt(i, this.colorOf(meta[i].nodeIdx).multiplyScalar(1 + flash * 12))
            flags[i] = 1
            repaint = true
          } else {
            // 闪亮结束的那一帧把颜色写回本档，其余帧不动这张 buffer
            if (was) { mesh.setColorAt(i, this.colorOf(meta[i].nodeIdx)); repaint = true }
            flags[i] = 0
          }
        }
      }
      mesh.instanceMatrix.needsUpdate = true
      if (repaint && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  /** 进入漫游：接管可见性，节点按 revealAt 逐个出现 */
  beginTour(revealAt: Float32Array, t: number) {
    this.revealAt = revealAt
    this.tourTime = t
    this.flashFlags = this.metas.map(m => new Uint8Array(m.length))
  }

  /** 退出漫游：全部恢复可见并按当前掩码/聚焦重绘 */
  endTour() {
    this.revealAt = null
    this.tourTime = -1
    this.flashFlags = []
    this.repaintAll()
  }

  setTourTime(t: number) {
    if (this.revealAt) this.tourTime = t
  }

  /**
   * 下发两个通道并一次性重绘：
   * keep = 领域/kind 掩码（不通过的节点隐去：尺寸归零，射线也穿不过去）
   * focus = 点击聚焦的跳数表（集外淡出到近背景，集内保留本色，选中自身转白）
   */
  setVisible(keep: ((nodeIdx: number) => boolean) | null, focus: Int8Array | null) {
    this.keep = keep
    this.focus = focus
    this.repaintAll()
  }

  private repaintAll() {
    for (let lv = 0; lv < this.meshes.length; lv++) {
      const mesh = this.meshes[lv]
      this.metas[lv].forEach((m, i) => mesh.setColorAt(i, this.colorOf(m.nodeIdx)))
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  private hidden(nodeIdx: number): boolean {
    return !!this.keep && !this.keep(nodeIdx)
  }

  private colorOf(nodeIdx: number): THREE.Color {
    this.tmpColor.copy(this.nodeColors[nodeIdx])
    if (this.hidden(nodeIdx)) return this.tmpColor.lerp(this.dim, PolyhedraField.HIDE_MIX)
    const hop = this.focus ? this.focus[nodeIdx] : 1
    if (hop === 0) return this.tmpColor.copy(this.white)
    if (hop < 0) return this.tmpColor.lerp(this.dim, PolyhedraField.OUT_MIX)
    if (this.highlightIdx === nodeIdx) return this.tmpColor.lerp(this.white, PolyhedraField.HOVER_MIX)
    return this.tmpColor
  }

  /** 换某个节点的底色（null = 跟随领域色）：底色缓存改了要就地重绘，控制器不必重建整个世界 */
  setBaseColor(nodeIdx: number, hex: string | null) {
    this.nodeColors[nodeIdx] = hex
      ? new THREE.Color(hex)
      : this.domainColors[this.byIdx[nodeIdx].node.category]
    this.repaint(nodeIdx)
  }

  /** 悬停提亮：nodeIdx 为全局索引，null 恢复 */
  highlight(nodeIdx: number | null) {
    if (this.highlightIdx === nodeIdx) return
    const prev = this.highlightIdx
    this.highlightIdx = nodeIdx
    for (const idx of [prev, nodeIdx]) {
      if (idx !== null && idx !== undefined) this.repaint(idx)
    }
  }

  private repaint(nodeIdx: number) {
    for (let lv = 0; lv < this.meshes.length; lv++) {
      const meta = this.metas[lv]
      for (let i = 0; i < meta.length; i++) {
        if (meta[i].nodeIdx !== nodeIdx) continue
        this.meshes[lv].setColorAt(i, this.colorOf(nodeIdx))
        if (this.meshes[lv].instanceColor) this.meshes[lv].instanceColor!.needsUpdate = true
        return
      }
    }
  }

  /** 根据射线命中的 mesh + instanceId 找回全局节点索引；隐去的节点不可拾取 */
  nodeIndexAt(mesh: THREE.Object3D, instanceId: number): number | null {
    const lv = this.meshes.indexOf(mesh as THREE.InstancedMesh)
    if (lv < 0 || instanceId >= this.metas[lv].length) return null
    const idx = this.metas[lv][instanceId].nodeIdx
    return this.hidden(idx) ? null : idx
  }
}
