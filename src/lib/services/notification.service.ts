// ============================================================================
// ClearPort — Notification Service (email stub)
// ============================================================================
// On a $0 budget we can't actually send email — there's no Resend / SendGrid
// API key in the env. This service is the *single place* every user-facing
// notification flows through. It does two things today:
//
//   1. Inserts a row into the `notifications` table (migration 024) so the
//      in-app notification center (and any future polling UI) can read it.
//      The row is org-scoped via RLS — members of the org can see it; nobody
//      else can.
//   2. Logs the notification to console via the structured logger so it
//      shows up in dev / server logs as a structured JSON entry. This is
//      the "we have no email provider" backstop — at least the message is
//      observable.
//
// Production swap: when a Stripe budget unlocks an email provider, add the
// provider call (Resend / SendGrid) inside `dispatchNotification` below.
// The signature is already provider-agnostic — every dispatch has the
// recipient email, a type, and a fully-rendered message string. The DB row
// + console log stay (they're useful regardless), the email send is added
// alongside them.
//
// Every function is best-effort: a notification failure must never break
// the parent operation (extraction, exception flagging, invite acceptance).
// Errors are logged via the structured logger and swallowed.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'extraction_complete'
  | 'exception_flagged'
  | 'invite_accepted';

export interface NotificationRow {
  org_id: string;
  user_id: string | null;
  type: NotificationType;
  message: string;
  read: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Core dispatcher — single point of truth for "what happens when we send a
// notification". Every public helper funnels through this so the production
// email-provider swap is a one-file change.
// ---------------------------------------------------------------------------

async function dispatchNotification(
  client: SupabaseClient,
  params: {
    orgId: string;
    /** The user the notification is addressed to. Null is allowed because
     *  anonymous sessions don't have a real auth.uid() — the row is still
     *  org-scoped via the org_id column. */
    userId: string | null;
    type: NotificationType;
    message: string;
    recipientEmail: string;
  },
): Promise<void> {
  const row: NotificationRow = {
    org_id: params.orgId,
    user_id: params.userId,
    type: params.type,
    message: params.message,
    read: false,
    created_at: new Date().toISOString(),
  };

  // 1. Persist to the notifications table. RLS on the table
  //    (see migration 024) ensures only org members can read it; inserts are
  //    gated to org members too, so a caller with a user-scoped client can
  //    only create notifications for their own org.
  const { error } = await client.from('notifications').insert(row);

  if (error) {
    // Best-effort: log + swallow. The caller's operation (extraction,
    // exception flagging, invite acceptance) is more important than the
    // notification. Schema-not-deployed is the most common error in dev —
    // the table doesn't exist until migration 024 is applied.
    logger.warn('NotificationService: insert failed (stub will retry on next event)', {
      type: params.type,
      orgId: params.orgId,
      recipientEmail: params.recipientEmail,
      error: error.message,
    });
  } else {
    logger.info('NotificationService: persisted notification', {
      type: params.type,
      orgId: params.orgId,
      recipientEmail: params.recipientEmail,
    });
  }

  // 2. Console log — the $0-budget "email". Structured logger emits a JSON
  //    line so dev tools + server log aggregators can filter by type.
  //    Production: replace this block with the Resend / SendGrid call once
  //    a provider key is set in the env.
  console.log(
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        level: 'info' as const,
        channel: 'notification-stub',
        type: params.type,
        to: params.recipientEmail,
        message: params.message,
        orgId: params.orgId,
        hint: 'Set STRIPE_SECRET_KEY + an email provider key (RESEND_API_KEY / SENDGRID_API_KEY) to send real email.',
      },
      null,
      0,
    ),
  );
}

// ---------------------------------------------------------------------------
// Public helpers — one per user-facing event
// ---------------------------------------------------------------------------

/**
 * Fires after the extraction pipeline finishes for a shipment. Tells the
 * uploading user their document is ready to review.
 *
 * `reviewUrl` should be the absolute URL the user can click to land directly
 * on the extracted shipment (e.g. `https://app.clearport.com/?shipment=...`).
 * When the caller can't construct a URL (server context without a host), pass
 * an empty string — the message will say "Review it in the Exception Desk."
 */
export async function notifyExtractionComplete(
  client: SupabaseClient,
  shipmentId: string,
  userEmail: string,
  options: {
    orgId: string;
    userId?: string | null;
    reviewUrl?: string;
  },
): Promise<void> {
  const reviewUrl = options.reviewUrl?.trim();
  const message = reviewUrl
    ? `Your document extraction is complete for shipment ${shipmentId}. Review it at ${reviewUrl}`
    : `Your document extraction is complete for shipment ${shipmentId}. Review it in the Exception Desk.`;

  await dispatchNotification(client, {
    orgId: options.orgId,
    userId: options.userId ?? null,
    type: 'extraction_complete',
    message,
    recipientEmail: userEmail,
  });
}

/**
 * Fires when the validation pipeline flags an exception on a specific
 * field. Tells the responsible reviewer something needs their attention.
 */
export async function notifyExceptionFlagged(
  client: SupabaseClient,
  shipmentId: string,
  fieldName: string,
  userEmail: string,
  options: {
    orgId: string;
    userId?: string | null;
  },
): Promise<void> {
  const message = `An exception was flagged on field "${fieldName}" in shipment ${shipmentId}. Review it in the Exception Desk.`;

  await dispatchNotification(client, {
    orgId: options.orgId,
    userId: options.userId ?? null,
    type: 'exception_flagged',
    message,
    recipientEmail: userEmail,
  });
}

/**
 * Fires when an invitee accepts an org invite. Notifies the org admin who
 * sent the invite that their team has grown.
 *
 * `adminEmail` is the recipient (the inviter), `newMemberEmail` is the
 * user who just joined. Both are emails — at $0 budget we don't have an
 * in-app mailbox, so the admin needs an email (or console log) to know
 * the invite landed.
 */
export async function notifyInviteAccepted(
  client: SupabaseClient,
  orgId: string,
  newMemberEmail: string,
  adminEmail: string,
  options: {
    adminUserId?: string | null;
  } = {},
): Promise<void> {
  const message = `${newMemberEmail} joined your organization.`;

  await dispatchNotification(client, {
    orgId,
    userId: options.adminUserId ?? null,
    type: 'invite_accepted',
    message,
    recipientEmail: adminEmail,
  });
}
