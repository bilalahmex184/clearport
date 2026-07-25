-- ============================================================================
-- 024_notifications.sql — In-app notification table for the email stub
-- ============================================================================
-- Backing store for src/lib/services/notification.service.ts. On a $0 budget
-- we can't actually send email (no Resend / SendGrid key), so every
-- notification is persisted here + console-logged. When an email provider is
-- added later, the DB row stays (it powers any future in-app notification
-- center / badge) and the email send is layered on top — see the service
-- file for the single dispatch point.
--
-- RLS is org-scoped, matching every other table in the schema: a row is
-- visible to members of its org only. Inserts are gated the same way, so a
-- user-scoped client can only create notifications for their own org (the
-- notification service always passes the caller's orgId).
--
-- Columns mirror the spec:
--   org_id      — scope (org membership enforced via is_org_member)
--   user_id     — recipient (NULL allowed for anon sessions; row is still
--                 org-scoped via org_id)
--   type        — enum-ish: 'extraction_complete' | 'exception_flagged' |
--                 'invite_accepted' (TEXT + CHECK; no PG enum so adding a
--                 new type is a migration, not a type-level change)
--   message     — fully-rendered string ready to display
--   read        — boolean; the UI flips this when the user opens the notif
--   created_at  — timestamp (newest-first ordering for the notification list)
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (
    type IN ('extraction_complete', 'exception_flagged', 'invite_accepted')
  ),
  message TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for the common read paths: list-by-org (newest first) and the
-- "unread count" badge query.
CREATE INDEX IF NOT EXISTS idx_notifications_org_id_created
  ON notifications(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC)
  WHERE read = FALSE;

-- ---------------------------------------------------------------------------
-- RLS — org-scoped, same pattern as shipments / documents / audit_logs
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Drop legacy policies (idempotent re-run safety).
DROP POLICY IF EXISTS "org_members_read_notifications" ON notifications;
DROP POLICY IF EXISTS "org_members_insert_notifications" ON notifications;
DROP POLICY IF EXISTS "org_members_update_notifications" ON notifications;

-- Members can read notifications for their org.
CREATE POLICY "org_members_read_notifications" ON notifications
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, auth.uid()));

-- Members can create notifications for their own org. (The notification
-- service is invoked from server routes that hold a user-scoped client, so
-- this policy gates inserts to the caller's org.)
CREATE POLICY "org_members_insert_notifications" ON notifications
  FOR INSERT TO authenticated
  WITH CHECK (is_org_member(org_id, auth.uid()));

-- Members can update notifications for their own org — used by the "mark as
-- read" path. Limited to UPDATE so members can't DELETE each other's
-- notifications.
CREATE POLICY "org_members_update_notifications" ON notifications
  FOR UPDATE TO authenticated
  USING (is_org_member(org_id, auth.uid()))
  WITH CHECK (is_org_member(org_id, auth.uid()));

COMMENT ON TABLE notifications IS
  'In-app notification store (email-stub backing table). '
  'Rows are org-scoped: members can read + insert + update (mark-as-read) for '
  'their own org. No DELETE policy — notifications are append-only audit-like '
  'records; cleanup (if any) happens via a service-role job, not client calls.';
COMMENT ON COLUMN notifications.type IS
  'extraction_complete | exception_flagged | invite_accepted (see notification.service.ts).';
