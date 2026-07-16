// ============================================================================
// Edge Function: schema-validate
// Purpose: Strict JSON schema validation of extracted fields — format checks,
//          required-field enforcement, cross-document duplicate detection.
//          Pure logic validation (no Gemini).
// Input: JSON `{ shipmentId }`
//
// On schema validation failure:
//   - Sets `is_flagged = true` on the offending document_field
//   - Appends the error to `validation_errors`
//   - Inserts an `exceptions` row with `exception_type = 'schema_error'`
//
// On missing required field (invoiceNo, shipper, consignee, declaredValue):
//   - Inserts an `exceptions` row with `exception_type = 'missing_field'`
//
// On cross-document duplicate conflict (same field_key, different values):
//   - Sets `cross_doc_value` on the conflicting document_fields
//   - Inserts an `exceptions` row with `exception_type = 'cross_doc_mismatch'`
//     (note: flag-exceptions also re-creates cross_doc_mismatch rows from the
//      cross_doc_value column, so this serves as the canonical source of truth)
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

// --- Required fields (must be present somewhere in the shipment) ------------
const REQUIRED_FIELDS: Record<string, string> = {
  invoiceNo: "Commercial Invoice #",
  shipper: "Shipper/Exporter",
  consignee: "Consignee/Importer",
  declaredValue: "Total Declared Value",
};

// --- Validation rules -------------------------------------------------------
// Each rule receives the raw extracted_value and returns an error string or null.
// These are STRICTER than the previous version — see CHANGELOG below:
//   - htsCode:        now requires XXXX.XX.XXXX exactly (no plain-digit fallback)
//   - declaredValue:  must start with $, €, £, or ¥ AND numeric portion > 0
//   - countryOfOrigin:must be EXACTLY 2 uppercase letters (ISO 3166-1 alpha-2)
//   - grossWeight:    added (same rule as netWeight)
const SCHEMA_RULES: Record<
  string,
  { rule: (v: string) => string | null; description: string }
> = {
  invoiceNo: {
    description: "non-empty string",
    rule: (v) => (v && v.trim().length > 0 ? null : "invoiceNo is empty"),
  },
  invoiceDate: {
    description: "valid date YYYY-MM-DD",
    rule: (v) => {
      if (!v) return "invoiceDate is empty";
      // Accept YYYY-MM-DD or YYYY/MM/DD
      const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (!m) return `invoiceDate "${v}" is not in YYYY-MM-DD format`;
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month < 1 || month > 12) return `invoiceDate month "${month}" invalid`;
      if (day < 1 || day > 31) return `invoiceDate day "${day}" invalid`;
      if (year < 1900 || year > 2100) return `invoiceDate year "${year}" invalid`;
      return null;
    },
  },
  declaredValue: {
    description: "currency value with ISO 4217 symbol prefix ($, €, £, ¥) and amount > 0",
    rule: (v) => {
      if (!v) return "declaredValue is empty";
      const s = String(v).trim();
      // MUST start with one of the allowed currency symbols.
      if (!/^[$€£¥]/.test(s)) {
        return `declaredValue "${v}" must start with a currency symbol ($, €, £, or ¥)`;
      }
      // Strip the leading symbol + any thousands separators, then verify the
      // remaining string is a valid positive number.
      const cleaned = s.replace(/^[$€£¥]\s*/, "").replace(/,/g, "").trim();
      if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
        return `declaredValue "${v}" is not a valid currency value`;
      }
      const n = Number(cleaned);
      if (!Number.isFinite(n) || n <= 0) {
        return `declaredValue "${v}" must be greater than zero`;
      }
      return null;
    },
  },
  htsCode: {
    description: "HTS format XXXX.XX.XXXX (e.g. 8108.90.3060)",
    rule: (v) => {
      if (!v) return "htsCode is empty";
      // STRICT: only XXXX.XX.XXXX is accepted. Plain-digit fallback was removed
      // because it lets badly-extracted codes through silently.
      if (!/^\d{4}\.\d{2}\.\d{4}$/.test(v)) {
        return "HTS Code format invalid: expected XXXX.XX.XXXX";
      }
      return null;
    },
  },
  netWeight: {
    description: "number + unit (kg / lb / g / tons / oz)",
    rule: (v) => {
      if (!v) return "netWeight is empty";
      // Accept: 1234 kg | 1,234.56 lb | 1234.56g | 500 pounds | 1.5 kilograms
      const m = v.match(/^([\d,]+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lbs?|pounds?|g|oz|tons?)?$/i);
      if (!m) return `netWeight "${v}" is not a valid weight value`;
      return null;
    },
  },
  grossWeight: {
    description: "number + unit (kg / lb / g / tons / oz)",
    rule: (v) => {
      if (!v) return "grossWeight is empty";
      const m = v.match(/^([\d,]+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lbs?|pounds?|g|oz|tons?)?$/i);
      if (!m) return `grossWeight "${v}" is not a valid weight value`;
      return null;
    },
  },
  countryOfOrigin: {
    description: "2-letter ISO 3166-1 alpha-2 country code (uppercase)",
    rule: (v) => {
      if (!v) return "countryOfOrigin is empty";
      // STRICT: must be EXACTLY 2 uppercase letters. Lowercase is no longer
      // accepted (the schema explicitly requires ISO 3166-1 alpha-2).
      if (!/^[A-Z]{2}$/.test(v.trim())) {
        return `countryOfOrigin "${v}" is not a valid 2-letter uppercase ISO 3166-1 alpha-2 code`;
      }
      return null;
    },
  },
};

// --- Main handler -----------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // admin client created for symmetry with sibling functions (unused here,
  // but keeps the common pattern recognizable)
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

    // 1. Fetch all document_fields for this shipment (include document context
    //    so we can build meaningful cross-doc mismatch messages).
    const { data: fields, error: fieldsErr } = await userClient
      .from("document_fields")
      .select(
        `
        id,
        document_id,
        field_key,
        field_label,
        extracted_value,
        confidence,
        is_flagged,
        validation_errors,
        documents (
          doc_type,
          file_name
        )
      `
      )
      .eq("shipment_id", shipmentId);

    if (fieldsErr) {
      console.error("[schema-validate] fields query error:", fieldsErr);
      return jsonRes(
        { error: "Failed to fetch document_fields", detail: fieldsErr.message },
        500
      );
    }
    if (!fields || fields.length === 0) {
      return jsonRes({
        success: true,
        shipmentId,
        errors: [],
        exceptionsCreated: 0,
        message: "No document_fields found — nothing to schema-validate.",
      });
    }

    const errors: any[] = [];
    const exceptionsToInsert: any[] = [];
    const fieldUpdates: Promise<any>[] = [];

    // ---------------------------------------------------------------------
    // 2. Per-field schema validation
    // ---------------------------------------------------------------------
    for (const f of fields) {
      const rule = SCHEMA_RULES[f.field_key];
      // Build a fresh validation_errors array — preserve any pre-existing
      // errors that were not added by schema-validation itself.
      const existing: any[] = Array.isArray(f.validation_errors)
        ? f.validation_errors
        : [];
      const filtered = existing.filter(
        (e) => !(typeof e === "object" && e?.source === "schema")
      );

      let errorMsg: string | null = null;
      if (rule) {
        errorMsg = rule.rule(f.extracted_value || "");
      } else {
        // For fields without a specific schema rule, just ensure value is non-empty
        if (!f.extracted_value || !String(f.extracted_value).trim()) {
          errorMsg = `${f.field_key} is empty`;
        }
      }

      if (errorMsg) {
        const errObj = {
          source: "schema",
          field_id: f.id,
          field_key: f.field_key,
          field_label: f.field_label,
          extracted_value: f.extracted_value,
          message: errorMsg,
        };
        errors.push(errObj);
        filtered.push(errObj);

        // Update the field row: flag + attach validation error
        fieldUpdates.push(
          userClient
            .from("document_fields")
            .update({
              is_flagged: true,
              validation_errors: filtered,
            })
            .eq("id", f.id)
        );

        // Create an exception row so the reviewer can resolve it
        exceptionsToInsert.push({
          shipment_id: shipmentId,
          field_id: f.id,
          user_id: user.id,
          field_key: f.field_key,
          field_name: f.field_label,
          extracted_value: f.extracted_value,
          confidence: Number(f.confidence) || 0,
          reason: errorMsg,
          exception_type: "schema_error",
          doc_type: f.documents?.doc_type || null,
          status: "Unresolved",
        });
      } else {
        // If valid, clear schema-sourced errors (and unflag if no other errors remain)
        if (filtered.length === 0) {
          fieldUpdates.push(
            userClient
              .from("document_fields")
              .update({
                is_flagged: false,
                validation_errors: [],
              })
              .eq("id", f.id)
          );
        } else {
          fieldUpdates.push(
            userClient
              .from("document_fields")
              .update({
                validation_errors: filtered,
              })
              .eq("id", f.id)
          );
        }
      }
    }

    // ---------------------------------------------------------------------
    // 3. Required-field enforcement
    //    If invoiceNo, shipper, consignee, or declaredValue are entirely
    //    absent from the shipment's extracted fields, flag as missing_field.
    // ---------------------------------------------------------------------
    const presentKeys = new Set(fields.map((f: any) => f.field_key));
    for (const [key, label] of Object.entries(REQUIRED_FIELDS)) {
      if (!presentKeys.has(key)) {
        const reason = `Required field "${key}" (${label}) is missing from all documents in shipment`;
        errors.push({
          source: "schema",
          field_key: key,
          field_label: label,
          message: reason,
        });
        exceptionsToInsert.push({
          shipment_id: shipmentId,
          field_id: null, // no specific field row — it's missing entirely
          user_id: user.id,
          field_key: key,
          field_name: label,
          extracted_value: null,
          confidence: 0,
          reason,
          exception_type: "missing_field",
          doc_type: null,
          status: "Unresolved",
        });
      }
    }

    // ---------------------------------------------------------------------
    // 4. Cross-document duplicate detection
    //    If the same field_key appears in multiple documents with conflicting
    //    values, flag as cross_doc_mismatch and populate cross_doc_value on
    //    the conflicting fields so flag-exceptions can re-create the rows
    //    later (it deletes + recreates cross_doc_mismatch exceptions on each
    //    run).
    // ---------------------------------------------------------------------
    const byKey: Record<string, any[]> = {};
    for (const f of fields) {
      if (!byKey[f.field_key]) byKey[f.field_key] = [];
      byKey[f.field_key].push(f);
    }

    const crossDocUpdates: Array<{ id: string; crossDocValue: string; crossDocSource: string }> = [];

    for (const [key, group] of Object.entries(byKey)) {
      if (group.length < 2) continue;
      // Compare normalized values (trim + lowercase) to detect REAL conflicts.
      const normalizedValues = group.map((f: any) => String(f.extracted_value || "").trim());
      const uniqueValues = new Set(normalizedValues.map((v: string) => v.toLowerCase()));
      if (uniqueValues.size <= 1) continue; // all the same — no conflict

      // Find the most common value (plurality vote) — if there's no clear
      // winner, treat the first as the "canonical" reference.
      const valueCounts: Record<string, number> = {};
      for (const v of normalizedValues) {
        const lv = v.toLowerCase();
        valueCounts[lv] = (valueCounts[lv] || 0) + 1;
      }
      const sorted = Object.entries(valueCounts).sort((a, b) => b[1] - a[1]);
      const canonicalValueLower = sorted[0][0];
      const canonicalField = group.find(
        (f: any) => String(f.extracted_value || "").trim().toLowerCase() === canonicalValueLower
      )!;

      const errMsg =
        `Cross-document mismatch for "${key}": ${group
          .map((f: any) => `"${f.extracted_value}" (${f.documents?.doc_type || f.documents?.file_name || "doc"})`)
          .join(" vs ")}`;

      errors.push({
        source: "schema",
        field_key: key,
        message: errMsg,
        conflictingFieldIds: group.map((f: any) => f.id),
      });

      // Create one cross_doc_mismatch exception per conflicting field (every
      // field that differs from the canonical), and populate cross_doc_value
      // on those fields so the flag-exceptions pass can re-create the
      // exception row whenever it runs.
      for (const f of group) {
        const myVal = String(f.extracted_value || "").trim();
        const canonicalVal = String(canonicalField.extracted_value || "").trim();
        if (myVal.toLowerCase() === canonicalVal.toLowerCase()) continue;

        exceptionsToInsert.push({
          shipment_id: shipmentId,
          field_id: f.id,
          user_id: user.id,
          field_key: f.field_key,
          field_name: f.field_label,
          extracted_value: f.extracted_value,
          cross_doc_value: canonicalVal,
          confidence: Number(f.confidence) || 0,
          reason: errMsg,
          exception_type: "cross_doc_mismatch",
          doc_type: f.documents?.doc_type || null,
          status: "Unresolved",
        });

        crossDocUpdates.push({
          id: f.id,
          crossDocValue: canonicalVal,
          crossDocSource: canonicalField.documents?.doc_type ||
            canonicalField.documents?.file_name ||
            "another document",
        });
      }
    }

    // Apply cross_doc_value / cross_doc_source updates (separate from the
    // per-field validation_errors updates so they don't clobber each other).
    for (const upd of crossDocUpdates) {
      fieldUpdates.push(
        userClient
          .from("document_fields")
          .update({
            cross_doc_value: upd.crossDocValue,
            cross_doc_source: upd.crossDocSource,
            is_flagged: true,
          })
          .eq("id", upd.id)
      );
    }

    // ---------------------------------------------------------------------
    // 5. Apply field updates in parallel, then insert exceptions
    // ---------------------------------------------------------------------
    await Promise.allSettled(fieldUpdates);

    let exceptionsCreated = 0;
    if (exceptionsToInsert.length > 0) {
      const { data: inserted, error: exInsErr } = await userClient
        .from("exceptions")
        .insert(exceptionsToInsert)
        .select("id, exception_type");
      if (exInsErr) {
        console.error("[schema-validate] exception insert failed:", exInsErr);
      } else {
        exceptionsCreated = inserted?.length || 0;
      }
    }

    // 6. Audit log
    const breakdown = {
      schema_error: exceptionsToInsert.filter((e) => e.exception_type === "schema_error").length,
      missing_field: exceptionsToInsert.filter((e) => e.exception_type === "missing_field").length,
      cross_doc_mismatch: exceptionsToInsert.filter((e) => e.exception_type === "cross_doc_mismatch").length,
    };
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Schema validation: ${errors.length} error(s) across ${fields.length} field(s); ${exceptionsCreated} exception(s) created (schema:${breakdown.schema_error}, missing:${breakdown.missing_field}, xdoc:${breakdown.cross_doc_mismatch}).`,
      type: errors.length > 0 ? "warning" : "success",
    });

    // 7. Respond
    return jsonRes({
      success: true,
      shipmentId,
      errors,
      exceptionsCreated,
      breakdown,
      fieldsChecked: fields.length,
      errorCount: errors.length,
    });
  } catch (err: any) {
    console.error("[schema-validate] unhandled error:", err);
    return jsonRes(
      { error: "Internal server error", detail: String(err?.message || err) },
      500
    );
  }
});
