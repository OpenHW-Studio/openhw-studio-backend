const fs = require('fs');
const path = 'OpenHW-studio-frontend/src/services/gamification/ProjectsConfig.js';

let content = fs.readFileSync(path, 'utf8');

// Regex to find wait_secs block opening and its fields
// It looks for: <block type="wait_secs"><field name="VAL">NUMBER</field><field name="UNIT">SEC|MS</field>
// Note: order of VAL and UNIT fields is usually fixed in Blockly if generated that way.
// Let's use a more flexible regex if possible.

const regex = /<block\s+type="wait_secs"\s*(id="[^"]*")?>\s*<field\s+name="VAL">([\d.]+)<\/field>\s*<field\s+name="UNIT">(SEC|MS)<\/field>/g;

content = content.replace(regex, (match, id, val, unit) => {
    let num = parseFloat(val);
    if (unit === 'MS') {
        num = num / 1000;
    }
    const idAttr = id ? ` ${id}` : '';
    return `<block type="set_duration"${idAttr}><value name="TIME"><shadow type="math_number"><field name="NUM">${num}</field></shadow></value>`;
});

// Also check for the case where UNIT comes first (rare, but possible)
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
