const fs = require('fs');
const path = 'OpenHW-studio-frontend/src/services/gamification/ProjectsConfig.js';

let content = fs.readFileSync(path, 'utf8');

const regex = /<block\s+type="wait_secs"\s*(id="[^"]*")?>\s*<field\s+name="VAL">([\d.]+)<\/field>\s*<field\s+name="UNIT">(SEC|MS)<\/field>/g;

content = content.replace(regex, (match, id, val, unit) => {
    let num = parseFloat(val);
    if (unit === 'MS') {
        num = num / 1000;
    }
    const idAttr = id ? ` ${id}` : '';
    return `<block type="set_duration"${idAttr}><value name="TIME"><shadow type="math_number"><field name="NUM">${num}</field></shadow></value>`;
});

const regex2 = /<block\s+type="wait_secs"\s*(id="[^"]*")?>\s*<field\s+name="UNIT">(SEC|MS)<\/field>\s*<field\s+name="VAL">([\d.]+)<\/field>/g;
content = content.replace(regex2, (match, id, unit, val) => {
    let num = parseFloat(val);
    if (unit === 'MS') {
        num = num / 1000;
    }
    const idAttr = id ? ` ${id}` : '';
    return `<block type="set_duration"${idAttr}><value name="TIME"><shadow type="math_number"><field name="NUM">${num}</field></shadow></value>`;
});

fs.writeFileSync(path, content);
console.log('Replacement done.');
