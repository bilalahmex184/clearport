// ============================================================================
// Edge Function: batch-accept
// Purpose: Batch-accept all high-confidence unresolved exceptions for a
//          shipment in a single call. Threshold defaults to the user's
//          operational_rules.invoice_threshold (80) unless overridden in body.
// Input: JSON { shipmentId: string, threshold?: number, resolvedBy: string }
// Output: { success: true, acceptedCount: number, shipmentStatus: string }
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// --- CORS -------------------------------------------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonRes(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// --- Client helpers ---------------------------------------------------------
function createUserClient(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
}

function createAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );
}

async function getUser(client: any) {
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) return null;
  return user;
}

function isSchemaError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  const code = err.code || "";
  return (
    msg.includes("does not exist") ||
    msg.includes("could not find the") ||
    code === "PGRST205" ||
    code === "42P01"
  );
}

const SCHEMA_HINT =
  "Schema not deployed. Run supabase/schema.sql in Supabase SQL Editor.";

const DEFAULT_THRESHOLD = 80;

// --- Main handler -----------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Verify JWT
    const userClient = createUserClient(req);
    if (!userClient) {
      return jsonRes(
        { success: false, error: "Missing Authorization header" },
        401
      );
    }
    const user = await getUser(userClient);
    if (!user) {
      return jsonRes(
        { success: false, error: "Unauthorized — invalid JWT" },
        401
      );
    }

    // 2. Parse + validate body
    const body = await req.json().catch(() => ({}));
    const { shipmentId, threshold, resolvedBy } = body || {};

    if (!shipmentId || typeof shipmentId !== "string") {
      return jsonRes(
        { success: false, error: "Missing or invalid 'shipmentId'" },
        400
      );
    }

    // 3. Determine confidence threshold
    //    Body override > user operational_rules.invoice_threshold > 80
    let effectiveThreshold: number;
    if (
      typeof threshold === "number" &&
      !Number.isNaN(threshold) &&
      threshold >= 0 &&
      threshold <= 100
    ) {
      effectiveThreshold = threshold;
    } else {
      const { data: rules, error: rulesErr } = await userClient
        .from("operational_rules")
        .select("invoice_threshold")
        .maybeSingle();

      if (rulesErr && isSchemaError(rulesErr)) {
        return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
      }
      effectiveThreshold =
        rules && typeof rules.invoice_threshold === "number"
          ? rules.invoice_threshold
          : DEFAULT_THRESHOLD;
    }

    const resolver =
      typeof resolvedBy === "string" && resolvedBy.trim()
        ? resolvedBy.trim()
        : user.email || user.id;

    // 4. Fetch the shipment (RLS ensures ownership)
    const { data: shipment, error: shipErr } = await userClient
      .from("shipments")
      .select("id, initial_confidence, current_confidence, status")
      .eq("id", shipmentId)
      .maybeSingle();

    if (shipErr) {
      if (isSchemaError(shipErr)) {
        return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
      }
      console.error("[batch-accept] shipment fetch failed:", shipErr);
      return jsonRes({ success: false, error: shipErr.message }, 500);
    }
    if (!shipment) {
      return jsonRes(
        { success: false, error: "Shipment not found" },
        404
      );
    }

    // 5. Fetch all UNRESOLVED exceptions for this shipment
    const { data: unresolvedExs, error: exErr } = await userClient
      .from("exceptions")
      .select("*")
      .eq("shipment_id", shipmentId)
      .eq("status", "Unresolved");

    if (exErr) {
      if (isSchemaError(exErr)) {
        return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
      }
      console.error("[batch-accept] exceptions fetch failed:", exErr);
      return jsonRes({ success: false, error: exErr.message }, 500);
    }

    // 6. Filter to those at or above the confidence threshold
    const toAccept = (unresolvedExs || []).filter(
      (ex: any) => typeof ex.confidence === "number" && ex.confidence >= effectiveThreshold
    );

    if (toAccept.length === 0) {
      // Nothing to accept — return current state without writing audit log
      return jsonRes({
        success: true,
        acceptedCount: 0,
        shipmentStatus: shipment.status,
        threshold: effectiveThreshold,
        message: `No unresolved exceptions met the confidence threshold (>= ${effectiveThreshold}%).`,
      });
    }

    // 7. Update each qualifying exception — batched for efficiency
    const nowIso = new Date().toISOString();
    const fieldIdsToUpdate: string[] = [];
    const acceptedIds: string[] = [];

    // Build per-row updates (history needs to be appended per row, so we can't
    // do a single bulk update with different payloads — issue N updates)
    for (const ex of toAccept) {
      const historyEntry = {
        user: resolver,
        oldValue: ex.extracted_value ?? "",
        newValue: ex.extracted_value ?? "",
        timestamp: nowIso,
        action: "Accepted",
      };
      const existingHistory = Array.isArray(ex.history) ? ex.history : [];
      const newHistory = [historyEntry, ...existingHistory];

      const { error: updateErr } = await userClient
        .from("exceptions")
        .update({
          status: "Accepted",
          resolved_at: nowIso,
          resolved_by: resolver,
          history: newHistory,
        })
        .eq("id", ex.id);

      if (updateErr) {
        console.warn(
          `[batch-accept] failed to update exception ${ex.id}:`,
          updateErr
        );
        continue; // skip this one but continue with the rest
      }
      acceptedIds.push(ex.id);
      if (ex.field_id) fieldIdsToUpdate.push(ex.field_id);
    }

    // 8. Sync document_fields — unflag + mark reviewer_action='Accepted'
    for (const fieldId of fieldIdsToUpdate) {
      const { error: fieldErr } = await userClient
        .from("document_fields")
        .update({
          is_flagged: false,
          reviewer_action: "Accepted",
        })
        .eq("id", fieldId);
      if (fieldErr) {
        console.warn(
          `[batch-accept] document_fields sync failed for ${fieldId}:`,
          fieldErr
        );
      }
    }

    // 9. Re-check whether all exceptions for the shipment are now resolved
    const { data: allExceptions } = await userClient
      .from("exceptions")
      .select("id, status")
      .eq("shipment_id", shipmentId);

    const total = (allExceptions || []).length;
    const unresolved = (allExceptions || []).filter(
      (e: any) => e.status === "Unresolved"
    ).length;
    const resolvedCount = total - unresolved;

    // 10. Recalculate current_confidence (same formula as update-exception)
    const initialConfidence = shipment.initial_confidence ?? 0;
    let newConfidence = initialConfidence;
    if (total > 0) {
      const ratio = resolvedCount / total;
      const boost = Math.round(ratio * 30);
      newConfidence = Math.min(100, initialConfidence + boost);
    }

    let shipmentStatus = shipment.status || "Under Review";
    const shipUpdate: any = { current_confidence: newConfidence };
    if (unresolved === 0) {
      shipUpdate.status = "Approved";
      shipmentStatus = "Approved";
    }
    await userClient
      .from("shipments")
      .update(shipUpdate)
      .eq("id", shipmentId);

    // 11. Audit log entry
    const auditText = `Batch action: Approved ${acceptedIds.length} high-confidence exceptions (>= ${effectiveThreshold}%) in ${shipmentId}`;
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: auditText,
      type: "success",
    });

    return jsonRes({
      success: true,
      acceptedCount: acceptedIds.length,
      shipmentStatus,
      threshold: effectiveThreshold,
    });
  } catch (err: any) {
    console.error("[batch-accept] unhandled error:", err);
    return jsonRes(
      {
        success: false,
        error: "Internal server error",
        detail: String(err?.message || err),
      },
      500
    );
  }
});
