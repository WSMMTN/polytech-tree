// ============================================================================
// supabase/functions/write —— 社区写入入口（匿名公开）
//
// 客户端提交 → 这里过一遍人机验证 / 签名 → 用 service_role 写进 edit_log。
// 之所以必须经服务端：Turnstile 校验需要 SECRET，签名 token 也只有服务端能签。
// 启用后记得把 community_config.direct_writes 置 false，堵死"拿 anon key 直连写"。
//
// 环境变量（supabase secrets set）：
//   TURNSTILE_SECRET   可选。配了就要求请求体带 turnstileToken，并在 Cloudflare 侧验票
//   TOKEN_SECRET       可选。配了就要求请求头 x-community-token 是一个
//                      HMAC(TOKEN_SECRET, `${issuedAt}`) 的签名，用于识别匿名作者
//   ALLOW_ORIGIN       可选。默认 https://wsmmtn.github.io
//
// 注意：真正的校验（结构 / 核心节点禁删 / 限流 / 熔断 / 暂停）在数据库触发器里，
// 这里只做前置的人机验证与身份签发，不重复实现一遍规则。
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET') ?? ''
const TOKEN_SECRET = Deno.env.get('TOKEN_SECRET') ?? ''
const ALLOW_ORIGIN = Deno.env.get('ALLOW_ORIGIN') ?? 'https://wsmmtn.github.io'

const cors = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type, x-community-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 校验 Turnstile；未配置 SECRET 时视为"未启用"放行（本地开发用） */
async function turnstileOk(token: string | undefined): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true
  if (!token) return false
  const form = new FormData()
  form.append('secret', TURNSTILE_SECRET)
  form.append('response', token)
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  const j = await r.json() as { success?: boolean }
  return j.success === true
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  let body: { op?: string; entity?: string; target_id?: string; payload?: unknown; turnstileToken?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'body 必须是 JSON' }, 400)
  }

  const { op, entity, target_id, payload } = body
  if (!op || !entity || !target_id) return json({ error: '缺少 op / entity / target_id' }, 400)

  if (!(await turnstileOk(body.turnstileToken))) {
    return json({ error: '人机验证未通过' }, 403)
  }

  // 匿名作者指纹：客户端每次带同一枚 token（由 /functions/issue 签发）→ 同一个人可被整体回退
  let authorHash: string | null = null
  let sig: string | null = null
  let issuedAt: string | null = null
  if (TOKEN_SECRET) {
    const token = req.headers.get('x-community-token') ?? ''
    const [ts, mac] = token.split('.')
    if (!ts || !mac || mac !== await hmacHex(TOKEN_SECRET, ts)) {
      return json({ error: 'token 无效或缺失' }, 403)
    }
    issuedAt = new Date(Number(ts)).toISOString()
    if (Date.now() - Number(ts) > 30 * 24 * 3600 * 1000) return json({ error: 'token 过旧，请重新获取' }, 403)
    sig = mac
    authorHash = await hmacHex(TOKEN_SECRET, `author:${ts}`)
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const { data, error } = await db
    .from('edit_log')
    .insert({ op, entity, target_id, payload })
    .select('seq')
    .single()

  if (error) {
    // 触发器里的 raise 会作为 error.message 原样带回，前端可直接展示
    return json({ error: error.message }, 400)
  }

  if (authorHash) {
    // 回填作者指纹（edit_meta 由 AFTER 触发器先写入 ip/ua 指纹）
    await db.from('edit_meta')
      .update({ author_hash: authorHash, sig, issued_at: issuedAt })
      .eq('seq', data.seq)
  }
  return json({ ok: true, seq: data.seq })
})
