create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users (id) on delete cascade,
  public_id uuid not null unique default gen_random_uuid(),
  handle text not null unique
    check (handle ~ '^[a-z0-9_]{3,24}$' and handle <> 'everyone'),
  display_name text not null
    check (char_length(display_name) between 2 and 40),
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  target_profile_id uuid references public.profiles (id) on delete cascade,
  asker_profile_id uuid references public.profiles (id) on delete set null,
  asker_user_id uuid references auth.users (id) on delete set null,
  body text not null
    check (char_length(btrim(body)) between 3 and 500),
  created_at timestamptz not null default now()
);

alter table public.questions
  add column if not exists asker_profile_id uuid
  references public.profiles (id) on delete set null;
alter table public.questions
  add column if not exists asker_user_id uuid
  references auth.users (id) on delete set null;

create index if not exists questions_created_at_idx
  on public.questions (created_at desc);
create index if not exists questions_target_created_at_idx
  on public.questions (target_profile_id, created_at desc);

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null unique references public.questions (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.answers enable row level security;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  kind text not null check (kind in ('new_question', 'answer')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  email_status text not null default 'pending'
    check (email_status in ('pending', 'sending', 'sent', 'failed')),
  email_started_at timestamptz,
  email_sent_at timestamptz,
  unique (recipient_id, question_id, kind)
);

alter table public.notifications
  add column if not exists email_started_at timestamptz;

create index if not exists notifications_recipient_created_idx
  on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_pending_email_idx
  on public.notifications (created_at)
  where email_status = 'pending';

alter table public.notifications enable row level security;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email_confirmed_at is null then
    return new;
  end if;

  insert into public.profiles (owner_id, handle, display_name)
  values (
    new.id,
    lower(new.raw_user_meta_data ->> 'username'),
    new.raw_user_meta_data ->> 'display_name'
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists create_profile_after_signup on auth.users;
create trigger create_profile_after_signup
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();

drop trigger if exists create_profile_after_verification on auth.users;
create trigger create_profile_after_verification
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.create_profile_for_new_user();

create or replace function public.notify_profile_owner_of_question()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.notifications (recipient_id, question_id, kind)
  select profile.owner_id, new.id, 'new_question'
  from public.profiles as profile
  where profile.id = new.target_profile_id
    and (auth.uid() is null or profile.owner_id <> auth.uid())
    and not exists (
      select 1
      from public.profiles as asker
      where asker.id = new.asker_profile_id
        and asker.owner_id = profile.owner_id
    )
  on conflict (recipient_id, question_id, kind) do nothing;
  return new;
end;
$$;

drop trigger if exists notify_profile_owner_of_question on public.questions;
create trigger notify_profile_owner_of_question
  after insert on public.questions
  for each row execute function public.notify_profile_owner_of_question();

create or replace function public.broadcast_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_id uuid;
  v_question_id uuid;
  v_public_id uuid;
begin
  if tg_table_name = 'questions' then
    if tg_op = 'DELETE' then
      v_profile_id := old.target_profile_id;
    else
      v_profile_id := new.target_profile_id;
    end if;

    select profile.public_id into v_public_id
    from public.profiles as profile
    where profile.id = v_profile_id;
  else
    if tg_op = 'DELETE' then
      v_question_id := old.question_id;
    else
      v_question_id := new.question_id;
    end if;

    select profile.public_id into v_public_id
    from public.questions as question
    join public.profiles as profile on profile.id = question.target_profile_id
    where question.id = v_question_id;
  end if;

  if v_public_id is not null then
    perform realtime.send(
      payload => jsonb_build_object('profile_id', v_public_id),
      event => 'profile_updated',
      topic => 'profile:' || v_public_id::text,
      private => false
    );
  end if;
  return null;
end;
$$;

drop trigger if exists broadcast_profile_question_update on public.questions;
create trigger broadcast_profile_question_update
  after insert or update or delete on public.questions
  for each row execute function public.broadcast_profile_update();

create or replace function public.notify_asker_of_answer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.notifications (recipient_id, question_id, kind)
  select question.asker_user_id, question.id, 'answer'
  from public.questions as question
  join public.profiles as owner on owner.id = question.target_profile_id
  where question.id = new.question_id
    and question.asker_user_id is not null
    and question.asker_user_id <> owner.owner_id
  on conflict (recipient_id, question_id, kind) do nothing;
  return new;
end;
$$;

drop trigger if exists notify_asker_of_answer on public.answers;
create trigger notify_asker_of_answer
  after insert on public.answers
  for each row execute function public.notify_asker_of_answer();

drop trigger if exists broadcast_profile_answer_update on public.answers;
create trigger broadcast_profile_answer_update
  after insert or update or delete on public.answers
  for each row execute function public.broadcast_profile_update();

create table if not exists public.identifier_lookup_limits (
  key_hash text primary key,
  window_started_at timestamptz not null,
  request_count integer not null
);
alter table public.identifier_lookup_limits enable row level security;

create or replace function public.resolve_login_identifier(p_identifier text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_identifier text := lower(btrim(p_identifier));
  v_user_id uuid;
  v_email text;
  v_kind text;
begin
  if position('@' in v_identifier) > 0 then
    select id, email into v_user_id, v_email
    from auth.users
    where lower(email) = v_identifier
    limit 1;
    v_kind := 'email';
  else
    select users.id, users.email into v_user_id, v_email
    from auth.users as users
    where lower(users.raw_user_meta_data ->> 'username') = v_identifier
       or exists (
         select 1 from public.profiles as profile
         where profile.owner_id = users.id and profile.handle = v_identifier
       )
    limit 1;
    v_kind := 'username';
  end if;

  if v_user_id is null then
    return jsonb_build_object('exists', false);
  end if;
  return jsonb_build_object('exists', true, 'kind', v_kind, 'email', v_email);
end;
$$;

create or replace function public.consume_identifier_lookup(p_key_hash text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into public.identifier_lookup_limits (key_hash, window_started_at, request_count)
  values (p_key_hash, now(), 1)
  on conflict (key_hash) do update
  set request_count = case
        when identifier_lookup_limits.window_started_at < now() - interval '10 minutes' then 1
        else identifier_lookup_limits.request_count + 1
      end,
      window_started_at = case
        when identifier_lookup_limits.window_started_at < now() - interval '10 minutes' then now()
        else identifier_lookup_limits.window_started_at
      end
  returning request_count into v_count;

  return v_count <= 10;
end;
$$;

create or replace function public.purge_expired_question_content()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if to_regclass('public.answers') is not null then
    execute 'delete from public.answers where created_at < now() - interval ''2 months''';
  end if;
  delete from public.questions
  where created_at < now() - interval '2 months';
end;
$$;

create or replace function public.can_disclose_question_asker(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = p_profile_id
      and profile.owner_id = auth.uid()
  );
$$;

alter table public.profiles enable row level security;
alter table public.questions enable row level security;

drop policy if exists "Owners can read their profiles" on public.profiles;
create policy "Owners can read their profiles"
  on public.profiles for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "Authenticated users can create one profile" on public.profiles;
create policy "Authenticated users can create one profile"
  on public.profiles for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists "Owners can update their profiles" on public.profiles;
create policy "Owners can update their profiles"
  on public.profiles for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "Only public questions are readable from the feed" on public.questions;
create policy "Only public questions are readable from the feed"
  on public.questions for select
  to anon, authenticated
  using (target_profile_id is null);

drop policy if exists "Anyone can ask an anonymous question" on public.questions;
create policy "Anyone can ask an anonymous question"
  on public.questions for insert
  to anon, authenticated
  with check (
    target_profile_id is not null
    and char_length(btrim(body)) between 3 and 500
    and (
      asker_profile_id is null
      or public.can_disclose_question_asker(asker_profile_id)
    )
  );

drop policy if exists "Users can read their notifications" on public.notifications;
create policy "Users can read their notifications"
  on public.notifications for select
  to authenticated
  using (recipient_id = (select auth.uid()));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'notifications'
     ) then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end;
$$;

create or replace function public.get_shared_profile(p_share_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', profile.id,
    'public_id', profile.public_id,
    'handle', profile.handle,
    'display_name', profile.display_name,
    'questions', case
      when profile.owner_id = auth.uid() then coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', question.id,
              'body', question.body,
              'created_at', question.created_at,
              'can_manage_question', coalesce(question.asker_user_id = auth.uid(), false),
              'can_delete_question', coalesce(question.asker_user_id = auth.uid(), false)
                and not exists (
                  select 1 from public.answers as answer
                  where answer.question_id = question.id
                ),
              'asker', case
                when asker.id is null then null
                else jsonb_build_object('handle', asker.handle, 'display_name', asker.display_name)
              end,
              'answer', (
                select jsonb_build_object(
                  'body', answer.body,
                  'created_at', answer.created_at,
                  'updated_at', answer.updated_at
                )
                from public.answers as answer
                where answer.question_id = question.id
                limit 1
              )
            )
            order by question.created_at desc
          )
          from (
            select id, target_profile_id, asker_profile_id, asker_user_id, body, created_at
            from public.questions
            where target_profile_id = profile.id
            order by created_at desc
            limit 50
          ) as question
          left join public.profiles as asker on asker.id = question.asker_profile_id
        ),
        '[]'::jsonb
      )
      else coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', question.id,
              'body', question.body,
              'created_at', question.created_at,
              'can_manage_question', coalesce(question.asker_user_id = auth.uid(), false),
              'can_delete_question', coalesce(question.asker_user_id = auth.uid(), false)
                and answer.question_id is null,
              'answer', case
                when answer.question_id is null then null
                else jsonb_build_object(
                  'body', answer.body,
                  'created_at', answer.created_at,
                  'updated_at', answer.updated_at
                )
              end
              )
            order by question.created_at desc
          )
          from (
            select question_row.id, question_row.target_profile_id, question_row.asker_profile_id, question_row.asker_user_id, question_row.body, question_row.created_at
            from public.questions as question_row
            where question_row.target_profile_id = profile.id
              and (
                question_row.asker_user_id = auth.uid()
                or exists (
                  select 1 from public.answers as answer
                  where answer.question_id = question_row.id
                )
              )
            order by question_row.created_at desc
            limit 50
          ) as question
          left join public.answers as answer on answer.question_id = question.id
        ),
        '[]'::jsonb
      )
    end
  )
  from public.profiles as profile
  where profile.public_id = p_share_id
  limit 1;
$$;

create or replace function public.answer_profile_question(
  p_question_id uuid,
  p_body text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_answer text := btrim(p_body);
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if v_answer is null or char_length(v_answer) not between 1 and 2000 then
    raise exception 'Answer must be between 1 and 2000 characters' using errcode = '22023';
  end if;

  select profile.owner_id into v_owner_id
  from public.questions as question
  join public.profiles as profile on profile.id = question.target_profile_id
  where question.id = p_question_id;

  if v_owner_id is null or v_owner_id <> auth.uid() then
    raise exception 'Only the profile owner can answer this question' using errcode = '42501';
  end if;

  insert into public.answers (question_id, body)
  values (p_question_id, v_answer)
  on conflict (question_id) do update
  set body = excluded.body, updated_at = now();
end;
$$;

create or replace function public.update_profile_question(
  p_question_id uuid,
  p_body text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(p_body);
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if v_body is null or char_length(v_body) not between 3 and 500 then
    raise exception 'Question must be between 3 and 500 characters' using errcode = '22023';
  end if;

  update public.questions
  set body = v_body
  where id = p_question_id
    and asker_user_id = auth.uid();
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'Only the question author can update this question' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.delete_profile_question(
  p_question_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  delete from public.questions as question
  where question.id = p_question_id
    and question.asker_user_id = auth.uid()
    and not exists (
      select 1 from public.answers
      where question_id = question.id
    );
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    raise exception 'Only the question author can delete this question' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.delete_profile_answer(
  p_question_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  delete from public.answers as answer
  using public.questions as question, public.profiles as profile
  where answer.question_id = p_question_id
    and question.id = answer.question_id
    and profile.id = question.target_profile_id
    and profile.owner_id = auth.uid();
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    raise exception 'Only the profile owner can delete this reply' using errcode = '42501';
  end if;

  delete from public.notifications
  where question_id = p_question_id
    and kind = 'answer';
end;
$$;

create or replace function public.submit_profile_question(
  p_target_profile_id uuid,
  p_asker_profile_id uuid,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_question_id uuid;
  v_body text := btrim(p_body);
begin
  if v_body is null or char_length(v_body) not between 3 and 500 then
    raise exception 'Question must be between 3 and 500 characters' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_target_profile_id
  ) then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;
  if p_asker_profile_id is not null and (
    auth.uid() is null
    or not exists (
      select 1 from public.profiles
      where id = p_asker_profile_id and owner_id = auth.uid()
    )
  ) then
    raise exception 'Cannot disclose another profile' using errcode = '42501';
  end if;

  insert into public.questions (
    target_profile_id,
    asker_profile_id,
    asker_user_id,
    body
  )
  values (
    p_target_profile_id,
    p_asker_profile_id,
    auth.uid(),
    v_body
  )
  returning id into v_question_id;

  return v_question_id;
end;
$$;

create or replace function public.get_my_notifications()
returns table (
  id uuid,
  kind text,
  question_id uuid,
  question_body text,
  answer_body text,
  profile_display_name text,
  profile_public_id uuid,
  created_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    notification.id,
    notification.kind,
    question.id,
    question.body,
    answer.body,
    profile.display_name,
    profile.public_id,
    notification.created_at,
    notification.read_at
  from public.notifications as notification
  join public.questions as question on question.id = notification.question_id
  join public.profiles as profile on profile.id = question.target_profile_id
  left join public.answers as answer on answer.question_id = question.id
  where auth.uid() is not null
    and notification.recipient_id = auth.uid()
  order by notification.created_at desc
  limit 30;
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  update public.notifications
  set read_at = coalesce(read_at, now())
  where id = p_notification_id
    and recipient_id = auth.uid();
end;
$$;

revoke all on public.profiles from public, anon, authenticated;
revoke all on public.questions from public, anon, authenticated;
revoke all on public.answers from public, anon, authenticated;
revoke all on public.notifications from public, anon, authenticated;
revoke all on public.identifier_lookup_limits from public, anon, authenticated;
revoke all on function public.get_shared_profile(uuid) from public;
revoke all on function public.answer_profile_question(uuid, text) from public;
revoke all on function public.update_profile_question(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_profile_question(uuid) from public, anon, authenticated;
revoke all on function public.delete_profile_answer(uuid) from public, anon, authenticated;
revoke all on function public.can_disclose_question_asker(uuid) from public;
revoke all on function public.resolve_login_identifier(text) from public, anon, authenticated;
revoke all on function public.consume_identifier_lookup(text) from public, anon, authenticated;
revoke all on function public.create_profile_for_new_user() from public, anon, authenticated;
revoke all on function public.notify_profile_owner_of_question() from public, anon, authenticated;
revoke all on function public.broadcast_profile_update() from public, anon, authenticated;
revoke all on function public.notify_asker_of_answer() from public, anon, authenticated;
revoke all on function public.purge_expired_question_content() from public, anon, authenticated;
revoke all on function public.submit_profile_question(uuid, uuid, text) from public;
revoke all on function public.get_my_notifications() from public;
revoke all on function public.mark_notification_read(uuid) from public;

grant select on public.profiles to authenticated;
grant insert (owner_id, handle, display_name) on public.profiles to authenticated;
grant update (handle, display_name) on public.profiles to authenticated;
grant select on public.questions to anon, authenticated;
grant select on public.notifications to authenticated;
grant execute on function public.get_shared_profile(uuid) to anon, authenticated;
grant execute on function public.answer_profile_question(uuid, text) to authenticated;
grant execute on function public.update_profile_question(uuid, text) to authenticated;
grant execute on function public.delete_profile_question(uuid) to authenticated;
grant execute on function public.delete_profile_answer(uuid) to authenticated;
grant execute on function public.submit_profile_question(uuid, uuid, text) to anon, authenticated;
grant execute on function public.get_my_notifications() to authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.can_disclose_question_asker(uuid) to anon, authenticated;
grant execute on function public.resolve_login_identifier(text) to service_role;
grant execute on function public.consume_identifier_lookup(text) to service_role;

select public.purge_expired_question_content();
create extension if not exists pg_cron with schema extensions;
select cron.unschedule(jobid)
from cron.job
where jobname = 'purge-expired-questions';
select cron.schedule(
  'purge-expired-questions',
  '17 3 * * *',
  'select public.purge_expired_question_content();'
);
select cron.unschedule(jobid)
from cron.job
where jobname = 'purge-expired-lookup-limits';
select cron.schedule(
  'purge-expired-lookup-limits',
  '37 3 * * *',
  $job$delete from public.identifier_lookup_limits where window_started_at < now() - interval '1 day';$job$
);
