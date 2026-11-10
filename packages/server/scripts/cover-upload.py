"""Cover-only normalization. Sources are local, temporary files, never URLs.

Opaque motion is streamed frame by frame to H.264; transparent animations keep
their alpha, frame delays and loop count in WebP. All outputs are bounded before
the website publishes them. This process never gets storage/database credentials.
"""
import json
import math
import os
import subprocess
import sys
import warnings
from fractions import Fraction
from pathlib import Path

try:
    from PIL import Image, ImageSequence
except ImportError:
    print("COVER_RUNTIME", file=sys.stderr)
    sys.exit(1)

INPUT_BYTES = 64 * 1024 * 1024
OUTPUT_BYTES = 5 * 1024 * 1024
MAX_FRAME_PIXELS = 16_000_000
MAX_DECODE_PIXELS = 4_000_000_000
MAX_FRAMES = 3600
MAX_DURATION_MS = 60_000
ALPHA_OUTPUT_PIXELS = 40_000_000

Image.MAX_IMAGE_PIXELS = MAX_FRAME_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)


def fail(code):
    raise ValueError("COVER_" + code)


def set_limits():
    if os.name != "nt":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
        resource.setrlimit(resource.RLIMIT_CPU, (75, 75))
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024**2, 16 * 1024**2))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def dimensions(width, height, pixel_budget=None):
    if width < 1 or height < 1 or width * height > MAX_FRAME_PIXELS:
        fail("DIMENSIONS")
    bounds = (1920, 1080) if width >= height else (1080, 1920)
    scale = min(1, bounds[0] / width, bounds[1] / height)
    if pixel_budget:
        scale = min(scale, math.sqrt(pixel_budget / (width * height)))
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def check_work(width, height, count, duration_ms):
    dimensions(width, height)
    if not math.isfinite(duration_ms) or duration_ms <= 0:
        fail("INVALID")
    if duration_ms > MAX_DURATION_MS:
        fail("DURATION")
    if count < 1 or count > MAX_FRAMES or width * height * count > MAX_DECODE_PIXELS:
        fail("WORK")


def run(arguments, timeout=30):
    result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False)
    if result.returncode != 0 or len(result.stdout) > 256 * 1024:
        fail("INVALID")
    return result.stdout


def probe(source):
    # No HLS, concat, remote protocols, external references or attached streams.
    raw = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
               "-format_whitelist", "mov,matroska,webm", "-show_streams", "-show_format",
               "-of", "json", str(source)])
    data = json.loads(raw)
    streams = [stream for stream in data.get("streams", []) if stream.get("codec_type") == "video"]
    if not streams or len(data.get("streams", [])) > 16:
        fail("FORMAT")
    stream = streams[0]
    if stream.get("tags", {}).get("alpha_mode") == "1" or str(stream.get("pix_fmt", "")).startswith(("yuva", "gbrap", "rgba", "argb", "bgra", "abgr")):
        fail("ALPHA")
    width, height = int(stream["width"]), int(stream["height"])
    for side in stream.get("side_data_list", []):
        if abs(int(side.get("rotation", 0))) % 180 == 90:
            width, height = height, width
            break
    seconds = float(stream.get("duration") or data.get("format", {}).get("duration") or 0)
    # WebM recordings can report an unknown average as 0/0 while retaining
    # a usable nominal rate. Unknown is a fallback case, not a decode failure.
    try:
        fps = float(Fraction(stream.get("avg_frame_rate") or "0"))
    except (ValueError, ZeroDivisionError):
        fps = 0
    if fps <= 0:
        fps = float(Fraction(stream.get("r_frame_rate") or "0"))
    if not math.isfinite(fps) or fps <= 0:
        fail("INVALID")
    count = max(int(stream.get("nb_frames") or 0), math.ceil(seconds * fps))
    check_work(width, height, count, seconds * 1000)
    return width, height, seconds, data["format"]["format_name"]


def video_options(duration_ms, target):
    # CRF keeps easy clips small. A duration-aware bitrate ceiling also bounds
    # detailed clips; the exact file size and duration are checked afterwards.
    rate = min(4_000_000, int(OUTPUT_BYTES * 8 * 0.82 / (duration_ms / 1000)))
    return ["-an", "-sn", "-dn", "-map_metadata", "-1", "-c:v", "libx264",
            "-threads", "2", "-preset", "fast", "-tune", "zerolatency", "-crf", "23", "-maxrate", str(rate),
            "-bufsize", str(rate), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-fs", str(OUTPUT_BYTES + 64 * 1024), "-y", str(target)]


def validate_video(target, expected_ms):
    if not 0 < target.stat().st_size <= OUTPUT_BYTES:
        fail("OUTPUT")
    width, height, seconds, _ = probe(target)
    # An encoder's file-size stop must never silently publish a shortened clip.
    if abs(seconds * 1000 - expected_ms) > 100:
        fail("OUTPUT")
    return width, height


def poster_from_video(video, target, expected_ms):
    width, height = validate_video(video, expected_ms)
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
         "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-i", str(video),
         "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-c:v", "libwebp",
         "-quality", "82", "-threads", "1", "-y", str(target)])
    if not 0 < target.stat().st_size <= 1024 * 1024:
        fail("OUTPUT")
    return {"kind": "video", "width": width, "height": height, "durationMs": expected_ms}


def from_video(source, directory, mime):
    width, height, seconds, container = probe(source)
    if (mime == "video/mp4" and "mov" not in container) or (mime == "video/webm" and "webm" not in container):
        fail("FORMAT")
    size = dimensions(width, height)
    target = directory / "cover.mp4"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2",
         "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm",
         "-i", str(source), "-map", "0:v:0", "-t", "61", "-filter_threads", "1",
         "-vf", f"scale={size[0]}:{size[1]}:flags=lanczos,setsar=1,fps=30"]
        + video_options(seconds * 1000, target), timeout=75)
    return poster_from_video(target, directory / "cover.webp", round(seconds * 1000))


def animation_frames(image):
    # APNG may have a default still that is not part of its playback timeline.
    skip_default = bool(image.info.get("default_image", False))
    for index, frame in enumerate(ImageSequence.Iterator(image)):
        if skip_default and index == 0:
            continue
        yield frame


def playback_loops(image):
    loop = int(image.info.get("loop", 1))
    # GIF stores repeat count; WebP/APNG store total plays. No GIF loop means
    # play once. Zero is infinite for all three formats.
    if image.format == "GIF" and "loop" in image.info and loop > 0:
        loop += 1
    return loop


def inspect_animation(image, mime):
    expected = {"image/gif": "GIF", "image/webp": "WEBP", "image/png": "PNG"}
    if expected.get(mime) != image.format:
        fail("FORMAT")
    width, height = image.size
    dimensions(width, height)
    # Do not ask Pillow for n_frames up front: GIF's implementation may scan
    # arbitrarily many frames before a caller gets a chance to enforce a budget.
    durations = []
    transparent = False
    for index, frame in enumerate(animation_frames(image)):
        if index >= MAX_FRAMES or width * height * (index + 1) > MAX_DECODE_PIXELS:
            fail("WORK")
        if frame.size != (width, height):
            fail("DIMENSIONS")
        frame.load()
        rgba = frame.convert("RGBA")
        transparent = transparent or rgba.getextrema()[3][0] != 255
        delay = int(frame.info.get("duration", 100))
        if delay < 0:
            fail("INVALID")
        durations.append(max(10, delay))
        if sum(durations) > MAX_DURATION_MS:
            fail("DURATION")
    if len(durations) < 2:
        fail("FORMAT")
    check_work(width, height, len(durations), sum(durations))
    return durations, transparent


def animated_webp(image, durations, directory):
    # Alpha must never be composited onto black just to obtain an MP4. Finite
    # loop counts also need an image (cover videos loop indefinitely). Bound
    # the decoded output, not the uploaded resolution, and keep frame timing.
    size = dimensions(*image.size, ALPHA_OUTPUT_PIXELS / len(durations))
    target = directory / "cover.webp"
    loop = playback_loops(image)
    for attempt in range(3):
        frames = []
        try:
            for frame in animation_frames(image):
                frame.load()
                frames.append(frame.convert("RGBA").resize(size, Image.Resampling.LANCZOS))
            frames[0].save(target, format="WEBP", save_all=True, append_images=frames[1:],
                           duration=durations, loop=loop, quality=82, method=3,
                           lossless=False, allow_mixed=True)
        finally:
            for frame in frames:
                frame.close()
        if 0 < target.stat().st_size <= OUTPUT_BYTES:
            return {"kind": "webp", "width": size[0], "height": size[1], "durationMs": sum(durations)}
        size = (max(2, int(size[0] * 0.75) // 2 * 2), max(2, int(size[1] * 0.75) // 2 * 2))
    fail("OUTPUT")


def opaque_video(image, durations, directory):
    size = dimensions(*image.size)
    target = directory / "cover.mp4"
    # FFmpeg stderr goes to a bounded local file: a pipe that nobody drains can
    # deadlock a writer on a malformed frame. RLIMIT_FSIZE bounds it in production.
    with (directory / "encoder.log").open("wb") as errors:
        process = subprocess.Popen([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-threads", "2", "-filter_threads", "1",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{size[0]}x{size[1]}",
            "-r", "30", "-i", "pipe:0",
        ] + video_options(sum(durations), target), stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=errors)
        try:
            end, emitted = 0, 0
            for index, frame in enumerate(animation_frames(image)):
                frame.load()
                pixels = frame.convert("RGB").resize(size, Image.Resampling.LANCZOS).tobytes()
                end += durations[index]
                target_frames = max(1, round(end * 30 / 1000))
                while emitted < target_frames:
                    process.stdin.write(pixels)
                    emitted += 1
            process.stdin.close()
            if process.wait(timeout=30) != 0:
                fail("OUTPUT")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    return poster_from_video(target, directory / "cover.webp", sum(durations))


def convert(source, directory, mime):
    source, directory = Path(source), Path(directory)
    if not 0 < source.stat().st_size <= INPUT_BYTES:
        fail("WORK")
    if mime in ("video/mp4", "video/webm"):
        result = from_video(source, directory, mime)
    else:
        with Image.open(source) as image:
            durations, alpha = inspect_animation(image, mime)
            image.seek(0)
            finite_loop = playback_loops(image) != 0
            result = animated_webp(image, durations, directory) if alpha or finite_loop else opaque_video(image, durations, directory)
    (directory / "result.json").write_text(json.dumps(result), encoding="utf8")
    return result


if __name__ == "__main__":
    try:
        set_limits()
        convert(sys.argv[1], sys.argv[2], sys.argv[3])
    except FileNotFoundError:
        print("COVER_RUNTIME", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        code = str(error) if str(error).startswith("COVER_") else "COVER_INVALID"
        print(code, file=sys.stderr)
        sys.exit(1)
