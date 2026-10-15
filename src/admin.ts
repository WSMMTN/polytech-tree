// /admin 管理端：社区改动的回退与运维面板。
//
// 三件事：看（最近改动列表）、抹（单条 / 按作者 / 按时间点 / 全局重置）、停（暂停写入）。
// 真正的权限在服务端：ADMIN_SECRET 只在本页手输、只存 sessionStorage、绝不进构建产物；
// 所有动作都由 supabase/functions/admin 用 service_role 执行，前端拿不到任何提权能力。
import './admin.css'
import { SUPABASE_URL, COMMUNITY_ENABLED } from './community/config'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const elSecret = $<HTMLInputElement>('admSecret')
const elConnect = $<HTMLButtonElement>('admConnect')
const elState = $<HTMLSpanElement>('admState')
const elHint = $<HTMLParagraphElement>('admHint')
const elToolbar = $<HTMLDivElement>('admToolbar')
const elPaused = $<HTMLButtonElement>('admPaused')
const elSince = $<HTMLInputElement>('admSince')
const elRollbackSince = $<HTMLButtonElement>('admRollbackSince')
const elReset = $<HTMLButtonElement>('admReset')
const elCount = $<HTMLSpanElement>('admCount')
const elTable = $<HTMLTableElement>('admTable')
const elRows = $<HTMLTableSectionElement>('admRows')

const SECRET_KEY = 'polytech-tree:admin-secret'
const OP_LABEL: Record<string, string> = { add: '新增', update: '修改', delete: '删除', color: '改色' }
const COMMUNITY_HINT = '密钥只存在本标签页的 sessionStorage（刷新仍在，关掉标签页即失效），不会写进构建产物。'

interface EditRow {
  seq: number
  created_at: string
  op: string
  entity: string
  target_id: string
  payload: unknown
  author_hash: string | null
}

interface Res { ok: boolean; result?: unknown; error?: string }

let secret = ''
let paused = false

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** 社区来的内容一律转义后再拼进 DOM（payload 是外人可写的） */
const shortHash = (h: string | null) => (h ? `${h.slice(0, 8)}…` : '—')
const timeText = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

function setState(text: string, kind: '' | 'ok' | 'err') {
  elState.textContent = text
  elState.className = `state${kind ? ' ' + kind : ''}`
}

/** 调一次管理端 Edge Function */
async function callAdmin(action: string, extra: Record<string, unknown> = {}): Promise<Res> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify({ action, ...extra }),
    })
    const j = await r.json().catch(() => ({} as Record<string, unknown>))
    if (!r.ok || j.error) return { ok: false, error: String(j.error ?? `HTTP ${r.status}`) }
    return { ok: true, result: j.result }
  } catch (e) {
    return { ok: false, error: `请求失败：${e}` }
  }
}

function payloadCell(row: EditRow): string {
  if (row.op === 'color') {
    if (typeof row.payload !== 'string') return '<span class="sub">恢复领域色</span>'
    const hex = row.payload
    return `<span class="swatch" style="background:${esc(hex)}"></span>${esc(hex)}`
  }
  if (row.op === 'delete') return '<span class="sub">—</span>'
  const p = row.payload as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return '<span class="sub">—</span>'
  const name = String(p.name ?? p.nameEn ?? '')
  const en = String(p.nameEn ?? '')
  const meta = [String(p.era ?? ''), String(p.category ?? ''), p.year === undefined ? '' : String(p.year)]
    .filter(Boolean).join(' · ')
  return `<span class="name">${esc(name)}</span> <span class="sub">${esc(en)}</span>
    <div class="sub">${esc(meta)}</div>`
}

function render(rows: EditRow[]) {
  elCount.textContent = `共 ${rows.length} 条社区改动${paused ? ' · 写入已暂停' : ''}`
  elRows.innerHTML = rows.length
    ? rows.map(r => `
      <tr>
        <td class="id">${r.seq}</td>
        <td>${esc(timeText(r.created_at))}</td>
        <td><span class="op op-${esc(r.op)}">${esc(OP_LABEL[r.op] ?? r.op)}</span></td>
        <td class="id">${esc(r.target_id)}</td>
        <td>${payloadCell(r)}</td>
        <td class="id" title="${esc(r.author_hash ?? '')}">${esc(shortHash(r.author_hash))}</td>
        <td class="act">
          <button data-act="row" data-seq="${r.seq}">↩ 回退</button>
          ${r.author_hash ? `<button data-act="author" data-author="${esc(r.author_hash)}">↩ 按作者</button>` : ''}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="id">暂无社区改动</td></tr>'
}

function syncPaused() {
  elPaused.textContent = paused ? '▶ 恢复社区写入' : '⏸ 暂停社区写入'
  elPaused.classList.toggle('on', paused)
}

/** 拉状态 + 列表。任何一步失败都直接把原因显示出来，不静默 */
async function refresh() {
  if (!COMMUNITY_ENABLED || !secret) return
  setState('连接中…', '')
  const st = await callAdmin('status')
  if (!st.ok) {
    elToolbar.classList.add('hidden')
    elTable.classList.add('hidden')
    setState(st.error ?? '连接失败', 'err')
    return
  }
  paused = Boolean((st.result as Record<string, unknown> | undefined)?.writes_paused)
  syncPaused()

  const list = await callAdmin('list', { limit: 300 })
  if (!list.ok) { setState(list.error ?? '读取失败', 'err'); return }
  render((list.result as EditRow[] | null) ?? [])
  elToolbar.classList.remove('hidden')
  elTable.classList.remove('hidden')
  setState('已连接', 'ok')
}

/** 执行一个动作 → 成功则刷新并提示影响条数 */
async function run(action: string, extra: Record<string, unknown>, okMsg: (result: unknown) => string) {
  const r = await callAdmin(action, extra)
  if (!r.ok) { setState(r.error ?? '执行失败', 'err'); return }
  const msg = okMsg(r.result)
  await refresh() // 内部结尾会写"已连接"，所以成功提示放在其后覆盖
  setState(msg, 'ok')
}

// ───── 交互 ─────
elConnect.addEventListener('click', () => {
  const v = elSecret.value.trim()
  if (!v) { setState('先填 ADMIN_SECRET', 'err'); return }
  secret = v
  try { sessionStorage.setItem(SECRET_KEY, v) } catch { /* 隐私模式下存不下也不影响本次会话 */ }
  void refresh()
})
elSecret.addEventListener('keydown', e => { if (e.key === 'Enter') elConnect.click() })

elRows.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!btn) return
  if (btn.dataset.act === 'row') {
    const seq = Number(btn.dataset.seq)
    if (!confirm(`抹掉第 ${seq} 条社区改动？画面会立刻回到这一笔之前的状态。`)) return
    void run('rollback_row', { seq }, r => `已回退第 ${seq} 条（影响 ${Number(r ?? 0)} 条）`)
  } else if (btn.dataset.act === 'author') {
    const author = btn.dataset.author!
    if (!confirm(`抹掉该作者（${shortHash(author)}）的全部社区改动？`)) return
    void run('rollback_author', { author_hash: author }, r => `已按作者回退 ${Number(r ?? 0)} 条`)
  }
})

elPaused.addEventListener('click', () => {
  const next = !paused
  void run(next ? 'pause' : 'resume', {}, () => (next ? '社区写入已暂停' : '社区写入已恢复'))
})

elRollbackSince.addEventListener('click', () => {
  if (!elSince.value) { setState('先选一个时间点', 'err'); return }
  const ts = new Date(elSince.value).toISOString()
  if (!confirm(`回退到 ${timeText(ts)}：该时刻之后的所有社区改动都会被抹掉。继续？`)) return
  void run('rollback_since', { ts }, r => `已回退 ${Number(r ?? 0)} 条改动`)
})

elReset.addEventListener('click', () => {
  const typed = prompt('全局重置会清空全部社区改动，回到纯调研基线。输入 RESET 确认：')
  if (typed !== 'RESET') return
  void run('reset_all', {}, r => `已清空 ${Number(r ?? 0)} 条社区改动`)
})

// ───── 初始状态 ─────
if (!COMMUNITY_ENABLED) {
  elConnect.disabled = true
  elSecret.disabled = true
  elHint.textContent =
    '还没配置后端：先在 src/community/config.ts 填好 SUPABASE_URL 与 anon key，并部署 supabase/functions/admin。'
} else {
  try { secret = sessionStorage.getItem(SECRET_KEY) ?? '' } catch { secret = '' }
  elHint.textContent = COMMUNITY_HINT
  if (secret) {
    elSecret.value = secret
    void refresh()
  } else {
    setState('等待密钥', '')
  }
}
