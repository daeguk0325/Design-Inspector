import { useEffect, useState } from 'react';
import type {
  InspectorMode,
  SelectionRecord,
  StyleFacts,
  StyleFactsDerived,
} from '../protocol/types.ts';
import {
  STYLE_FACT_GROUP_LABEL,
  isColorProperty,
  styleFactLabel,
  swatchColor,
} from '../style/properties.ts';
import { groupStyleFacts, sanitizeStyleFacts } from '../style/sanitize.ts';
import { sourceSnippet } from '../target/sourceCache.ts';
import type { SourceResult } from '../target/source.ts';

export interface ComponentDetailsProps {
  record: SelectionRecord;
  className?: string;
}

interface DetailRow {
  label: string;
  value: string;
  mono?: boolean;
}

interface ExtraField {
  label: string;
  value: string;
}

const MODE_LABEL: Record<InspectorMode, string> = Object.freeze({
  html: 'HTML',
  '3d': '3D',
  konva: 'Konva',
});

const TAG_KEYS = ['tagName', 'tag', 'nodeName', 'localName'] as const;
const TEXT_KEYS: readonly ExtraField[] = Object.freeze([
  { label: 'Text', value: 'text' },
  { label: 'Content', value: 'content' },
  { label: 'Label', value: 'label' },
  { label: 'Aria label', value: 'aria-label' },
  { label: 'Title', value: 'title' },
  { label: 'Alt', value: 'alt' },
  { label: 'Placeholder', value: 'placeholder' },
  { label: 'Role', value: 'role' },
  { label: 'Test id', value: 'testId' },
  { label: 'Data test id', value: 'data-testid' },
  { label: 'Class', value: 'className' },
  { label: 'Href', value: 'href' },
]);

const MAX_VALUE_CHARS = 160;
const MAX_ROWS = 4;
const MAX_TOTAL_EXTRA_CHARS = 320;
const TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const UNSAFE_VALUE = /data:|<[a-z/!]/i;

function bounded(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function safeScalar(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'string') return null;
  if (value.length === 0 || UNSAFE_VALUE.test(value)) return null;
  return bounded(value, MAX_VALUE_CHARS);
}

function extraRecord(extra: unknown): Record<string, unknown> | null {
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return null;
  return extra as Record<string, unknown>;
}

function tagFromExtra(extra: unknown): string | null {
  const record = extraRecord(extra);
  if (!record) return null;
  for (const key of TAG_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (TAG_PATTERN.test(normalized)) return normalized;
  }
  return null;
}

function tagFromElementKey(elementKey: string): string | null {
  const head = elementKey.trim().split(/[^a-z0-9-]+/i)[0]?.toLowerCase() ?? '';
  return TAG_PATTERN.test(head) ? head : null;
}

function extraText(extra: unknown): ExtraField[] {
  const record = extraRecord(extra);
  if (!record) return [];
  const rows: ExtraField[] = [];
  let used = 0;
  for (const field of TEXT_KEYS) {
    if (!Object.hasOwn(record, field.value)) continue;
    const value = safeScalar(record[field.value]);
    if (value === null) continue;
    if (used + value.length > MAX_TOTAL_EXTRA_CHARS) break;
    used += value.length;
    rows.push({ label: field.label, value });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

function locationOf(record: SelectionRecord): string | null {
  const file = record.file?.trim();
  if (!file) return null;
  const line = record.line;
  if (typeof line === 'number' && Number.isFinite(line) && line >= 0) {
    return bounded(`${file}:${Math.floor(line)}`, MAX_VALUE_CHARS);
  }
  return bounded(file, MAX_VALUE_CHARS);
}

function detailRows(record: SelectionRecord): DetailRow[] {
  const rows: DetailRow[] = [];
  const component = safeScalar(record.component);
  if (component !== null) rows.push({ label: 'Component', value: component, mono: true });
  const tag = tagFromExtra(record.extra) ?? tagFromElementKey(record.elementKey ?? '');
  if (tag !== null) rows.push({ label: 'Tag', value: tag, mono: true });
  const elementKey = safeScalar(record.elementKey);
  if (elementKey !== null) rows.push({ label: 'Element key', value: elementKey, mono: true });
  const location = locationOf(record);
  if (location !== null) rows.push({ label: 'Location', value: location, mono: true });
  rows.push({ label: 'Mode', value: MODE_LABEL[record.mode] ?? bounded(record.mode, 16) });
  for (const field of extraText(record.extra)) {
    rows.push({ label: field.label, value: field.value, mono: false });
  }
  return rows;
}

function detailsName(record: SelectionRecord): string {
  return safeScalar(record.component) ?? safeScalar(record.elementKey) ?? 'Component';
}

interface StyleFactSection {
  group: keyof typeof STYLE_FACT_GROUP_LABEL;
  rows: Array<{ label: string; value: string; swatch: string | null }>;
}

interface StyleFactView {
  facts: StyleFacts;
  sections: StyleFactSection[];
}

/**
 * Re-sanitized here rather than trusted: the record arrives over postMessage
 * from a page the app does not control. Everything rendered below comes out of
 * this copy, including the ancestor chain.
 */
function styleView(record: SelectionRecord): StyleFactView | null {
  const facts = sanitizeStyleFacts(record.styleFacts);
  if (!facts) return null;
  const sections = new Map<StyleFactSection['group'], StyleFactSection>();
  for (const row of groupStyleFacts(facts)) {
    const value = safeScalar(row.value);
    if (value === null) continue;
    const existing = sections.get(row.group) ?? { group: row.group, rows: [] };
    existing.rows.push({
      label: styleFactLabel(row.property),
      value,
      swatch: isColorProperty(row.property) ? swatchColor(row.value) : null,
    });
    sections.set(row.group, existing);
  }
  return { facts, sections: [...sections.values()] };
}

/**
 * The derived measurements, phrased as answers. A contrast that could not be
 * measured says so: the panel is where someone checks whether the tool knows,
 * and a blank row would read as "no problem found".
 */
function derivedRows(derived: StyleFactsDerived | undefined): Array<{ label: string; value: string; swatch: string | null }> {
  if (derived === undefined) return [];
  const rows: Array<{ label: string; value: string; swatch: string | null }> = [];
  const contrast = derived.contrast;
  if (contrast !== undefined) {
    if ('unmeasurable' in contrast) {
      rows.push({ label: 'Contrast', value: 'not measurable', swatch: null });
    } else {
      rows.push({
        label: 'Contrast',
        value: `${contrast.ratio}:1 · AA ${contrast.pass ? 'pass' : 'fail'} (min ${contrast.min})`,
        swatch: contrast.background,
      });
    }
  }
  if (derived.truncated === true) rows.push({ label: 'Text', value: 'truncated', swatch: null });
  if (derived.fontLoad !== undefined) {
    rows.push({ label: 'Font load', value: derived.fontLoad, swatch: null });
  }
  return rows;
}

/**
 * The cited source, if the target reported a location and the project file can
 * be read. A target that sets no `data-inspector-file` gets nothing here and
 * nothing is requested — an empty panel that says "unavailable" every time
 * would be noise, and the location row above already says so.
 */
function SourceBlock({ record }: { record: SelectionRecord }) {
  const [result, setResult] = useState<SourceResult | null>(null);
  useEffect(() => {
    let live = true;
    setResult(null);
    if (record.file === null) return;
    void sourceSnippet({ path: record.file, line: record.line }).then((next) => {
      if (live) setResult(next);
    });
    return () => {
      live = false;
    };
  }, [record.file, record.line]);

  if (record.file === null || result === null || !result.ok) return null;
  const { snippet } = result;
  return (
    <div className="cdetails-source">
      <h5 className="cdetails-style-group-label">
        Source <span className="cdetails-mono">{`${snippet.path}:${snippet.startLine}`}</span>
      </h5>
      <pre className="cdetails-source-code">
        {snippet.lines.map((line, index) => (
          <span className="cdetails-source-line" key={`${snippet.startLine + index}`}>
            <span className="cdetails-source-no" aria-hidden="true">
              {snippet.startLine + index}
            </span>
            <span className="cdetails-source-text">{line}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

export function ComponentDetails({ record, className }: ComponentDetailsProps) {
  const rows = detailRows(record);
  const style = styleView(record);
  const measured = derivedRows(style?.facts.derived);
  const name = detailsName(record);
  return (
    <div
      className={className ? `cdetails ${className}` : 'cdetails'}
      role="group"
      aria-label={`Component details: ${name}`}
    >
      <dl className="cdetails-list">
        {rows.map((row) => (
          <div className="cdetails-row" key={`${row.label}-${row.value}`}>
            <dt>{row.label}</dt>
            <dd className={row.mono ? 'cdetails-mono' : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {style !== null && (style.sections.length > 0 || measured.length > 0) && (
        <div className="cdetails-style">
          <h4 className="cdetails-style-title">Style facts</h4>
          <dl className="cdetails-list">
            {safeScalar(style.facts.label) !== null && (
              <div className="cdetails-row">
                <dt>Label</dt>
                <dd>{safeScalar(style.facts.label)}</dd>
              </div>
            )}
            {style.facts.ancestors !== undefined && style.facts.ancestors.length > 0 && (
              <div className="cdetails-row">
                <dt>Inside</dt>
                <dd className="cdetails-mono">{style.facts.ancestors.join(' > ')}</dd>
              </div>
            )}
          </dl>
          {measured.length > 0 && (
            <>
              <h5 className="cdetails-style-group-label">Measured</h5>
              <dl className="cdetails-list">
                {measured.map((row) => (
                  <div className="cdetails-row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd className="cdetails-mono">
                      {row.swatch !== null && (
                        <span
                          className="cdetails-swatch"
                          style={{ background: row.swatch }}
                          aria-hidden="true"
                        />
                      )}
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {style.sections.length > 0 &&
            style.sections.map((section) => (
              <div className="cdetails-style-group" key={section.group}>
                <h5 className="cdetails-style-group-label">{STYLE_FACT_GROUP_LABEL[section.group]}</h5>
                <dl className="cdetails-list">
                  {section.rows.map((row) => (
                    <div className="cdetails-row" key={`${row.label}-${row.value}`}>
                      <dt>{row.label}</dt>
                      <dd className="cdetails-mono">
                        {row.swatch !== null && (
                          <span
                            className="cdetails-swatch"
                            style={{ background: row.swatch }}
                            aria-hidden="true"
                          />
                        )}
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
        </div>
      )}
      <SourceBlock record={record} />
    </div>
  );
}
