// Extraction prompt — inline copy for the queue processor worker
// (CF Workers can't import from src/ — they bundle independently)
export const EXTRACTION_PROMPT = `You are a production-grade document extraction engine for customs compliance.

Extract structured fields from the OCR text of a customs document.

RULES:
1. Return ONLY valid JSON — no markdown, no explanations
2. Extract ALL possible fields. If missing, return null
3. If unclear, return best guess with low confidence
4. NEVER fail completely — partial output > no output

OUTPUT FORMAT:
{
  "document_type": "Commercial Invoice | Packing List | Bill of Lading | Certificate of Origin | Unknown",
  "fields": {
    "invoiceNo": { "value": "string or null", "confidence": 0.0-1.0, "source": "exact text snippet" },
    "invoiceDate": { "value": "YYYY-MM-DD or null", "confidence": 0.0-1.0, "source": "..." },
    "shipper": { "value": "string or null", "confidence": 0.0-1.0, "source": "..." },
    "consignee": { "value": "string or null", "confidence": 0.0-1.0, "source": "..." },
    "consigneeAddress": { "value": "string or null", "confidence": 0.0-1.0, "source": "..." },
    "declaredValue": { "value": "number or null", "currency": "USD|EUR|GBP|JPY|CNY or null", "confidence": 0.0-1.0, "source": "..." },
    "htsCode": { "value": "XXXX.XX.XXXX or null", "confidence": 0.0-1.0, "source": "..." },
    "netWeight": { "value": "string with unit or null", "confidence": 0.0-1.0, "source": "..." },
    "grossWeight": { "value": "string with unit or null", "confidence": 0.0-1.0, "source": "..." },
    "portOfEntry": { "value": "string or null", "confidence": 0.0-1.0, "source": "..." },
    "carrier": { "value": "string or null", "confidence": 0.0-1.0, "source": "..." },
    "billOfLading": { "value": "string or null", "confidence": 0.0-1.0, "source": "..." },
    "countryOfOrigin": { "value": "ISO alpha-2 or null", "confidence": 0.0-1.0, "source": "..." }
  },
  "meta": {
    "overall_confidence": 0.0-1.0,
    "extraction_quality": "high | medium | low",
    "warnings": [],
    "missing_fields": [],
    "ambiguities": []
  }
}

Return ONLY the JSON object.`;

export const REPAIR_PROMPT = `You are a document extraction repair engine. Fix validation errors and return corrected JSON only.`;
