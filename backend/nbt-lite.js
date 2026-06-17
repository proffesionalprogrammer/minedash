'use strict';

// Minimal big-endian NBT reader — just enough to read a Minecraft `level.dat`
// (seed, game mode, last-played, level name). Pure JS, zero dependencies, so it
// adds no packaging surface (no new node_module to duplicate into the root
// package.json / app.asar — see the pngjs MODULE_NOT_FOUND lesson in CLAUDE.md).
//
// 64-bit TAG_Long values are returned as BigInt so a world seed survives intact
// (JS numbers lose precision past 2^53).

const zlib = require('zlib');

// level.dat is gzip-compressed (magic 1f 8b). Handle zlib (78) too, and pass an
// already-inflated buffer straight through, so we're robust to odd writers.
function decompress(buf) {
  if (!buf || buf.length < 2) return buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  if (buf[0] === 0x78) return zlib.inflateSync(buf);
  return buf;
}

// Parse a (decompressed) NBT buffer into a plain JS object. Throws on a tag type
// it doesn't understand rather than returning garbage.
function parse(buf) {
  let off = 0;
  const readByte   = () => { const v = buf.readInt8(off);      off += 1; return v; };
  const readUByte  = () => { const v = buf.readUInt8(off);     off += 1; return v; };
  const readShort  = () => { const v = buf.readInt16BE(off);   off += 2; return v; };
  const readUShort = () => { const v = buf.readUInt16BE(off);  off += 2; return v; };
  const readInt    = () => { const v = buf.readInt32BE(off);   off += 4; return v; };
  const readLong   = () => { const v = buf.readBigInt64BE(off);off += 8; return v; };
  const readFloat  = () => { const v = buf.readFloatBE(off);   off += 4; return v; };
  const readDouble = () => { const v = buf.readDoubleBE(off);  off += 8; return v; };
  const readString = () => {
    const len = readUShort();
    const s = buf.toString('utf8', off, off + len); // close enough to Java's modified UTF-8 for display
    off += len;
    return s;
  };

  function readPayload(type) {
    switch (type) {
      case 1:  return readByte();
      case 2:  return readShort();
      case 3:  return readInt();
      case 4:  return readLong();
      case 5:  return readFloat();
      case 6:  return readDouble();
      case 7:  { const len = readInt(); const a = []; for (let i = 0; i < len; i++) a.push(readByte()); return a; }   // TAG_Byte_Array
      case 8:  return readString();
      case 9:  {                                                                                                       // TAG_List
        const itemType = readUByte();
        const len = readInt();
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(readPayload(itemType));
        return arr;
      }
      case 10: {                                                                                                       // TAG_Compound
        const obj = {};
        for (;;) {
          const t = readUByte();
          if (t === 0) break; // TAG_End
          const name = readString();
          obj[name] = readPayload(t);
        }
        return obj;
      }
      case 11: { const len = readInt(); const a = []; for (let i = 0; i < len; i++) a.push(readInt());  return a; }    // TAG_Int_Array
      case 12: { const len = readInt(); const a = []; for (let i = 0; i < len; i++) a.push(readLong()); return a; }    // TAG_Long_Array
      default: throw new Error(`Unknown NBT tag type ${type} at offset ${off}`);
    }
  }

  const rootType = readUByte();
  if (rootType === 0) return {};
  readString(); // root tag name (conventionally empty)
  return readPayload(rootType);
}

// Pull the handful of fields the Worlds UI surfaces out of a raw (possibly
// gzipped) level.dat buffer. Tolerates pre-1.16 (`RandomSeed`) and 1.16+
// (`WorldGenSettings.seed`) layouts.
function summarizeLevelDat(rawBuf) {
  const root = parse(decompress(rawBuf));
  const data = (root && root.Data) || {};

  const gameMode = typeof data.GameType === 'number' ? data.GameType : null;

  let lastPlayed = null;
  if (typeof data.LastPlayed === 'bigint') lastPlayed = Number(data.LastPlayed);
  else if (typeof data.LastPlayed === 'number') lastPlayed = data.LastPlayed;

  let seed = null;
  if (data.WorldGenSettings && data.WorldGenSettings.seed != null) seed = String(data.WorldGenSettings.seed);
  else if (data.RandomSeed != null) seed = String(data.RandomSeed);

  const levelName = typeof data.LevelName === 'string' ? data.LevelName : null;

  return { gameMode, lastPlayed, seed, levelName };
}

module.exports = { parse, decompress, summarizeLevelDat };
