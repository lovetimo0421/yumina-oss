"""Bounded, frame-at-a-time animation preview. Never modifies the source."""
import json
import subprocess
import sys
import warnings
from pathlib import Path
from PIL import Image, ImageSequence

Image.MAX_IMAGE_PIXELS = 16_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def convert(source, target):
    if Path(source).stat().st_size > 64 * 1024 * 1024:
        raise ValueError("cover input too large")
    with Image.open(source) as image:
        width, height = image.size
        count = getattr(image, "n_frames", 1)
        if not 1 < count <= 600 or width * height * count > 500_000_000:
            raise ValueError("cover frame budget exceeded")
        scale = min(1, 480 / width, 720 / height)
        size = (max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2))
        # Resample the timeline, not the animation's duration. At most 30fps.
        durations = []
        for frame in ImageSequence.Iterator(image):
            frame.load()
            durations.append(max(10, int(frame.info.get("duration", 100))))
        duration = sum(durations)
        if duration > 60_000:
            raise ValueError("cover duration exceeded")
        process = subprocess.Popen([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{size[0]}x{size[1]}",
            "-r", "30", "-i", "pipe:0", "-an", "-c:v", "libx264", "-threads", "2",
            "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
            "-fs", str(12 * 1024 * 1024), "-movflags", "+faststart", "-y", target,
        ], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            end = 0
            emitted = 0
            for index, frame in enumerate(ImageSequence.Iterator(image)):
                frame.load()
                if frame.convert("RGBA").getextrema()[3][0] != 255:
                    raise ValueError("transparent animation requires an alpha-capable preview")
                pixels = frame.convert("RGB").resize(size, Image.Resampling.LANCZOS).tobytes()
                end += durations[index]
                target_frames = round(end * 30 / 1000)
                while emitted < target_frames:
                    process.stdin.write(pixels)
                    emitted += 1
            process.stdin.close()
            error = process.stderr.read(4096)
            if process.wait() != 0:
                raise ValueError("cover encoder failed: " + error.decode("utf-8", "replace"))
            if Path(target).stat().st_size >= 12 * 1024 * 1024:
                raise ValueError("cover output budget exceeded")
            return {"width": size[0], "height": size[1], "frames": emitted, "durationMs": duration}
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    print(json.dumps(convert(sys.argv[1], sys.argv[2])))
