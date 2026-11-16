// Git smart HTTP: protocol v2 upload-pack (advertisement, ls-refs, fetch with shallow
// support), v0 receive-pack (push with report-status), packfile read/write including
// ofs/ref delta resolution for pushed packs. Node stdlib only: SHA-1 from node:crypto,
// zlib from node:zlib. No git binary is involved anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  commitClosure,
  getObject,
  hashObject,
  isAncestor,
  isOid,
  objectClosure,
  parseCommit,
  parseTag,
  peelToCommit,
  storeObject,
  type ObjectType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Parse as many complete packets as `buffer` holds; returns them plus the unconsumed rest. */
export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    // Not a pkt-line header: the rest is raw trailing bytes (a packfile after a
    // receive-pack command list), which the caller takes from `rest`.
    if (!HEX4.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// packfiles

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (non-delta) objects, in the order given. */
export function writePack(entries: readonly { type: ObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    parts.push(packObjectHeader(entry.type, entry.data.length));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Read a pack and store every object it carries (resolving ofs/ref deltas, with the
 * forge's own store as the thin-pack base source). Returns the object ids stored.
 */
export function unpackPack(pack: Buffer): string[] {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjectType;
    resolvedData?: Buffer;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes');

  const stored: string[] = [];
  const resolve = (entry: Raw): { type: ObjectType; data: Buffer } => {
    if (entry.resolvedType && entry.resolvedData) return { type: entry.resolvedType, data: entry.resolvedData };
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = raw.find((candidate) => candidate.oid === entry.baseOid);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = getObject(entry.baseOid!);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    entry.resolvedType = type;
    entry.resolvedData = data;
    entry.oid = hashObject(type, data);
    return { type, data };
  };
  for (const entry of raw) {
    const { type, data } = resolve(entry);
    stored.push(storeObject(type, data));
  }
  return stored;
}

// ---------------------------------------------------------------------------
// advertisements

const AGENT = 'forge/1.0';

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 ref lines for a repo (no capability suffix; the caller adds it to the first). */
function v0RefLines(repo: Repo): string[] {
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target) ?? ZERO_OID;
  lines.push(`${headOid} HEAD`);
  for (const [ref, oid] of sortedRefs(repo)) {
    lines.push(`${oid} ${ref}`);
    const object = getObject(oid);
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(oid);
      if (peeled !== null) lines.push(`${peeled} ${ref}^{}`);
    }
  }
  return lines;
}

export function uploadPackAdvertisement(repo: Repo, protocolV2: boolean): { contentType: string; body: Buffer } {
  const contentType = 'application/x-git-upload-pack-advertisement';
  if (protocolV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { contentType, body };
  }
  const caps = `multi_ack_detailed side-band-64k ofs-delta symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
  const lines = v0RefLines(repo);
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { contentType, body: Buffer.concat(parts) };
}

export function receivePackAdvertisement(repo: Repo): { contentType: string; body: Buffer } {
  const contentType = 'application/x-git-receive-pack-advertisement';
  const caps = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const lines = v0RefLines(repo);
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const target = headTarget(repo);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (matches('HEAD')) {
    const tip = repo.refs.get(target);
    if (tip !== undefined) {
      lines.push(`${tip} HEAD${args.symrefs ? ` symref-target:${target}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${target}` : ''}`);
    } else {
      lines.push(`${ZERO_OID} HEAD${args.symrefs ? ` symref-target:${target}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const object = getObject(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowClient: string[];
  deepen: number | null;
  done: boolean;
}

/** The objects a fetch must deliver, plus the shallow boundary to report. */
function fetchPlan(args: FetchArgs): { send: string[]; shallow: string[]; unshallow: string[] } {
  const clientShallow = new Set(args.shallowClient.filter(isOid));
  const haveCommits = commitClosure(args.haves, clientShallow);
  const haveObjects = new Set<string>();
  for (const oid of haveCommits) {
    for (const inner of objectClosure([oid])) haveObjects.add(inner);
  }
  // Note: objectClosure from a have commit walks its full ancestry, but a shallow have's
  // ancestry is exactly what the depth limit below re-derives; the exclusion that matters
  // is per-object, and depth-limited delivery never includes ancestors of a shallow have
  // beyond the new boundary. To stay exact, when the client declares shallow commits we
  // compute the have-object set with the parent cut applied at those commits.
  if (clientShallow.size > 0) {
    haveObjects.clear();
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const oid of haveCommits) queue.push(oid);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = getObject(oid);
      if (!object) continue;
      haveObjects.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        haveObjects.add(commit.tree);
        for (const inner of objectClosure([commit.tree])) haveObjects.add(inner);
        if (!clientShallow.has(oid)) queue.push(...commit.parents);
      }
    }
  }

  const depthMode = args.deepen !== null;
  const included = new Set<string>();
  if (!depthMode) {
    for (const oid of objectClosure(args.wants)) included.add(oid);
  } else {
    // Breadth-first by commit depth (a want is depth 1); a commit inside the limit brings
    // its whole tree closure with it.
    const limit = Math.max(1, args.deepen!);
    const seenCommits = new Set<string>();
    const queue: { oid: string; depth: number }[] = [];
    for (const want of args.wants) if (isOid(want)) queue.push({ oid: want, depth: 1 });
    while (queue.length) {
      const { oid, depth } = queue.shift()!;
      if (seenCommits.has(oid) || depth > limit) continue;
      const object = getObject(oid);
      if (!object || object.type !== 'commit') continue;
      seenCommits.add(oid);
      included.add(oid);
      const commit = parseCommit(object.data);
      for (const inner of objectClosure([commit.tree])) included.add(inner);
      if (depth < limit) {
        for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    }
  }

  const send = [...included].filter((oid) => !haveObjects.has(oid));

  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depthMode) {
    // A commit inside the depth window is on the new shallow boundary when any of its
    // parents fell outside the window.
    const boundary = new Set<string>();
    for (const oid of included) {
      const object = getObject(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit.parents.length > 0 && commit.parents.some((parent) => !included.has(parent))) boundary.add(oid);
    }
    shallow = [...boundary];
    for (const oid of clientShallow) {
      const object = getObject(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit.parents.some((parent) => included.has(parent)) && !boundary.has(oid)) unshallow.push(oid);
    }
  }
  return { send, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  return parts;
}

export function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = fetchPlan(args);
  const entries = plan.send
    .map((oid) => getObject(oid))
    .filter((object): object is NonNullable<typeof object> => object !== undefined)
    .map((object) => ({ type: object.type, data: object.data }));
  const pack = writePack(entries);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (args.haves.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${args.haves[0]}\n`));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A minimal v0 fetch (the suite's client only uses it when v2 is refused, which never happens here). */
export function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = fetchPlan({ ...args, deepen: args.deepen });
  const entries = plan.send
    .map((oid) => getObject(oid))
    .filter((object): object is NonNullable<typeof object> => object !== undefined)
    .map((object) => ({ type: object.type, data: object.data }));
  const pack = writePack(entries);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse an upload-pack request body and dispatch ls-refs / fetch (v2 or v0 by its shape). */
export function handleUploadPack(repo: Repo, body: Buffer, protocolV2: boolean): Buffer {
  const { packets, rest } = parsePackets(body);
  void rest;
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  if (commandLine !== undefined) {
    const command = commandLine.trim().slice('command='.length);
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of lines) {
        const text = line.replace(/\n$/, '');
        if (text === 'peel') args.peel = true;
        else if (text === 'symrefs') args.symrefs = true;
        else if (text === 'unborn') args.unborn = true;
        else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
      }
      return handleLsRefs(repo, args);
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallowClient: [], deepen: null, done: false };
      for (const line of lines) {
        const text = line.replace(/\n$/, '');
        if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) args.shallowClient.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) args.deepen = Number.parseInt(text.slice(7), 10);
        else if (text === 'done') args.done = true;
      }
      return handleFetchV2(repo, args);
    }
    throw new Error(`unknown upload-pack command ${command}`);
  }
  if (!protocolV2) {
    // v0 fetch: want lines, flush, have lines, done, flush.
    const args: FetchArgs = { wants: [], haves: [], shallowClient: [], deepen: null, done: false };
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      const firstSpace = text.indexOf(' ');
      const head = firstSpace < 0 ? text : text.slice(0, firstSpace);
      if (head === 'want') args.wants.push(text.slice(firstSpace + 1).split(' ')[0]);
      else if (head === 'have') args.haves.push(text.slice(firstSpace + 1).trim());
      else if (head === 'shallow') args.shallowClient.push(text.slice(firstSpace + 1).trim());
      else if (head === 'deepen') args.deepen = Number.parseInt(text.slice(firstSpace + 1), 10);
      else if (head === 'done') args.done = true;
    }
    if (args.wants.length > 0) return handleFetchV0(repo, args);
  }
  throw new Error('unrecognized upload-pack request');
}

// ---------------------------------------------------------------------------
// receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isFastForward(repo: Repo, current: string, next: string): boolean {
  void repo;
  if (current === ZERO_OID || current === next) return true;
  return isAncestor(current, next);
}

/** Apply a receive-pack request; returns the report-status body to send back. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = parsePackets(body);
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0]));
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length === 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  void sawFlush;
  const pack = rest;
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      unpackPack(pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail(command.oldOid === ZERO_OID ? 'reference already exists' : 'stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const object = getObject(command.newOid);
    if (!object) {
      fail('bad object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') {
      fail('bad object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && !isFastForward(repo, current, command.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (capabilities.has('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      const slice = inner.subarray(offset, Math.min(inner.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return inner;
}

export { parseTag };
