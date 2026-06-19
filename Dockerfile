# phaselimiter web server image
# Build context must contain:
#   phaselimiter-server       — Go HTTP server binary (linux/amd64, CGO_ENABLED=0)
#   phaselimiter/bin/         — phase_limiter, audio_analyzer + their .so deps
#   phaselimiter/resource/    — mastering_reference.json, sound_quality2_cache/, analysis_data/

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libsndfile1 \
      libgomp1 \
      libboost-filesystem1.83.0 \
      libboost-serialization1.83.0 \
      libboost-iostreams1.83.0 \
      ca-certificates \
    && ln -sf /usr/lib/x86_64-linux-gnu/libboost_filesystem.so.1.83.0 \
              /usr/lib/x86_64-linux-gnu/libboost_filesystem.so.1.82.0 \
    && ln -sf /usr/lib/x86_64-linux-gnu/libboost_serialization.so.1.83.0 \
              /usr/lib/x86_64-linux-gnu/libboost_serialization.so.1.82.0 \
    && ln -sf /usr/lib/x86_64-linux-gnu/libboost_iostreams.so.1.83.0 \
              /usr/lib/x86_64-linux-gnu/libboost_iostreams.so.1.82.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY phaselimiter-server .
COPY phaselimiter/ ./phaselimiter/

# IPP runtime dispatcher dlopen's the CPU-specific variant by full soname (e.g.
# libippvmk0.so.12.0), but the artifact ships only *.so.12. Create the missing
# *.so.12.0 symlinks so dlopen finds them via LD_LIBRARY_PATH.
RUN find /app/phaselimiter/bin -name "libipp*.so.12" | \
    while read f; do ln -sf "$(basename "$f")" "${f}.0"; done

# Regenerate sound_quality2_cache as a Linux-native boost::binary_archive.
# The cache copied from the engine artifact was built on Windows and uses a
# platform-specific binary archive format that cannot be read on Linux, causing
# phase_limiter to throw "syntax error at line 1" during AutoMastering init.
# Running audio_analyzer --mode sound_quality2_preparation here (inside the
# final Linux amd64 container) produces a compatible file in-place.
# The build continues on failure so limiter-only mode still works without it.
RUN LD_LIBRARY_PATH=/app/phaselimiter/bin \
    /app/phaselimiter/bin/audio_analyzer \
      --mode sound_quality2_preparation \
      --sound_quality2_cache /app/phaselimiter/resource/sound_quality2_cache \
      --analysis_data_dir /app/phaselimiter/resource/analysis_data \
    && echo "sound_quality2_cache regenerated: $(stat -c%s /app/phaselimiter/resource/sound_quality2_cache) bytes" \
    || echo "WARNING: sound_quality2_preparation failed — mastering5 will crash on this image"

# Put bundled .so files on the library search path so the engine finds them at runtime.
ENV LD_LIBRARY_PATH=/app/phaselimiter/bin

EXPOSE 8080
CMD ["/app/phaselimiter-server"]
