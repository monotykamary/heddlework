FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/root/.bun/bin:/root/.cargo/bin:${PATH} \
    CARGO_INCREMENTAL=0 \
    CARGO_PROFILE_RELEASE_DEBUG=0 \
    CARGO_PROFILE_DEV_DEBUG=0 \
    CARGO_BUILD_JOBS=2

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    clang \
    curl \
    dbus-x11 \
    fonts-dejavu-core \
    git \
    jq \
    libfontconfig-dev \
    libgl1-mesa-dri \
    libssl-dev \
    libvulkan1 \
    libwayland-dev \
    libx11-xcb-dev \
    libxkbcommon-x11-dev \
    libzstd-dev \
    mesa-vulkan-drivers \
    mutter \
    pkg-config \
    rsync \
    sway \
    unzip \
    vulkan-tools \
    wayland-protocols \
    weston \
    x11-utils \
    xdotool \
    xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash heddlework-smoke

RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.0 \
  && install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \
  && curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none

WORKDIR /work
CMD ["sleep", "infinity"]
