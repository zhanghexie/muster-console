/** JPEG requires full-range YUV. Flush the last interval so short clips yield a frame. */
export function videoFrameFilter(intervalSeconds: number): string {
  return `fps=1/${intervalSeconds}:eof_action=pass,scale=1280:720:force_original_aspect_ratio=decrease:out_range=full,format=yuvj420p`;
}
