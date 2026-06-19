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

# Put bundled .so files on the library search path so the engine finds them at runtime.
ENV LD_LIBRARY_PATH=/app/phaselimiter/bin

# Verify all shared-library deps are satisfied at build time (shows "not found" in CI logs).
RUN LD_LIBRARY_PATH=/app/phaselimiter/bin ldd /app/phaselimiter/bin/phase_limiter 2>&1 || true && \
    LD_LIBRARY_PATH=/app/phaselimiter/bin ldd /app/phaselimiter/bin/audio_analyzer 2>&1 || true

EXPOSE 8080
CMD ["/app/phaselimiter-server"]
