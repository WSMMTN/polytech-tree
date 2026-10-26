// 社区层客户端（腾讯云 CloudBase 后端）。
//
// 数据流向（对应 cloudbase/migrations 的建表 SQL）：
//   读：GET PostgREST /edit_log 拉回整条 append-only 日志 → 在本地按 seq 回放成
//       "社区叠加层"（形状与 src/edit.ts 的 UserEdits 一致，交给 applyEdits 合并）
//   写：POST 一条日志（op/entity/target_id/payload）。结构校验、核心节点禁删、
//       限流、熔断、暂停开关都在数据库触发器里，客户端不做重复判断。
//
// 认证在 ./tcb-auth（与 /admin 页共用）：匿名登录拿 access_token（角色 anon），
// 过期后直接重新登录，不走 refresh（作者指纹在服务端按 IP 算，与 token 无关）。
//
// 刻意不引任何 SDK：只用 fetch，没配置后端时这个模块根本不会被加载。
import { ERA_ID_TO_INDEX, CATEGORY_ID_TO_INDEX, ERA_IDS, CATEGORY_IDS } from '../data'
import type { TechNode } from '../data'
import { emptyEdits, type UserEdits } from '../edit'
import { tcbFetch } from './tcb-auth'

/** edit_log 公开可读的那几列（其余指纹列只在 edit_meta，公开角色无权读） */
interface LogRow {
  seq: number
  created_at: string
  op: 'add' | 'update' | 'delete' | 'color'
  entity: 'tech' | 'color'
  target_id: string
  payload: unknown
}

export interface CommunityState {
  /** 拉取/回放是否成功。false 时调用方应保持"纯本地"行为不变 */
  ok: boolean
  /** 可直接与本地叠加层合并的社区层 */
  edits: UserEdits
  /** 当前来自社区的节点 / 改色 id，用于卡片上的"社区"标记 */
  communityIds: Set<string>
  /** 其中的节点 id（新增或修改过的条目）——"一键隐藏社区层"隐藏的就是这一批 */
  nodeIds: Set<string>
}

/** 未接入/失败时的默认态：调用方据此保持"纯本地"行为不变 */
const emptyState = (): CommunityState => ({
  ok: false, edits: emptyEdits(), communityIds: new Set(), nodeIds: new Set(),
})

// ───── 读取：拉日志 + 本地回放 ───────────────────────────────────────────────

/** 拉回社区层。未配置后端时不该被调用（调用方用 COMMUNITY_ENABLED 把关） */
export async function fetchCommunity(): Promise<CommunityState> {
  try {
    const r = await tcbFetch('/v1/rdb/rest/edit_log?select=seq,created_at,op,entity,target_id,payload&order=seq.asc')
    if (!r.ok) {
      console.warn('[community] 拉取失败', r.status, await r.text().catch(() => ''))
      return emptyState()
    }
    const rows = (await r.json()) as LogRow[]
    return { ok: true, ...replay(rows) }
  } catch (e) {
    console.warn('[community] 拉取异常（离线？），本次退回纯本地', e)
    return emptyState()
  }
}

/**
 * 回放日志得到叠加层：同 id 后写的覆盖先写的，删除摘掉节点/颜色。
 * 顺序即 seq（bigserial 单调），所以回放结果与服务端状态一致。
 */
function replay(rows: LogRow[]): { edits: UserEdits; communityIds: Set<string>; nodeIds: Set<string> } {
  const nodes = new Map<string, TechNode>()
  const deleted = new Set<string>()
  const colors = new Map<string, string>()

  for (const row of rows) {
    const id = row.target_id
    if (!id) continue
    switch (row.op) {
      case 'add':
      case 'update': {
        const n = toTechNode(row.payload)
        if (!n) break
        nodes.set(id, n)
        deleted.delete(id) // 改了回来，就不再算"被删"
        break
      }
      case 'delete':
        // 社区新增的节点被删 → 直接从新增里摘掉；基线节点被删 → 记进删除集
        if (!nodes.delete(id)) deleted.add(id)
        break
      case 'color':
        if (typeof row.payload === 'string') colors.set(id, row.payload)
        else colors.delete(id) // payload=null 表示恢复领域色
        break
    }
  }

  return {
    edits: { added: [...nodes.values()], deleted: [...deleted], colors: Object.fromEntries(colors) },
    communityIds: new Set([...nodes.keys(), ...colors.keys()]),
    nodeIds: new Set(nodes.keys()),
  }
}

// ───── 写入：追加一条日志 ───────────────────────────────────────────────────

async function post(body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await tcbFetch('/v1/rdb/rest/edit_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      // 触发器抛出的原因（暂停 / 限流 / 核心节点 / 结构非法）会原样回来，便于排查
      console.warn('[community] 写入被拒', r.status, await r.text().catch(() => ''))
      return false
    }
    return true
  } catch (e) {
    console.warn('[community] 写入失败（离线？）', e)
    return false
  }
}

/** 社区新增节点 */
export const pushAdd = (node: TechNode) =>
  post({ op: 'add', entity: 'tech', target_id: node.id, payload: toPayload(node) })

/** 社区删除节点（核心节点会被服务端拒掉） */
export const pushDelete = (id: string) =>
  post({ op: 'delete', entity: 'tech', target_id: id, payload: null })

/** 社区改色；hex 传 null = 恢复领域色 */
export const pushColor = (id: string, hex: string | null) =>
  post({ op: 'color', entity: 'color', target_id: id, payload: hex })

// ───── 订阅：轮询代替 Realtime ───────────────────────────────────────────────
//
// CloudBase 没有 Realtime，改为轮询 max(seq)：页面可见时每 30s 探测一次，
// 变了（含 admin 回退导致变小）就通知整体重拉；hidden 停止、visible 立即补探；
// 失败退避 30→60→120→300s。

/** 订阅 edit_log 的变化；返回退订函数。 */
export function subscribe(onChange: () => void): () => void {
  let timer = 0
  let stopped = false
  let lastSeq: number | null = null // 启动时先静默取基线，避免加载完立刻重拉
  let backoff = 0 // 失败退避的当前间隔（秒）

  const probe = async () => {
    if (stopped || document.hidden) return
    try {
      const r = await tcbFetch('/v1/rdb/rest/edit_log?select=seq&order=seq.desc&limit=1')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const rows = (await r.json()) as Array<{ seq: number }>
      const maxSeq = rows.length ? rows[0].seq : -1
      backoff = 0
      if (lastSeq === null) {
        lastSeq = maxSeq // 基线
      } else if (maxSeq !== lastSeq) {
        lastSeq = maxSeq
        onChange() // 有新增或回退：整体重拉
      }
    } catch (e) {
      backoff = Math.min(backoff ? backoff * 2 : 30, 300)
      console.warn('[community] 轮询探测失败', e)
    } finally {
      if (!stopped) timer = window.setTimeout(() => void probe(), (backoff || 30) * 1000)
    }
  }

  const onVisible = () => { if (!document.hidden) void probe() }
  document.addEventListener('visibilitychange', onVisible)
  timer = window.setTimeout(() => void probe(), 30_000)

  return () => {
    stopped = true
    if (timer) window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

// ───── 与 data/*.json 的 schema 互转 ────────────────────────────────────────
// 库里存的是字符串 id（同 techs.json，便于 validate_data.py 复用同一套规则），
// 渲染管线用的是数字索引，两边在客户端翻译。

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function toTechNode(raw: unknown): TechNode | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const name = str(r.name) || str(r.nameEn)
  return {
    id,
    name,
    nameEn: str(r.nameEn) || name,
    wikiEn: str(r.wikiEn),
    aliases: arr(r.aliases),
    year: num(r.year, 0),
    yearBasis: str(r.year_basis) || 'exact',
    yearNote: str(r.year_note),
    kind: str(r.kind),
    era: ERA_ID_TO_INDEX.get(str(r.era)) ?? 0,
    category: CATEGORY_ID_TO_INDEX.get(str(r.category)) ?? 0,
    importance: num(r.importance, 3),
    prereqs: arr(r.prereqs),
    related: arr(r.related),
    desc: str(r.desc),
  }
}

/** TechNode → 日志 payload（还原成 techs.json 的字段名） */
function toPayload(n: TechNode) {
  return {
    id: n.id,
    name: n.name,
    nameEn: n.nameEn,
    wikiEn: n.wikiEn,
    aliases: n.aliases,
    year: n.year,
    year_basis: n.yearBasis,
    year_span: null,
    year_note: n.yearNote,
    era: ERA_IDS[n.era] ?? ERA_IDS[0],
    category: CATEGORY_IDS[n.category] ?? CATEGORY_IDS[0],
    kind: n.kind,
    importance: n.importance,
    prereqs: n.prereqs,
    related: n.related,
    desc: n.desc,
  }
}
