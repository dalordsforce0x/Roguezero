import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const includeDirs = ['apps','services','packages','scripts'];
const exts = new Set(['.ts','.tsx','.js','.mjs','.cjs']);
const skip = new Set(['node_modules','.next','dist','tmp']);
const files = [];
function walk(dir){
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
    if(skip.has(ent.name) || ent.name.startsWith('.git')) continue;
    const p=path.join(dir,ent.name);
    if(ent.isDirectory()) walk(p);
    else if(exts.has(path.extname(ent.name))) files.push(p);
  }
}
for(const d of includeDirs){ if(fs.existsSync(path.join(root,d))) walk(path.join(root,d)); }
const envUses = new Map();
const secretInBrowser=[];
const envRe=/process\.env\.([A-Z0-9_]+)/g;
const bracketRe=/process\.env\[['"]([A-Z0-9_]+)['"]\]/g;
const secretNames=['DATABASE_PRIVATE_URL','DATABASE_PUBLIC_URL','SESSION_KEY_ENCRYPTION_KEY','RZ_INTERNAL_SECRET','HELIUS_API_KEY','JUPITER_API_KEY','KEYAUTH_SELLER_KEY','HELIUS_RPC_URL'];
for(const file of files){
  const rel=path.relative(root,file).replaceAll('\\','/');
  const text=fs.readFileSync(file,'utf8');
  for(const re of [envRe, bracketRe]){
    let m; while((m=re.exec(text))){
      const k=m[1];
      if(!envUses.has(k)) envUses.set(k,new Set());
      envUses.get(k).add(rel);
    }
  }
  const isBrowser = rel.startsWith('apps/web/src/app/page') || rel.startsWith('apps/web/src/components') || rel.startsWith('apps/admin/src/app/page');
  if(isBrowser){
    for(const s of secretNames){ if(text.includes(s)) secretInBrowser.push({file:rel, secret:s}); }
  }
}
const byService={api:[],worker:[],web:[],admin:[],packages:[],scripts:[],other:[]};
for(const [k,set] of [...envUses.entries()].sort(([a],[b])=>a.localeCompare(b))){
  const where=[...set].sort();
  const row={key:k, files:where};
  if(where.some(f=>f.startsWith('services/api/'))) byService.api.push(row);
  if(where.some(f=>f.startsWith('services/worker/'))) byService.worker.push(row);
  if(where.some(f=>f.startsWith('apps/web/'))) byService.web.push(row);
  if(where.some(f=>f.startsWith('apps/admin/'))) byService.admin.push(row);
  if(where.some(f=>f.startsWith('packages/'))) byService.packages.push(row);
  if(where.some(f=>f.startsWith('scripts/'))) byService.scripts.push(row);
}
const summary = Object.fromEntries(Object.entries(byService).map(([k,v])=>[k,v.map(x=>x.key)]));
console.log(JSON.stringify({envKeyCounts:Object.fromEntries(Object.entries(byService).map(([k,v])=>[k,v.length])), summary, secretInBrowser}, null, 2));
