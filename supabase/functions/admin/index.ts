// ============================================================================
// supabase/functions/admin —— 管理端（只有你知道 ADMIN_SECRET）
//
// 这是"随时删除 / 回退任何社区改动"的唯一入口。ADMIN_SECRET 只存在于
// Edge Function 的环境变量里，前端页面永远不碰它。
//
// 环境变量：ADMIN_SECRET（必填）、ALLOW_ORIGIN（可选，默认只允许你的 Pages 域名）
//
// 调用方式（前端 /admin 页面或 curl）：
//   POST <project>/functions/v1/admin
//   headers: x-admin-secret: <ADMIN_SECRET>
//   body:    { "action": "...", ... }
//   action 取值：
//     status                {}                    读取开关状态（writes_paused 等）
//     list                  { limit? }            列出最近改动（含作者指纹）
//     rollback_row          { seq }               抹掉某一笔
//     rollback_author       { author_hash }       抹掉某人全部改动
//     rollback_since        { ts }                回到某时刻（ISO 时间）
//     reset_all             {}                    全局重置
//     pause                 {} / resume  {}        暂停 / 恢复写入
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ADMIN_SECRET = Deno.env.get('ADMIN_SECRET') ?? ''
const ALLOW_ORIGIN = Deno.env.get('ALLOW_ORIGIN') ?? 'https://wsmmtn.github.io'

const cors = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type, x-admin-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  if (!ADMIN_SECRET) return json({ error: '服务端未配置 ADMIN_SECRET' }, 500)
  if (req.headers.get('x-admin-secret') !== ADMIN_SECRET) return json({ error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'body 必须是 JSON' }, 400)
  }
  const action = String(body.action ?? '')
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args)
    return error ? json({ error: error.message }, 400) : json({ ok: true, result: data })
  }

  switch (action) {
    case 'status': { // 开关状态（writes_paused 等）供 /admin 渲染暂停按钮
      const { data, error } = await db.from('community_config').select('key, value')
      if (error) return json({ error: error.message }, 400)
      const cfg: Record<string, unknown> = {}
      for (const r of (data ?? []) as { key: string; value: unknown }[]) cfg[r.key] = r.value
      return json({ ok: true, result: cfg })
    }
    case 'list':
      return rpc('admin_recent_edits', { p_limit: Number(body.limit ?? 100) })
    case 'rollback_row': // 单条回退
      return rpc('admin_rollback_row', { p_seq: Number(body.seq) })
    case 'rollback_author': // 按作者回退
      return rpc('admin_rollback_author', { p_author_hash: String(body.author_hash ?? '') })
    case 'rollback_since': // 按时间点回退
      return rpc('admin_rollback_since', { p_ts: String(body.ts ?? '') })
    case 'reset_all': // 全局重置（建议先 list 导出备份）
      return rpc('admin_reset_all', {})
    case 'pause':
      return rpc('admin_set_paused', { p_paused: true })
    case 'resume':
      return rpc('admin_set_paused', { p_paused: false })
    default:
      return json({ error: `未知 action: ${action}` }, 400)
  }
})
