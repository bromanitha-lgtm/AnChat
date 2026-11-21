<<<<<<< HEAD
# anChat

A Sinhala/English anonymous question wall with share-link-only profiles, email accounts for profile owners, a public community feed, and light/dark themes. Asking questions never requires an account.

## Run locally

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and add your Supabase project URL and **publishable/anon key**.
3. Run `npm install`, then `npm run dev`.

Without Supabase configuration, the app shows a clearly labelled demo preview; profile creation and question submission are disabled.

## Supabase setup

1. Create a Supabase project.
2. In its SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql) for a new project. This sets up profile creation after email verification, private identifier lookup, owner-only inboxes/replies, profile-link Q&A, live profile updates, in-app notifications, and scheduled cleanup. For an existing project with the current `profiles.owner_id` schema, apply [`supabase/migrations/20261121_profile_qa_live_updates.sql`](./supabase/migrations/20261121_profile_qa_live_updates.sql), then [`supabase/migrations/20261121_qa_post_management.sql`](./supabase/migrations/20261121_qa_post_management.sql). These update profile Q&A, live updates, and post management without rerunning the bootstrap script's cleanup.
3. In **Authentication → Sign In / Providers → Email**, enable email confirmations. In **Authentication → URL Configuration**, set the deployed app as the Site URL and add the local and deployed app URLs as allowed redirect URLs.
4. Copy the project URL and publishable/anon key into `.env` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. To deliver notification emails, create a [Resend](https://resend.com/) account and verify the sender domain. Set these **Supabase Function secrets** (never add them to the frontend `.env`):

   ```sh
   npx supabase secrets set RESEND_API_KEY=re_your_key EMAIL_FROM="anChat <notifications@example.com>" APP_URL="https://your-name.github.io/your-repository/"
   ```

   `APP_URL` must be the deployed app URL, including its repository path when using GitHub Pages.
6. The Supabase CLI is included as a project dependency. From the project root, log in, link the project, and deploy both public-request functions:

   ```sh
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase functions deploy account-auth --no-verify-jwt
   npx supabase functions deploy send-notification-email --no-verify-jwt
   ```

The app asks for an email or username first. Existing accounts continue with their password; new accounts are asked for the other identifier, name, and password in the same flow (there is no separate sign-up screen). New accounts must verify their email before they can sign in; the profile is created only after verification. Username login is handled by the `account-auth` Edge Function; it never sends the account email back to the browser. Account checks, registration, username-login, and notification email requests are rate-limited to 10 attempts per 10 minutes per trusted source IP.

Profiles require an email/password account. Questions can be submitted without signing in, but only from a profile share link; the home page does not have a question form. Only the profile owner can view other unanswered questions and submit or manage replies. A signed-in asker can view and edit only their own questions, and can delete one only while it is unanswered; their unanswered questions are not shown to other visitors. Anonymous questions cannot be edited or deleted by the asker. Visitors with the profile link can see answered questions and replies; asker names are never shown to visitors. Signed-in askers may explicitly opt in to show their profile name to the profile owner; otherwise the question is anonymous. The profile link contains a random UUID access token, so share it only with people you want to visit that profile. Never include personal or sensitive information in a question.

Profile owners receive in-app notifications and email for new questions. Logged-in askers receive an in-app notification and email when the owner replies; anonymous askers can still view the reply by revisiting the profile link. Email delivery requires the Resend secrets above. If email delivery is unavailable, the question or reply is still saved and the in-app notification remains available.

Signed-in sessions are stored by Supabase in the browser and refreshed automatically until the user signs out.

Row Level Security is enabled. Never put a Supabase `service_role` key in this frontend; it is available only inside the Edge Function environment.

Question records older than **two calendar months** are deleted immediately when the full schema is applied and then by a daily `pg_cron` job. Replies are removed with their questions; the cleanup never deletes profiles or authentication accounts. Use the targeted migrations above for an existing database if you do not want to run the full schema's immediate cleanup again.

**Legacy project note:** if your existing `profiles` table has no `owner_id`, do not run this schema over it; legacy profiles cannot safely be assigned to accounts automatically. Back up any data first, then use a fresh Supabase project or explicitly migrate those legacy tables. Projects already using the current `owner_id` schema can apply this update in place as described above.

## GitHub Pages

1. Push this repository to GitHub on the `main` branch.
2. In **Settings → Secrets and variables → Actions → Variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The publishable/anon key is intended for browser use; keep the service-role key private.
3. In **Settings → Pages**, set the build and deployment source to **GitHub Actions**.
4. Push to `main` or manually run the **Deploy to GitHub Pages** workflow.

The site uses relative asset paths and supports repository-subpath Pages URLs. Profile links use a random query-string token and work without server-side routing.

## Build

```sh
npm run build
```
=======
# AnChat
a anonymous Q&amp;A platform
>>>>>>> 73f1b633fe7c6c9a7fcb23d5cfdf56042811bab5
