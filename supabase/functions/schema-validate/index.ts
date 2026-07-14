// ============================================================================
// Edge Function: schema-validate
// Purpose: JSON schema validation of extracted fields — check format, required
//          fields, data types. Pure logic validation (no Gemini).
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

// --- Validation rules -------------------------------------------------------
// Each rule receives the raw extracted_value and returns an error string or null.
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
    description: "currency pattern $X,XXX.XX or X,XXX.XX",
    rule: (v) => {
      if (!v) return "declaredValue is empty";
      // Accept: $1,234.56 | 1234.56 | $1234 | USD 1,234.56
      const cleaned = v.replace(/^(USD|usd|\$)\s*/, "").replace(/,/g, "");
      if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
        return `declaredValue "${v}" is not a valid currency value`;
      }
      return null;
    },
  },
  htsCode: {
    description: "HTS format XXXX.XX.XXXX or XXXXXX.XXXX",
    rule: (v) => {
      if (!v) return "htsCode is empty";
      // Accept XXXX.XX.XXXX (with dots) or XXXXXXXXXXXX (10+ digits)
      const withDots = /^\d{4}\.\d{2}\.\d{4}$/;
      const plainDigits = /^\d{8,10}$/;
      if (!withDots.test(v) && !plainDigits.test(v)) {
        return `htsCode "${v}" is not in XXXX.XX.XXXX format`;
      }
      return null;
    },
  },
  netWeight: {
    description: "number + unit (kg / lb / g)",
    rule: (v) => {
      if (!v) return "netWeight is empty";
      // Accept: 1234 kg | 1,234.56 lb | 1234.56g | 1234
      const m = v.match(/^([\d,]+(?:\.\d+)?)\s*(kg|lbs?|g|oz|tons?|kgs)?$/i);
      if (!m) return `netWeight "${v}" is not a valid weight value`;
      return null;
    },
  },
  countryOfOrigin: {
    description: "2-letter ISO country code",
    rule: (v) => {
      if (!v) return "countryOfOrigin is empty";
      if (!/^[A-Za-z]{2}$/.test(v.trim())) {
        return `countryOfOrigin "${v}" is not a 2-letter ISO code`;
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

    // 1. Fetch all document_fields for this shipment
    const { data: fields, error: fieldsErr } = await userClient
      .from("document_fields")
      .select(
        "id, document_id, field_key, field_label, extracted_value, confidence, is_flagged, validation_errors"
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
        message: "No document_fields found — nothing to schema-validate.",
      });
    }

    const errors: any[] = [];
    const updates: Promise<any>[] = [];

    // 2. For each field, validate against schema rules
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

        updates.push(
          userClient
            .from("document_fields")
            .update({
              is_flagged: true,
              validation_errors: filtered,
            })
            .eq("id", f.id)
        );
      } else {
        // If valid, clear schema-sourced errors (and unflag if no other errors remain)
        if (filtered.length === 0) {
          updates.push(
            userClient
              .from("document_fields")
              .update({
                is_flagged: false,
                validation_errors: [],
              })
              .eq("id", f.id)
          );
        } else {
          updates.push(
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

    // 3. Apply updates
    await Promise.allSettled(updates);

    // 4. Audit log
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Schema validation: ${errors.length} format error(s) across ${fields.length} field(s).`,
      type: errors.length > 0 ? "warning" : "success",
    });

    // 5. Respond
    return jsonRes({
      success: true,
      shipmentId,
      errors,
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
