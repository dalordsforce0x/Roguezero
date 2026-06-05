const service = process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_SERVICE_ID || 'unknown';
const checks = {
  common: ['DATABASE_PRIVATE_URL','RZ_INTERNAL_SECRET','JUPITER_API_KEY'],
  api: ['DATABASE_PRIVATE_URL','SESSION_KEY_ENCRYPTION_KEY','RZ_INTERNAL_SECRET','HELIUS_API_KEY','WEB_PUBLIC_ORIGIN','JUPITER_API_KEY'],
  worker: ['DATABASE_PRIVATE_URL','SESSION_KEY_ENCRYPTION_KEY','RZ_INTERNAL_SECRET','API_URL','HELIUS_RPC_URL','JUPITER_API_KEY'],
  web: ['RZ_INTERNAL_SECRET','NEXT_PUBLIC_API_URL','NEXT_PUBLIC_HELIUS_RPC_URL','WEB_GATE_TEMP_PASSWORD'],
  admin: ['DATABASE_PRIVATE_URL','KEYAUTH_SELLER_KEY','JUPITER_API_KEY'],
  deploy: ['NIXPACKS_BUILD_CMD','NIXPACKS_START_CMD','PORT']
};
const all = [...new Set(Object.values(checks).flat())];
console.log(JSON.stringify({ service, present: Object.fromEntries(all.map(k => [k, Boolean(process.env[k])])) }, null, 2));
