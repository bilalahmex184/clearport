// ============================================================================
// Edge Function: extract-document
// Purpose: First-pass Gemini extraction — OCR + structured customs field
//          extraction from one or all documents in a shipment.
// Input: JSON `{ shipmentId, documentId? }`
// Output: Extracted fields written to `document_fields`, shipper/consignee
//         propagated up to the shipment row.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { GoogleGenAI } from "npm:@google/genai@2";

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

// --- Field schema (must match shared clearport-types) ----------------------
const FIELD_DEFINITIONS: Array<{
  key: string;
  label: string;
}> = [
  { key: "invoiceNo", label: "Commercial Invoice #" },
  { key: "invoiceDate", label: "Invoice Date" },
  { key: "shipper", label: "Shipper/Exporter" },
  { key: "consignee", label: "Consignee/Importer" },
  { key: "consigneeAddress", label: "Consignee Address" },
  { key: "declaredValue", label: "Total Declared Value" },
  { key: "htsCode", label: "HTS Code" },
  { key: "netWeight", label: "Net Weight" },
  { key: "portOfEntry", label: "Port of Entry" },
  { key: "carrier", label: "Carrier" },
  { key: "billOfLading", label: "Bill of Lading #" },
  { key: "countryOfOrigin", label: "Country of Origin" },
];

const GEMINI_PROMPT = `You are a customs document OCR engine. Extract the following fields from this document image.
Return ONLY a JSON array of objects with keys: field_key, field_label, extracted_value, confidence (0-100).
Fields to extract: invoiceNo (Commercial Invoice #), invoiceDate (Invoice Date), shipper (Shipper/Exporter), consignee (Consignee/Importer), consigneeAddress (Consignee Address), declaredValue (Total Declared Value), htsCode (HTS Code), netWeight (Net Weight), portOfEntry (Port of Entry), carrier (Carrier), billOfLading (Bill of Lading #), countryOfOrigin (Country of Origin).
If a field is not present, omit it. Confidence is your certainty 0-100.
Do not wrap the JSON in markdown fences. Output ONLY the JSON array.`;

// --- Gemini client ----------------------------------------------------------
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

// --- Helpers ----------------------------------------------------------------
// Convert ArrayBuffer to base64 string (UTF-8 safe via chunked encoding)
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000; // 32 KB
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

// Strip ```json fences and trailing prose from Gemini's reply.
// Handles arrays, single objects, and objects with a wrapper like { fields: [...] }.
function extractJsonArray(text: string): any[] {
  if (!text) return [];
  let cleaned = text.trim();

  // Remove ```json ... ``` fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try direct parse first (fast path)
  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === "object") {
      // Could be a wrapper object
      if (Array.isArray(direct.fields)) return direct.fields;
      if (Array.isArray(direct.data)) return direct.data;
      // Single field object?
      if (direct.field_key) return [direct];
    }
  } catch {
    // Fall through to manual extraction
  }

  // Find the first '[' and matching last ']'
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Fall through
    }
  }

  // Try finding a JSON object instead
  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const slice = cleaned.slice(objStart, objEnd + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.fields)) return parsed.fields;
        if (parsed.field_key) return [parsed];
      }
    } catch {
      // Give up
    }
  }

  return [];
}

// Fallback mock fields (used when GEMINI_API_KEY is not set so the pipeline
// can still flow end-to-end in demo/dev mode).
function mockFields(): any[] {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  return [
    {
      field_key: "invoiceNo",
      field_label: "Commercial Invoice #",
      extracted_value: "INV-" + Math.floor(10000 + Math.random() * 89999),
      confidence: 78,
    },
    {
      field_key: "invoiceDate",
      field_label: "Invoice Date",
      extracted_value: "2024-09-15",
      confidence: 82,
    },
    {
      field_key: "shipper",
      field_label: "Shipper/Exporter",
      extracted_value: pick([
        "Acme Industries Ltd.",
        "Global Trade Co.",
        "Pacific Exports Inc.",
      ]),
      confidence: 72,
    },
    {
      field_key: "consignee",
      field_label: "Consignee/Importer",
      extracted_value: pick([
        "Northwind Imports LLC",
        "Summit Distribution Corp.",
        "Harbor Trading Group",
      ]),
      confidence: 70,
    },
    {
      field_key: "declaredValue",
      field_label: "Total Declared Value",
      extracted_value: "$" + (10000 + Math.floor(Math.random() * 90000)) + ".00",
      confidence: 80,
    },
    {
      field_key: "htsCode",
      field_label: "HTS Code",
      extracted_value: "8471.30.0100",
      confidence: 65,
    },
    {
      field_key: "netWeight",
      field_label: "Net Weight",
      extracted_value: Math.floor(100 + Math.random() * 900) + " kg",
      confidence: 75,
    },
    {
      field_key: "countryOfOrigin",
      field_label: "Country of Origin",
      extracted_value: pick(["CN", "US", "DE", "JP"]),
      confidence: 68,
    },
  ];
}

// Call Gemini with the file bytes. Returns an array of field objects.
// Handles both binary files (via inlineData) and text files (via text prompt).
// Returns { fields, debug } so the caller can surface diagnostic info.
async function callGeminiExtraction(
  ai: GoogleGenAI,
  mimeType: string,
  base64Data: string,
  rawText?: string
): Promise<{ fields: any[]; debug: any }> {
  const models = ["gemini-2.0-flash", "gemini-1.5-flash"];
  const debug: any = { modelsTried: [], errors: [], rawResponses: [] };

  for (const model of models) {
    debug.modelsTried.push(model);
    try {
      const parts: any[] = [];

      if (rawText && rawText.length > 0) {
        parts.push({ text: `Document text content:\n\n${rawText}\n\n---\n${GEMINI_PROMPT}` });
      } else {
        parts.push({ inlineData: { mimeType, data: base64Data } });
        parts.push({ text: GEMINI_PROMPT });
      }

      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
      });

      // Try multiple ways to get text from the response
      let text = "";
      if (typeof response.text === "string") {
        text = response.text;
      } else if (typeof response.text === "function") {
        text = response.text();
      } else if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
        text = response.candidates[0].content.parts[0].text;
      } else if (response?.response?.text) {
        text = response.response.text;
      }

      debug.rawResponses.push({ model, textLength: text.length, preview: text.substring(0, 300) });

      const parsed = extractJsonArray(text);
      if (parsed.length > 0) {
        debug.success = true;
        debug.successModel = model;
        return { fields: parsed, debug };
      } else {
        debug.errors.push(`${model}: 0 parseable fields from ${text.length} chars`);
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      debug.errors.push(`${model}: ${errMsg}`);
      debug.rawResponses.push({ model, error: errMsg });
    }
  }

  return { fields: [], debug };
}

// --- Regex-based fallback extractor -----------------------------------------
// When Gemini is unavailable (invalid key, rate limit, etc.), this extracts
// fields from plain-text documents using pattern matching.
function regexExtract(text: string): any[] {
  if (!text) return [];
  const fields: any[] = [];

  const patterns: Array<{ key: string; label: string; regex: RegExp; conf: number }> = [
    { key: "invoiceNo", label: "Commercial Invoice #", regex: /(?:invoice\s*(?:number|no\.?|#)\s*[:\-]?\s*)([A-Z0-9\-]+)/i, conf: 85 },
    { key: "invoiceDate", label: "Invoice Date", regex: /(?:invoice\s*date\s*[:\-]?\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i, conf: 82 },
    { key: "shipper", label: "Shipper/Exporter", regex: /(?:shipper(?:\/exporter)?\s*[:\-]?\s*)(.+?)(?:\n|$)/i, conf: 80 },
    { key: "consignee", label: "Consignee/Importer", regex: /(?:consignee(?:\/importer)?\s*[:\-]?\s*)(.+?)(?:\n|$)/i, conf: 80 },
    { key: "declaredValue", label: "Total Declared Value", regex: /(?:total\s*(?:declared\s*)?value\s*[:\-]?\s*)(\$[\d,]+\.?\d*)/i, conf: 88 },
    { key: "htsCode", label: "HTS Code", regex: /(?:hts\s*(?:code)?\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i, conf: 90 },
    { key: "netWeight", label: "Net Weight", regex: /(?:net\s*weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?))/i, conf: 85 },
    { key: "countryOfOrigin", label: "Country of Origin", regex: /(?:country\s*of\s*origin\s*[:\-]?\s*)([A-Z]{2})/i, conf: 78 },
    { key: "carrier", label: "Carrier", regex: /(?:carrier\s*[:\-]?\s*)(.+?)(?:\n|$)/i, conf: 75 },
    { key: "portOfEntry", label: "Port of Entry", regex: /(?:port\s*of\s*entry\s*[:\-]?\s*)(.+?)(?:\n|$)/i, conf: 75 },
    { key: "billOfLading", label: "Bill of Lading #", regex: /(?:bill\s*of\s*lading\s*(?:#|no\.?)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i, conf: 82 },
    { key: "consigneeAddress", label: "Consignee Address", regex: /(?:consignee\s*address\s*[:\-]?\s*)(.+?)(?:\n|$)/i, conf: 72 },
  ];

  for (const { key, label, regex, conf } of patterns) {
    const match = text.match(regex);
    if (match && match[1]) {
      const value = match[1].trim();
      if (value.length > 0 && value.length < 200) {
        fields.push({ field_key: key, field_label: label, extracted_value: value, confidence: conf });
      }
    }
  }

  return fields;
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

    // 2. Parse JSON body
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return jsonRes({ error: "Invalid JSON body" }, 400);
    }
    const { shipmentId, documentId } = body;
    if (!shipmentId) {
      return jsonRes({ error: "Missing 'shipmentId'" }, 400);
    }

    // 3. Fetch documents for shipment
    let docQuery = userClient
      .from("documents")
      .select("id, shipment_id, doc_type, file_name, storage_path, mime_type")
      .eq("shipment_id", shipmentId);

    if (documentId) {
      docQuery = docQuery.eq("id", documentId);
    }

    const { data: docs, error: docsErr } = await docQuery.order("uploaded_at", {
      ascending: true,
    });

    if (docsErr) {
      console.error("[extract-document] docs query error:", docsErr);
      return jsonRes(
        { error: "Failed to fetch documents", detail: docsErr.message },
        500
      );
    }
    if (!docs || docs.length === 0) {
      return jsonRes(
        { error: "No documents found for this shipment" },
        404
      );
    }

    const admin = createAdminClient();
    const ai = getGeminiClient();

    if (!ai) {
      console.warn(
        "[extract-document] GEMINI_API_KEY not set — using mock extraction"
      );
    }

    const allFields: any[] = [];
    const perDocResults: any[] = [];
    let latestShipper: string | null = null;
    let latestConsignee: string | null = null;
    let geminiDebug: any = null;

    // 4. Process each document
    for (const doc of docs) {
      let extracted: any[] = [];

      if (ai) {
        // 4a. Download the file from Storage (admin client)
        const { data: fileData, error: downloadErr } = await admin.storage
          .from("documents")
          .download(doc.storage_path);

        if (downloadErr || !fileData) {
          console.error(
            "[extract-document] file download failed for",
            doc.storage_path,
            downloadErr
          );
          perDocResults.push({
            documentId: doc.id,
            file_name: doc.file_name,
            status: "download_failed",
            fields: [],
          });
          continue;
        }

        const ab = await fileData.arrayBuffer();
        const base64 = bufToBase64(ab);
        const mimeType = doc.mime_type || "application/octet-stream";

        // For text-based files, extract the raw text to pass to Gemini directly
        let rawText: string | undefined;
        if (mimeType.startsWith("text/")) {
          try {
            rawText = new TextDecoder().decode(ab);
          } catch {
            // If decode fails, fall back to inlineData
          }
        }

        const geminiResult = await callGeminiExtraction(ai, mimeType, base64, rawText);
        extracted = geminiResult.fields;
        geminiDebug = geminiResult.debug;

        // If Gemini returned 0 fields, try regex-based extraction on text
        if (extracted.length === 0 && rawText) {
          console.log("[extract-document] Gemini returned 0 fields, trying regex extraction");
          extracted = regexExtract(rawText);
          if (geminiDebug) geminiDebug.regexFallback = extracted.length > 0;
        }
      } else {
        // No Gemini key — use regex extraction if we have text, else mock
        if (rawText) {
          extracted = regexExtract(rawText);
        }
        if (extracted.length === 0) {
          extracted = mockFields();
        }
      }

      // 4b. Normalize + write to document_fields
      const writtenFields: any[] = [];
      for (const f of extracted) {
        const key = String(f.field_key || "").trim();
        const value = String(f.extracted_value ?? "").trim();
        if (!key || !value) continue;

        // Map label if missing
        const def = FIELD_DEFINITIONS.find((d) => d.key === key);
        const label = String(f.field_label || def?.label || key);
        const conf = Math.max(
          0,
          Math.min(100, Number(f.confidence ?? 70) || 70)
        );

        const insertRow = {
          document_id: doc.id,
          shipment_id: shipmentId,
          user_id: user.id,
          field_key: key,
          field_label: label,
          extracted_value: value,
          confidence: conf,
          is_flagged: false,
          validation_errors: [],
          bounding_box: f.bounding_box || null,
        };

        const { data: inserted, error: insErr } = await userClient
          .from("document_fields")
          .insert(insertRow)
          .select("id, field_key, field_label, extracted_value, confidence")
          .single();

        if (insErr) {
          console.warn(
            "[extract-document] field insert failed:",
            key,
            insErr.message
          );
          continue;
        }

        writtenFields.push(inserted);
        allFields.push(inserted);

        // Track shipper / consignee for shipment row update
        if (key === "shipper" && !latestShipper) latestShipper = value;
        if (key === "consignee" && !latestConsignee) latestConsignee = value;
      }

      perDocResults.push({
        documentId: doc.id,
        file_name: doc.file_name,
        doc_type: doc.doc_type,
        status: "extracted",
        fieldsCount: writtenFields.length,
        fields: writtenFields,
      });
    }

    // 5. Update shipment shipper / consignee if extracted
    const shipUpdate: any = {};
    if (latestShipper) shipUpdate.shipper = latestShipper;
    if (latestConsignee) shipUpdate.consignee = latestConsignee;

    if (Object.keys(shipUpdate).length > 0) {
      const { error: shipUpdErr } = await userClient
        .from("shipments")
        .update(shipUpdate)
        .eq("id", shipmentId);
      if (shipUpdErr) {
        console.warn(
          "[extract-document] shipment shipper/consignee update failed:",
          shipUpdErr
        );
      }
    }

    // 6. Audit log
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Gemini extraction completed for ${docs.length} document(s) — ${allFields.length} fields extracted.`,
      type: "success",
    });

    // 7. Respond — the response mirrors ExtractDocumentResponse shape
    return jsonRes({
      success: true,
      shipmentId,
      documentId: documentId || docs[0]?.id,
      fields: allFields.map((f) => ({
        field_key: f.field_key,
        field_label: f.field_label,
        extracted_value: f.extracted_value,
        confidence: f.confidence,
        bounding_box: f.bounding_box || null,
      })),
      documents: perDocResults,
      shipper: latestShipper || undefined,
      consignee: latestConsignee || undefined,
      geminiUsed: !!ai,
      debug: geminiDebug,
    });
  } catch (err: any) {
    console.error("[extract-document] unhandled error:", err);
    return jsonRes(
      { error: "Internal server error", detail: String(err?.message || err) },
      500
    );
  }
});
