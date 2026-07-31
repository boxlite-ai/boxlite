/* Curated base image for C e2e drivers run directly from /tmp.
 * Keep this fallback in step with apps/box-images/VERSION; run.sh and the
 * pytest wrappers normally provide BOXLITE_E2E_IMAGE.
 */
#ifndef BOXLITE_E2E_IMAGE_H
#define BOXLITE_E2E_IMAGE_H

#include <stdlib.h>
#include <string.h>

#define BOXLITE_E2E_DEFAULT_IMAGE "ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0"

static inline const char* boxlite_e2e_default_image(void) {
    const char* image = getenv("BOXLITE_E2E_IMAGE");
    return (image && strlen(image)) ? image : BOXLITE_E2E_DEFAULT_IMAGE;
}

#endif /* BOXLITE_E2E_IMAGE_H */
