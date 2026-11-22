// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: split a file into its lines and whether it ends with a line break. */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(br: string, lines: string[], final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

/** SPEC.md section 5: how a line compares at a tier. */
function tierOf(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
}

/** The first tier where old occurs in fileLines at or after `from`; all positions at that tier. */
function findTier(fileLines: string[], old: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const maxTier = strict ? 1 : 3;
  for (let tier = 0; tier < maxTier; tier += 1) {
    const at: number[] = [];
    const first = tierOf(old[0]!, tier);
    for (let i = Math.max(0, from); i + old.length <= fileLines.length; i += 1) {
      if (tierOf(fileLines[i]!, tier) !== first) continue;
      let ok = true;
      for (let j = 1; j < old.length; j += 1) {
        if (tierOf(fileLines[i + j]!, tier) !== tierOf(old[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** SPEC.md section 5: replace the old.length lines at pos by neu's lines, context as the file's own. */
function applyMatch(fileLines: string[], pos: number, old: string[], neu: string[], pairs: (number | null)[], tier: number): string[] {
  let leadP = '';
  let leadF = '';
  if (tier === 2) {
    const m = old[0]!.match(/^[ \t]*/);
    leadP = m === null ? '' : m[0];
    const fm = fileLines[pos]!.match(/^[ \t]*/);
    leadF = fm === null ? '' : fm[0];
  }
  const out = fileLines.slice();
  const repl = neu.map((line, j) => {
    if (pairs[j] !== null && pairs[j] !== undefined) return fileLines[pos + pairs[j]!]!;
    if (tier === 2 && /[^ \t]/.test(line) && line.startsWith(leadP)) return leadF + line.slice(leadP.length);
    return line;
  });
  out.splice(pos, old.length, ...repl);
  return out;
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  move(from: string, to: string, text: string): void {
    this.now.set(from, null);
    this.now.set(to, text);
    this.moves.push([from, to]);
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- SPEC.md section 6: unified diffs ----

type BodyKind = 'ctx' | 'old' | 'new' | 'mark';
interface BodyEntry {
  kind: BodyKind;
  text: string;
  blank: boolean;
}
interface Hunk {
  a: number;
  o: string[];
  n: string[];
  pairs: (number | null)[];
  noBreak: boolean;
  plus: string[];
  plusMark: boolean;
}
interface Section {
  gitX: string | null;
  gitY: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | undefined;
  renameTo: string | undefined;
  sawNew: boolean;
  sawDel: boolean;
  hunks: Hunk[];
}

/** The path of a `--- `/`+++ ` line: after four chars, to the first tab, trimmed, one a/ or b/ off. */
function diffPath(l: string): string | null {
  let p = l.slice(4);
  const t = p.indexOf('\t');
  if (t >= 0) p = p.slice(0, t);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

/** The body of a hunk starting at `start`: entries and the index of the first line after it. */
function scanBody(lines: string[], start: number): { entries: BodyEntry[]; next: number } {
  const entries: BodyEntry[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      entries.push({ kind: 'ctx', text: '', blank: true });
    } else if (l[0] === ' ') {
      entries.push({ kind: 'ctx', text: l.slice(1), blank: false });
    } else if (l[0] === '-') {
      entries.push({ kind: 'old', text: l.slice(1), blank: false });
    } else if (l[0] === '+') {
      entries.push({ kind: 'new', text: l.slice(1), blank: false });
    } else if (l[0] === '\\') {
      entries.push({ kind: 'mark', text: l, blank: false });
    } else {
      break;
    }
    j += 1;
  }
  return { entries, next: j };
}

/** O, N, pairs, the `+` lines and the two `\`-marker facts of one hunk body. */
function buildHunk(a: number, raw: BodyEntry[]): Hunk {
  const body = raw.slice();
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.blank) body.pop();
  const o: string[] = [];
  const n: string[] = [];
  const pairs: (number | null)[] = [];
  const plus: string[] = [];
  let oi = 0;
  let lastSide = -1;
  let lastNew = -1;
  body.forEach((e, idx) => {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push(e.text);
      pairs.push(oi);
      oi += 1;
      lastSide = idx;
    } else if (e.kind === 'old') {
      o.push(e.text);
      oi += 1;
    } else if (e.kind === 'new') {
      n.push(e.text);
      pairs.push(null);
      plus.push(e.text);
      lastNew = idx;
      lastSide = idx;
    }
  });
  const mark = (k: number): boolean => k >= 0 && body[k + 1] !== undefined && body[k + 1]!.kind === 'mark';
  return { a, o, n, pairs, noBreak: mark(lastSide), plus, plusMark: mark(lastNew) };
}

/** SPEC.md section 6: apply a section's hunks in order to a splitFile state. */
function applyHunks(st: { br: string; lines: string[]; final: boolean }, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(st.lines, h.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      for (const p of found.at) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const ranToEnd = pos + h.o.length === st.lines.length;
      st.lines = applyMatch(st.lines, pos, h.o, h.n, h.pairs, found.tier);
      if (ranToEnd) st.final = !h.noBreak;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, st.lines.length));
      const atEnd = pos === st.lines.length;
      st.lines.splice(pos, 0, ...h.n);
      if (atEnd) st.final = !h.noBreak;
    }
    d += h.n.length - h.o.length;
  }
}

/** The one edit a parsed section stands for. */
function sectionEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.hasPair ? s.pairOld : (s.renameOld ?? s.gitX);
  const newPath = s.hasPair ? s.pairNew : (s.renameTo ?? s.gitY);
  const isCreate = oldPath === null || s.sawNew;
  const isDelete = newPath === null || s.sawDel;
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (newPath === null) throw new Fail('missing', oldPath ?? '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const fl: string[] = [];
      let mark = false;
      for (const h of s.hunks) {
        fl.push(...h.plus);
        if (h.plus.length > 0) mark = h.plusMark;
      }
      tree.now.set(newPath, joinFile('\n', fl, !mark));
    } else if (isDelete) {
      if (oldPath === null) throw new Fail('missing', '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    } else if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      const t = tree.get(oldPath);
      if (t === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const st = splitFile(t);
      applyHunks(st, s.hunks, oldPath, strict);
      tree.move(oldPath, newPath, joinFile(st.br, st.lines, st.final));
    } else {
      const p = oldPath ?? newPath;
      if (p === null) throw new Fail('missing', '');
      const t = tree.get(p);
      if (t === null) throw new Fail('missing', p);
      const st = splitFile(t);
      applyHunks(st, s.hunks, p, strict);
      tree.now.set(p, joinFile(st.br, st.lines, st.final));
    }
  };
}

/** SPEC.md section 6: read a unified diff into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const HUNK = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/;
  const edits: Edit[] = [];
  let sec: Section | null = null;
  const finish = (): void => {
    if (sec !== null) {
      edits.push(sectionEdit(sec, strict));
      sec = null;
    }
  };
  const fresh = (gitX: string | null, gitY: string | null, hasPair: boolean, pairOld: string | null, pairNew: string | null): Section => ({
    gitX,
    gitY,
    hasPair,
    pairOld,
    pairNew,
    renameOld: undefined,
    renameTo: undefined,
    sawNew: false,
    sawDel: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const n = i + 1;
    if (l.startsWith('diff --git ')) {
      finish();
      const rest = l.slice('diff --git '.length);
      const k = rest.startsWith('a/') ? rest.indexOf(' b/') : -1;
      if (k < 0) throw new Exit2(`error: parse ${n}`);
      sec = fresh(rest.slice(2, k), rest.slice(k + 3), false, null, null);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK.exec(l);
      if (m === null) throw new Exit2(`error: parse ${n}`);
      if (sec === null) throw new Exit2(`error: parse ${n}`);
      const body = scanBody(lines, i + 1);
      sec.hunks.push(buildHunk(parseInt(m[1]!, 10), body.entries));
      i = body.next;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nxt = i + 1 < lines.length ? lines[i + 1]! : '';
      if (nxt.startsWith('+++ ')) {
        if (sec !== null && !sec.hasPair && sec.hunks.length === 0) {
          sec.pairOld = diffPath(l);
          sec.pairNew = diffPath(nxt);
          sec.hasPair = true;
        } else {
          finish();
          sec = fresh(null, null, true, diffPath(l), diffPath(nxt));
        }
        i += 2;
        continue;
      }
      if (sec !== null && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (l.startsWith('rename from ')) sec.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) sec.sawNew = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) sec.sawDel = true;
    }
    i += 1;
  }
  finish();
  return edits;
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks ----

/** SPEC.md section 7: read SEARCH/REPLACE blocks into one edit each. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let rep = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (sep < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    prevPath = path;
    prevEnd = rep;
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile('\n', newLines, true));
        return;
      }
      const t = tree.get(p);
      if (t === null) throw new Fail('missing', p);
      const st = splitFile(t);
      const found = findTier(st.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const pairs = newLines.map(() => null);
      st.lines = applyMatch(st.lines, found.at[0]!, oldLines, newLines, pairs, found.tier);
      tree.now.set(p, joinFile(st.br, st.lines, st.final));
    });
    i = rep + 1;
  }
  return edits;
}

// ---- SPEC.md section 8: V4A patches ----

interface V4AEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}
interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  pairs: (number | null)[];
}
interface V4ARaw {
  anchor: string | null;
  eof: boolean;
  ents: V4AEntry[];
}

/** O, N and pairs of a chunk's body entries, in body order. */
function v4aChunk(c: V4ARaw): V4AChunk {
  const o: string[] = [];
  const n: string[] = [];
  const pairs: (number | null)[] = [];
  let oi = 0;
  for (const e of c.ents) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push(e.text);
      pairs.push(oi);
      oi += 1;
    } else if (e.kind === 'old') {
      o.push(e.text);
      oi += 1;
    } else {
      n.push(e.text);
      pairs.push(null);
    }
  }
  return { anchor: c.anchor, eof: c.eof, o, n, pairs };
}

/** The first line at or after `from` equal to `anchor` at the first tier where one is. */
function findAnchor(fileLines: string[], anchor: string, strict: boolean, from: number): number | null {
  const maxTier = strict ? 1 : 3;
  for (let tier = 0; tier < maxTier; tier += 1) {
    const a = tierOf(anchor, tier);
    for (let i = Math.max(0, from); i < fileLines.length; i += 1) {
      if (tierOf(fileLines[i]!, tier) === a) return i;
    }
  }
  return null;
}

/** SPEC.md section 8: apply an Update File section's chunks in order to a splitFile state. */
function applyV4AChunks(st: { br: string; lines: string[]; final: boolean }, chunks: V4AChunk[], path: string, strict: boolean): void {
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const at = findAnchor(st.lines, c.anchor, strict, cursor);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    if (c.o.length > 0) {
      const found = findTier(st.lines, c.o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos: number;
      if (c.eof) {
        const p = found.at.find((q) => q + c.o.length === st.lines.length);
        if (p === undefined) throw new Fail('no-match', path);
        pos = p;
      } else {
        pos = found.at[0]!;
      }
      st.lines = applyMatch(st.lines, pos, c.o, c.n, c.pairs, found.tier);
      cursor = pos + c.n.length;
    } else {
      const pos = c.eof ? st.lines.length : cursor;
      st.lines.splice(pos, 0, ...c.n);
      cursor = pos + c.n.length;
    }
  }
}

/** SPEC.md section 8: read a V4A patch into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  /** The section body: lines i+1 up to the next section or `last`, trailing blank lines dropped. */
  const bodyOf = (i: number): { raw: string[]; next: number } => {
    let j = i + 1;
    while (j < last && !isStart(lines[j]!)) j += 1;
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    return { raw: lines.slice(i + 1, end), next: j };
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const n = i + 1;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const { raw, next } = bodyOf(i);
      raw.forEach((bl, k) => {
        if (bl !== '' && !bl.startsWith('+')) throw new Exit2(`error: parse ${i + k + 2}`);
      });
      const fileLines = raw.map((bl) => (bl === '' ? '' : bl.slice(1)));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile('\n', fileLines, true));
      });
      i = next;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const { raw, next } = bodyOf(i);
      if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = next;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const { raw, next } = bodyOf(i);
      let k = 0;
      let moveTo: string | undefined;
      if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.slice('*** Move to: '.length).trim();
        k += 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4ARaw | null = null;
      let firstChunk = true;
      for (let m = k; m < raw.length; m += 1) {
        const bl = raw[m]!;
        const ln = i + m + 2;
        if (bl.startsWith('@@')) {
          if (cur !== null) chunks.push(v4aChunk(cur));
          const a = bl.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, ents: [] };
          firstChunk = false;
          continue;
        }
        if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          chunks.push(v4aChunk(cur));
          cur = null;
          continue;
        }
        if (bl.startsWith('*** ')) throw new Exit2(`error: parse ${ln}`);
        let e: V4AEntry | null = null;
        if (bl === '') e = { kind: 'ctx', text: '' };
        else if (bl[0] === ' ') e = { kind: 'ctx', text: bl.slice(1) };
        else if (bl[0] === '-') e = { kind: 'old', text: bl.slice(1) };
        else if (bl[0] === '+') e = { kind: 'new', text: bl.slice(1) };
        if (e === null) throw new Exit2(`error: parse ${ln}`);
        if (cur === null) {
          if (!firstChunk) throw new Exit2(`error: parse ${ln}`);
          cur = { anchor: null, eof: false, ents: [] };
          firstChunk = false;
        }
        cur.ents.push(e);
      }
      if (cur !== null) chunks.push(v4aChunk(cur));
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${n}`);
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (mv !== undefined && !safe(mv)) throw new Fail('unsafe', mv);
        const t = tree.get(path);
        if (t === null) throw new Fail('missing', path);
        if (mv !== undefined && tree.get(mv) !== null) throw new Fail('exists', mv);
        const st = splitFile(t);
        applyV4AChunks(st, chunks, path, strict);
        const text = joinFile(st.br, st.lines, st.final);
        if (mv !== undefined) tree.move(path, mv, text);
        else tree.now.set(path, text);
      });
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${n}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldPath, newPath] of tree.moves) {
    if (consumed.has(oldPath) || consumed.has(newPath)) continue;
    if (tree.original(oldPath) === null || tree.now.get(oldPath) !== null) continue;
    if (tree.original(newPath) !== null || tree.now.get(newPath) === null) continue;
    consumed.add(oldPath);
    consumed.add(newPath);
    rows.push({ key: newPath, text: `R ${oldPath} -> ${newPath}` });
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  for (const [p, now] of tree.now) {
    if (check) break;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
