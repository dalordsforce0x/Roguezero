/**
 * F1: Admin UI — add performanceFeeEnabled to type + toggle button + callback.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'apps', 'admin', 'src', 'app', 'page.tsx');
let c = fs.readFileSync(file, 'utf8');
let edits = 0;

function mustReplace(label, old, replacement) {
  if (!c.includes(old)) {
    console.error(`FATAL: [${label}] not found`);
    console.error('Looking for:', JSON.stringify(old.substring(0, 100)));
    process.exit(1);
  }
  c = c.replace(old, replacement);
  edits++;
  console.log(`  [${edits}] ${label}`);
}

if (!c.includes('performanceFeeEnabled')) {
  // 1. Add to RuntimeControlData interface
  mustReplace('type field',
    '  entriesEnabled: boolean;\r\n  maintenanceReason: string | null;',
    '  entriesEnabled: boolean;\r\n  performanceFeeEnabled: boolean;\r\n  maintenanceReason: string | null;'
  );

  // 2. Add toggle callback (after toggleRuntimeEntries)
  mustReplace('toggle callback',
    '  const toggleRuntimeEntries = useCallback(async (entriesEnabled: boolean) => {',
    '  const togglePerformanceFee = useCallback(async (enabled: boolean) => {\r\n    setRuntimeControlUpdating(true);\r\n    try {\r\n      const res = await fetch(\'/api/runtime-control\', {\r\n        method: \'PATCH\',\r\n        headers: { \'Content-Type\': \'application/json\' },\r\n        body: JSON.stringify({ performanceFeeEnabled: enabled }),\r\n      });\r\n      if (!res.ok) return;\r\n      const data = await res.json() as RuntimeControlData;\r\n      setRuntimeControl(data);\r\n    } finally {\r\n      setRuntimeControlUpdating(false);\r\n    }\r\n  }, []);\r\n\r\n  const toggleRuntimeEntries = useCallback(async (entriesEnabled: boolean) => {'
  );

  // 3. Add onToggleFee prop to RuntimeControlPanel
  mustReplace('panel prop pass',
    '              onToggleEntries={toggleRuntimeEntries}',
    '              onToggleEntries={toggleRuntimeEntries}\r\n              onToggleFee={togglePerformanceFee}'
  );

  // 4. Add onToggleFee to RuntimeControlPanel props
  mustReplace('panel prop type',
    '  onToggleEntries: (enabled: boolean) => void;\r\n}) {',
    '  onToggleEntries: (enabled: boolean) => void;\r\n  onToggleFee: (enabled: boolean) => void;\r\n}) {'
  );
  mustReplace('panel prop destructure',
    '  onToggleEntries,\r\n}: {',
    '  onToggleEntries,\r\n  onToggleFee,\r\n}: {'
  );

  // 5. Add fee toggle button after the entries toggle block
  // The entries toggle ends at </div>\n        </div>\n      )}\n\n      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
  mustReplace('fee toggle button',
    '              {control.entriesEnabled ? \'Block New Entries\' : \'Allow New Entries\'}\r\n            </button>\r\n          </div>\r\n        </div>\r\n      )}',
    '              {control.entriesEnabled ? \'Block New Entries\' : \'Allow New Entries\'}\r\n            </button>\r\n          </div>\r\n        </div>\r\n      )}\r\n\r\n      {/* F1: Performance Fee Toggle */}\r\n      {control && (\r\n        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">\r\n          <div className="flex items-center justify-between">\r\n            <div>\r\n              <p className="text-sm font-semibold text-white">\r\n                Performance Fee\r\n                <span className={`ml-2 text-xs font-normal ${control.performanceFeeEnabled ? \'text-emerald-400\' : \'text-gray-500\'}`}>\r\n                  {control.performanceFeeEnabled ? \'ACTIVE\' : \'DISABLED\'}\r\n                </span>\r\n              </p>\r\n              <p className="text-xs text-gray-500 mt-1">\r\n                {control.performanceFeeEnabled\r\n                  ? \'0.33% of net session profit is collected at settlement.\'\r\n                  : \'Performance fee is disabled. No revenue is being collected.\'}\r\n              </p>\r\n            </div>\r\n            <button\r\n              type="button"\r\n              disabled={updating}\r\n              onClick={() => onToggleFee(!control.performanceFeeEnabled)}\r\n              className={[\r\n                \'rounded-lg border px-3 py-2 text-xs font-semibold transition-colors\',\r\n                control.performanceFeeEnabled\r\n                  ? \'border-amber-400/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20\'\r\n                  : \'border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20\',\r\n                updating ? \'opacity-60 cursor-not-allowed\' : \'\',\r\n              ].join(\' \')}\r\n            >\r\n              {control.performanceFeeEnabled ? \'Disable Fee\' : \'Enable Fee\'}\r\n            </button>\r\n          </div>\r\n        </div>\r\n      )}'
  );
}

fs.writeFileSync(file, c);
console.log(`\nDone: ${edits} edits applied.`);
