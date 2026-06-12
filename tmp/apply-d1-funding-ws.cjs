/**
 * D1: Add awaiting_funding to balance subscription statuses.
 * The subscription system already exists (D3 done) — just need to include
 * awaiting_funding so funding detection uses WS balance instead of polling.
 * Also wire the subscription balance into checkFunding.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');

// 1. Add awaiting_funding to subscription statuses
const oldStatuses = "const ACTIVE_BALANCE_SUB_STATUSES = new Set(['ready', 'starting', 'active', 'stopping']);";
if (!c.includes(oldStatuses)) {
  console.error('FATAL: balance sub statuses not found');
  process.exit(1);
}
c = c.replace(oldStatuses,
  "const ACTIVE_BALANCE_SUB_STATUSES = new Set(['awaiting_funding', 'ready', 'starting', 'active', 'stopping']);"
);

// 2. Use getCachedSessionWalletBalance in checkFunding instead of rlGetBalance
// Currently: balance = await rlGetBalance(new PublicKey(session.session_wallet));
// Replace with: balance = await getCachedSessionWalletBalance(new PublicKey(session.session_wallet));
c = c.replace(
  '      balance = await rlGetBalance(new PublicKey(session.session_wallet));\r\n    } catch (err) {\r\n      log(\'warn\', session.id, `balance check failed: ${String(err)}`);\r\n      return;\r\n    }',
  '      balance = await getCachedSessionWalletBalance(new PublicKey(session.session_wallet));\r\n    } catch (err) {\r\n      log(\'warn\', session.id, `balance check failed: ${String(err)}`);\r\n      return;\r\n    }'
);

fs.writeFileSync(file, c);
console.log('D1 done: awaiting_funding sessions now use WS balance subscriptions');
