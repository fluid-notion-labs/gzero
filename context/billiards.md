# Context — billiards

## notes #billiards #headless #wayland
- billiards unattended/agent sessions must run the game under a headless weston compositor via billiards-rs/run-headless.sh (starts weston headless output on socket 'wlheadless' with [core] renderer=gl — the gl config is what makes weston advertise dmabuf so client EGL gets hardware r600 GL; without it clients fall back to llvmpipe ~20fps). Desktop-compositor occlusion stops frame callbacks and permanently freezes the whole game, so never rely on the visible desktop session for agent play. Weston dying kills its clients; the relay-launcher then respawns the game into the dead socket, so restart weston first, then the launcher.
