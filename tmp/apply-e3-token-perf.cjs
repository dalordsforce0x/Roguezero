/**
 * E3: Add per-token performance section to admin overview tab.
 * Adds fetch + render for token performance data.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'apps', 'admin', 'src', 'app', 'page.tsx');
let c = fs.readFileSync(file, 'utf8');

if (c.includes('tokenPerformance')) {
  console.log('E3 UI already applied');
  process.exit(0);
}

// 1. Add TokenPerformance type
const typeInsert = `
interface TokenPerformanceEntry {
  mint: string;
  symbol: string;
  token_class: string;
  total_exits: number;
  wins: number;
  losses: number;
  avg_pnl_bps: number;
  total_pnl_bps: number;
  max_favorable_bps_avg: number;
  max_adverse_bps_avg: number;
  avg_hold_minutes: number;
  last_exit_at: string;
}

`;

// Insert after RuntimeControlData interface
const afterRtControl = "  updatedAt: string;\n}\n";
const rtIdx = c.lastIndexOf(afterRtControl);
if (rtIdx < 0) {
  console.error('FATAL: cannot find RuntimeControlData end');
  process.exit(1);
}
c = c.substring(0, rtIdx + afterRtControl.length) + typeInsert + c.substring(rtIdx + afterRtControl.length);
console.log('[1] Added TokenPerformanceEntry type');

// 2. Add state + fetch callback (after tokenUniverse state)
const afterTokenUniverse = "const [tokenUniverseLoading, setTokenUniverseLoading] = useState(false);\n";
const tuIdx = c.indexOf(afterTokenUniverse);
if (tuIdx < 0) {
  console.error('FATAL: tokenUniverseLoading not found');
  process.exit(1);
}
c = c.substring(0, tuIdx + afterTokenUniverse.length) +
  "  const [tokenPerformance, setTokenPerformance] = useState<TokenPerformanceEntry[]>([]);\n" +
  "  const [tokenPerfLoading, setTokenPerfLoading] = useState(false);\n" +
  c.substring(tuIdx + afterTokenUniverse.length);
console.log('[2] Added tokenPerformance state');

// 3. Add fetch function (after fetchTokenUniverse)
const fetchTU = "const fetchTokenUniverse = useCallback(async () => {\n";
const fetchTUIdx = c.indexOf(fetchTU);
if (fetchTUIdx < 0) {
  console.error('FATAL: fetchTokenUniverse not found');
  process.exit(1);
}
const fetchTPFn = `  const fetchTokenPerformance = useCallback(async () => {
    setTokenPerfLoading(true);
    try {
      const res = await fetch('/api/token-performance');
      if (!res.ok) return;
      const data = await res.json() as { tokens: TokenPerformanceEntry[] };
      setTokenPerformance(data.tokens ?? []);
    } finally {
      setTokenPerfLoading(false);
    }
  }, []);

  `;
c = c.substring(0, fetchTUIdx) + fetchTPFn + c.substring(fetchTUIdx);
console.log('[3] Added fetchTokenPerformance callback');

// 4. Add render in the overview tab — after the overview stats cards
// Find the overview tab to add the performance table
const overviewEnd = "              <StatCard label=\"Licensed\"";
const overviewIdx = c.indexOf(overviewEnd);
if (overviewIdx < 0) {
  console.log('[4] WARN: overview section not found, skipping UI render');
} else {
  // Find the closing of the overview stats grid
  const gridEnd = c.indexOf('</div>\n          </div>\n', overviewIdx);
  if (gridEnd < 0) {
    console.log('[4] WARN: stats grid end not found');
  } else {
    const insertPoint = c.indexOf('\n', gridEnd + '</div>\n          </div>'.length);
    
    const perfTable = `

            {/* E3: Per-Token Performance (last 30d) */}
            <div className="mt-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-white">Token Performance (30d)</p>
                <button
                  onClick={() => void fetchTokenPerformance()}
                  disabled={tokenPerfLoading}
                  className="text-xs border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
                >
                  {tokenPerfLoading ? 'Loading…' : '↻ Load'}
                </button>
              </div>
              {tokenPerformance.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-800 text-gray-500">
                        <th className="text-left py-2 px-2">Token</th>
                        <th className="text-left py-2 px-2">Class</th>
                        <th className="text-right py-2 px-2">Exits</th>
                        <th className="text-right py-2 px-2">Win%</th>
                        <th className="text-right py-2 px-2">Avg PnL</th>
                        <th className="text-right py-2 px-2">Total PnL</th>
                        <th className="text-right py-2 px-2">Avg Hold</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tokenPerformance.map((t) => (
                        <tr key={t.mint} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                          <td className="py-1.5 px-2 text-white font-mono">{t.symbol}</td>
                          <td className="py-1.5 px-2 text-gray-400">{t.token_class}</td>
                          <td className="py-1.5 px-2 text-right text-gray-300">{t.total_exits}</td>
                          <td className="py-1.5 px-2 text-right text-gray-300">
                            {t.total_exits > 0 ? Math.round(t.wins / t.total_exits * 100) : 0}%
                          </td>
                          <td className={\`py-1.5 px-2 text-right \${t.avg_pnl_bps >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                            {t.avg_pnl_bps >= 0 ? '+' : ''}{t.avg_pnl_bps}bps
                          </td>
                          <td className={\`py-1.5 px-2 text-right font-semibold \${t.total_pnl_bps >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                            {t.total_pnl_bps >= 0 ? '+' : ''}{t.total_pnl_bps}bps
                          </td>
                          <td className="py-1.5 px-2 text-right text-gray-400">{t.avg_hold_minutes}m</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>`;

    c = c.substring(0, insertPoint) + perfTable + c.substring(insertPoint);
    console.log('[4] Added token performance table to overview tab');
  }
}

fs.writeFileSync(file, c);
console.log('\nE3 done: token performance API + admin UI');
