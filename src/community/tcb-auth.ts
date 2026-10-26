// CloudBase 匿名认证小模块：client.ts（社区层）与 admin.ts（管理页）共用。
//
// 流程：POST /auth/v1/signin/anonymously → access_token（角色 anon，默认 2h 有效）。
// 匿名身份不要求连续性（作者指纹在服务端按 IP 加盐哈希，与 token 无关），
// 所以 token 过期后直接重新登录即可，不走 refresh 流程。
import { TCB_API_BASE } from './config'

const DEVICE_KEY = 'polytech-tree:tcb-device-id'

/** 匿名登录要求的 x-device-id：生成一次后固定在 localStorage */
export function tcbDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return 'web-anonymous' // 隐私模式存不下：固定值也行，不影响功能
  }
}

let token = ''
let tokenExp = 0 // ms 时间戳
let loginInFlight: Promise<string> | null = null

/** 拿一个可用 token；过期或没有就重新匿名登录（并发请求共享同一次登录） */
export async function tcbGetToken(): Promise<string> {
  if (token && Date.now() < tokenExp - 60_000) return token
  loginInFlight ??= (async () => {
    const r = await fetch(`${TCB_API_BASE}/auth/v1/signin/anonymously`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-id': tcbDeviceId() },
      body: '{}',
    })
    if (!r.ok) throw new Error(`匿名登录失败 HTTP ${r.status}`)
    const j = (await r.json()) as { access_token?: string; expires_in?: number }
    if (!j.access_token) throw new Error('匿名登录响应缺 access_token')
    token = j.access_token
    tokenExp = Date.now() + (j.expires_in ?? 7200) * 1000
    return token
  })()
  try {
    return await loginInFlight
  } finally {
    loginInFlight = null
  }
}

/** 带匿名 token 调 CloudBase 网关（PostgREST / RPC 通用） */
export async function tcbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const tk = await tcbGetToken()
  return fetch(`${TCB_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tk}`,
      'Content-Type': 'application/json',
      'x-device-id': tcbDeviceId(),
      ...(init.headers ?? {}),
    },
  })
}
