// 社区编辑后端配置（腾讯云 CloudBase，上海环境，国内直连）。
//
// 留空 TCB_API_BASE = 未接入：整个 src/community/ 不会被加载，应用行为与纯本地版本
// 完全一致（增删改色仍只写 localStorage 叠加层）。填好后社区层才生效。
//
// 这里只放公开的网关地址。任何密钥（ADMIN_SECRET / IP_SALT）都绝对不能出现在
// 这个文件里：它们只存在于数据库 app_secrets 表（公开角色连 SELECT 都被收回）。

/** CloudBase 环境 API 网关（PostgREST + auth 同源）。例：https://<envId>.api.tcloudbasegateway.com */
export const TCB_API_BASE: string = 'https://grotesque-catshark-d0ci5b3a82fe9.api.tcloudbasegateway.com'

/** 是否启用社区层：网关地址填了才算配置完成，避免半配置状态报错 */
export const COMMUNITY_ENABLED = TCB_API_BASE !== ''
