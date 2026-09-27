export interface ImageProcessor {
  process(
    bytes: Uint8Array,
    mime: string,
  ): Promise<{
    bytes: Uint8Array;
    mime: 'image/webp' | 'image/jpeg';
    width: number;
    height: number;
    thumbnail: Uint8Array;
    medium: Uint8Array;
  }>;
}

/** Sharp rotates according to EXIF then re-encodes, stripping EXIF and GPS metadata. */
export class SharpImageProcessor implements ImageProcessor {
  async process(bytes: Uint8Array, _mime: string) {
    if (
      !['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(_mime)
    )
      throw new Error('Unsupported image type');
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default;
    const create = () =>
      sharp(bytes, { failOn: 'error', limitInputPixels: 100_000_000 }).rotate();
    const original = await create()
      .resize({
        width: 2048,
        height: 2048,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    const medium = await create()
      .resize({
        width: 800,
        height: 800,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();
    const thumbnail = await create()
      .resize({
        width: 240,
        height: 240,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 78 })
      .toBuffer();
    return {
      bytes: original.data,
      mime: 'image/webp' as const,
      width: original.info.width,
      height: original.info.height,
      medium,
      thumbnail,
    };
  }
}
