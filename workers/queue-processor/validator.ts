// Validation + confidence — inline copy for the queue processor worker
// (CF Workers can't import from src/ — they bundle independently)

export interface ValidationResult { isValid: boolean; errors: string[]; confidence: number; }

const REQUIRED_FIELDS = ['invoiceNo', 'shipper', 'consignee', 'declaredValue', 'htsCode'];

export function validateExtraction(data: any): ValidationResult {
  const errors: string[] = [];
  if (!data?.fields) return { isValid: false, errors: ['No fields object'], confidence: 0 };
  const fields = data.fields;

  for (const key of REQUIRED_FIELDS) {
    const field = fields[key];
    if (!field || field.value === null || field.value === undefined || field.value === '') {
      errors.push(`Required field "${key}" is missing`);
    }
  }

  if (fields.invoiceDate?.value && typeof fields.invoiceDate.value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.invoiceDate.value)) errors.push('Date not ISO format');
  }
  if (fields.htsCode?.value && typeof fields.htsCode.value === 'string') {
    if (!/^\d{4}\.\d{2}\.\d{4}$/.test(fields.htsCode.value)) errors.push('HTS code format wrong');
  }
  if (fields.countryOfOrigin?.value && typeof fields.countryOfOrigin.value === 'string') {
    if (!/^[A-Z]{2}$/.test(fields.countryOfOrigin.value)) errors.push('Country code not ISO alpha-2');
  }
  if (fields.netWeight?.value && fields.grossWeight?.value) {
    const net = parseFloat(String(fields.netWeight.value).replace(/[^0-9.]/g, ''));
    const gross = parseFloat(String(fields.grossWeight.value).replace(/[^0-9.]/g, ''));
    if (!isNaN(net) && !isNaN(gross) && net > gross) errors.push('Net weight > gross weight');
  }

  return { isValid: errors.length === 0, errors, confidence: data.meta?.overall_confidence || 0 };
}

export function calculateConfidence(data: any, validationPassed: boolean): number {
  if (!data?.meta?.overall_confidence) return 0;
  const llmConfidence = data.meta.overall_confidence;
  const validationMultiplier = validationPassed ? 1.0 : 0.5;
  const presentCount = REQUIRED_FIELDS.filter(key => {
    const f = data.fields?.[key];
    return f && f.value !== null && f.value !== undefined && f.value !== '';
  }).length;
  const completenessRatio = presentCount / REQUIRED_FIELDS.length;
  return Math.round(llmConfidence * validationMultiplier * completenessRatio * 100) / 100;
}
