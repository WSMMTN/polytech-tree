// 应用内节点增删：不写回仓库的 data/*.json，只把用户的增删作为"叠加层"存在 localStorage。
// 于是基础数据始终是唯一事实源，一键恢复默认即可回到调研产物。
import type { TechNode, DatasetId } from './data'

// 每个数据集一份存档：两棵树的 era/category 索引空间不同（人类树 11 时代 / 群星 6 层级），
// 共用一份会让人类树里新建的 era=9 节点切到群星树时索引越界崩溃
const keyOf = (dataset: DatasetId) => `polytech-tree:edits:${dataset}:v1`

export interface UserEdits {
  added: TechNode[]
  deleted: string[]
  // 节点 id → 自定义颜色（#rrggbb）。不在表里的节点仍用所属领域的颜色
  colors: Record<string, string>
}

export const emptyEdits = (): UserEdits => ({ added: [], deleted: [], colors: {} })

export function loadEdits(dataset: DatasetId): UserEdits {
  try {
    const raw = localStorage.getItem(keyOf(dataset))
    if (!raw) return emptyEdits()
    const o = JSON.parse(raw) as Partial<UserEdits>
    if (!Array.isArray(o.added) || !Array.isArray(o.deleted)) return emptyEdits()
    // colors 是后加的字段：旧存档没有它，缺省视为"全部跟随领域色"
    const colors = o.colors && typeof o.colors === 'object' ? o.colors : {}
    return { added: o.added, deleted: o.deleted, colors }
  } catch {
    return emptyEdits() // 隐私模式 / 配额异常时静默退回基础数据
  }
}

export function saveEdits(dataset: DatasetId, e: UserEdits) {
  try {
    localStorage.setItem(keyOf(dataset), JSON.stringify(e))
  } catch {
    // 存不下就算了：本次会话内的编辑仍然生效
  }
}

export function clearEdits(dataset: DatasetId) {
  try {
    localStorage.removeItem(keyOf(dataset))
  } catch { /* 同上 */ }
}

export const hasEdits = (e: UserEdits) =>
  e.added.length > 0 || e.deleted.length > 0 || Object.keys(e.colors).length > 0

/**
 * 把增删叠加到基础数据上：
 * - 被删节点移除（新增的也在删除集里一并摘掉）
 * - prereqs / related 指向已删节点时同步清理，免得留下悬空引用让连线凭空消失
 * - colors 里的自定义色覆盖节点原有的"跟随领域"
 */
export function applyEdits(base: TechNode[], e: UserEdits): TechNode[] {
  if (!hasEdits(e)) return base
  const gone = new Set(e.deleted)
  const merged = [
    ...base.filter(n => !gone.has(n.id)),
    ...e.added.filter(n => !gone.has(n.id)),
  ]
  const alive = new Set(merged.map(n => n.id))
  return merged.map(n => {
    const prereqs = n.prereqs.filter(p => alive.has(p))
    const related = n.related.filter(r => alive.has(r))
    const color = e.colors[n.id]
    const prunedPreds = prereqs.length !== n.prereqs.length || related.length !== n.related.length
    if (!prunedPreds && !color) return n
    return { ...n, prereqs, related, ...(color ? { color } : {}) }
  })
}

/** 新增节点的主键：时间戳 36 进制，够用且不会撞上调研数据的 id */
export const newTechId = () => `user-${Date.now().toString(36)}`
