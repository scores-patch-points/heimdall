// Where the two neighbours this package needs are found. Nothing here names a sibling by a fixed path:
//   HEIMDALL_PHAROS_LIB     path to pharos' lib/pharos.mjs           (default: a `pharos` checkout beside this repo)
//   PENELOPE_WEAVE_MODULE   path to penelope's organs/weave-mark.mjs (default: a `penelope` checkout beside this repo)
// Penelope must be at or after the commit that added her merge route (mergeEntries).
// When either is missing, the tests that need them skip and say so.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const beside = (...p) => path.resolve(HERE, '../../..', ...p);
export const PHAROS_LIB = process.env.HEIMDALL_PHAROS_LIB || beside('pharos/lib/pharos.mjs');
export const PENELOPE = process.env.PENELOPE_WEAVE_MODULE || beside('penelope/organs/weave-mark.mjs');
const missing = [[PHAROS_LIB, 'pharos (HEIMDALL_PHAROS_LIB)'], [PENELOPE, 'Penelope (PENELOPE_WEAVE_MODULE)']].filter(([p]) => !fs.existsSync(p)).map(([, n]) => n);
export const needs = missing.length ? `not found: ${missing.join(' and ')}` : false;
if (!needs) process.env.PENELOPE_WEAVE_MODULE = PENELOPE;
