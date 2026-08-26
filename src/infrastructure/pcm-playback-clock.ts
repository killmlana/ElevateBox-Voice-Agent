export interface PcmPlaybackClockInput {
  totalBytes: number;
  elapsedMs: number;
  bufferMs: number;
  bytesPerSecond: number;
  sampleBytes?: number;
}

export const pacedPcmTargetBytes = ({
  totalBytes,
  elapsedMs,
  bufferMs,
  bytesPerSecond,
  sampleBytes = 2,
}: PcmPlaybackClockInput): number => {
  const clockBytes = Math.floor(
    ((Math.max(0, elapsedMs) + bufferMs) / 1000) *
      bytesPerSecond / sampleBytes,
  ) * sampleBytes;
  return Math.min(totalBytes, clockBytes);
};
