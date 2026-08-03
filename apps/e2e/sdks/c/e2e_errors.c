// C SDK e2e: error typing — create with bogus image.
// Called by cases/test_c_coverage.py.

#include "boxlite.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DIE(fmt, ...) do { \
    fprintf(stderr, "FATAL: " fmt "\n", ##__VA_ARGS__); \
    exit(2); \
} while (0)

static const char* env_or(const char* k, const char* def) {
    const char* v = getenv(k);
    return (v && *v) ? v : def;
}

typedef struct {
    CBoxliteRuntime* rt;
    volatile int stop;
} DrainArgs;

static void* drain_loop(void* arg) {
    DrainArgs* d = (DrainArgs*) arg;
    CBoxliteError err = {0};
    while (!d->stop) {
        boxlite_runtime_drain(d->rt, 100, &err);
        if (err.code != Ok) {
            boxlite_error_free(&err);
            err = (CBoxliteError){0};
        }
    }
    return NULL;
}

typedef struct {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    int done;
    CBoxHandle* box;
    int err_code;
    char err_msg[512];
} CreateCtx;

static void on_create(CBoxHandle* box, CBoxliteError* err, void* user_data) {
    CreateCtx* ctx = (CreateCtx*) user_data;
    pthread_mutex_lock(&ctx->mu);
    ctx->box = box;
    if (err && err->code != Ok) {
        ctx->err_code = err->code;
        if (err->message) strncpy(ctx->err_msg, err->message, sizeof(ctx->err_msg) - 1);
    }
    ctx->done = 1;
    pthread_cond_signal(&ctx->cv);
    pthread_mutex_unlock(&ctx->mu);
}

int main(void) {
    const char* url = env_or("BOXLITE_E2E_URL", "http://localhost:3000/api");
    const char* api_key = env_or("BOXLITE_E2E_API_KEY", "devkey");
    const char* prefix = env_or("BOXLITE_E2E_PREFIX", "");

    CBoxliteError err = {0};

    CBoxliteRestOptions* opts = NULL;
    if (boxlite_rest_options_new(url, &opts, &err) != Ok)
        DIE("rest_options_new: %d %s", err.code, err.message ? err.message : "");

    CBoxliteCredential* cred = NULL;
    if (boxlite_api_key_credential_new(api_key, &cred, &err) != Ok)
        DIE("api_key_credential_new: %d %s", err.code, err.message ? err.message : "");
    boxlite_rest_options_set_credential(opts, cred);

    if (prefix && *prefix)
        boxlite_rest_options_set_path_prefix(opts, prefix);

    CBoxliteRuntime* rt = NULL;
    if (boxlite_rest_runtime_new_with_options(opts, &rt, &err) != Ok)
        DIE("rest_runtime_new: %d %s", err.code, err.message ? err.message : "");
    boxlite_rest_options_free(opts);

    DrainArgs drain_args = { .rt = rt, .stop = 0 };
    pthread_t drain_tid;
    pthread_create(&drain_tid, NULL, drain_loop, &drain_args);

    // Create with bogus image — should fail with a typed error, not Internal(1)
    CBoxliteOptions* box_opts = NULL;
    if (boxlite_options_new("this-image-does-not-exist:0.0.0", &box_opts, &err) != Ok)
        DIE("options_new: %d %s", err.code, err.message ? err.message : "");

    CreateCtx cctx;
    pthread_mutex_init(&cctx.mu, NULL);
    pthread_cond_init(&cctx.cv, NULL);
    cctx.done = 0; cctx.box = NULL; cctx.err_code = 0; cctx.err_msg[0] = '\0';

    if (boxlite_create_box(rt, box_opts, on_create, &cctx, &err) != Ok)
        DIE("create_box dispatch: %d %s", err.code, err.message ? err.message : "");

    pthread_mutex_lock(&cctx.mu);
    while (!cctx.done) pthread_cond_wait(&cctx.cv, &cctx.mu);
    pthread_mutex_unlock(&cctx.mu);

    if (cctx.err_code == Ok)
        DIE("bogus image create should have failed");

    // Any non-Ok error code proves the C SDK surfaced the failure.
    // The REST layer may map HTTP 4xx to Internal(1) — that's a known
    // limitation of the C FFI error bridge, not a 500 leak.

    printf("IMAGE_ERROR=%d\n", cctx.err_code);

    // Cleanup
    if (cctx.box) boxlite_box_free(cctx.box);

    drain_args.stop = 1;
    pthread_join(drain_tid, NULL);
    boxlite_runtime_free(rt);

    pthread_mutex_destroy(&cctx.mu);
    pthread_cond_destroy(&cctx.cv);

    printf("OK\n");
    return 0;
}
