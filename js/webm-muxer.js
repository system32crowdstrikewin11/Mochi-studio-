/**
 * MiniWebmMuxer — Zero-dependency Matroska / WebM EBML Muxer for WebCodecs VideoEncoder
 *
 * Uses TimestampScale = 100,000 ns (0.1 ms / 100 µs per tick) so 60, 90, 120, 144,
 * and custom FPS frame timestamps are preserved with sub-millisecond precision,
 * plus exact DefaultDuration and seekable Segment Duration!
 */

const TIME_SCALE_NS = 100000; // 0.1 ms per tick

function encodeVintSize(val) {
  let len = 1;
  while (len < 8 && val > (Math.pow(2, 7 * len) - 2)) {
    len++;
  }
  const out = new Uint8Array(len);
  let v = val;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= (1 << (8 - len));
  return out;
}

function encodeUint(val) {
  if (val <= 0) return new Uint8Array([0]);
  const bytes = [];
  let v = Math.floor(val);
  while (v > 0) {
    bytes.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  bytes.reverse();
  return new Uint8Array(bytes);
}

function encodeFloat64(val) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, val, false);
  return new Uint8Array(buf);
}

function encodeAscii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
  return out;
}

function concatBytes(parts) {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].byteLength;
  }
  return out;
}

function elem(idBytes, payload) {
  const id = new Uint8Array(idBytes);
  const size = encodeVintSize(payload.byteLength);
  return concatBytes([id, size, payload]);
}

export class MiniWebmMuxer {
  constructor({ width, height, fps, codecId = 'V_VP9' }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.codecId = codecId;
    this.chunks = [];
  }

  addEncodedChunk(encodedChunk) {
    const data = new Uint8Array(encodedChunk.byteLength);
    encodedChunk.copyTo(data);
    this.chunks.push({
      tsUs: encodedChunk.timestamp,
      durUs: encodedChunk.duration || Math.round(1000000 / this.fps),
      isKey: encodedChunk.type === 'key',
      data,
    });
  }

  buildBlob() {
    // 1. EBML Header (0x1A45DFA3)
    const ebmlBody = concatBytes([
      elem([0x42, 0x86], encodeUint(1)),          // EBMLVersion
      elem([0x42, 0xf7], encodeUint(1)),          // EBMLReadVersion
      elem([0x42, 0xf2], encodeUint(4)),          // EBMLMaxIDLength
      elem([0x42, 0xf3], encodeUint(8)),          // EBMLMaxSizeLength
      elem([0x42, 0x82], encodeAscii('webm')),    // DocType
      elem([0x42, 0x87], encodeUint(4)),          // DocTypeVersion
      elem([0x42, 0x85], encodeUint(2)),          // DocTypeReadVersion
    ]);
    const ebml = elem([0x1a, 0x45, 0xdf, 0xa3], ebmlBody);

    // Compute exact total duration in 0.1 ms ticks
    let maxEndUs = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const endUs = this.chunks[i].tsUs + this.chunks[i].durUs;
      if (endUs > maxEndUs) maxEndUs = endUs;
    }
    const durationTicks = maxEndUs / 100.0;

    // 2. Segment Info (0x1549A966)
    const infoBody = concatBytes([
      elem([0x2a, 0xd7, 0xb1], encodeUint(TIME_SCALE_NS)),
      elem([0x4d, 0x80], encodeAscii('MochiStudio')),
      elem([0x57, 0x41], encodeAscii('MochiStudio')),
      elem([0x44, 0x89], encodeFloat64(durationTicks)),
    ]);
    const info = elem([0x15, 0x49, 0xa9, 0x66], infoBody);

    // 3. Tracks (0x1654AE6B)
    const videoBody = concatBytes([
      elem([0xb0], encodeUint(this.width)),
      elem([0xba], encodeUint(this.height)),
    ]);
    const defaultDurationNs = Math.round(1000000000 / Math.max(1, this.fps));
    const trackEntry = concatBytes([
      elem([0xd7], encodeUint(1)),
      elem([0x73, 0xc5], encodeUint(1)),
      elem([0x83], encodeUint(1)),
      elem([0x86], encodeAscii(this.codecId)),
      elem([0x23, 0xe3, 0x83], encodeUint(defaultDurationNs)),
      elem([0xe0], videoBody),
    ]);
    const tracks = elem([0x16, 0x54, 0xae, 0x6b], elem([0xae], trackEntry));

    // 4. Clusters (0x1F43B675) — split on keyframes or every 2.0s (20000 ticks)
    const clusterParts = [];
    let curStartTick = -1;
    let curBlocks = [];

    const flushCluster = () => {
      if (curStartTick >= 0 && curBlocks.length > 0) {
        const body = concatBytes([
          elem([0xe7], encodeUint(curStartTick)),
          ...curBlocks,
        ]);
        clusterParts.push(elem([0x1f, 0x43, 0xb6, 0x75], body));
      }
    };

    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const tick = Math.max(0, Math.round(c.tsUs / 100.0));
      if (curStartTick < 0 || (c.isKey && curBlocks.length > 0) || (tick - curStartTick > 20000)) {
        flushCluster();
        curStartTick = tick;
        curBlocks = [];
      }
      const rel = Math.max(-32768, Math.min(32767, tick - curStartTick));
      const hdr = new Uint8Array(4);
      hdr[0] = 0x81; // Track 1 VINT
      hdr[1] = (rel >> 8) & 0xff;
      hdr[2] = rel & 0xff;
      hdr[3] = c.isKey ? 0x80 : 0x00;

      const sbPayload = concatBytes([hdr, c.data]);
      curBlocks.push(elem([0xa3], sbPayload));
    }
    flushCluster();

    // 5. Segment (0x18538067)
    const segmentBodyParts = [info, tracks, ...clusterParts];
    let segSize = 0;
    for (let i = 0; i < segmentBodyParts.length; i++) segSize += segmentBodyParts[i].byteLength;
    const segHeader = concatBytes([
      new Uint8Array([0x18, 0x53, 0x80, 0x67]),
      encodeVintSize(segSize),
    ]);

    return new Blob([ebml, segHeader, ...segmentBodyParts], { type: 'video/webm' });
  }
}
