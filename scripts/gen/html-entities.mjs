// Generates src/core/fetch/data/entities.json: the HTML5 named character references (every name that is written with a closing semicolon), the one table toText and the XML decoder read (R2c C7, register rows C:6 and D:87).
// The names come from the `character-entities` package already in the tree through react-markdown (the WHATWG table); this only freezes them as data so the Edge-adjacent decoders carry no dependency. Run: node scripts/gen/html-entities.mjs
import { characterEntities } from "character-entities";

import { writeJsonData } from "./json-data.mjs";

const table = Object.fromEntries(Object.entries(characterEntities).sort(([a], [b]) => a.localeCompare(b)));
writeJsonData("src/core/fetch/data/entities.json", table, 0);
console.log(`html-entities: ${Object.keys(table).length} named references written`);
