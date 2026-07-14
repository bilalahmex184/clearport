// ============================================================================
// Edge Function: export-csv
// Purpose: Generate a CSV string of shipment audit data — first all extracted
//          fields with their confidence/flagging/review status, then a blank
//          line, then all exceptions with their resolution status. Returns the
//          CSV inline (as a JSON string) and writes an audit log entry.
// Input: JSON { shipmentId: string }
// Output: { success: true, csv: string, filename: string }
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

// --- CSV utilities ----------------------------------------------------------
// Per RFC 4180: wrap a value in double quotes if it contains a comma, double
// quote, newline, or carriage return. Escape any inner double quotes by
// doubling them.
function csvEscape(value: any): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Join an array of values into a single CSV row, ending with CRLF (Excel-friendly)
function csvRow(values: any[]): string {
  return values.map(csvEscape).join(",") + "\r\n";
}

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

    // 2. Parse body
    const body = await req.json().catch(() => ({}));
    const { shipmentId } = body || {};
    if (!shipmentId || typeof shipmentId !== "string") {
      return jsonRes(
        { success: false, error: "Missing or invalid 'shipmentId'" },
        400
      );
    }

    // 3. Fetch the shipment (RLS protects ownership)
    const { data: shipment, error: shipErr } = await userClient
      .from("shipments")
      .select("id, shipper, consignee, status, created_at")
      .eq("id", shipmentId)
      .maybeSingle();

    if (shipErr) {
      if (isSchemaError(shipErr)) {
        return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
      }
      console.error("[export-csv] shipment fetch failed:", shipErr);
      return jsonRes({ success: false, error: shipErr.message }, 500);
    }
    if (!shipment) {
      return jsonRes({ success: false, error: "Shipment not found" }, 404);
    }

    // 4. Parallel fetch of fields, documents (for source doc lookup), exceptions
    const [fieldsRes, docsRes, exceptionsRes] = await Promise.all([
      userClient
        .from("document_fields")
        .select("*")
        .eq("shipment_id", shipmentId)
        .order("field_label", { ascending: true }),
      userClient
        .from("documents")
        .select("id, doc_type, file_name")
        .eq("shipment_id", shipmentId),
      userClient
        .from("exceptions")
        .select("*")
        .eq("shipment_id", shipmentId)
        .order("created_at", { ascending: true }),
    ]);

    if (fieldsRes.error && isSchemaError(fieldsRes.error)) {
      return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
    }
    if (docsRes.error && isSchemaError(docsRes.error)) {
      return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
    }
    if (exceptionsRes.error && isSchemaError(exceptionsRes.error)) {
      return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
    }

    const fields = fieldsRes.data || [];
    const documents = docsRes.data || [];
    const exceptions = exceptionsRes.data || [];

    // Build document_id -> doc_type lookup so fields can show source document
    const docTypeByDocId = new Map<string, string>();
    for (const d of documents) {
      docTypeByDocId.set(d.id, d.doc_type || "Unknown");
    }

    // 5. Build CSV — start with a small header block for human-readability
    const lines: string[] = [];
    lines.push(csvRow(["ClearPort Audit Export"]));
    lines.push(
      csvRow([
        "Shipment ID",
        shipmentId,
      ])
    );
    lines.push(csvRow(["Shipper", shipment.shipper || ""]));
    lines.push(csvRow(["Consignee", shipment.consignee || ""]));
    lines.push(csvRow(["Status", shipment.status || ""]));
    lines.push(
      csvRow([
        "Created At",
        shipment.created_at ? new Date(shipment.created_at).toISOString() : "",
      ])
    );
    lines.push(csvRow(["Exported At", new Date().toISOString()]));
    lines.push(csvRow(["Exported By", user.email || user.id]));
    lines.push(""); // blank line

    // --- Section 1: Extracted Fields ---
    lines.push(
      csvRow([
        "Field Key",
        "Field Label",
        "Value",
        "Source Document",
        "Confidence",
        "Flagged",
        "Status",
      ])
    );
    for (const f of fields) {
      const value = f.corrected_value || f.extracted_value || "";
      const sourceDoc = docTypeByDocId.get(f.document_id) || "Unknown";
      const flagged = f.is_flagged ? "true" : "false";
      const status = f.reviewer_action || "Pending";
      lines.push(
        csvRow([
          f.field_key,
          f.field_label,
          value,
          sourceDoc,
          f.confidence,
          flagged,
          status,
        ])
      );
    }

    lines.push(""); // blank line

    // --- Section 2: Exceptions ---
    lines.push(
      csvRow([
        "Exception ID",
        "Field Name",
        "Reason",
        "Confidence",
        "Status",
        "Resolved By",
      ])
    );
    for (const ex of exceptions) {
      lines.push(
        csvRow([
          ex.id,
          ex.field_name,
          ex.reason,
          ex.confidence,
          ex.status,
          ex.resolved_by || "",
        ])
      );
    }

    const csv = lines.join("");

    // 6. Audit log entry
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Exported CSV audit report for ${shipmentId} (${fields.length} fields, ${exceptions.length} exceptions)`,
      type: "info",
    });

    // 7. Build a filesystem-safe filename
    const safeShipmentId = shipmentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `ClearPort_Audit_${safeShipmentId}.csv`;

    return jsonRes({ success: true, csv, filename });
  } catch (err: any) {
    console.error("[export-csv] unhandled error:", err);
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
