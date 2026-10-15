// 应用内节点增删：不写回仓库的 data/*.json，只把用户的增删作为"叠加层"存在 localStorage。
// 于是基础数据始终是唯一事实源，一键恢复默认即可回到调研产物。
import type { TechNode } from './data'

const KEY = 'polytech-tree:edits:v1'

export interface UserEdits {
  added: TechNode[]
  deleted: string[]
}

export const emptyEdits = (): UserEdits => ({ added: [], deleted: [] })

export function loadEdits(): UserEdits {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return emptyEdits()
    const o = JSON.parse(raw) as Partial<UserEdits>
    if (!Array.isArray(o.added) || !Array.isArray(o.deleted)) return emptyEdits()
    return { added: o.added, deleted: o.deleted }
  } catch {
    return emptyEdits() // 隐私模式 / 配额异常时静默退回基础数据
  }
}

export function saveEdits(e: UserEdits) {
  try {
    localStorage.setItem(KEY, JSON.stringify(e))
  } catch {
    // 存不下就算了：本次会话内的编辑仍然生效
  }
}

export function clearEdits() {
  try {
    localStorage.removeItem(KEY)
  } catch { /* 同上 */ }
}

export const hasEdits = (e: UserEdits) => e.added.length > 0 || e.deleted.length > 0

/**
 * 把增删叠加到基础数据上：
 * - 被删节点移除（新增的也在删除集里一并摘掉）
 * - prereqs / related 指向已删节点时同步清理，免得留下悬空引用让连线凭空消失
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
    return prereqs.length === n.prereqs.length && related.length === n.related.length
      ? n
      : { ...n, prereqs, related }
  })
}

/** 新增节点的主键：时间戳 36 进制，够用且不会撞上调研数据的 id */
export const newTechId = () => `user-${Date.now().toString(36)}`
