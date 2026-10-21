import fs from 'node:fs';
export function loadDataset(){return JSON.parse(fs.readFileSync(new URL('./fixtures/synthetic-matching.json',import.meta.url),'utf8'));}
