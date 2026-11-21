create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null unique references public.questions (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.answers
  add column if not exists created_at timestamptz not null default now();
alter table public.answers
  add column if not exists updated_at timestamptz not null default now();
alter table public.answers enable row level security;
revoke all on public.answers from public, anon, authenticated;
create unique index if not exists answers_question_id_key
  on public.answers (question_id);

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
            select id, target_profile_id, asker_profile_id, body, created_at
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
              'answer', jsonb_build_object(
                'body', answer.body,
                'created_at', answer.created_at,
                'updated_at', answer.updated_at
              )
            )
            order by question.created_at desc
          )
          from (
            select question_row.id, question_row.target_profile_id, question_row.asker_profile_id, question_row.body, question_row.created_at
            from public.questions as question_row
            where question_row.target_profile_id = profile.id
              and exists (
                select 1 from public.answers as answer
                where answer.question_id = question_row.id
              )
            order by question_row.created_at desc
            limit 50
          ) as question
          join public.answers as answer on answer.question_id = question.id
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

drop trigger if exists broadcast_profile_answer_update on public.answers;
create trigger broadcast_profile_answer_update
  after insert or update or delete on public.answers
  for each row execute function public.broadcast_profile_update();

revoke all on function public.answer_profile_question(uuid, text) from public, anon, authenticated;
grant execute on function public.answer_profile_question(uuid, text) to authenticated;
revoke all on function public.get_shared_profile(uuid) from public, anon, authenticated;
grant execute on function public.get_shared_profile(uuid) to anon, authenticated;
revoke all on function public.broadcast_profile_update() from public, anon, authenticated;
