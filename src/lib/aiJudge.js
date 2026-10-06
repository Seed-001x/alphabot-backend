// aiJudge — server-side edition. Judgment numbers only; the code decides.
// Runs on kill-chain survivors (≤3/cycle). Skipped without OPENAI_API_KEY.
// HARD RULES: the model NEVER kills, NEVER approves/blocks a trade, NEVER
// does arithmetic. Fail-open on every error.

import { floorEmit } from './events.js';
import { getJudgeContext } from './learning.js';

const MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 10000;
const MAX_TOKENS = 220;
const IN_PER_M = 0.15;
const OUT_PER_M = 0.60;

const stats = { calls: 0, inTok: 0, outTok: 0 };
export function getJudgeStats() {
  const est = stats.inTok / 1e6 * IN_PER_M + stats.outTok / 1e6 * OUT_PER_M;
  return { calls: stats.calls, estUsd: est };
}

function buildPrompt(t, dossier, research, siteText) {
  const d = dossier || {};
  const lines = [
    `name: ${t.name || '?'}`, `symbol: ${t.symbol || '?'}`,
    `mcap: ${t.mc != null ? '$' + Math.round(t.mc) : '?'}`,
    `liquidity: ${t.liquidity != null ? '$' + Math.round(t.liquidity) : '?'}`,
    `holders: ${d.holderCount != null ? d.holderCount : '?'}`,
    `top holder: ${d.topPct != null ? d.topPct.toFixed(1) + '%' : '?'}`,
    `dev share: ${d.devPct != null ? d.devPct.toFixed(1) + '%' : '?'}`,
    `buys/sells 24h: ${t.buys24h != null ? t.buys24h : '?'}/${t.sells24h != null ? t.sells24h : '?'}`,
    `mint authority: ${t.mintAuthOpen === true ? 'OPEN' : t.mintAuthOpen === false ? 'revoked' : '?'}`,
    `freeze authority: ${t.freezeAuthOpen === true ? 'OPEN' : t.freezeAuthOpen === false ? 'revoked' : '?'}`,
    `research notes: ${research && research.line ? research.line : 'none'}`,
  ];
  if (siteText) lines.push(`website excerpt: ${String(siteText).slice(0, 1500)}`);
  const ledgerCtx = getJudgeContext(t);
  if (ledgerCtx) lines.push(ledgerCtx);
  return `You are a memecoin risk analyst. Given the token data, return STRICT JSON ONLY, no other text:\n{"legitimacy": <integer 1-10>, "risk_flags": ["<max 4 short flags>"], "one_liner": "<max 12 words>"}\nlegitimacy: 1 = likely scam/rug, 10 = looks legitimate.\nJudge ONLY. Never recommend buying or selling. Never do math — return the numbers as your judgment.\n\nTOKEN DATA:\n${lines.join('\n')}`;
}

function parseVerdict(text) {
  if (!text || typeof text !== 'string') return null;
  let j = null;
  try { j = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { j = JSON.parse(m[0]); } catch { return null; }
  }
  if (!j || typeof j !== 'object') return null;
  let leg = Number(j.legitimacy);
  if (!isFinite(leg)) return null;
  leg = Math.max(1, Math.min(10, Math.round(leg)));
  const flags = Array.isArray(j.risk_flags)
    ? j.risk_flags.filter(x => typeof x === 'string').map(x => x.slice(0, 60)).slice(0, 4)
    : [];
  const one = typeof j.one_liner === 'string' ? j.one_liner.slice(0, 90) : '';
  return { legitimacy: leg, risk_flags: flags, one_liner: one };
}

export async function judgeToken(t, dossier, research) {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return { modifier: 0, line: 'no key', verdict: null };
  const prompt = buildPrompt(t, dossier, research, null);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a memecoin risk analyst. Return strict JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('openai_' + r.status);
    const j = await r.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message
      ? j.choices[0].message.content : null;
    const u = (j && j.usage) || {};
    stats.calls++;
    stats.inTok += Number(u.prompt_tokens) || Math.ceil(prompt.length / 4);
    stats.outTok += Number(u.completion_tokens) || 0;
    const verdict = parseVerdict(text);
    if (!verdict) throw new Error('bad_json');
    const modifier = Math.max(-10, Math.min(10, (verdict.legitimacy - 5) * 2));
    const line = `'${verdict.one_liner || 'no summary'}'${verdict.risk_flags.length ? ' · flags: ' + verdict.risk_flags.join(', ') : ''}`;
    floorEmit('judge.done', {
      mint: t.address, symbol: t.symbol, name: t.name,
      legitimacy: verdict.legitimacy, one_liner: verdict.one_liner,
      risk_flags: verdict.risk_flags, modifier,
    });
    return { modifier, line, verdict };
  } catch {
    return { modifier: 0, line: 'no data', verdict: null };
  } finally {
    clearTimeout(to);
  }
}
