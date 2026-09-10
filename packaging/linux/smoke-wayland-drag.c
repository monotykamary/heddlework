#include <errno.h>
#include <linux/input-event-codes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "wlr-virtual-pointer-client-protocol.h"

static struct zwlr_virtual_pointer_manager_v1 *manager;
static struct wl_seat *seat;

static uint32_t timestamp_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    perror("clock_gettime");
    exit(1);
  }
  return (uint32_t)(now.tv_sec * 1000u + now.tv_nsec / 1000000u);
}

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  if (strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
    manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, version < 2 ? version : 2);
  } else if (strcmp(interface, wl_seat_interface.name) == 0) {
    seat = wl_registry_bind(registry, name, &wl_seat_interface, version < 7 ? version : 7);
  }
}

static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

static const struct wl_registry_listener registry_listener = {
  .global = global,
  .global_remove = global_remove,
};

static int integer(const char *value) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < -32768 || parsed > 32768) {
    fprintf(stderr, "invalid pointer coordinate: %s\n", value);
    exit(64);
  }
  return (int)parsed;
}

static void sync_display(struct wl_display *display) {
  if (wl_display_roundtrip(display) < 0) {
    fprintf(stderr, "Wayland virtual pointer roundtrip failed\n");
    exit(1);
  }
}

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: %s X Y DX DY\n", argv[0]);
    return 64;
  }
  const int x = integer(argv[1]);
  const int y = integer(argv[2]);
  const int dx = integer(argv[3]);
  const int dy = integer(argv[4]);
  if (x < 0 || y < 0 || x > 1280 || y > 800) {
    fprintf(stderr, "initial pointer position is outside the 1280x800 smoke output\n");
    return 64;
  }

  struct wl_display *display = wl_display_connect(NULL);
  if (!display) {
    fprintf(stderr, "failed to connect to WAYLAND_DISPLAY\n");
    return 1;
  }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  sync_display(display);
  if (!manager || !seat) {
    fprintf(stderr, "compositor does not expose zwlr_virtual_pointer_manager_v1 and wl_seat\n");
    return 1;
  }

  struct zwlr_virtual_pointer_v1 *pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, seat);
  zwlr_virtual_pointer_v1_motion_absolute(pointer, timestamp_ms(), (uint32_t)x, (uint32_t)y, 1280, 800);
  zwlr_virtual_pointer_v1_frame(pointer);
  sync_display(display);
  usleep(50000);

  zwlr_virtual_pointer_v1_button(pointer, timestamp_ms(), BTN_LEFT, WL_POINTER_BUTTON_STATE_PRESSED);
  zwlr_virtual_pointer_v1_frame(pointer);
  sync_display(display);
  usleep(50000);

  for (int step = 0; step < 4; step++) {
    zwlr_virtual_pointer_v1_motion(pointer, timestamp_ms(), wl_fixed_from_double(dx / 4.0), wl_fixed_from_double(dy / 4.0));
    zwlr_virtual_pointer_v1_frame(pointer);
    sync_display(display);
    usleep(50000);
  }

  zwlr_virtual_pointer_v1_button(pointer, timestamp_ms(), BTN_LEFT, WL_POINTER_BUTTON_STATE_RELEASED);
  zwlr_virtual_pointer_v1_frame(pointer);
  sync_display(display);

  zwlr_virtual_pointer_v1_destroy(pointer);
  zwlr_virtual_pointer_manager_v1_destroy(manager);
  wl_seat_destroy(seat);
  wl_registry_destroy(registry);
  wl_display_disconnect(display);
  return 0;
}
