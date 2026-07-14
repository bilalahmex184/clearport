// ============================================================================
// Edge Function: cross-validate
// Purpose: Second-pass Gemini cross-document validation — compare field values
//          extracted from multiple customs documents for the same shipment
//          and flag mismatches.
// Input: JSON `{ shipmentId }`
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

// --- Gemini client ----------------------------------------------------------
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

// --- Helpers ----------------------------------------------------------------
function extractJsonArray(text: string): any[] {
  if (!text) return [];
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Normalize strings for fuzzy comparison
function normalize(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s,.\-_/\\]+/g, " ")
    .trim();
}

// --- Main handler -----------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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

    // 1. Fetch all document_fields for this shipment joined with documents
    //    (so we can include doc_type / file_name as the "source").
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
      console.error("[cross-validate] fields query error:", fieldsErr);
      return jsonRes(
        { error: "Failed to fetch document_fields", detail: fieldsErr.message },
        500
      );
    }
    if (!fields || fields.length === 0) {
      return jsonRes({
        success: true,
        shipmentId,
        mismatches: [],
        message: "No document_fields found — nothing to cross-validate.",
      });
    }

    // 2. Group by field_key
    const grouped: Record<string, any[]> = {};
    for (const f of fields) {
      const key = f.field_key;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(f);
    }

    // Only consider field_keys that appear in 2+ documents
    const multiDocKeys = Object.keys(grouped).filter(
      (k) => grouped[k].length >= 2
    );

    if (multiDocKeys.length === 0) {
      return jsonRes({
        success: true,
        shipmentId,
        mismatches: [],
        message: "No field_keys appear in multiple documents.",
      });
    }

    // 3. For each multi-doc field, compare values
    const ai = getGeminiClient();
    const allMismatches: any[] = [];

    for (const fieldKey of multiDocKeys) {
      const instances = grouped[fieldKey];

      if (ai) {
        // Build a comparison payload for Gemini
        const payload = instances.map((inst, i) => ({
          index: i + 1,
          value: inst.extracted_value,
          source:
            inst.documents?.doc_type || inst.documents?.file_name || "unknown",
        }));

        const prompt = `Compare these extracted values for the same field "${fieldKey}" from different customs documents.
Return JSON array of { field_key, value1, source1, value2, source2, is_mismatch, reason } for any pairs that mismatch.
If all values agree, return an empty array [].
Values to compare: ${JSON.stringify(payload, null, 2)}
Output ONLY JSON, no markdown fences.`;

        try {
          const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          });
          const text = response.text || "";
          const parsed = extractJsonArray(text);

          for (const m of parsed) {
            if (!m.is_mismatch) continue;
            // Find the two instances by index
            const idx1 = (Number(m.value1_index) || 1) - 1;
            const idx2 = (Number(m.value2_index) || 2) - 1;
            const inst1 = instances[idx1] || instances[0];
            const inst2 = instances[idx2] || instances[1];

            const mismatchRecord = {
              field_key: fieldKey,
              value1: m.value1 ?? inst1.extracted_value,
              source1: m.source1 ?? inst1.documents?.doc_type,
              value2: m.value2 ?? inst2.extracted_value,
              source2: m.source2 ?? inst2.documents?.doc_type,
              reason: m.reason || "Cross-document mismatch detected by Gemini",
            };
            allMismatches.push(mismatchRecord);

            // Update the second instance to carry the cross_doc_value / source
            await userClient
              .from("document_fields")
              .update({
                cross_doc_value: inst1.extracted_value,
                cross_doc_source: inst1.documents?.doc_type || null,
                is_flagged: true,
                exception_reason: mismatchRecord.reason,
              })
              .eq("id", inst2.id);

            // Also flag the first instance for symmetry
            await userClient
              .from("document_fields")
              .update({
                cross_doc_value: inst2.extracted_value,
                cross_doc_source: inst2.documents?.doc_type || null,
                is_flagged: true,
                exception_reason: mismatchRecord.reason,
              })
              .eq("id", inst1.id);
          }
        } catch (err) {
          console.warn(
            `[cross-validate] Gemini call failed for ${fieldKey}, falling back to string compare:`,
            err
          );
          await fallbackStringCompare(
            userClient,
            instances,
            fieldKey,
            allMismatches
          );
        }
      } else {
        // No Gemini — simple string comparison fallback
        await fallbackStringCompare(userClient, instances, fieldKey, allMismatches);
      }
    }

    // 4. Audit log
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Cross-document validation: ${allMismatches.length} mismatch(es) found across ${multiDocKeys.length} shared field(s).`,
      type: allMismatches.length > 0 ? "warning" : "success",
    });

    // 5. Respond
    return jsonRes({
      success: true,
      shipmentId,
      mismatches: allMismatches,
      fieldsChecked: multiDocKeys.length,
      geminiUsed: !!ai,
    });
  } catch (err: any) {
    console.error("[cross-validate] unhandled error:", err);
    return jsonRes(
      { error: "Internal server error", detail: String(err?.message || err) },
      500
    );
  }
});

// Fallback: simple normalized string comparison across all pairs of instances
async function fallbackStringCompare(
  userClient: any,
  instances: any[],
  fieldKey: string,
  out: any[]
) {
  for (let i = 0; i < instances.length; i++) {
    for (let j = i + 1; j < instances.length; j++) {
      const a = instances[i];
      const b = instances[j];
      if (normalize(a.extracted_value) !== normalize(b.extracted_value)) {
        const reason = `Cross-document mismatch for "${fieldKey}": "${a.extracted_value}" vs "${b.extracted_value}"`;
        out.push({
          field_key: fieldKey,
          value1: a.extracted_value,
          source1: a.documents?.doc_type || a.documents?.file_name || "doc1",
          value2: b.extracted_value,
          source2: b.documents?.doc_type || b.documents?.file_name || "doc2",
          reason,
        });
        // Mark both instances flagged with cross_doc_value
        await userClient
          .from("document_fields")
          .update({
            cross_doc_value: b.extracted_value,
            cross_doc_source: b.documents?.doc_type || null,
            is_flagged: true,
            exception_reason: reason,
          })
          .eq("id", a.id);

        await userClient
          .from("document_fields")
          .update({
            cross_doc_value: a.extracted_value,
            cross_doc_source: a.documents?.doc_type || null,
            is_flagged: true,
            exception_reason: reason,
          })
          .eq("id", b.id);
      }
    }
  }
}
