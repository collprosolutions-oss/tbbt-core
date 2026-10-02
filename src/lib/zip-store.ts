/**
 * Minimal uncompressed ZIP writer (STORE method). Used for tenant data
 * export so we do not add a zip dependency.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

export type ZipStoreFile = {
  name: string;
  data: string | Buffer;
};

export const ZIP_UTF8_NAME_FLAG = 0x0800;

export function zipNameGeneralPurposeFlag(name: string | Buffer): number {
  const bytes = typeof name === "string" ? Buffer.from(name, "utf8") : name;
  return bytes.some((byte) => byte > 0x7f) ? ZIP_UTF8_NAME_FLAG : 0;
}

export function buildZipStore(files: readonly ZipStoreFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = typeof file.data === "string" ? Buffer.from(file.data, "utf8") : file.data;
    const crc = crc32(data);
    const flags = zipNameGeneralPurposeFlag(name);
    const local = Buffer.concat([
      Buffer.from("PK\u0003\u0004", "binary"),
      u16(20),
      u16(flags),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    locals.push(local);
    const central = Buffer.concat([
      Buffer.from("PK\u0001\u0002", "binary"),
      u16(20),
      u16(20),
      u16(flags),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from("PK\u0005\u0006", "binary"),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes.length),
    u32(localBytes.length),
    u16(0),
  ]);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

export function readZipStoreFiles(bytes: Buffer): Array<{ name: string; data: Buffer }> {
  const files: Array<{ name: string; data: Buffer }> = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const signature = bytes.toString("binary", offset, offset + 4);
    if (signature === "PK\u0001\u0002" || signature === "PK\u0005\u0006") break;
    if (signature !== "PK\u0003\u0004") {
      throw new Error("Invalid ZIP local header.");
    }
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = bytes.toString("utf8", nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    files.push({ name, data: Buffer.from(bytes.subarray(dataStart, dataStart + size)) });
    offset = dataStart + size;
  }
  return files;
}

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;
const CSV_NUMERIC_CELL = /^-?\d+(\.\d+)?$/;

export function neutralizeCsvFormulaPrefix(value: string): string {
  return CSV_FORMULA_PREFIX.test(value) && !CSV_NUMERIC_CELL.test(value) ? `'${value}` : value;
}

export function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeCsvFormulaPrefix(
    value instanceof Date ? value.toISOString() : String(value),
  );
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: Array<Record<string, unknown>>): string {
  const lines = [
    headers.map(toCsvCell).join(","),
    ...rows.map((row) => headers.map((header) => toCsvCell(row[header])).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}
