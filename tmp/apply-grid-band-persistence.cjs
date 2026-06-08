const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');

function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  console.log(`[${label}] applied`);
}

// A) CREATE TABLE: add band columns
apply(
  'create-table',
  `        partial_net_bps INTEGER,
        thresholds JSONB,`,
  `        partial_net_bps INTEGER,
        grid_range_width_bps INTEGER,
        grid_price_position_pct INTEGER,
        grid_recent_move_bps INTEGER,
        thresholds JSONB,`,
);

// B) ALTER TABLE: add band columns for existing tables
apply(
  'alter-table',
  `          ADD COLUMN IF NOT EXISTS partial_net_bps INTEGER
      \`))`,
  `          ADD COLUMN IF NOT EXISTS partial_net_bps INTEGER,
          ADD COLUMN IF NOT EXISTS grid_range_width_bps INTEGER,
          ADD COLUMN IF NOT EXISTS grid_price_position_pct INTEGER,
          ADD COLUMN IF NOT EXISTS grid_recent_move_bps INTEGER
      \`))`,
);

// C) INSERT column list
apply(
  'insert-cols',
  `          partial_trigger_bps, partial_sell_bps, partial_fired, partial_net_bps
        ) VALUES`,
  `          partial_trigger_bps, partial_sell_bps, partial_fired, partial_net_bps,
          grid_range_width_bps, grid_price_position_pct, grid_recent_move_bps
        ) VALUES`,
);

// D) cols count
apply(
  'cols-count',
  `    const cols = 27;`,
  `    const cols = 30;`,
);

// E) column casts
apply(
  'column-casts',
  `      '::int', '::int', '::boolean', '::int',
    ];`,
  `      '::int', '::int', '::boolean', '::int',
      '::int', '::int', '::int',
    ];`,
);

// F) row values
apply(
  'row-values',
  `      partialShadow.fired,
      partialShadow.netBps,
    ]);`,
  `      partialShadow.fired,
      partialShadow.netBps,
      intOrNull(grid?.rangeWidthBps),
      intOrNull(grid?.pricePositionPct),
      intOrNull(grid?.recentMoveBps),
    ]);`,
);

fs.writeFileSync(path, src, 'utf8');
console.log('DONE: grid band persistence applied');
