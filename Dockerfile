# Two stages: Bun compiles the release executables, and the final image holds
# only those executables. It has no Bun, no node_modules and no source.

# The build stage runs on the builder's own platform and cross-compiles for the target, so a multi-platform
# build never runs Bun under emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.3 AS build
ARG TARGETARCH
WORKDIR /src
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/collector/package.json packages/collector/
# --cpu fetches sqlite-vec's library for the target rather than for the builder.
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported: $TARGETARCH" >&2; exit 1 ;; esac \
 && bun install --frozen-lockfile --os=linux --cpu="$arch"
COPY packages packages
COPY scripts/build.ts scripts/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# Collectors are not in the image: the server forwards them from the GitHub release matching its version.
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; esac \
 && bun scripts/build.ts --out /out --server "linux-$arch" --collectors none

# The final stage's filesystem is prepared here, so that stage needs no RUN and builds for any platform without emulation.
RUN mkdir -p /root-fs/var/lib/retrospecticus /root-fs/etc/retrospecticus /root-fs/var/cache/retrospecticus \
 && chmod 755 /root-fs/var/lib/retrospecticus /root-fs/var/cache/retrospecticus \
 && chmod 700 /root-fs/etc/retrospecticus

# Debian rather than Alpine: the executable and sqlite-vec are built against glibc, the only library they need.
FROM debian:bookworm-slim
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chown=1000:1000 /root-fs/var/lib/retrospecticus /var/lib/retrospecticus
COPY --from=build --chown=1000:1000 /root-fs/var/cache/retrospecticus /var/cache/retrospecticus
COPY --from=build --chown=1000:1000 --chmod=700 /root-fs/etc/retrospecticus /etc/retrospecticus
COPY --from=build /out/server/retrospecticus /usr/local/bin/retrospecticus
COPY --from=build /out/server/vec0.so /usr/local/lib/retrospecticus/vec0.so
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/retrospecticus/

ENV RETROSPECTICUS_CONFIG=/etc/retrospecticus/config.json \
    RETROSPECTICUS_LISTEN_HOST=0.0.0.0 \
    RETROSPECTICUS_SQLITE_VEC=/usr/local/lib/retrospecticus/vec0.so \
    RETROSPECTICUS_CACHE_DIR=/var/cache/retrospecticus

USER 1000:1000
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s CMD ["retrospecticus", "health"]
CMD ["retrospecticus", "serve"]
