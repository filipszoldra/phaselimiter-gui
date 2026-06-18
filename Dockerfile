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
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY phaselimiter-server .
COPY phaselimiter/ ./phaselimiter/

# Put bundled .so files on the library search path so the engine finds them at runtime.
ENV LD_LIBRARY_PATH=/app/phaselimiter/bin

EXPOSE 8080
CMD ["/app/phaselimiter-server"]
