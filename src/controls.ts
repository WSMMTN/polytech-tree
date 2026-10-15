import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { startViewDistance } from './layout'
import { BLEND, type TourPlan } from './tour'

// 相机系统：环绕观察（默认）+ 螺旋上升漫游动画（轨道与排期见 tour.ts）
export type CameraMode = 'orbit' | 'tour'

const WORLD_UP = new THREE.Vector3(0, 1, 0)
// 用户系统层声明"减少动态效果"时，关闭自动旋转这类非必要运动
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const FOCUS_DUR = 0.7 // 飞往选中节点的过渡时长（秒）
const FOCUS_PAD = 1.18 // 取景留白：包围球外再留 18%
const FOCUS_MIN = 26 // 无邻居的单点也拉到这个距离，保证节点够大
const FOCUS_MAX = 460 // 一跳邻居铺得很开时也不至于退成全景

export class CameraRig {
  mode: CameraMode = 'orbit'
  /** 漫游时钟（秒）：orbit 模式下无意义 */
  tourT = 0
  controls: OrbitControls
  onEraChange?: (era: number) => void
  onTourEnd?: () => void

  private camera: THREE.PerspectiveCamera
  private plan: TourPlan
  private eraRadii: number[]
  private towerHeight: number
  private lastEra = -1
  private startPos = new THREE.Vector3()
  private startTarget = new THREE.Vector3()
  private lookTarget = new THREE.Vector3()
  private pos = new THREE.Vector3()
  private up = new THREE.Vector3(0, 1, 0)
  /** 飞往节点的过渡动画：同时插值相机位置与观察目标 */
  private focusAnim: {
    t: number
    fromPos: THREE.Vector3; toPos: THREE.Vector3
    fromTgt: THREE.Vector3; toTgt: THREE.Vector3
  } | null = null

  constructor(
    camera: THREE.PerspectiveCamera, dom: HTMLElement,
    eraRadii: number[], towerHeight: number, plan: TourPlan
  ) {
    this.camera = camera
    this.plan = plan
    this.eraRadii = eraRadii
    this.towerHeight = towerHeight

    this.controls = new OrbitControls(camera, dom)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.autoRotate = !REDUCED_MOTION
    this.controls.autoRotateSpeed = 0.35
    this.controls.maxDistance = 950
    this.controls.minDistance = 6
    this.controls.target.set(0, this.towerHeight * 0.5, 0)

    // 用户一旦交互就停掉自动旋转，并打断进行中的飞往动画
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false
      this.focusAnim = null
    })

    // ESC 中断漫游
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.mode === 'tour') this.stopTour()
    })
    // 点击画布中断漫游
    dom.addEventListener('pointerdown', () => {
      if (this.mode === 'tour') this.stopTour()
    })
  }

  resetView() {
    this.stopTour()
    this.focusAnim = null
    this.controls.target.set(0, this.towerHeight * 0.5, 0)
    const d = startViewDistance(this.eraRadii, this.towerHeight) / Math.SQRT2
    this.camera.position.set(d, this.towerHeight * 0.68, d)
    this.controls.autoRotate = !REDUCED_MOTION
    this.controls.update()
  }

  /**
   * 数据增删后换一套布局：塔高/层半径/漫游排期都变了，相机必须跟着认新的。
   * 由 main.ts 在场景重建后调用。
   */
  setLayout(eraRadii: number[], towerHeight: number, plan: TourPlan) {
    this.eraRadii = eraRadii
    this.towerHeight = towerHeight
    this.plan = plan
    this.focusAnim = null
  }

  /**
   * 平滑飞往一组节点（选中项 + 一跳邻居）：观察目标落到这一组的包围球中心，
   * 相机保持当前方位，距离按包围球 + 当前视场角解出，使整组恰好落在画面内。
   * 于是"点一个节点"就有了自动放大与邻居同框：邻居少时贴近看细节，铺得开时自动退到能看全。
   */
  focusOnGroup(points: THREE.Vector3[]) {
    if (this.mode !== 'orbit' || points.length === 0) return
    const center = new THREE.Vector3()
    for (const p of points) center.add(p)
    center.multiplyScalar(1 / points.length)
    let radius = 0
    for (const p of points) radius = Math.max(radius, center.distanceTo(p))
    radius += 2.6 // 节点自身外接球 + 一点呼吸空间

    // 半径 r 的球要落进竖直视场：r ≤ d·sin(fov/2)，故 d = r ÷ sin(fov/2)
    const fov = THREE.MathUtils.degToRad(this.camera.fov)
    const dist = THREE.MathUtils.clamp(radius / Math.sin(fov / 2) * FOCUS_PAD, FOCUS_MIN, FOCUS_MAX)

    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.55, 1)
    dir.normalize()

    this.focusAnim = {
      t: 0,
      fromPos: this.camera.position.clone(),
      toPos: center.clone().addScaledVector(dir, dist),
      fromTgt: this.controls.target.clone(),
      toTgt: center,
    }
    this.controls.autoRotate = false
  }

  startTour() {
    if (this.mode === 'tour') return
    this.mode = 'tour'
    this.focusAnim = null
    this.tourT = 0
    this.lastEra = -1
    this.plan.reset()
    this.startPos.copy(this.camera.position)
    this.startTarget.copy(this.controls.target)
    this.controls.enabled = false
  }

  stopTour() {
    if (this.mode !== 'tour') return
    this.mode = 'orbit'
    this.controls.enabled = true
    // 漫游把 up 改成了水平向量（视线朝上时必需），环绕模式要交还世界竖直
    this.camera.up.copy(WORLD_UP)
    this.controls.target.copy(this.lookTarget.lengthSq() > 0 ? this.lookTarget : new THREE.Vector3(0, this.camera.position.y, 0))
    this.controls.update()
    this.onTourEnd?.()
  }

  update(dt: number) {
    if (this.mode === 'orbit') {
      const a = this.focusAnim
      if (a) {
        a.t += dt
        const k = Math.min(1, a.t / FOCUS_DUR)
        const s = k * k * (3 - 2 * k) // smoothstep
        this.camera.position.lerpVectors(a.fromPos, a.toPos, s)
        this.controls.target.lerpVectors(a.fromTgt, a.toTgt, s)
        if (k >= 1) this.focusAnim = null
      }
      this.controls.update()
      return
    }

    this.tourT += dt
    if (this.tourT >= this.plan.total) {
      this.applyTourPose(this.plan.total)
      this.stopTour()
      return
    }
    this.applyTourPose(this.tourT)
  }

  private applyTourPose(t: number) {
    this.plan.poseAt(t, this.pos, this.lookTarget)
    this.plan.upAt(t, this.up)

    // 开场从当前位姿融入中轴线起点
    if (t < BLEND) {
      const k = t / BLEND
      const s = k * k * (3 - 2 * k) // smoothstep
      this.pos.lerpVectors(this.startPos, this.pos, s)
      this.lookTarget.lerpVectors(this.startTarget, this.lookTarget, s)
      this.up.lerpVectors(WORLD_UP, this.up, s)
    }

    this.camera.position.copy(this.pos)
    this.camera.up.copy(this.up)
    this.camera.lookAt(this.lookTarget)

    const era = this.plan.eraOf(t)
    if (era !== this.lastEra) {
      this.lastEra = era
      this.onEraChange?.(era)
    }
  }
}
