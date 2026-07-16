// ============================================================================
// Edge Function: get-shipments
// Purpose: Fetch all shipments for the authenticated user, fully hydrated with
//          their documents, extracted fields, and exceptions — transformed to
//          the camelCase ShipmentEntry shape used by the ClearPort frontend.
// Input: none (just JWT in Authorization header)
// Output: { success: true, shipments: ShipmentEntry[] }
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

// Detect "schema not deployed" errors so we can give the operator a useful hint.
function isSchemaError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  const code = err.code || "";
  return (
    msg.includes("does not exist") ||
    msg.includes("could not find the") ||
    msg.includes("relation") && msg.includes("public.") ||
    code === "PGRST205" ||
    code === "42P01"
  );
}

const SCHEMA_HINT =
  "Schema not deployed. Run supabase/schema.sql in Supabase SQL Editor.";

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

    // 2. Fetch all shipments for the user (RLS scopes to user_id = auth.uid())
    const { data: shipments, error: shipmentsError } = await userClient
      .from("shipments")
      .select("*")
      .order("created_at", { ascending: false });

    if (shipmentsError) {
      if (isSchemaError(shipmentsError)) {
        return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
      }
      console.error("[get-shipments] shipments query failed:", shipmentsError);
      return jsonRes(
        { success: false, error: shipmentsError.message },
        500
      );
    }

    // 3. No shipments — return empty array (do NOT seed demo data)
    if (!shipments || shipments.length === 0) {
      return jsonRes({ success: true, shipments: [] });
    }

    const shipmentIds = shipments.map((s: any) => s.id);

    // 4. Parallel fetch of all related rows for these shipments
    const [documentsRes, fieldsRes, exceptionsRes] = await Promise.all([
      userClient
        .from("documents")
        .select("*")
        .in("shipment_id", shipmentIds),
      userClient
        .from("document_fields")
        .select("*")
        .in("shipment_id", shipmentIds),
      userClient
        .from("exceptions")
        .select("*")
        .in("shipment_id", shipmentIds),
    ]);

    if (documentsRes.error && isSchemaError(documentsRes.error)) {
      return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
    }
    if (fieldsRes.error && isSchemaError(fieldsRes.error)) {
      return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
    }
    if (exceptionsRes.error && isSchemaError(exceptionsRes.error)) {
      return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
    }

    const documents = documentsRes.data || [];
    const fields = fieldsRes.data || [];
    const exceptions = exceptionsRes.data || [];

    // 5. Build lookup maps for O(1) joins during transform
    //    - docTypeByDocId: document_id -> doc_type (used to populate sourceDoc on fields)
    //    - exceptionIdByFieldId: field_id -> exception_id (links a field to its exception)
    const docTypeByDocId = new Map<string, string>();
    for (const doc of documents) {
      docTypeByDocId.set(doc.id, doc.doc_type || "Unknown");
    }

    const exceptionIdByFieldId = new Map<string, string>();
    for (const ex of exceptions) {
      if (ex.field_id && !exceptionIdByFieldId.has(ex.field_id)) {
        exceptionIdByFieldId.set(ex.field_id, ex.id);
      }
    }

    // 6. Group child rows by shipment_id
    const docsByShipment = new Map<string, any[]>();
    const fieldsByShipment = new Map<string, any[]>();
    const exceptionsByShipment = new Map<string, any[]>();

    for (const doc of documents) {
      const arr = docsByShipment.get(doc.shipment_id) || [];
      arr.push(doc);
      docsByShipment.set(doc.shipment_id, arr);
    }
    for (const f of fields) {
      const arr = fieldsByShipment.get(f.shipment_id) || [];
      arr.push(f);
      fieldsByShipment.set(f.shipment_id, arr);
    }
    for (const ex of exceptions) {
      const arr = exceptionsByShipment.get(ex.shipment_id) || [];
      arr.push(ex);
      exceptionsByShipment.set(ex.shipment_id, arr);
    }

    // 7. Transform DB rows -> frontend ShipmentEntry shape (camelCase)
    const result = shipments.map((s: any) => {
      const shipDocs = docsByShipment.get(s.id) || [];
      const shipFields = fieldsByShipment.get(s.id) || [];
      const shipExceptions = exceptionsByShipment.get(s.id) || [];

      return {
        id: s.id,
        shipper: s.shipper,
        consignee: s.consignee,
        status: s.status,
        docsCount: s.docs_count,
        urgency: s.urgency,
        initialConfidence: s.initial_confidence,
        currentConfidence: s.current_confidence,
        createdAt: s.created_at,

        documents: shipDocs.map((d: any) => ({
          id: d.id,
          docType: d.doc_type,
          fileName: d.file_name,
          storagePath: d.storage_path,
          mimeType: d.mime_type,
          uploadedAt: d.uploaded_at,
        })),

        fields: shipFields.map((f: any) => ({
          id: f.id,
          key: f.field_key,
          label: f.field_label,
          // Corrected value takes precedence over extracted value
          value: f.corrected_value || f.extracted_value || "",
          // Resolve the source document's doc_type from the document lookup
          sourceDoc: docTypeByDocId.get(f.document_id) || "Unknown",
          isFlagged: !!f.is_flagged,
          // Link the field to its exception (if any) — first match wins
          exceptionId: exceptionIdByFieldId.get(f.id) || undefined,
          confidence: f.confidence,
          correctedValue: f.corrected_value || undefined,
          crossDocValue: f.cross_doc_value || undefined,
          crossDocSource: f.cross_doc_source || undefined,
          boundingBox: f.bounding_box || undefined,
        })),

        exceptions: shipExceptions.map((ex: any) => ({
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
        })),
      };
    });

    return jsonRes({ success: true, shipments: result });
  } catch (err: any) {
    console.error("[get-shipments] unhandled error:", err);
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
