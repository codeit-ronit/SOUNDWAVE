export const MAX_CHAPTER_BYTES = 25 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export function validateDownload(bytes, contentType, expectedSize) {
  if (
    bytes.byteLength !== expectedSize ||
    expectedSize < 12 ||
    expectedSize > MAX_CHAPTER_BYTES
  )
    throw Error("The download was incomplete or invalid. Please retry.");
  const view = new DataView(bytes);
  if (contentType.startsWith("audio/wav")) {
    if (
      expectedSize < 44 ||
      view.getUint32(0) !== 0x52494646 ||
      view.getUint32(8) !== 0x57415645 ||
      view.getUint32(4, true) + 8 !== expectedSize
    )
      throw Error("The download was incomplete or invalid. Please retry.");
  } else if (contentType.startsWith("audio/mpeg")) {
    const id3 =
      view.getUint8(0) === 0x49 &&
      view.getUint8(1) === 0x44 &&
      view.getUint8(2) === 0x33;
    const frame =
      view.getUint8(0) === 0xff &&
      (view.getUint8(1) & 0xe0) === 0xe0 &&
      (view.getUint8(1) & 6) !== 0 &&
      (view.getUint8(2) & 0xf0) !== 0xf0;
    if (!id3 && !frame)
      throw Error("The MP3 download was invalid. Please retry.");
  } else throw Error("This audio format is not supported for downloads.");
}
