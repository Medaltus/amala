/**
 * api/write-report-insights.js
 * POST /api/write-report-insights
 *
 * Backend for the internal dashboard's editable report content (Executive
 * Summary, Amazon/Website/Walmart Key Insights, Opportunity and Accomplished cards, and the
 * per-event summaries on the Events page). Reads/writes SHEET_REPORT_INSIGHTS,
 * one pair of tabs per brand:
 *   {brand}         — one row per month.  Exec Summary, 3 Key Insights,
 *                     4 Opportunity and 4 Accomplished card slots, plus status/approval.
 *   {brand}_events  — one row per (event_name, event_year). Per-event
 *                     summary title/body, plus its own status/approval.
 *
 * Per Jaclyn 2026-07-17/18:
 * - No staging/live workflow on individual content blocks — just Edit, add
 *   content, Save. The only approval gate is a single "Approved & Ready"
 *   button per scope (once on the Sales Overview tab for the monthly row,
 *   once per event tab for that event's row).
 * - Multiple months/events can sit at status=Approved simultaneously — the
 *   (not-yet-built) external dashboard is responsible for picking the most
 *   recent Approved row for whatever it's displaying.
 * - This endpoint UPSERTS — every save reads the existing rows for that
 *   brand tab, finds the matching key (year+month, or event_name+event_year),
 *   merges in only the fields provided, and writes the full set back. It
 *   does NOT blind-append, since the same month/event gets edited repeatedly
 *   before it's ever approved.
 * - ASSUMPTION (flag if wrong): saving any field via action:'save' resets
 *   status back to 'Draft', even if that row was previously Approved. This
 *   is deliberate — an edit after approval shouldn't silently stay live
 *   without a fresh review. Only action:'approve' sets status to 'Approved'.
 *
 * POST body:
 *   Monthly: { brand, scope:'monthly', year, month, fields:{...}, action:'save'|'approve' }
 *   Event:   { brand, scope:'event', eventName, eventYear, fields:{...}, action:'save'|'approve' }
 *   fields is optional on action:'approve' (approving doesn't require new content).
 */

const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const sheets = require('./config/sheets');
const brands = require('./config/brands');

// Amala's physical column order on SHEET_REPORT_INSIGHTS, tab "amala" —
// confirmed from the live header row 2026-10-06. upsertRow() writes rows
// positionally against this array, so it MUST match the sheet left-to-
// right exactly. Any new column goes at the END, never in the middle.
// Note: this sheet uses accomplished{n}_* (not acc{n}_* like Just Bjorn's
// sheet), has opp5/opp6, and has category_key_insight BEFORE the
// accomplished block — see normalizeFieldKeys() below for how the
// dashboard's acc{n}_* field names still land in the right columns.
const MONTHLY_HEADERS = [
  'year', 'month',
  'exec_summary_title', 'exec_summary_left', 'exec_summary_right',
  'amazon_key_insight', 'website_key_insight', 'walmart_key_insight',
  'opp1_title', 'opp1_subtitle', 'opp1_body',
  'opp2_title', 'opp2_subtitle', 'opp2_body',
  'opp3_title', 'opp3_subtitle', 'opp3_body',
  'opp4_title', 'opp4_subtitle', 'opp4_body',
  'status', 'approved_by', 'approved_at', 'last_updated', 'last_updated_by',
  'ad_impressions_note',
  'category_key_insight',
  'accomplished1_title', 'accomplished1_subtitle', 'accomplished1_body',
  'accomplished1_image1', 'accomplished1_image2', 'accomplished1_image3',
  'accomplished2_title', 'accomplished2_subtitle', 'accomplished2_body',
  'accomplished2_image1', 'accomplished2_image2',
  'accomplished3_title', 'accomplished3_subtitle', 'accomplished3_body',
  'accomplished4_title', 'accomplished4_subtitle', 'accomplished4_body',
  'opp5_title', 'opp5_subtitle', 'opp5_body',
  'opp6_title', 'opp6_subtitle', 'opp6_body',
  'accomplished1_image4', 'accomplished1_image5', 'accomplished1_image6',
  'accomplished2_image3', 'accomplished2_image4', 'accomplished2_image5', 'accomplished2_image6',
];

// The dashboard's Accomplished editor sends acc{n}_title / acc{n}_image{i}
// (Just Bjorn's naming). Amala's sheet columns are accomplished{n}_*.
// Translate here so those saves aren't silently dropped by the
// headers.includes() filter in upsertRow(). Keys already in the
// accomplished{n}_* form pass through untouched.
function normalizeFieldKeys(fields) {
  if (!fields) return fields;
  const out = {};
  Object.entries(fields).forEach(([k, v]) => {
    const m = /^acc(\d+)_(.+)$/.exec(k);
    out[m ? `accomplished${m[1]}_${m[2]}` : k] = v;
  });
  return out;
}

const EVENT_HEADERS = [
  'event_name', 'event_year',
  'summary_title', 'summary_body',
  'status', 'approved_by', 'approved_at', 'last_updated', 'last_updated_by',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand: brandId, scope, year, month, eventName, eventYear, fields, action, actor } = req.body || {};

  const brand = brands.find(b => b.id === brandId && b.active);
  if (!brand) return res.status(400).json({ error: `Brand '${brandId}' not found or not active` });

  if (scope !== 'monthly' && scope !== 'event') {
    return res.status(400).json({ error: "scope must be 'monthly' or 'event'" });
  }
  if (action !== 'save' && action !== 'approve') {
    return res.status(400).json({ error: "action must be 'save' or 'approve'" });
  }

  try {
    if (scope === 'monthly') {
      const yearStr = String(year ?? '').trim();
      const monthStr = String(month ?? '').trim();
      if (!yearStr || !monthStr) return res.status(400).json({ error: 'year and month are required for scope=monthly' });
      // Extra sanity check: month should be a real 1-12 value. Catches
      // anything that survived the trim (e.g. a non-numeric string) before
      // it gets written to the sheet, rather than silently upserting a
      // row keyed on garbage.
      const monthNum = Number(monthStr);
      if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
        return res.status(400).json({ error: `month must be an integer 1-12, got '${month}'` });
      }
      const result = await upsertRow({
        tabName: brand.tabName,
        headers: MONTHLY_HEADERS,
        matchFields: { year: yearStr, month: monthStr },
        fields: normalizeFieldKeys(fields), action, actor,
      });
      return res.status(200).json({ ok: true, row: result });
    } else {
      const eventNameStr = String(eventName ?? '').trim();
      const eventYearStr = String(eventYear ?? '').trim();
      if (!eventNameStr || !eventYearStr) return res.status(400).json({ error: 'eventName and eventYear are required for scope=event' });
      const result = await upsertRow({
        tabName: `${brand.tabName}_events`,
        headers: EVENT_HEADERS,
        matchFields: { event_name: eventNameStr, event_year: eventYearStr },
        fields, action, actor,
      });
      return res.status(200).json({ ok: true, row: result });
    }
  } catch (err) {
    console.error('[write-report-insights] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function upsertRow({ tabName, headers, matchFields, fields, action, actor }) {
  const token = await ensureTab(sheets.reportInsights, tabName, headers);
  const existing = await readRows(sheets.reportInsights, tabName);

  const matchKeys = Object.keys(matchFields);
  const idx = existing.findIndex(r => matchKeys.every(k => String(r[k] || '') === matchFields[k]));

  let row;
  if (idx === -1) {
    row = {};
    headers.forEach(h => { row[h] = ''; });
    Object.assign(row, matchFields);
  } else {
    row = { ...existing[idx] }; // copy — don't mutate the object still sitting in `existing`
  }

  if (fields) {
    Object.entries(fields).forEach(([k, v]) => {
      if (headers.includes(k)) row[k] = v == null ? '' : String(v);
    });
  }

  const nowIso = new Date().toISOString();
  if (action === 'approve') {
    row.status = 'Approved';
    row.approved_by = actor || '';
    row.approved_at = nowIso;
  } else {
    // Any content save reverts an already-approved row to Draft — see the
    // ASSUMPTION note in the file header. Approving is a separate, explicit action.
    row.status = row.status === 'Approved' ? 'Draft' : (row.status || 'Draft');
  }
  row.last_updated = nowIso;
  row.last_updated_by = actor || '';

  const updatedRows = idx === -1 ? [...existing, row] : existing.map((r, i) => (i === idx ? row : r));
  const rowArrays = updatedRows.map(r => headers.map(h => r[h] ?? ''));
  await replaceRows(sheets.reportInsights, tabName, headers, rowArrays, token);
  return row;
}
