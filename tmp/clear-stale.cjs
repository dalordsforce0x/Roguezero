const pg = require('pg');
const c = new pg.Client(process.env.DATABASE_PRIVATE_URL);
c.connect()
  .then(() => c.query(
    `UPDATE swap_executions SET status='failed', error_message='stale_clear'
     WHERE status IN ('prepared','submitted')
       AND created_at < NOW() - interval '2 minutes'`
  ))
  .then(r => console.log('cleared', r.rowCount))
  .then(() => c.end())
  .catch(e => { console.error(e); c.end(); });
