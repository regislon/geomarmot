// @ts-check
/*
 * A minimal ustar archive writer: enough to hand the user a folder as one
 * download ("Export as folder"), readable by `tar -xf` everywhere.
 */

const encoder = new TextEncoder();

function header(name, size) {
  const block = new Uint8Array(512);
  const put = (text, offset, length) => block.set(encoder.encode(text).slice(0, length), offset);
  const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8); // checksum placeholder: eight spaces
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(octal(sum, 7) + " ", 148, 8);
  return block;
}

/** @param {Array<{ name: string, text: string }>} files  paths inside the archive */
export function tarArchive(files) {
  const parts = [];
  for (const file of files) {
    const data = encoder.encode(file.text);
    parts.push(header(file.name, data.length), data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: "application/x-tar" });
}
