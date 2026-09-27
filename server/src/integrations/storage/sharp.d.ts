declare module 'sharp' {
  interface SharpInfo {
    width: number;
    height: number;
  }
  interface SharpResult {
    data: Uint8Array;
    info: SharpInfo;
  }
  interface SharpPipeline {
    metadata(): Promise<{
      exif?: Uint8Array;
      xmp?: Uint8Array;
      iptc?: Uint8Array;
    }>;
    rotate(): SharpPipeline;
    resize(options: {
      width: number;
      height: number;
      fit: 'inside';
      withoutEnlargement: boolean;
    }): SharpPipeline;
    webp(options: { quality: number }): SharpPipeline;
    toBuffer(options: { resolveWithObject: true }): Promise<SharpResult>;
    toBuffer(): Promise<Uint8Array>;
  }
  const sharp: (
    input: Uint8Array,
    options?: { failOn: 'error'; limitInputPixels: number },
  ) => SharpPipeline;
  // Sharp exposes its factory as the default CommonJS export.
  // eslint-disable-next-line import/no-default-export
  export default sharp;
}
