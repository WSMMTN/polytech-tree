// 社区编辑后端配置（Supabase）。
//
// 留空 = 未接入：整个 src/community/ 不会被加载，应用行为与纯本地版本完全一致
// （增删改色仍只写 localStorage 叠加层）。填好下面两项后社区层才生效。
//
// 这里只放 SUPABASE_URL 和 anon 公钥——它们本来就是公开的，RLS 已经把权限限死。
// 任何密钥（ADMIN_SECRET / TURNSTILE_SECRET / TOKEN_SECRET / service_role KEY）
// 都绝对不能出现在这个文件里，它们只存在于 Supabase 的环境变量中。

/** Supabase 项目地址，例：https://abcdefg.supabase.co */
export const SUPABASE_URL: string = 'https://bajnkublgrrlqnoarchv.supabase.co'

/** anon 公钥（Settings → API → anon public）。只用于读日志 + 追加日志 */
export const SUPABASE_ANON_KEY: string = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJham5rdWJsZ3JybHFub2FyY2h2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNDg0MzMsImV4cCI6MjEwNzYyNDQzM30.wwO6fdmxvfxVxCflpFWPsHjQX9VryaJ_0AekLqtSyR8'

/** 是否启用社区层：URL 与 anon key 都填了才算配置完成，避免半配置状态报错 */
export const COMMUNITY_ENABLED = SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== ''

/** 写入是否走 Edge Function（functions/write）。启用 Turnstile / 签名 token 后必须为 true */
export const USE_WRITE_FUNCTION = false

/** 是否订阅 Realtime 增量（关掉就只在本地写入后刷新） */
export const USE_REALTIME = true
