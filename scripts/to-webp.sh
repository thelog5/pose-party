#!/usr/bin/env bash
# Convert PNG/JPG art to WebP, one .webp beside each source file.
#
#   scripts/to-webp.sh <file-or-dir>...        encode, keep the sources
#   JOBS=8 QUALITY=85 scripts/to-webp.sh ...   override the defaults
#
# Each file is encoded twice, lossy (QUALITY, sharp YUV, alpha kept lossless)
# and lossless, and the smaller one is kept. Photographic paper wins big as
# lossy; flat palette art (TIMES UP, small tapes) often comes out SMALLER as
# lossless than lossy, and lossless costs no quality at all.
#
# Alpha is never lossy (-alpha_q 100): alphaHit.js, the photo-strip hit test
# and the sp-clock mask all read the alpha channel.
#
# The build scripts in scripts/*.py still write PNG. Run this on their output
# afterwards, update the reference, and delete the PNG.
set -euo pipefail
QUALITY="${QUALITY:-85}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"
command -v cwebp >/dev/null || { echo "cwebp not found: brew install webp" >&2; exit 1; }

encode() {
  src="$1"; out="${src%.*}.webp"
  tmp_l="$(mktemp -t webpl).webp"; tmp_x="$(mktemp -t webpx).webp"
  cwebp -quiet -mt -m 6 -q "$QUALITY" -sharp_yuv -alpha_q 100 "$src" -o "$tmp_l"
  case "$src" in
    *.jpg|*.jpeg|*.JPG|*.JPEG) cp "$tmp_l" "$tmp_x" ;;  # lossless of a JPEG is never smaller
    *) cwebp -quiet -mt -lossless -z 9 "$src" -o "$tmp_x" ;;
  esac
  sl=$(stat -f%z "$tmp_l" 2>/dev/null || stat -c%s "$tmp_l")
  sx=$(stat -f%z "$tmp_x" 2>/dev/null || stat -c%s "$tmp_x")
  so=$(stat -f%z "$src" 2>/dev/null || stat -c%s "$src")
  if [ "$sx" -le "$sl" ]; then mv "$tmp_x" "$out"; rm -f "$tmp_l"; kind=lossless; size=$sx
  else mv "$tmp_l" "$out"; rm -f "$tmp_x"; kind="q$QUALITY"; size=$sl; fi
  printf '%s\t%s\t%s\t%s\n' "$so" "$size" "$kind" "$src"
}
export -f encode; export QUALITY

find "$@" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) -print0 \
  | xargs -0 -n 1 -P "$JOBS" bash -c 'encode "$0"'
