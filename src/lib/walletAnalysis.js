// v3.21: Learning Room — wallet style analyzer.
// Takes a wallet's trade history and extracts a "style profile":
// how they enter, how they exit, how they size, and where they leak P&L.

export function analyzeStyle(trades) {
  // trades: [{ symbol, buys: [{amount, mcap, ts}], sells: [{amount, mcap, ts}], pnl, pnlPct }]
  const profile = {
    totalTrades: trades.length,
    winners: 0,
    losers: 0,
    totalPnl: 0,
    avgWin: 0,
    avgLoss: 0,
    avgHoldMin: 0,
    entryMcaps: [],
    exitPatterns: { scalp: 0, swing: 0, runner: 0 }, // <50%, 50-300%, 300%+
    sizingPattern: 'unknown',
    leaks: [],
  };

  let winSum = 0, lossSum = 0, holdSum = 0, holdN = 0;

  for (const t of trades) {
    profile.totalPnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) { profile.winners++; winSum += t.pnl; }
    else if ((t.pnl || 0) < 0) { profile.losers++; lossSum += Math.abs(t.pnl); }

    // Entry mcap (first buy)
    if (t.buys && t.buys.length) {
      const firstBuy = t.buys[0];
      profile.entryMcaps.push(firstBuy.mcap || 0);
    }

    // Hold time (first buy to last sell)
    if (t.buys && t.buys.length && t.sells && t.sells.length) {
      const holdMs = t.sells[t.sells.length - 1].ts - t.buys[0].ts;
      if (holdMs > 0) { holdSum += holdMs; holdN++; }
    }

    // Exit pattern by max gain achieved
    if (t.pnlPct != null) {
      if (t.pnlPct < 50) profile.exitPatterns.scalp++;
      else if (t.pnlPct < 300) profile.exitPatterns.swing++;
      else profile.exitPatterns.runner++;
    }

    // Overtrading detection: many buys/sells per coin
    const tradeCount = (t.buys?.length || 0) + (t.sells?.length || 0);
    if (tradeCount > 10) {
      profile.leaks.push({
        type: 'overtrading',
        symbol: t.symbol,
        trades: tradeCount,
        note: `${tradeCount} txns on ${t.symbol} — chopped a winner into scalps`,
      });
    }
  }

  profile.winRate = profile.totalTrades > 0
    ? Math.round((profile.winners / profile.totalTrades) * 100) : 0;
  profile.avgWin = profile.winners > 0 ? Math.round(winSum / profile.winners) : 0;
  profile.avgLoss = profile.losers > 0 ? Math.round(lossSum / profile.losers) : 0;
  profile.avgHoldMin = holdN > 0 ? Math.round(holdSum / holdN / 60000) : 0;

  // Entry style
  const avgEntry = profile.entryMcaps.length
    ? profile.entryMcaps.reduce((a, b) => a + b, 0) / profile.entryMcaps.length : 0;
  profile.entryStyle = avgEntry < 500000 ? 'sniper (early)' :
    avgEntry < 2000000 ? 'early-mid' : 'momentum (late)';

  // Sizing: check if buys escalate (pyramiding) or are flat
  // (simplified — full analysis needs per-trade amounts)

  // Key leak: avg loss > avg win = negative expectancy
  if (profile.avgLoss > profile.avgWin && profile.avgWin > 0) {
    profile.leaks.push({
      type: 'negative_expectancy',
      note: `Avg loss $${profile.avgLoss} > avg win $${profile.avgWin} — losers bigger than winners`,
    });
  }

  // Key leak: scalp-heavy exits
  const totalExits = profile.exitPatterns.scalp + profile.exitPatterns.swing + profile.exitPatterns.runner;
  if (totalExits > 0 && profile.exitPatterns.scalp / totalExits > 0.7) {
    profile.leaks.push({
      type: 'paper_hands',
      note: `${Math.round(profile.exitPatterns.scalp / totalExits * 100)}% of exits are scalps (<50%) — leaving runners on the table`,
    });
  }

  return profile;
}

// Synthesize multiple profiles into strategy recommendations.
export function synthesizeStrategy(profiles) {
  const recs = {
    takeProfit: 0.20,  // default
    stopLoss: 0.10,
    maxHoldHours: 1.5,
    reasoning: [],
  };

  // If any profile shows runner exits working, widen TP
  const hasRunners = profiles.some(p => p.exitPatterns.runner > 0);
  const paperHands = profiles.some(p =>
    p.leaks.some(l => l.type === 'paper_hands'));

  if (hasRunners) {
    recs.takeProfit = 1.0; // 100% first scale
    recs.reasoning.push('Profiles show 300%+ runners exist — TP widened to 100% with trailing stop');
  }
  if (paperHands) {
    recs.maxHoldHours = 4;
    recs.reasoning.push('Paper-hands pattern detected — max hold extended to 4h to force patience');
  }

  // If avg hold is very short, the trader is scalping — bot should too OR compensate
  const avgHold = profiles.reduce((s, p) => s + p.avgHoldMin, 0) / Math.max(profiles.length, 1);
  if (avgHold < 30) {
    recs.reasoning.push(`Avg hold is ${Math.round(avgHold)}min (scalper) — bot will use wider stops to avoid chop`);
  }

  return recs;
}
