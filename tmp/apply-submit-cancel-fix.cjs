const fs = require('fs');
const f = 'services/worker/src/index.ts';
const src = fs.readFileSync(f, 'utf8');

// Find the submit failure block: after the shortfall log, before "return;"
// Pattern: the shortfall closing brace "    }" followed by "    return;" inside the !submit.ok block
// We need to insert the cancel call between the shortfall closing brace and the return.

const marker = `preserving session funds\`,\r\n      );\r\n    }\r\n    return;\r\n  }`;
const idx = src.indexOf(marker);
if (idx === -1) {
  // Try LF
  const markerLF = `preserving session funds\`,\n      );\n    }\n    return;\n  }`;
  const idxLF = src.indexOf(markerLF);
  if (idxLF === -1) {
    console.error('ERROR: Could not find submit failure return block');
    process.exit(1);
  }
  const nl = '\n';
  const replacement = `preserving session funds\`,\n      );\n    }\n    // Cancel the prepared execution so the session isn't blocked forever\n    try {\n      await apiPost(\`/jupiter/swap/executions/\${prepare.data.executionId}/cancel\`, {\n        stage: 'worker_cancel',\n        reason: 'submit_failed',\n      });\n    } catch (cancelErr) {\n      log('warn', session.id, \`cancel prepared execution failed after submit error: \${String(cancelErr)}\`);\n    }\n    return;\n  }`;
  const out = src.slice(0, idxLF) + replacement + src.slice(idxLF + markerLF.length);
  fs.writeFileSync(f, out, 'utf8');
  console.log('OK (LF) — cancel call added to submit failure handler');
  process.exit(0);
}

const replacement = `preserving session funds\`,\r\n      );\r\n    }\r\n    // Cancel the prepared execution so the session isn't blocked forever\r\n    try {\r\n      await apiPost(\`/jupiter/swap/executions/\${prepare.data.executionId}/cancel\`, {\r\n        stage: 'worker_cancel',\r\n        reason: 'submit_failed',\r\n      });\r\n    } catch (cancelErr) {\r\n      log('warn', session.id, \`cancel prepared execution failed after submit error: \${String(cancelErr)}\`);\r\n    }\r\n    return;\r\n  }`;

const out = src.slice(0, idx) + replacement + src.slice(idx + marker.length);
fs.writeFileSync(f, out, 'utf8');
console.log('OK (CRLF) — cancel call added to submit failure handler');
