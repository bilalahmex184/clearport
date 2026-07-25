;!function(){try { var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof global?global:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&((e._debugIds|| (e._debugIds={}))[n]="85403800-3469-6f19-0fef-881b34a461f5")}catch(e){}}();
(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/context/inline-pipeline.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "runInlinePipeline",
    ()=>runInlinePipeline
]);
// ============================================================================
// inline-pipeline.ts — Fallback extraction+validation pipeline
// ============================================================================
// Extracted from ClearPortContext.tsx (§4 refactor — behavior-preserving).
//
// Used ONLY when the processing_jobs table doesn't exist (migration 018 not
// run yet) or the queue insert fails. This is the old synchronous path that
// calls the edge function directly from the browser. The primary path is the
// queue + worker — this is the safety net so extraction still works during
// the migration period.
// ============================================================================
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/supabase.ts [app-client] (ecmascript)");
;
async function runInlinePipeline(shipmentId, apiFetchOrg, refreshShipment) {
    try {
        // Extraction
        try {
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["invokeEdgeFunction"])('extract-document', {
                shipmentId
            });
        } catch (err) {
            console.warn('[inline-pipeline] extraction failed:', err);
        }
        // Validation chain
        const traceId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `trace-${Date.now()}`;
        try {
            await apiFetchOrg('/api/shipments/' + shipmentId, {
                method: 'PATCH',
                body: JSON.stringify({
                    validation_status: 'running',
                    pipeline_trace_id: traceId
                })
            });
        } catch (e) {
            console.error('[inline-pipeline] failed to set validation_status=running:', e);
        }
        const invokeWithRetry = async (fnName, reqBody)=>{
            const delays = [
                500,
                1500
            ];
            let lastErr;
            for(let attempt = 0; attempt <= delays.length; attempt++){
                try {
                    await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["invokeEdgeFunction"])(fnName, reqBody);
                    return;
                } catch (err) {
                    lastErr = err;
                    if (attempt < delays.length) {
                        await new Promise((r)=>setTimeout(r, delays[attempt]));
                    }
                }
            }
            throw lastErr;
        };
        const results = await Promise.allSettled([
            invokeWithRetry('schema-validate', {
                shipmentId,
                trace_id: traceId
            }),
            invokeWithRetry('math-validate', {
                shipmentId,
                trace_id: traceId
            }),
            invokeWithRetry('cross-validate', {
                shipmentId,
                trace_id: traceId
            })
        ]);
        const failures = results.filter((r)=>r.status === 'rejected');
        if (failures.length > 0) {
            await apiFetchOrg('/api/shipments/' + shipmentId, {
                method: 'PATCH',
                body: JSON.stringify({
                    validation_status: 'failed'
                })
            }).catch((err)=>{
                console.warn('[inline-pipeline] PATCH failed status failed:', err instanceof Error ? err.message : err);
            });
        } else {
            try {
                await invokeWithRetry('flag-exceptions', {
                    shipmentId,
                    trace_id: traceId
                });
            } catch  {
            // flag-exceptions failed → degraded
            }
            await apiFetchOrg('/api/shipments/' + shipmentId, {
                method: 'PATCH',
                body: JSON.stringify({
                    validation_status: 'completed',
                    last_validated_at: new Date().toISOString()
                })
            }).catch((err)=>{
                console.warn('[inline-pipeline] PATCH completed status failed:', err instanceof Error ? err.message : err);
            });
        }
        await refreshShipment(shipmentId);
    } catch (err) {
        console.error('[inline-pipeline] unexpected error:', err);
    }
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# debugId=85403800-3469-6f19-0fef-881b34a461f5
//# sourceMappingURL=src_context_inline-pipeline_ts_5aeb6a1b._.js.map