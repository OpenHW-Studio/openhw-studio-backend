const fs = require('fs');
const path = 'OpenHW-studio-frontend/src/services/gamification/ProjectsConfig.js';
let content = fs.readFileSync(path, 'utf8');

if (content.includes('<block type="wait_secs">')) {
  console.error("ERROR: Still found wait_secs block in the file!");
  process.exit(1);
}

const matchCount = (content.match(/<block type="set_duration"/g) || []).length;
console.log(`Found ${matchCount} set_duration blocks.`);
if (matchCount === 0) {
  console.error("ERROR: No set_duration blocks found!");
  process.exit(1);
}
console.log("Preliminary verification passed!");
