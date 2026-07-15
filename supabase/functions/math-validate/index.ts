// ============================================================================
// Edge Function: math-validate
// Purpose: Math/cross-field validation — check that numbers add up, weights
//          are consistent, totals match across documents. Pure logic (no AI).
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

// --- Parsing helpers --------------------------------------------------------
// Pull a numeric value out of a messy string like "$1,234.56 USD" or "1234 kg"
function parseNumber(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).replace(/[, ]/g, "").replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Normalize unit strings to canonical short forms BEFORE any comparison.
//   "lbs", "lb", "pounds", "pound"  → "lbs"
//   "kg", "kgs", "kilograms", "kilogram" → "kg"
//   "g", "gram", "grams"            → "g"
//   "oz", "ounce", "ounces"         → "oz"
//   "ton", "tons", "tonne", "tonnes" → "tons"
// Anything else is returned lowercased as-is so unknown units don't silently
// collapse together (which would cause false-positive mismatches).
function normalizeUnit(raw: string | null | undefined): string {
  if (!raw) return "";
  const u = String(raw).trim().toLowerCase();
  if (u === "lb" || u === "lbs" || u === "pound" || u === "pounds") return "lbs";
  if (u === "kg" || u === "kgs" || u === "kilogram" || u === "kilograms") return "kg";
  if (u === "g" || u === "gram" || u === "grams") return "g";
  if (u === "oz" || u === "ounce" || u === "ounces") return "oz";
  if (u === "ton" || u === "tons" || u === "tonne" || u === "tonnes") return "tons";
  return u;
}

// Pull weight number + unit from "1234 kg" / "1,234.5 lb" / "500g" / "500 pounds"
// The unit is normalized to its canonical short form via normalizeUnit().
function parseWeight(v: string | null | undefined): { value: number; unit: string } | null {
  if (!v) return null;
  // Accept spelled-out unit forms (pounds, kilograms, etc.) in addition to
  // the short forms handled previously.
  const m = String(v).match(
    /^([\d,]+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lbs?|pounds?|g|grams?|oz|ounces?|tons?|tonnes?)?$/i
  );
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  const unit = normalizeUnit(m[2]);
  if (!Number.isFinite(value)) return null;
  return { value, unit };
}

// Convert a parsed weight to kg for comparison. Uses the canonical unit
// produced by normalizeUnit() so we don't need to handle every spelling here.
function toKg(w: { value: number; unit: string }): number {
  switch (w.unit) {
    case "lbs":
      return w.value * 0.45359237;
    case "g":
      return w.value / 1000;
    case "oz":
      return w.value * 0.0283495231;
    case "tons":
      return w.value * 907.18474; // assume short ton
    case "kg":
    case "": // unspecified — assume kg
    default:
      return w.value;
  }
}

// --- Main handler -----------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // created for pattern symmetry; unused here
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

    // 1. Fetch all document_fields for this shipment (with document context)
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
        documents (
          doc_type,
          file_name
        )
      `
      )
      .eq("shipment_id", shipmentId);

    if (fieldsErr) {
      console.error("[math-validate] fields query error:", fieldsErr);
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
        message: "No document_fields found — nothing to math-validate.",
      });
    }

    const errors: any[] = [];
    const exceptionsToInsert: any[] = [];

    // 2. Group numeric fields by field_key for cross-doc comparison
    const numericFields = ["declaredValue", "netWeight", "grossWeight", "htsCode"];
    const grouped: Record<string, any[]> = {};
    for (const f of fields) {
      if (numericFields.includes(f.field_key)) {
        if (!grouped[f.field_key]) grouped[f.field_key] = [];
        grouped[f.field_key].push(f);
      }
    }

    // 2a. declaredValue consistency across docs (multiple invoices?)
    if (grouped.declaredValue && grouped.declaredValue.length > 1) {
      const values = grouped.declaredValue.map((f) => ({
        f,
        n: parseNumber(f.extracted_value),
      }));
      const validValues = values.filter((v) => v.n != null);
      if (validValues.length >= 2) {
        const first = validValues[0].n!;
        for (let i = 1; i < validValues.length; i++) {
          const cur = validValues[i].n!;
          // > 1% difference threshold
          if (Math.abs(first - cur) / Math.max(first, 1) > 0.01) {
            const errMsg = `Declared value mismatch: ${first} vs ${cur} across documents (${validValues[0].f.documents?.doc_type} vs ${validValues[i].f.documents?.doc_type})`;
            errors.push({
              type: "declared_value_mismatch",
              field_key: "declaredValue",
              message: errMsg,
              values: [first, cur],
            });
            // Create an exception for each conflicting field
            for (const v of [validValues[0], validValues[i]]) {
              exceptionsToInsert.push({
                shipment_id: shipmentId,
                field_id: v.f.id,
                user_id: user.id,
                field_key: "declaredValue",
                field_name: "Total Declared Value",
                extracted_value: v.f.extracted_value,
                confidence: v.f.confidence,
                reason: errMsg,
                exception_type: "math_error",
                doc_type: v.f.documents?.doc_type || null,
                status: "Unresolved",
              });
            }
            break; // only flag the first mismatch per field_key
          }
        }
      }
    }

    // 2b. netWeight consistency across docs
    if (grouped.netWeight && grouped.netWeight.length > 1) {
      const weights = grouped.netWeight
        .map((f) => ({ f, w: parseWeight(f.extracted_value) }))
        .filter((x) => x.w != null) as Array<{ f: any; w: { value: number; unit: string } }>;

      if (weights.length >= 2) {
        const firstKg = toKg(weights[0].w);
        for (let i = 1; i < weights.length; i++) {
          const curKg = toKg(weights[i].w);
          // > 5% tolerance (weights often vary slightly due to packaging)
          if (Math.abs(firstKg - curKg) / Math.max(firstKg, 1) > 0.05) {
            const errMsg = `Net weight mismatch: ${weights[0].f.extracted_value} (${weights[0].f.documents?.doc_type}) vs ${weights[i].f.extracted_value} (${weights[i].f.documents?.doc_type}) — exceeds 5% tolerance`;
            errors.push({
              type: "net_weight_mismatch",
              field_key: "netWeight",
              message: errMsg,
              values: [weights[0].f.extracted_value, weights[i].f.extracted_value],
            });
            for (const w of [weights[0], weights[i]]) {
              exceptionsToInsert.push({
                shipment_id: shipmentId,
                field_id: w.f.id,
                user_id: user.id,
                field_key: "netWeight",
                field_name: "Net Weight",
                extracted_value: w.f.extracted_value,
                confidence: w.f.confidence,
                reason: errMsg,
                exception_type: "math_error",
                doc_type: w.f.documents?.doc_type || null,
                status: "Unresolved",
              });
            }
            break;
          }
        }
      }
    }

    // 2c. grossWeight >= netWeight
    //    First check per-document pairs (gross + net on the SAME document —
    //    that's the most meaningful comparison). Then fall back to a shipment-
    //    level comparison (first gross vs first net) for the case where the
    //    two fields live on different documents.
    if (grouped.grossWeight && grouped.netWeight) {
      const gross = grouped.grossWeight
        .map((f) => ({ f, w: parseWeight(f.extracted_value) }))
        .filter((x) => x.w != null) as Array<{ f: any; w: { value: number; unit: string } }>;
      const net = grouped.netWeight
        .map((f) => ({ f, w: parseWeight(f.extracted_value) }))
        .filter((x) => x.w != null) as Array<{ f: any; w: { value: number; unit: string } }>;

      if (gross.length > 0 && net.length > 0) {
        // Try to find a per-document pair first (most accurate check).
        let checkedPair = false;
        for (const g of gross) {
          const matchingNet = net.find((n) => n.f.document_id === g.f.document_id);
          if (!matchingNet) continue;
          const grossKg = toKg(g.w);
          const netKg = toKg(matchingNet.w);
          if (grossKg < netKg) {
            const errMsg = `Gross weight (${g.f.extracted_value}) is less than net weight (${matchingNet.f.extracted_value}) on document ${g.f.documents?.file_name || g.f.document_id} — gross must be >= net`;
            errors.push({
              type: "gross_less_than_net",
              field_key: "grossWeight",
              message: errMsg,
              values: [grossKg, netKg],
              document_id: g.f.document_id,
            });
            exceptionsToInsert.push({
              shipment_id: shipmentId,
              field_id: g.f.id,
              user_id: user.id,
              field_key: "grossWeight",
              field_name: "Gross Weight",
              extracted_value: g.f.extracted_value,
              confidence: g.f.confidence,
              reason: errMsg,
              exception_type: "math_error",
              doc_type: g.f.documents?.doc_type || null,
              status: "Unresolved",
            });
          }
          checkedPair = true;
        }

        // Fallback: no per-document pair, but the shipment has both fields —
        // compare the first gross vs the first net as a sanity check.
        if (!checkedPair) {
          const grossKg = toKg(gross[0].w);
          const netKg = toKg(net[0].w);
          if (grossKg < netKg) {
            const errMsg = `Gross weight (${gross[0].f.extracted_value}) is less than net weight (${net[0].f.extracted_value}) — gross must be >= net`;
            errors.push({
              type: "gross_less_than_net",
              field_key: "grossWeight",
              message: errMsg,
              values: [grossKg, netKg],
            });
            exceptionsToInsert.push({
              shipment_id: shipmentId,
              field_id: gross[0].f.id,
              user_id: user.id,
              field_key: "grossWeight",
              field_name: "Gross Weight",
              extracted_value: gross[0].f.extracted_value,
              confidence: gross[0].f.confidence,
              reason: errMsg,
              exception_type: "math_error",
              doc_type: gross[0].f.documents?.doc_type || null,
              status: "Unresolved",
            });
          }
        }
      }
    }

    // 2d. HTS code consistency across documents
    if (grouped.htsCode && grouped.htsCode.length > 1) {
      const normalized = grouped.htsCode.map((f) => ({
        f,
        normalized: String(f.extracted_value || "").replace(/[.\-\s]/g, ""),
      }));
      const first = normalized[0].normalized;
      for (let i = 1; i < normalized.length; i++) {
        if (normalized[i].normalized !== first) {
          const errMsg = `HTS code mismatch across documents: "${normalized[0].f.extracted_value}" (${normalized[0].f.documents?.doc_type}) vs "${normalized[i].f.extracted_value}" (${normalized[i].f.documents?.doc_type})`;
          errors.push({
            type: "hts_mismatch",
            field_key: "htsCode",
            message: errMsg,
            values: [
              normalized[0].f.extracted_value,
              normalized[i].f.extracted_value,
            ],
          });
          for (const n of [normalized[0], normalized[i]]) {
            exceptionsToInsert.push({
              shipment_id: shipmentId,
              field_id: n.f.id,
              user_id: user.id,
              field_key: "htsCode",
              field_name: "HTS Code",
              extracted_value: n.f.extracted_value,
              confidence: n.f.confidence,
              reason: errMsg,
              exception_type: "math_error",
              doc_type: n.f.documents?.doc_type || null,
              status: "Unresolved",
            });
          }
          break;
        }
      }
    }

    // 3. Insert any math_error exceptions
    if (exceptionsToInsert.length > 0) {
      const { error: exInsErr } = await userClient
        .from("exceptions")
        .insert(exceptionsToInsert);
      if (exInsErr) {
        console.error("[math-validate] exception insert failed:", exInsErr);
      }

      // Also flag the corresponding document_fields
      const fieldIds = new Set(exceptionsToInsert.map((e) => e.field_id));
      for (const fid of fieldIds) {
        if (fid) {
          await userClient
            .from("document_fields")
            .update({ is_flagged: true })
            .eq("id", fid);
        }
      }
    }

    // 4. Audit log
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Math validation: ${errors.length} error(s) detected; ${exceptionsToInsert.length} exception(s) created. Unit normalization applied (lbs/lb/pounds→lbs, kg/kgs/kilograms→kg, etc.) before comparison.`,
      type: errors.length > 0 ? "warning" : "success",
    });

    // 5. Respond
    return jsonRes({
      success: true,
      shipmentId,
      errors,
      exceptionsCreated: exceptionsToInsert.length,
      fieldsChecked: fields.length,
    });
  } catch (err: any) {
    console.error("[math-validate] unhandled error:", err);
    return jsonRes(
      { error: "Internal server error", detail: String(err?.message || err) },
      500
    );
  }
});
