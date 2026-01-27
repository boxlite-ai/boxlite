/**
 * Default configuration constants for BoxLite specialized boxes.
 *
 * These values match the Python SDK for consistency across language bindings.
 */

// ComputerBox (Desktop Automation) defaults
export const COMPUTERBOX_IMAGE = 'lscr.io/linuxserver/webtop:ubuntu-xfce';
export const COMPUTERBOX_CPUS = 2;
export const COMPUTERBOX_MEMORY_MIB = 2048;
export const COMPUTERBOX_DISPLAY_NUMBER = ':1';
export const COMPUTERBOX_DISPLAY_WIDTH = 1024;
export const COMPUTERBOX_DISPLAY_HEIGHT = 768;
export const COMPUTERBOX_GUI_HTTP_PORT = 3000;
export const COMPUTERBOX_GUI_HTTPS_PORT = 3001;

// Desktop readiness detection
export const DESKTOP_READY_TIMEOUT = 60; // seconds
export const DESKTOP_READY_RETRY_DELAY = 2; // seconds

// BrowserBox defaults
// Playwright Server port - single port for all browser types (chromium, firefox, webkit)
export const BROWSERBOX_PORT = 3000;

// Default resource limits
export const DEFAULT_CPUS = 1;
export const DEFAULT_MEMORY_MIB = 512;

// Network constants (must match boxlite/src/net/constants.rs)
export const GUEST_IP = '192.168.127.2';
