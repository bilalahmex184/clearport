// ============================================================================
// Edge Function: flag-exceptions
// Purpose: Confidence-threshold-based exception flagging. Creates `exceptions`
//          rows for document_fields whose confidence is below the user's
//          configured threshold, and for fields where cross_doc_value differs
//          from extracted_value. Updates shipment.current_confidence.
// Input: JSON `{ shipmentId }`
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// --- CORS -------------------------------------------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
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

// --- Threshold routing ------------------------------------------------------
// Field-key → which threshold bucket it falls under.
const HTS_FIELDS = new Set(["htsCode", "htsCodes", "hts"]);
const PARTIES_FIELDS = new Set([
  "shipper",
  "consignee",
  "consigneeAddress",
  "shipperAddress",
  "notifyParty",
  "exporter",
  "importer",
]);

function thresholdFor(
  fieldKey: string,
  rules: { invoice_threshold: number; hts_threshold: number; parties_threshold: number }
): number {
  if (HTS_FIELDS.has(fieldKey)) return rules.hts_threshold;
  if (PARTIES_FIELDS.has(fieldKey)) return rules.parties_threshold;
  return rules.invoice_threshold;
}

// --- Main handler -----------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // pattern symmetry — unused
  const _admin = createAdminClient();
  void _admin;

  try {
    const userClient = createUserClient(req);
    if (!userClient) return jsonRes({ error: "Missing Authorization header" }, 401);
    const user = await getUser(userClient);
    if (!user) return jsonRes({ error: "Unauthorized — invalid JWT" }, 401);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return jsonRes({ error: "Invalid JSON body" }, 400);
    }
    const { shipmentId } = body;
    if (!shipmentId) return jsonRes({ error: "Missing 'shipmentId'" }, 400);

    // 1. Fetch the user's operational_rules (thresholds)
    let { data: rules, error: rulesErr } = await userClient
      .from("operational_rules")
      .select("invoice_threshold, hts_threshold, parties_threshold")
      .eq("user_id", user.id)
      .maybeSingle();

    if (rulesErr) {
      console.error("[flag-exceptions] rules query error:", rulesErr);
      return jsonRes(
        { error: "Failed to fetch operational_rules", detail: rulesErr.message },
        500
      );
    }

    // If the user doesn't have a rules row yet, create one with defaults.
    if (!rules) {
      const { data: newRules, error: newRulesErr } = await userClient
        .from("operational_rules")
        .insert({
          user_id: user.id,
          invoice_threshold: 80,
          hts_threshold: 85,
          parties_threshold: 75,
        })
        .select("invoice_threshold, hts_threshold, parties_threshold")
        .single();

      if (newRulesErr || !newRules) {
        console.warn(
          "[flag-exceptions] could not create default rules; using hardcoded defaults",
          newRulesErr
        );
        rules = { invoice_threshold: 80, hts_threshold: 85, parties_threshold: 75 };
      } else {
        rules = newRules;
      }
    }

    // 2. Fetch all document_fields for this shipment
    const { data: fields, error: fieldsErr } = await userClient
      .from("document_fields")
      .select(
        `
        id,
        document_id,
        field_key,
        field_label,
        extracted_value,
        corrected_value,
        confidence,
        is_flagged,
        cross_doc_value,
        cross_doc_source,
        documents (
          doc_type,
          file_name
        )
      `
      )
      .eq("shipment_id", shipmentId);

    if (fieldsErr) {
      console.error("[flag-exceptions] fields query error:", fieldsErr);
      return jsonRes(
        { error: "Failed to fetch document_fields", detail: fieldsErr.message },
        500
      );
    }
    if (!fields || fields.length === 0) {
      // Still update the shipment confidence to 0 if no fields exist
      await userClient
        .from("shipments")
        .update({ current_confidence: 0 })
        .eq("id", shipmentId);
      return jsonRes({
        success: true,
        shipmentId,
        exceptionsCreated: 0,
        message: "No document_fields found.",
      });
    }

    // 3. Delete any pre-existing auto-flagged exceptions for this shipment
    //    so re-running the pipeline doesn't double-create them. We only
    //    delete unresolved low_confidence / cross_doc_mismatch rows.
    await userClient
      .from("exceptions")
      .delete()
      .eq("shipment_id", shipmentId)
      .in("exception_type", ["low_confidence", "cross_doc_mismatch"])
      .eq("status", "Unresolved");

    // 4. Iterate fields and create exceptions where thresholds are breached
    const exceptionsToInsert: any[] = [];
    let totalConfidence = 0;
    let flaggedCount = 0;

    for (const f of fields) {
      const effectiveValue = f.corrected_value || f.extracted_value || "";
      const conf = Number(f.confidence) || 0;
      totalConfidence += conf;

      const threshold = thresholdFor(f.field_key, rules);
      const docType = f.documents?.doc_type || null;

      // 4a. Low-confidence exception
      if (conf < threshold) {
        exceptionsToInsert.push({
          shipment_id: shipmentId,
          field_id: f.id,
          user_id: user.id,
          field_key: f.field_key,
          field_name: f.field_label,
          original_value: effectiveValue,
          extracted_value: f.extracted_value,
          cross_doc_value: f.cross_doc_value || null,
          confidence: conf,
          reason: `Confidence ${conf}% is below ${f.field_key} threshold ${threshold}%`,
          exception_type: "low_confidence",
          doc_type: docType,
          status: "Unresolved",
        });
        flaggedCount++;
      }

      // 4b. Cross-doc mismatch exception (only if cross_doc_value present and
      //     differs from the effective extracted value)
      if (
        f.cross_doc_value != null &&
        String(f.cross_doc_value).trim() !== "" &&
        String(f.cross_doc_value).trim() !== String(effectiveValue).trim()
      ) {
        // Avoid duplicating if a low_confidence exception is already queued
        // for this same field — we still want a separate cross_doc_mismatch
        // exception because the reviewer should treat them differently.
        exceptionsToInsert.push({
          shipment_id: shipmentId,
          field_id: f.id,
          user_id: user.id,
          field_key: f.field_key,
          field_name: f.field_label,
          original_value: effectiveValue,
          extracted_value: f.extracted_value,
          cross_doc_value: f.cross_doc_value,
          cross_doc_source: f.cross_doc_source || null,
          confidence: conf,
          reason: `Cross-document mismatch: extracted "${effectiveValue}" vs "${f.cross_doc_value}" from ${f.cross_doc_source || "another document"}`,
          exception_type: "cross_doc_mismatch",
          doc_type: docType,
          status: "Unresolved",
        });
        flaggedCount++;
      }
    }

    // 5. Insert exceptions (batch)
    if (exceptionsToInsert.length > 0) {
      const { error: exInsErr } = await userClient
        .from("exceptions")
        .insert(exceptionsToInsert);
      if (exInsErr) {
        console.error("[flag-exceptions] exception insert failed:", exInsErr);
      }
    }

    // 6. Compute new current_confidence for the shipment.
    //    Formula: average confidence of all fields, minus 5pts per flagged field,
    //    clamped to [0, 100]. If no fields, 0.
    let currentConfidence = 0;
    if (fields.length > 0) {
      const avg = totalConfidence / fields.length;
      currentConfidence = Math.max(0, Math.min(100, Math.round(avg - flaggedCount * 5)));
    }

    const { error: shipUpdErr } = await userClient
      .from("shipments")
      .update({ current_confidence: currentConfidence })
      .eq("id", shipmentId);
    if (shipUpdErr) {
      console.warn(
        "[flag-exceptions] shipment confidence update failed:",
        shipUpdErr
      );
    }

    // 7. Audit log
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Flag-exceptions pass: ${exceptionsToInsert.length} exception(s) created; shipment confidence now ${currentConfidence}%.`,
      type: exceptionsToInsert.length > 0 ? "warning" : "success",
    });

    // 8. Respond
    return jsonRes({
      success: true,
      shipmentId,
      exceptionsCreated: exceptionsToInsert.length,
      currentConfidence,
      thresholds: rules,
      fieldsChecked: fields.length,
      breakdown: {
        low_confidence: exceptionsToInsert.filter(
          (e) => e.exception_type === "low_confidence"
        ).length,
        cross_doc_mismatch: exceptionsToInsert.filter(
          (e) => e.exception_type === "cross_doc_mismatch"
        ).length,
      },
    });
  } catch (err: any) {
    console.error("[flag-exceptions] unhandled error:", err);
    return jsonRes(
      { error: "Internal server error", detail: String(err?.message || err) },
      500
    );
  }
});
