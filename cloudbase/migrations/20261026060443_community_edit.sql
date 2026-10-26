-- ============================================================================
-- community_edit —— 社区编辑后端（腾讯云 CloudBase PostgreSQL 版）
--
-- 由 supabase/migrations/0001_community_edit.sql 适配而来，差异：
--   * CloudBase 的 HTTP API 就是 PostgREST，且 anon/authenticated/service_role
--     角色名与 Supabase 一致，RLS / 触发器 / 护栏全部原样可用。
--   * 去掉 pgcrypto（md5 是 PG 内置函数，用不到扩展）。
--   * Realtime 不可用时前端退化为轮询（客户端侧处理），publication 段保留容错。
--   * 管理端不依赖 Edge Function：新增 admin_action(p_secret, p_action, p_params)
--     分发 RPC，内部比对 app_secrets.admin_secret 后调用各 admin_* 函数，
--     前端 /admin 页直接以 anon 身份调它（密钥是唯一防线）。
--   * ip_salt / admin_secret 在此为占位值，部署后用 tcb db execute 改成随机串
--     （真值绝不进 git）。
-- ============================================================================

-- ── 配置表：开关 / 阈值 / 白名单 / 枚举（公开可读，只有 service_role 能改） ──────
create table if not exists public.community_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.community_config(key, value) values
  -- 全局暂停写入。置 true 后所有 INSERT 一律被触发器拒绝（管理员可随时开关）
  ('writes_paused', 'false'::jsonb),
  -- true = 允许匿名直连 PostgREST 写入；CloudBase 版没有 Edge Function 写路径，保持 true
  ('direct_writes', 'true'::jsonb),
  -- 限流与熔断阈值
  ('limits', '{
    "rate_per_ip": 20,
    "rate_window_seconds": 600,
    "delete_circuit": 30,
    "delete_window_seconds": 300
  }'::jsonb),
  -- 核心节点 id：禁止删除（与 data/core-ids.json 同步；改动数据后请重新生成这一段）
  ('protected_ids', '["fire","stone_tools","clothing","bow_and_arrow","language","boat_canoe","agriculture","irrigation","pottery","animal_husbandry","weaving_loom","plow","fermentation","sail","cuneiform_writing","bronze_metallurgy","wheel_axle","mathematics_early","glassmaking","chariot","iron_smelting","alphabet","papermaking","aqueduct","roman_concrete","geometry_deductive","seismoscope","gunpowder","compass_navigation","woodblock_printing","mechanical_clock","paper_money","blast_furnace","windmill","horse_collar","movable_type_printing","telescope","microscope","heliocentric_model","logarithm","barometer","calculus","steam_engine","spinning_jenny","power_loom","railway_locomotive","telegraph","photography","bessemer_steel","electricity_generation","incandescent_lamp","telephone","radio","internal_combustion_engine","automobile","airplane","assembly_line","alternating_current","dynamite","refrigeration","penicillin","jet_engine","nuclear_reactor","transistor","electronic_computer","stored_program_computer","dna_double_helix","artificial_satellite","rocket_engine","oral_contraceptive","laser","microprocessor","personal_computer","internet","world_wide_web","email","mobile_phone","fiber_optics_comm","lcd_display","smartphone","deep_learning","crispr_gene_editing","reusable_rocket","human_genome_project","cloud_computing","mrna_vaccine","large_language_model","electric_vehicle"]'::jsonb),
  -- 枚举白名单（与 scripts/validate_data.py 保持一致）
  ('enums', '{
    "eras": ["prehistory","neolithic","bronze_age","antiquity","middle_ages","renaissance","industrial","second_industrial","atomic_electronic","information","intelligent"],
    "categories": ["math_pure","logic_foundations","algorithms_cs","computing_systems","info_media","physics","chemistry","life_medicine","earth_space","materials","manufacturing","energy_power","construction","transport","agriculture_food","military","space_exploration","governance","economy","education_knowledge","culture_media","daily_life"],
    "kinds": ["原理","工艺","器物","制度","媒介"],
    "year_basis": ["exact","decade","century","circa","range_midpoint","scholarly_disputed","convention_floor","batch_asserted"]
  }'::jsonb)
on conflict (key) do nothing;

-- ── 密钥表：公开角色完全读不到（不建任何 RLS 策略）；只有 service_role 与授权函数可用 ──
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);
-- ip_salt：IP/UA 指纹的加盐值，避免被彩虹表反查。部署后改成随机串。
-- admin_secret：管理端密钥（admin_action RPC 校验用）。部署后改成随机长串。
insert into public.app_secrets(key, value) values
  ('ip_salt', 'CHANGE-ME-polytech-tree-salt'),
  ('admin_secret', 'CHANGE-ME-admin-secret')
on conflict (key) do nothing;

-- ── 日志表：唯一事实源，append-only ──────────────────────────────────────────
create table if not exists public.edit_log (
  seq        bigserial primary key,
  created_at timestamptz not null default now(),
  op         text not null check (op in ('add', 'update', 'delete', 'color')),
  entity     text not null check (entity in ('tech', 'color')),
  -- 被操作的对象 id：tech 为节点 id；color 为被改色的节点 id
  target_id  text not null check (char_length(target_id) between 1 and 64),
  -- op=add/update 时是完整节点（schema 同 data/techs.json）；op=color 时是 "#rrggbb"；
  -- op=delete 时为 null
  payload    jsonb
);
create index if not exists edit_log_created_idx on public.edit_log (created_at);
create index if not exists edit_log_target_idx  on public.edit_log (target_id);

-- ── 指纹表：与 edit_log 一一对应，公开角色读不到 ─────────────────────────────
create table if not exists public.edit_meta (
  seq         bigint primary key references public.edit_log(seq) on delete cascade,
  created_at  timestamptz not null default now(),
  ip_hash     text,
  ua_hash     text,
  -- 匿名作者指纹：默认等于 ip_hash。「按作者回退」就靠这一列
  author_hash text,
  sig         text,
  issued_at   timestamptz
);
create index if not exists edit_meta_ip_idx     on public.edit_meta (ip_hash, created_at);
create index if not exists edit_meta_author_idx on public.edit_meta (author_hash);

-- ============================================================================
-- 辅助函数
-- ============================================================================

/** 读一条配置（配置本身公开可读，这里只是省得每处写子查询） */
create or replace function public.cfg_json(p_key text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select value from public.community_config where key = p_key;
$$;

/** 读一个布尔开关（缺省时回落到 p_default） */
create or replace function public.cfg_bool(p_key text, p_default boolean)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((public.cfg_json(p_key))::boolean, p_default);
$$;

/** 是否核心节点（禁止删除） */
create or replace function public.is_protected(p_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.cfg_json('protected_ids') ? p_id, false);
$$;

/** 当前请求的角色（PostgREST 把 JWT claims 放在同名的 GUC 里；SQL 直连时为空） */
create or replace function public.request_role()
returns text
language sql stable set search_path = public, pg_temp as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
$$;

/** 当前请求的 IP（经 PostgREST 转发的头；客户端无法伪造） */
create or replace function public.request_ip()
returns text
language sql stable set search_path = public, pg_temp as $$
  select btrim(split_part(coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for',
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'cf-connecting-ip', ''), ',', 1));
$$;

/** 加盐哈希：IP / UA 指纹（隐私上只存哈希，且加盐防彩虹表） */
create or replace function public.salted_hash(p_raw text)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when coalesce(p_raw, '') = '' then null
              else md5(p_raw || ':' || coalesce((select value from public.app_secrets where key = 'ip_salt'), 'polytech-tree')) end;
$$;

/**
 * 结构校验：规则对齐 scripts/validate_data.py 的主干部分。
 * 违反一律 raise，PostgREST 会把它变成 400/403，客户端拿不到半条脏数据。
 */
create or replace function public.assert_valid_edit(
  p_op text, p_entity text, p_target text, p_payload jsonb
) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  enums jsonb;
  rec   jsonb;
  imp   int;
begin
  enums := coalesce(public.cfg_json('enums'), '{}'::jsonb);

  if p_op in ('add', 'update') then
    if p_entity <> 'tech' then
      raise exception 'op=% 只允许 entity=tech', p_op using errcode = '22023';
    end if;
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
      raise exception 'payload 必须是对象' using errcode = '22023';
    end if;
    rec := p_payload;

    -- 新增节点必须用 user- 前缀：既保证不和基线 id 撞车，也保证不会"覆盖"核心条目
    if p_op = 'add' and p_target not like 'user-%' then
      raise exception '新增节点 id 必须以 user- 开头（收到 %）', p_target using errcode = '22023';
    end if;
    if rec ->> 'id' is distinct from p_target then
      raise exception 'payload.id 与 target_id 不一致' using errcode = '22023';
    end if;

    if btrim(coalesce(rec ->> 'name', '') || coalesce(rec ->> 'nameEn', '')) = '' then
      raise exception 'name / nameEn 不能都为空' using errcode = '22023';
    end if;
    if coalesce(rec ->> 'year', '') !~ '^-?[0-9]{1,7}$' then
      raise exception 'year 非法：%', coalesce(rec ->> 'year', '<缺失>') using errcode = '22023';
    end if;
    if not (enums -> 'eras' ? (rec ->> 'era')) then
      raise exception 'era 非法：%', coalesce(rec ->> 'era', '<缺失>') using errcode = '22023';
    end if;
    if not (enums -> 'categories' ? (rec ->> 'category')) then
      raise exception 'category 非法：%', coalesce(rec ->> 'category', '<缺失>') using errcode = '22023';
    end if;
    if coalesce(rec ->> 'year_basis', '') <> ''
       and not (enums -> 'year_basis' ? (rec ->> 'year_basis')) then
      raise exception 'year_basis 非法：%', rec ->> 'year_basis' using errcode = '22023';
    end if;
    if coalesce(rec ->> 'kind', '') <> ''
       and not (enums -> 'kinds' ? (rec ->> 'kind')) then
      raise exception 'kind 非法：%', rec ->> 'kind' using errcode = '22023';
    end if;

    imp := nullif(rec ->> 'importance', '')::int;
    if imp is null or imp < 1 or imp > 5 then
      raise exception 'importance 越界：%', coalesce(rec ->> 'importance', '<缺失>') using errcode = '22023';
    end if;

    if jsonb_typeof(coalesce(rec -> 'prereqs', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(rec -> 'related', '[]'::jsonb)) <> 'array' then
      raise exception 'prereqs / related 必须是数组' using errcode = '22023';
    end if;
    -- 基线里每条最多 4 条关系边；社区侧放宽到 8，避免把"稍多条"的人一棍子打死
    if jsonb_array_length(coalesce(rec -> 'prereqs', '[]'::jsonb)) > 8
       or jsonb_array_length(coalesce(rec -> 'related', '[]'::jsonb)) > 8 then
      raise exception '关系边过多（上限 8）' using errcode = '22023';
    end if;
    if rec -> 'prereqs' @> to_jsonb(array[p_target])
       or rec -> 'related' @> to_jsonb(array[p_target]) then
      raise exception '自引用：% 指向了自己', p_target using errcode = '22023';
    end if;
    if char_length(coalesce(rec ->> 'desc', '')) > 200 then
      raise exception 'desc 过长（上限 200 字）' using errcode = '22023';
    end if;

  elsif p_op = 'delete' then
    if p_entity <> 'tech' then
      raise exception 'delete 只允许 entity=tech' using errcode = '22023';
    end if;
    if public.is_protected(p_target) then
      raise exception '核心节点禁止删除：%', p_target using errcode = '42501';
    end if;

  elsif p_op = 'color' then
    if p_entity <> 'color' then
      raise exception 'color 只允许 entity=color' using errcode = '22023';
    end if;
    -- null = 恢复领域色
    if p_payload is not null
       and (jsonb_typeof(p_payload) <> 'string' or (p_payload #>> '{}') !~* '^#[0-9a-f]{6}$') then
      raise exception '颜色必须形如 #rrggbb，或 null（恢复领域色）' using errcode = '22023';
    end if;

  else
    raise exception '未知 op：%', p_op using errcode = '22023';
  end if;
end $$;

-- ============================================================================
-- 写入护栏：BEFORE INSERT
-- ============================================================================
create or replace function public.edit_log_guard()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  lim      jsonb;
  role_txt text;
  ip_h     text;
  r_window int;  r_max int;
  d_window int;  d_max int;
  n_rate   int;
  n_del    int;
begin
  -- 1) 全局暂停开关（管理员随时可停；熔断也会把它置上）
  if public.cfg_bool('writes_paused', false) then
    raise exception '社区写入当前已暂停（管理员关闭中）' using errcode = '55000';
  end if;

  -- 2) 预留的服务端写入开关（CloudBase 版保持 direct_writes=true，此分支不生效；
  --    role 取不到 = SQL 直连/迁移脚本，视为运维操作放行）
  role_txt := public.request_role();
  if not public.cfg_bool('direct_writes', true)
     and role_txt <> '' and role_txt <> 'service_role' then
    raise exception '社区写入必须经服务端提交' using errcode = '42501';
  end if;

  -- 3) 结构校验 + 核心节点禁删
  perform public.assert_valid_edit(new.op, new.entity, new.target_id, new.payload);

  lim      := coalesce(public.cfg_json('limits'), '{}'::jsonb);
  r_window := coalesce((lim ->> 'rate_window_seconds')::int, 600);
  r_max    := coalesce((lim ->> 'rate_per_ip')::int, 20);
  d_window := coalesce((lim ->> 'delete_window_seconds')::int, 300);
  d_max    := coalesce((lim ->> 'delete_circuit')::int, 30);

  -- 4) 按 IP 限流。指纹在 AFTER 触发器才落 edit_meta，所以这里查历史记录
  ip_h := public.salted_hash(public.request_ip());
  if ip_h is not null then
    select count(*) into n_rate
      from public.edit_meta
     where ip_hash = ip_h
       and created_at > now() - make_interval(secs => r_window);
    if n_rate >= r_max then
      raise exception '写入过于频繁（% 秒内上限 % 条），请稍后再试', r_window, r_max using errcode = '54000';
    end if;
  end if;

  -- 5) 熔断：短窗口内删除量异常 → 自动暂停写入，交管理员人工恢复
  select count(*) into n_del
    from public.edit_log
   where op = 'delete' and created_at > now() - make_interval(secs => d_window);
  if n_del >= d_max then
    update public.community_config
       set value = 'true'::jsonb, updated_at = now()
     where key = 'writes_paused';
    raise exception '检测到异常批量删除，已自动暂停社区写入' using errcode = '55000';
  end if;

  new.created_at := now(); -- 时间以服务端为准，客户端塞不进顺序
  return new;
end $$;

drop trigger if exists edit_log_guard_trg on public.edit_log;
create trigger edit_log_guard_trg
  before insert on public.edit_log
  for each row execute function public.edit_log_guard();

-- ============================================================================
-- 指纹落库：AFTER INSERT
-- IP / UA 不挂在 edit_log 上，单独落到 edit_meta —— 公开角色对它没有任何策略。
-- ============================================================================
create or replace function public.edit_meta_write()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  hdrs jsonb;
  ip_h text;
begin
  hdrs := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  ip_h := public.salted_hash(public.request_ip());

  insert into public.edit_meta (seq, created_at, ip_hash, ua_hash, author_hash)
  values (
    new.seq,
    new.created_at,
    ip_h,
    public.salted_hash(hdrs ->> 'user-agent'),
    -- 作者指纹退化为 IP 指纹（仅够用于"按来源回退"）
    ip_h
  )
  on conflict (seq) do nothing;
  return null;
end $$;

drop trigger if exists edit_meta_write_trg on public.edit_log;
create trigger edit_meta_write_trg
  after insert on public.edit_log
  for each row execute function public.edit_meta_write();

-- ============================================================================
-- RLS：公开角色只能"读日志 + 追加日志"
-- ============================================================================
alter table public.edit_log         enable row level security;
alter table public.edit_meta        enable row level security;
alter table public.community_config enable row level security;
alter table public.app_secrets      enable row level security;

-- edit_log：任何人可读、可追加；没有 UPDATE/DELETE 策略 = 谁都改不掉历史
drop policy if exists edit_log_read on public.edit_log;
drop policy if exists edit_log_append on public.edit_log;
create policy edit_log_read   on public.edit_log for select using (true);
create policy edit_log_append on public.edit_log for insert with check (true);

-- community_config：只读（暂停开关要给前端看见）
drop policy if exists config_read on public.community_config;
create policy config_read on public.community_config for select using (true);

-- edit_meta / app_secrets：不建任何策略 → 公开角色一行都读不到（service_role 不受限）

-- 列级授权：可写列钉死在 op/entity/target_id/payload，免得有人往 created_at / seq
-- 里塞值搅乱回放顺序；可读列只给前端回放需要的那些
grant select (seq, created_at, op, entity, target_id, payload) on public.edit_log to anon, authenticated;
grant insert (op, entity, target_id, payload)          on public.edit_log to anon, authenticated;
grant usage on sequence public.edit_log_seq_seq to anon, authenticated;
grant select on public.community_config to anon, authenticated;
-- edit_meta / app_secrets 不 grant —— RLS 之外再加一道

-- ============================================================================
-- Realtime：CloudBase 版前端用轮询，不依赖发布；此处仅容错尝试
-- ============================================================================
do $$
begin
  begin
    alter publication supabase_realtime add table public.edit_log;
  exception
    when duplicate_object then null;   -- 已经加过了
    when undefined_object then null;   -- 该实例没开 supabase_realtime 发布
  end;
end $$;

-- ============================================================================
-- 回退 / 运维函数（只有 service_role 与 admin_action 分发器能执行）
-- 四种粒度：单条 / 按作者 / 按时间点 / 全局。
-- ============================================================================

/** 回退单条社区改动（某人把某节点改坏了，只抹这一笔） */
create or replace function public.admin_rollback_row(p_seq bigint)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.edit_log where seq = p_seq;
  get diagnostics n = row_count;
  return n;
end $$;

/** 回退某个匿名作者的全部改动（作者指纹在 edit_meta.author_hash） */
create or replace function public.admin_rollback_author(p_author_hash text)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.edit_log
   where seq in (select seq from public.edit_meta where author_hash = p_author_hash);
  get diagnostics n = row_count;
  return n;
end $$;

/** 回退到某个时间点（删除该时刻之后的所有社区改动 = 回到那时快照） */
create or replace function public.admin_rollback_since(p_ts timestamptz)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.edit_log where created_at >= p_ts;
  get diagnostics n = row_count;
  return n;
end $$;

/** 全局重置：清空社区层，回到纯基线（调用前先导出备份） */
create or replace function public.admin_reset_all()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.edit_log;
  get diagnostics n = row_count;
  return n;
end $$;

/** 暂停 / 恢复社区写入 */
create or replace function public.admin_set_paused(p_paused boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.community_config
     set value = to_jsonb(p_paused), updated_at = now()
   where key = 'writes_paused';
end $$;

/** 管理端看板：最近的社区改动（含作者指纹），供 /admin 列表用 */
create or replace function public.admin_recent_edits(p_limit integer default 100)
returns table (seq bigint, created_at timestamptz, op text, entity text, target_id text,
               payload jsonb, author_hash text, ip_hash text)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.seq, l.created_at, l.op, l.entity, l.target_id, l.payload, m.author_hash, m.ip_hash
    from public.edit_log l
    left join public.edit_meta m on m.seq = l.seq
   order by l.seq desc
   limit greatest(1, least(coalesce(p_limit, 100), 1000));
$$;

/**
 * 管理动作分发器（CloudBase 版替代 Edge Function admin）：
 * 前端 /admin 页以 anon 身份调它，唯一防线是 app_secrets.admin_secret。
 * 密钥只存在这张表里与用户手输的 sessionStorage，绝不进前端构建产物。
 */
create or replace function public.admin_action(
  p_secret text, p_action text, p_params jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  real_secret text;
  n           integer;
begin
  select value into real_secret from public.app_secrets where key = 'admin_secret';
  if real_secret is null or real_secret like 'CHANGE-ME%'
     or coalesce(p_secret, '') = '' or p_secret <> real_secret then
    raise exception '管理密钥错误或尚未配置' using errcode = '42501';
  end if;

  case p_action
    when 'status' then
      return (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.community_config);
    when 'list' then
      return (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select seq, created_at, op, entity, target_id, payload, author_hash
          from public.admin_recent_edits(greatest(1, least(coalesce((p_params ->> 'limit')::int, 100), 1000)))
        -- 上面的返回列顺序即 JSON 键序；再按 seq 倒序包一层保证输出有序
        order by seq desc
      ) t);
    when 'rollback_row' then
      n := public.admin_rollback_row((p_params ->> 'seq')::bigint);
      return to_jsonb(n);
    when 'rollback_author' then
      n := public.admin_rollback_author(p_params ->> 'author_hash');
      return to_jsonb(n);
    when 'rollback_since' then
      n := public.admin_rollback_since((p_params ->> 'ts')::timestamptz);
      return to_jsonb(n);
    when 'reset_all' then
      n := public.admin_reset_all();
      return to_jsonb(n);
    when 'pause' then
      perform public.admin_set_paused(true);
      return 'true'::jsonb;
    when 'resume' then
      perform public.admin_set_paused(false);
      return 'false'::jsonb;
    else
      raise exception '未知管理动作：%', p_action using errcode = '22023';
  end case;
end $$;

-- PostgreSQL 默认把 EXECUTE 授给 PUBLIC：先收回，再按需授权
revoke execute on function public.admin_rollback_row(bigint)        from public, anon, authenticated;
revoke execute on function public.admin_rollback_author(text)       from public, anon, authenticated;
revoke execute on function public.admin_rollback_since(timestamptz) from public, anon, authenticated;
revoke execute on function public.admin_reset_all()                 from public, anon, authenticated;
revoke execute on function public.admin_set_paused(boolean)         from public, anon, authenticated;
revoke execute on function public.admin_recent_edits(integer)       from public, anon, authenticated;
revoke execute on function public.admin_action(text, text, jsonb)   from public, anon, authenticated;
grant execute on function public.admin_rollback_row(bigint)        to service_role;
grant execute on function public.admin_rollback_author(text)       to service_role;
grant execute on function public.admin_rollback_since(timestamptz) to service_role;
grant execute on function public.admin_reset_all()                 to service_role;
grant execute on function public.admin_set_paused(boolean)         to service_role;
grant execute on function public.admin_recent_edits(integer)       to service_role;
-- admin_action 内部自校验密钥，anon 可调用（否则 /admin 页进不了门）
grant execute on function public.admin_action(text, text, jsonb)   to anon, authenticated;

-- ============================================================================
-- 备份：CloudBase 控制台 → 数据库 → 备份；迁移后请确认备份策略已开启。
-- ============================================================================
