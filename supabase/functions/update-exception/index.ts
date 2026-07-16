// ============================================================================
// Edge Function: update-exception
// Purpose: Resolve a single exception — accept the extracted value, correct it
//          to a new value, or reject it. Updates the exception, the linked
//          document_field (if any), the shipment status/confidence, and writes
//          an audit log entry.
// Input: JSON { exceptionId: string, status: 'Accepted'|'Corrected'|'Rejected',
//                correctedValue?: string, resolvedBy: string }
// Output: { success: true, exception: {...}, shipmentStatus: string }
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

const VALID_STATUSES = new Set(["Accepted", "Corrected", "Rejected"]);

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
    const { exceptionId, status, correctedValue, resolvedBy } = body || {};

    if (!exceptionId || typeof exceptionId !== "string") {
      return jsonRes(
        { success: false, error: "Missing or invalid 'exceptionId'" },
        400
      );
    }
    if (!VALID_STATUSES.has(status)) {
      return jsonRes(
        {
          success: false,
          error:
            "Invalid 'status'. Must be 'Accepted', 'Corrected', or 'Rejected'.",
        },
        400
      );
    }
    if (status === "Corrected" && (correctedValue === undefined || correctedValue === null || correctedValue === "")) {
      return jsonRes(
        { success: false, error: "'correctedValue' is required when status is 'Corrected'." },
        400
      );
    }
    const resolver = typeof resolvedBy === "string" && resolvedBy.trim()
      ? resolvedBy.trim()
      : user.email || user.id;

    // 3. Fetch the exception (RLS ensures user can only see their own)
    const { data: existing, error: fetchErr } = await userClient
      .from("exceptions")
      .select("*")
      .eq("id", exceptionId)
      .maybeSingle();

    if (fetchErr) {
      if (isSchemaError(fetchErr)) {
        return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
      }
      console.error("[update-exception] fetch failed:", fetchErr);
      return jsonRes({ success: false, error: fetchErr.message }, 500);
    }
    if (!existing) {
      return jsonRes(
        { success: false, error: "Exception not found" },
        404
      );
    }

    // 4. Build history entry — record the resolution action
    const nowIso = new Date().toISOString();
    const newValueForHistory = correctedValue ?? existing.extracted_value ?? "";
    const historyEntry = {
      user: resolver,
      oldValue: newValueForHistory,
      newValue: newValueForHistory,
      timestamp: nowIso,
      action: status,
    };
    const existingHistory = Array.isArray(existing.history)
      ? existing.history
      : [];
    const newHistory = [historyEntry, ...existingHistory];

    // 5. Build the update payload for exceptions
    const exceptionUpdate: any = {
      status,
      resolved_at: nowIso,
      resolved_by: resolver,
      history: newHistory,
    };
    // Only set corrected_value when status is 'Corrected'
    if (status === "Corrected") {
      exceptionUpdate.corrected_value = correctedValue;
    }

    const { data: updatedException, error: updateErr } = await userClient
      .from("exceptions")
      .update(exceptionUpdate)
      .eq("id", exceptionId)
      .select("*")
      .single();

    if (updateErr || !updatedException) {
      console.error("[update-exception] update failed:", updateErr);
      return jsonRes(
        { success: false, error: updateErr?.message || "Failed to update exception" },
        500
      );
    }

    // 6. If the exception references a document_field, sync the field too
    if (existing.field_id) {
      const fieldUpdate: any = {
        is_flagged: false,
        reviewer_action: status,
      };
      if (status === "Corrected") {
        fieldUpdate.corrected_value = correctedValue;
      }
      const { error: fieldErr } = await userClient
        .from("document_fields")
        .update(fieldUpdate)
        .eq("id", existing.field_id);

      if (fieldErr) {
        // Non-fatal — log and continue. The exception itself was updated.
        console.warn(
          "[update-exception] document_fields sync failed:",
          fieldErr
        );
      }
    }

    // 7. Check whether ALL exceptions for this shipment are resolved.
    //    If so, flip shipment status to 'Approved'.
    const shipmentId = existing.shipment_id;
    const { data: allExceptions, error: allExErr } = await userClient
      .from("exceptions")
      .select("id, status, confidence")
      .eq("shipment_id", shipmentId);

    let shipmentStatus = "Under Review";
    if (allExErr) {
      console.warn(
        "[update-exception] failed to re-fetch exceptions:",
        allExErr
      );
    } else {
      const total = (allExceptions || []).length;
      const unresolved = (allExceptions || []).filter(
        (e: any) => e.status === "Unresolved"
      ).length;
      const resolvedCount = total - unresolved;

      // 8. Recalculate current_confidence — interpolate from initial_confidence
      //    up to initial_confidence + 30 based on resolution ratio.
      const { data: shipment } = await userClient
        .from("shipments")
        .select("id, initial_confidence, current_confidence, status")
        .eq("id", shipmentId)
        .maybeSingle();

      const initialConfidence = shipment?.initial_confidence ?? 0;
      let newConfidence = initialConfidence;
      if (total > 0) {
        const ratio = resolvedCount / total;
        const boost = Math.round(ratio * 30);
        newConfidence = Math.min(100, initialConfidence + boost);
      }

      const updatePayload: any = { current_confidence: newConfidence };

      // If everything is resolved, ship is ready for approval
      if (unresolved === 0) {
        updatePayload.status = "Approved";
        shipmentStatus = "Approved";
      } else {
        shipmentStatus = shipment?.status || "Under Review";
      }

      await userClient
        .from("shipments")
        .update(updatePayload)
        .eq("id", shipmentId);
    }

    // 9. Audit log entry
    const actionVerb =
      status === "Accepted"
        ? "Accepted"
        : status === "Corrected"
        ? `Corrected to "${correctedValue}"`
        : "Rejected";
    const auditText = `Exception "${existing.field_name}" (${existing.exception_type}) — ${actionVerb} by ${resolver}`;

    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: auditText,
      type: status === "Rejected" ? "warning" : "success",
    });

    // 10. Respond — transform the updated exception to camelCase shape
    const ex = updatedException;
    const exceptionOut = {
      id: ex.id,
      fieldName: ex.field_name,
      fieldKey: ex.field_key,
      originalValue: ex.original_value || "",
      extractedValue: ex.extracted_value || "",
      crossDocValue: ex.cross_doc_value || null,
      confidence: ex.confidence,
      reason: ex.reason,
      exceptionType: ex.exception_type,
      docType: ex.doc_type || "Unknown",
      boundingBox: ex.bounding_box || { x: 0, y: 0, w: 0, h: 0 },
      status: ex.status,
      correctedValue: ex.corrected_value || null,
      history: Array.isArray(ex.history) ? ex.history : [],
      fieldId: ex.field_id || undefined,
      createdAt: ex.created_at,
      resolvedAt: ex.resolved_at || null,
      resolvedBy: ex.resolved_by || null,
    };

    return jsonRes({
      success: true,
      exception: exceptionOut,
      shipmentStatus,
    });
  } catch (err: any) {
    console.error("[update-exception] unhandled error:", err);
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
