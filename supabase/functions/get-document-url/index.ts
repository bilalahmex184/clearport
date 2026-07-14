// ============================================================================
// Edge Function: get-document-url
// Purpose: Generate a 1-hour signed URL for viewing a document stored in the
//          private 'documents' bucket. The caller can supply either a direct
//          `storagePath` OR a `documentId` (the function will look up the
//          path). Uses the user-scoped client for the documents lookup so RLS
//          enforces ownership, and the admin client for signed URL generation.
// Input: JSON { storagePath?: string, documentId?: string }
// Output: { success: true, signedUrl: string }
//         { success: false, error: "File not found" } (HTTP 404)
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

// Signed URL lifetime in seconds (1 hour)
const SIGNED_URL_TTL = 3600;
const BUCKET_NAME = "documents";

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

    // 2. Parse body — accept either storagePath or documentId
    const body = await req.json().catch(() => ({}));
    const { storagePath, documentId } = body || {};

    if (!storagePath && !documentId) {
      return jsonRes(
        {
          success: false,
          error: "Provide either 'storagePath' or 'documentId'.",
        },
        400
      );
    }

    let finalStoragePath: string | undefined =
      typeof storagePath === "string" && storagePath.trim()
        ? storagePath.trim()
        : undefined;

    // 3. If documentId was provided, look up the document row (RLS-protected)
    if (!finalStoragePath && documentId) {
      const { data: doc, error: docErr } = await userClient
        .from("documents")
        .select("id, storage_path, file_name, user_id")
        .eq("id", documentId)
        .maybeSingle();

      if (docErr) {
        if (isSchemaError(docErr)) {
          return jsonRes({ success: false, error: SCHEMA_HINT }, 500);
        }
        console.error("[get-document-url] document lookup failed:", docErr);
        return jsonRes(
          { success: false, error: docErr.message },
          500
        );
      }
      if (!doc) {
        return jsonRes(
          { success: false, error: "File not found" },
          404
        );
      }
      finalStoragePath = doc.storage_path;
    }

    if (!finalStoragePath) {
      return jsonRes(
        { success: false, error: "File not found" },
        404
      );
    }

    // 4. Verify the object actually exists in Storage before generating the URL
    //    (createSignedUrl alone doesn't validate existence — the URL would
    //    just 404 when accessed). We split the path into folder + filename
    //    and call list() with a search filter.
    const pathParts = finalStoragePath.split("/");
    const fileName = pathParts.pop() || "";
    const folder = pathParts.join("/");

    const admin = createAdminClient();

    // List with search filter — should return at most the matching file
    const { data: fileList, error: listErr } = await admin.storage
      .from(BUCKET_NAME)
      .list(folder || undefined, {
        limit: 100,
        search: fileName,
      });

    if (listErr) {
      console.error("[get-document-url] storage list failed:", listErr);
      return jsonRes(
        {
          success: false,
          error: "Failed to verify file in storage",
          detail: listErr.message,
        },
        500
      );
    }

    const fileExists = Array.isArray(fileList) &&
      fileList.some((f: any) => f.name === fileName);

    if (!fileExists) {
      return jsonRes(
        { success: false, error: "File not found" },
        404
      );
    }

    // 5. Generate a 1-hour signed URL using the admin client.
    //    (Admin bypasses storage RLS; the user's ownership was already
    //    verified above via RLS-protected documents lookup.)
    const { data: signedUrlData, error: signedUrlErr } = await admin.storage
      .from(BUCKET_NAME)
      .createSignedUrl(finalStoragePath, SIGNED_URL_TTL);

    if (signedUrlErr || !signedUrlData?.signedUrl) {
      console.error("[get-document-url] createSignedUrl failed:", signedUrlErr);
      return jsonRes(
        {
          success: false,
          error: "Failed to generate signed URL",
          detail: signedUrlErr?.message,
        },
        500
      );
    }

    return jsonRes({
      success: true,
      signedUrl: signedUrlData.signedUrl,
      expiresIn: SIGNED_URL_TTL,
    });
  } catch (err: any) {
    console.error("[get-document-url] unhandled error:", err);
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
