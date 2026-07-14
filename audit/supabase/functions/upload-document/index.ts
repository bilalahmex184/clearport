import { createClient } from "npm:@supabase/supabase-js@2.44.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9.-]/g, "_");
}

Deno.serve(async (req) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [INFO] Received document upload request.`);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");

    // Robust detection of service role key:
    let serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY");

    if (!serviceRoleKey) {
      const rawSecretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
      if (rawSecretKeys) {
        try {
          const secretKeys = JSON.parse(rawSecretKeys);
          serviceRoleKey = secretKeys["my_super_base_key"];
        } catch (e) {
          console.error("Failed to parse SUPABASE_SECRET_KEYS JSON:", e);
        }
      }
    }

    // Last fallback: check if standard service_role is in other environment variables or throw
    if (!serviceRoleKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY, SERVICE_ROLE_KEY, or SUPABASE_SECRET_KEYS with my_super_base_key is required");
    }

    const supabaseClient = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: {
        persistSession: false,
      },
    });

    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      console.warn(`[${timestamp}] [WARNING] Rejected request due to invalid Content-Type: ${contentType}`);
      return new Response(
        JSON.stringify({ error: "Expected multipart/form-data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const shipmentId = formData.get("shipment_id") as string | null;
    const documentId = formData.get("document_id") as string | null;

    if (!file) {
      console.warn(`[${timestamp}] [WARNING] Rejected request due to missing file.`);
      return new Response(
        JSON.stringify({ error: "Missing file field in form data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Core Server-side Upload Validation
    const maxSizeBytes = 10 * 1024 * 1024; // 10MB limit
    if (file.size > maxSizeBytes) {
      console.warn(`[${timestamp}] [WARNING] Rejected file "${file.name}" because it exceeds 10MB limit (${file.size} bytes).`);
      return new Response(
        JSON.stringify({ error: "File size exceeds the 10MB limit." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const allowedMimeTypes = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/tiff",
    ];
    if (!allowedMimeTypes.includes(file.type)) {
      console.warn(`[${timestamp}] [WARNING] Rejected file "${file.name}" because MIME type "${file.type}" is not allowed.`);
      return new Response(
        JSON.stringify({ error: `File type "${file.type}" is not allowed. Supported formats: PDF, PNG, JPEG, TIFF.` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const shipId = shipmentId || "unknown-shipment";
    const docId = documentId || crypto.randomUUID();
    const bucketName = "documents";
    
    // 2. Fix File Overwrite Bug with unique timestamp + UUID prefix while keeping name readable
    const uniqueId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const sanitizedFileName = sanitizeFileName(file.name);
    const filePath = `${shipId}/${uniqueId}-${sanitizedFileName}`;

    console.log(`[${timestamp}] [INFO] Processing upload for Shipment: ${shipId}, File: ${file.name}, Target Path: ${filePath}`);

    // Ensure bucket exists (create it once; tolerate "already exists")
    const { data: buckets, error: listError } = await supabaseClient.storage.listBuckets();
    if (listError) {
      console.error(`[${timestamp}] [ERROR] Failed to list buckets:`, listError);
      throw listError;
    }

    const bucketExists = buckets?.some((b) => b.name === bucketName);
    if (!bucketExists) {
      console.log(`[${timestamp}] [INFO] Creating bucket "${bucketName}"...`);
      // 3. Private Storage Bucket: public is set to false
      const { error: createError } = await supabaseClient.storage.createBucket(
        bucketName,
        {
          public: false, // Strict Private Bucket
          allowedMimeTypes,
        }
      );

      if (createError) {
        const msg = (createError.message || "").toLowerCase();
        const alreadyExists = msg.includes("exists") || msg.includes("already");
        if (!alreadyExists) {
          console.error(`[${timestamp}] [ERROR] Failed to create private bucket:`, createError);
          throw createError;
        }
      } else {
        console.log(`[${timestamp}] [INFO] Secure private bucket "${bucketName}" created successfully.`);
      }
    }

    const fileBuffer = await file.arrayBuffer();
    const { data: uploadData, error: uploadError } = await supabaseClient.storage
      .from(bucketName)
      .upload(filePath, fileBuffer, {
        contentType: file.type,
        upsert: false, // Prevents silent overwriting if collision happens
      });

    if (uploadError) {
      console.error(`[${timestamp}] [ERROR] Storage upload failed for path "${filePath}":`, uploadError);
      return new Response(
        JSON.stringify({ error: `Storage upload failed: ${uploadError.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[${timestamp}] [INFO] Storage file uploaded successfully at "${uploadData?.path}".`);

    // 4. Secure signed URL generation (expires in 1 hour) instead of public URL
    const { data: signedUrlData, error: signedUrlError } = await supabaseClient.storage
      .from(bucketName)
      .createSignedUrl(filePath, 3600); // 3600 seconds = 1 hour

    if (signedUrlError) {
      console.error(`[${timestamp}] [ERROR] Failed to generate signed URL for path "${filePath}":`, signedUrlError);
      return new Response(
        JSON.stringify({ error: `Failed to generate signed retrieval URL: ${signedUrlError.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const secureUrl = signedUrlData?.signedUrl || "";
    console.log(`[${timestamp}] [INFO] Successfully generated secure 1-hour signed URL for document retrieval.`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "File uploaded successfully!",
        path: uploadData?.path,
        publicUrl: secureUrl, // Keep name compatible to avoid client code breakages
        shipmentId: shipId,
        documentId: docId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error(`[${timestamp}] [CRITICAL] Internal processing error in Edge Function:`, error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unexpected error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
