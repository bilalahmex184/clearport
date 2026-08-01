'use client';

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import {
  FileText, Plus, Trash2, Edit2, Save, X, Download, AlertCircle, Check, ChevronDown,
} from 'lucide-react';

interface Template {
  id: string;
  name: string;
  direction: 'import' | 'export';
  delimiter: string;
  encoding: string;
  is_active: boolean;
  version: number;
}

interface Mapping {
  id: string;
  template_id: string;
  internal_field_key: string;
  external_field_name: string;
  transform: Record<string, any>;
  is_required: boolean;
  sort_order: number;
}

const FIELD_DEFINITIONS = [
  { key: 'invoiceNo', label: 'Commercial Invoice #' },
  { key: 'invoiceDate', label: 'Invoice Date' },
  { key: 'shipper', label: 'Shipper/Exporter' },
  { key: 'consignee', label: 'Consignee/Importer' },
  { key: 'consigneeAddress', label: 'Consignee Address' },
  { key: 'declaredValue', label: 'Total Declared Value' },
  { key: 'htsCode', label: 'HTS Code' },
  { key: 'netWeight', label: 'Net Weight' },
  { key: 'grossWeight', label: 'Gross Weight' },
  { key: 'portOfEntry', label: 'Port of Entry' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'billOfLading', label: 'Bill of Lading #' },
  { key: 'countryOfOrigin', label: 'Country of Origin' },
];

const TRANSFORM_TYPES = [
  { value: '', label: 'None' },
  { value: 'uppercase', label: 'Uppercase' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'trim', label: 'Trim' },
  { value: 'date_format', label: 'Date Format' },
  { value: 'round', label: 'Round' },
  { value: 'concat', label: 'Concatenate' },
  { value: 'lookup_table', label: 'Lookup Table' },
];

export default function BrokerTemplates() {
  const { theme, userRole, currentOrgId, apiFetchOrg } = useClearPort();
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = React.useState<Template | null>(null);
  const [mappings, setMappings] = React.useState<Mapping[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const canManage = userRole === 'admin' || userRole === 'operator';

  // Load templates
  const loadTemplates = React.useCallback(async () => {
    if (!currentOrgId) return;
    setIsLoading(true);
    try {
      const data = await apiFetchOrg<{ templates: Template[] }>('/api/broker-templates');
      setTemplates(data.templates || []);
    } catch (err) {
      setError('Failed to load templates');
    } finally {
      setIsLoading(false);
    }
  }, [currentOrgId, apiFetchOrg]);

  React.useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // Select template → load mappings
  const selectTemplate = async (template: Template) => {
    setSelectedTemplate(template);
    try {
      const data = await apiFetchOrg<{ mappings: Mapping[] }>(`/api/broker-templates/${template.id}/mappings`);
      setMappings(data.mappings || []);
    } catch {
      setMappings([]);
    }
  };

  // Create new template
  const createTemplate = async (name: string, direction: 'import' | 'export') => {
    try {
      const data = await apiFetchOrg<{ template: Template }>('/api/broker-templates', {
        method: 'POST',
        body: JSON.stringify({ name, direction }),
      });
      setSuccess(`Template "${name}" created`);
      setIsCreating(false);
      await loadTemplates();
      await selectTemplate(data.template);
    } catch (err) {
      setError('Failed to create template');
    }
  };

  // Save mappings
  const saveMappings = async () => {
    if (!selectedTemplate) return;
    try {
      await apiFetchOrg(`/api/broker-templates/${selectedTemplate.id}/mappings`, {
        method: 'PUT',
        body: JSON.stringify({ mappings }),
      });
      setSuccess('Mappings saved');
    } catch {
      setError('Failed to save mappings');
    }
  };

  // Delete template
  const deleteTemplate = async (template: Template) => {
    if (!confirm(`Delete template "${template.name}"? This cannot be undone.`)) return;
    try {
      await apiFetchOrg(`/api/broker-templates/${template.id}`, { method: 'DELETE' });
      setSuccess(`Template "${template.name}" deleted`);
      if (selectedTemplate?.id === template.id) {
        setSelectedTemplate(null);
        setMappings([]);
      }
      await loadTemplates();
    } catch {
      setError('Failed to delete template');
    }
  };

  // Update a mapping row
  const updateMapping = (idx: number, field: keyof Mapping, value: any) => {
    setMappings(prev => prev.map((m, i) => i === idx ? { ...m, [field]: value } : m));
  };

  // Add a new mapping row
  const addMapping = () => {
    setMappings(prev => [...prev, {
      id: `temp-${Date.now()}`,
      template_id: selectedTemplate?.id || '',
      internal_field_key: 'invoiceNo',
      external_field_name: '',
      transform: {},
      is_required: false,
      sort_order: prev.length,
    }]);
  };

  // Remove a mapping row
  const removeMapping = (idx: number) => {
    setMappings(prev => prev.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-4 sm:space-y-6 overflow-y-auto h-full pb-6 sm:pb-8 pr-1 sm:pr-2 p-3 sm:p-4 md:p-6 font-sans">
      {/* Header */}
      <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
        <span className="font-mono text-xs text-amber-500 tracking-wider">BROKER TEMPLATES</span>
        <h2 className="text-xl font-bold text-gray-100 tracking-tight mt-1">Field Mapping & Template Management</h2>
        <p className="text-xs text-gray-400 mt-2 leading-relaxed">
          Create and manage import/export templates for different brokers. Map internal fields to external column names,
          apply transforms, and validate required fields before export.
        </p>
      </div>

      {error && (
        <div className="bg-red-950/20 border border-red-900/40 text-red-400 text-xs rounded-lg px-4 py-2 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto"><X className="w-3 h-3" /></button>
        </div>
      )}

      {success && (
        <div className="bg-emerald-950/20 border border-emerald-900/40 text-emerald-400 text-xs rounded-lg px-4 py-2 flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" />
          <span>{success}</span>
          <button onClick={() => setSuccess(null)} className="ml-auto"><X className="w-3 h-3" /></button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* LEFT: Template list */}
        <div className="lg:col-span-4 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden">
          <div className="p-4 border-b border-gray-900 bg-[#0e1017] flex items-center justify-between">
            <div>
              <span className="font-mono text-xs text-gray-500 tracking-wider">TEMPLATES</span>
              <h3 className="text-sm font-semibold text-gray-200 mt-0.5">{templates.length} Templates</h3>
            </div>
            {canManage && (
              <button
                onClick={() => setIsCreating(true)}
                className="flex items-center gap-1 text-xs bg-amber-600 hover:bg-amber-500 text-black px-2.5 py-1.5 rounded-lg font-bold transition-all cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                New
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {isLoading ? (
              <div className="p-8 text-center text-gray-500 text-xs">Loading...</div>
            ) : templates.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-xs">No templates yet. Create one to get started.</div>
            ) : (
              templates.map(t => (
                <div
                  key={t.id}
                  onClick={() => selectTemplate(t)}
                  className={`p-3 rounded-lg cursor-pointer transition-all border ${
                    selectedTemplate?.id === t.id
                      ? 'bg-gray-950 border-gray-700 shadow-md'
                      : 'bg-transparent border-transparent hover:bg-gray-950/40 hover:border-gray-900'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-gray-200 truncate">{t.name}</span>
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                      t.direction === 'import' ? 'bg-blue-950 text-blue-400 border border-blue-900/40' : 'bg-emerald-950 text-emerald-400 border border-emerald-900/40'
                    }`}>
                      {t.direction.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-gray-500 font-mono">
                    <span>v{t.version} • {t.delimiter === ',' ? 'CSV' : t.delimiter === '\t' ? 'TSV' : t.delimiter}</span>
                    {canManage && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteTemplate(t); }}
                        className="text-red-500 hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* RIGHT: Template editor */}
        <div className="lg:col-span-8 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden">
          {isCreating ? (
            <NewTemplateForm onCreate={createTemplate} onCancel={() => setIsCreating(false)} />
          ) : selectedTemplate ? (
            <>
              <div className="p-4 border-b border-gray-900 bg-[#0e1017] flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-200">{selectedTemplate.name}</h3>
                  <p className="text-[10px] text-gray-500 font-mono mt-0.5">
                    {selectedTemplate.direction} • delimiter: "{selectedTemplate.delimiter}" • {selectedTemplate.encoding}
                  </p>
                </div>
                {canManage && (
                  <button
                    onClick={saveMappings}
                    className="flex items-center gap-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-black px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Save Mappings
                  </button>
                )}
              </div>

              {/* Mapping table */}
              <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-black/30 border-b border-gray-900">
                    <tr className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
                      <th className="py-2 px-3 font-semibold">#</th>
                      <th className="py-2 px-3 font-semibold">Internal Field</th>
                      <th className="py-2 px-3 font-semibold">External Column Name</th>
                      <th className="py-2 px-3 font-semibold">Transform</th>
                      <th className="py-2 px-3 font-semibold text-center">Required</th>
                      {canManage && <th className="py-2 px-3 font-semibold text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-950">
                    {mappings.map((m, idx) => (
                      <tr key={m.id} className="hover:bg-gray-950/40">
                        <td className="py-2 px-3 font-mono text-gray-500">{idx + 1}</td>
                        <td className="py-2 px-3">
                          {canManage ? (
                            <select
                              value={m.internal_field_key}
                              onChange={e => updateMapping(idx, 'internal_field_key', e.target.value)}
                              className="bg-black border border-gray-800 text-gray-200 rounded px-2 py-1 text-xs w-full"
                            >
                              {FIELD_DEFINITIONS.map(f => (
                                <option key={f.key} value={f.key}>{f.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-gray-200">{m.internal_field_key}</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {canManage ? (
                            <input
                              type="text"
                              value={m.external_field_name}
                              onChange={e => updateMapping(idx, 'external_field_name', e.target.value)}
                              className="bg-black border border-gray-800 text-gray-200 rounded px-2 py-1 text-xs w-full"
                              placeholder="e.g. Invoice Number"
                            />
                          ) : (
                            <span className="text-gray-200">{m.external_field_name}</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {canManage ? (
                            <select
                              value={m.transform?.type || ''}
                              onChange={e => updateMapping(idx, 'transform', e.target.value ? { type: e.target.value } : {})}
                              className="bg-black border border-gray-800 text-gray-200 rounded px-2 py-1 text-xs"
                            >
                              {TRANSFORM_TYPES.map(t => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-gray-400">{m.transform?.type || '—'}</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          {canManage ? (
                            <input
                              type="checkbox"
                              checked={m.is_required}
                              onChange={e => updateMapping(idx, 'is_required', e.target.checked)}
                              className="accent-amber-500"
                            />
                          ) : (
                            <span className={m.is_required ? 'text-red-400' : 'text-gray-600'}>
                              {m.is_required ? '✓' : '—'}
                            </span>
                          )}
                        </td>
                        {canManage && (
                          <td className="py-2 px-3 text-right">
                            <button
                              onClick={() => removeMapping(idx)}
                              className="text-red-500 hover:text-red-400"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>

                {canManage && (
                  <div className="p-3 border-t border-gray-900">
                    <button
                      onClick={addMapping}
                      className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 bg-gray-950 hover:bg-gray-900 border border-gray-800 px-3 py-1.5 rounded-lg transition-all"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Mapping
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500 p-8">
              <FileText className="w-12 h-12 mb-4 text-gray-600" />
              <p className="text-sm font-medium">No template selected</p>
              <p className="text-xs text-gray-600 mt-1">Select a template from the left, or create a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// New Template Form (inline component)
// ============================================================================

function NewTemplateForm({ onCreate, onCancel }: { onCreate: (name: string, direction: 'import' | 'export') => void; onCancel: () => void }) {
  const [name, setName] = React.useState('');
  const [direction, setDirection] = React.useState<'import' | 'export'>('import');

  return (
    <div className="p-6 space-y-4">
      <h3 className="text-sm font-semibold text-gray-200">Create New Template</h3>

      <div className="space-y-3">
        <div>
          <label className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block mb-1">Template Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Broker A Export v2"
            className="w-full bg-black border border-gray-800 text-gray-200 rounded-lg px-3 py-2 text-xs"
            autoFocus
          />
        </div>

        <div>
          <label className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block mb-1">Direction</label>
          <div className="flex gap-2">
            <button
              onClick={() => setDirection('import')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${
                direction === 'import' ? 'bg-blue-600 text-white' : 'bg-gray-950 text-gray-400 border border-gray-800'
              }`}
            >
              Import (parse incoming files)
            </button>
            <button
              onClick={() => setDirection('export')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${
                direction === 'export' ? 'bg-emerald-600 text-white' : 'bg-gray-950 text-gray-400 border border-gray-800'
              }`}
            >
              Export (generate output files)
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <button
          onClick={onCancel}
          className="text-xs text-gray-400 hover:text-white border border-gray-800 px-3 py-1.5 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() => name && onCreate(name, direction)}
          disabled={!name}
          className="text-xs bg-amber-600 hover:bg-amber-500 text-black px-3 py-1.5 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create Template
        </button>
      </div>
    </div>
  );
}
