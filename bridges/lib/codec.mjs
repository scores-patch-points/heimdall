// codec.mjs: the contract between a database and pharos, and the measure of the gap between two nodes.
//
// NO NODE IS THE TRUTH. A device's pharos log, a browser's OPFS or IndexedDB, a spawned database and a
// member's device are all nodes. Each holds a partial view, each moves on, and they approach one another
// by exchange (union of what each holds); none of them is the whole and none overrules another. A
// database is not "a projection of the true log": it is a node that speaks another shape, and a codec
// is how two nodes of different shapes exchange.
//
// A codec is two directions:
//   down(db, entries)  log-shaped -> engine-shaped. Idempotent by entry id.
//   up(db)             engine-shaped -> log-shaped: changes made natively in the engine since the last
//                      exchange, as marks (Penelope's shape), each with ack(id) once Penelope wove it.
//   ids(db)            the entry ids this node says it holds
//   holds              'public' | 'ciphertext' | 'plaintext': what the node keeps at rest. A plaintext node
//                      of subject data may only exist on a device that holds the keys, and must be declared
//                      so a revoke or erase can find it and rebuild it.
//
// The measure (DECISIONS-2026-11-14 #14c: a fold refuses a codec nobody has measured) compares TWO NODES
// at stated frontiers and reports the gap both ways. A zero gap means "no difference found between these
// two nodes at these frontiers with this comparison", and it is woven as a revisable EVA entry, never as
// a pass/fail stamp on the truth. The next exchange can reopen it.
//
// Kinds:
//   database      DEF·Pattern  declares a database node: engine, codec, holds, the pinned public repo that defines it
//   gap-measured  EVA·Pattern  the gap between two nodes at two frontiers, of = [database id]
//   row           INS·Figure   one row as a value at db:<name>/<table>/<key>
//   row-cut       SEG·Figure   a row deleted in the engine: the row entry at that address is cut, not erased
export const KINDS = {
  database: { cell: 'DEF·Pattern', why: 'declares a database node: engine, codec, what it holds at rest, and the pinned public repo that defines it' },
  'gap-measured': { cell: 'EVA·Pattern', why: 'the measured gap between two nodes at stated frontiers; revisable by the next exchange, never a verdict on truth' },
  row: { cell: 'INS·Figure', why: 'one row of a database, as a value, at the address db:<name>/<table>/<key>' },
  'row-cut': { cell: 'SEG·Figure', why: 'a row was deleted in the database: the row entry at that address is cut, not erased' },
};
export const markOf = (kind, addr, body, { of = [], witness, basis = {} } = {}) =>
  ({ kind, cell: KINDS[kind].cell, addr, body, of, basis, witness: { how: witness }, declare: { why: KINDS[kind].why } });

// Gap between node A (what one side says belongs to the database: entry ids + their values) and node B
// (a database rebuilt by the codec from A's entries alone, or a live database). Both directions are
// reported; neither side is assumed right.
export async function measureGap({ codec, nodeB, entriesA, frontierA, frontierB, compare }) {
  if (codec && entriesA) await codec.down(nodeB, entriesA);
  const a = new Set(entriesA.map((e) => e.id));
  const b = new Set(await codec.ids(nodeB));
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  const values = compare ? await compare(nodeB) : { checked: 0, differ: [] };
  return {
    frontierA, frontierB,
    held: { a: a.size, b: b.size, both: a.size - onlyA.length },
    onlyA: onlyA.slice(0, 20), onlyB: onlyB.slice(0, 20), onlyACount: onlyA.length, onlyBCount: onlyB.length,
    values: { checked: values.checked, differCount: values.differ.length, differ: values.differ.slice(0, 20) },
    noDifferenceFound: !onlyA.length && !onlyB.length && !values.differ.length,
  };
}
