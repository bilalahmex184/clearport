// ============================================================================
// Edge Function: upload-document
// Purpose: Securely upload a customs document to Supabase Storage and create
//          a corresponding `documents` row (and shipment row if missing).
// Input: multipart/form-data with `file`, `shipment_id`, optional `document_id`
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

// --- File validation --------------------------------------------------------
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/tiff": "tiff",
  "application/tiff": "tiff",
  "image/x-tiff": "tiff",
  "text/plain": "txt",
  "text/csv": "txt",
};

// --- doc_type detection -----------------------------------------------------
function detectDocType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("packing") || lower.includes("pack")) return "Packing List";
  if (lower.includes("lading") || lower.includes("bol") || lower.includes("b_l"))
    return "Bill of Lading";
  if (lower.includes("origin") || lower.includes("coo")) return "Certificate of Origin";
  return "Commercial Invoice";
}

// Sanitize filename — strip path components, drop unsafe chars
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || "document";
  return base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

// --- Main handler -----------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Verify JWT
    const userClient = createUserClient(req);
    if (!userClient) return jsonRes({ error: "Missing Authorization header" }, 401);
    const user = await getUser(userClient);
    if (!user) return jsonRes({ error: "Unauthorized — invalid JWT" }, 401);

    // 2. Parse multipart form
    const formData = await req.formData();
    const file = formData.get("file");
    const shipmentId = (formData.get("shipment_id") as string)?.trim();
    const providedDocId =
      (formData.get("document_id") as string | null)?.trim() || null;

    if (!file || !(file instanceof File)) {
      return jsonRes({ error: "Missing 'file' in form data" }, 400);
    }
    if (!shipmentId) {
      return jsonRes({ error: "Missing 'shipment_id' in form data" }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return jsonRes(
        { error: `File exceeds 10MB limit (got ${file.size} bytes)` },
        413
      );
    }

    // Determine MIME type (fallback to extension if browser didn't set one)
    let mimeType = file.type || "";
    if (!mimeType) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const extMap: Record<string, string> = {
        pdf: "application/pdf",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        tif: "image/tiff",
        tiff: "image/tiff",
        txt: "text/plain",
        csv: "text/csv",
      };
      mimeType = extMap[ext] || "";
    }
    if (!ALLOWED_MIME[mimeType]) {
      return jsonRes(
        {
          error: `Unsupported file type: ${mimeType || "unknown"}. Allowed: PDF, PNG, JPEG, TIFF.`,
        },
        415
      );
    }

    // 3. Sanitize filename + build storage path
    const safeName = sanitizeFilename(file.name);
    const timestamp = Date.now();
    const storagePath = `${user.id}/${shipmentId}/${timestamp}-${safeName}`;
    const docType = detectDocType(file.name);

    // 4. Read file bytes
    const fileBuf = new Uint8Array(await file.arrayBuffer());

    // 5. Admin client for Storage upload (bypasses RLS for storage.objects)
    const admin = createAdminClient();
    const { error: uploadError } = await admin.storage
      .from("documents")
      .upload(storagePath, fileBuf, {
        contentType: mimeType,
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("[upload-document] Storage upload failed:", uploadError);
      return jsonRes(
        { error: "Storage upload failed", detail: uploadError.message },
        500
      );
    }

    // 6. Ensure shipment exists (RLS-protected query via user client).
    //    If the shipment row doesn't exist yet, create it with defaults.
    const { data: existingShipment, error: shipLookupErr } = await userClient
      .from("shipments")
      .select("id, docs_count")
      .eq("id", shipmentId)
      .maybeSingle();

    if (shipLookupErr) {
      console.error("[upload-document] shipment lookup error:", shipLookupErr);
      return jsonRes(
        { error: "Failed to verify shipment", detail: shipLookupErr.message },
        500
      );
    }

    if (!existingShipment) {
      const { error: createShipErr } = await userClient
        .from("shipments")
        .insert({
          id: shipmentId,
          user_id: user.id,
          shipper: "Unknown Shipper",
          consignee: "Unknown Consignee",
          status: "Under Review",
          docs_count: 0,
          urgency: "PENDING",
          initial_confidence: 0,
          current_confidence: 0,
        });
      if (createShipErr) {
        console.error(
          "[upload-document] Failed to auto-create shipment:",
          createShipErr
        );
        return jsonRes(
          { error: "Failed to create shipment", detail: createShipErr.message },
          500
        );
      }
    }

    // 7. Insert documents row (user-scoped client — RLS applies)
    const insertPayload: any = {
      shipment_id: shipmentId,
      user_id: user.id,
      doc_type: docType,
      file_name: file.name, // preserve original display name
      storage_path: storagePath,
      file_size: file.size,
      mime_type: mimeType,
    };
    if (providedDocId) {
      // Allow caller to specify a deterministic UUID (must be valid uuid)
      insertPayload.id = providedDocId;
    }

    const { data: docRow, error: docInsertErr } = await userClient
      .from("documents")
      .insert(insertPayload)
      .select("id")
      .single();

    if (docInsertErr || !docRow) {
      console.error("[upload-document] documents insert failed:", docInsertErr);
      // Best-effort: clean up the uploaded file so we don't orphan blobs
      await admin.storage.from("documents").remove([storagePath]);
      return jsonRes(
        {
          error: "Failed to create document record",
          detail: docInsertErr?.message,
        },
        500
      );
    }

    // 8. Bump shipment.docs_count
    const newCount = (existingShipment?.docs_count || 0) + 1;
    await userClient
      .from("shipments")
      .update({ docs_count: newCount })
      .eq("id", shipmentId);

    // 9. Generate signed URL (1 hour expiry) using admin client
    const { data: signedUrlData, error: signedUrlErr } = await admin.storage
      .from("documents")
      .createSignedUrl(storagePath, 3600);

    const signedUrl = signedUrlData?.signedUrl || "";

    if (signedUrlErr) {
      console.warn(
        "[upload-document] signed URL generation warning:",
        signedUrlErr
      );
    }

    // 10. Audit log entry
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Uploaded ${docType} (${file.name}, ${file.size} bytes)`,
      type: "info",
    });

    // 11. Respond
    return jsonRes({
      success: true,
      documentId: docRow.id,
      shipmentId,
      storagePath,
      signedUrl,
      docType,
    });
  } catch (err: any) {
    console.error("[upload-document] unhandled error:", err);
    return jsonRes(
      { error: "Internal server error", detail: String(err?.message || err) },
      500
    );
  }
});
