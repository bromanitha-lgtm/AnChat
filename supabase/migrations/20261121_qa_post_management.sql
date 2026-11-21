alter table public.questions
  add column if not exists asker_user_id uuid
  references auth.users (id) on delete set null;

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
            select question_row.id, question_row.target_profile_id, question_row.asker_profile_id,
              question_row.asker_user_id, question_row.body, question_row.created_at
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

revoke all on function public.get_shared_profile(uuid) from public, anon, authenticated;
revoke all on function public.update_profile_question(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_profile_question(uuid) from public, anon, authenticated;
revoke all on function public.delete_profile_answer(uuid) from public, anon, authenticated;
grant execute on function public.get_shared_profile(uuid) to anon, authenticated;
grant execute on function public.update_profile_question(uuid, text) to authenticated;
grant execute on function public.delete_profile_question(uuid) to authenticated;
grant execute on function public.delete_profile_answer(uuid) to authenticated;
